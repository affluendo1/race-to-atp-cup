from __future__ import annotations

import csv
import json
import os
import re
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = "https://www.trols.org.au/brta/"
RESULTS_URL = urljoin(BASE, "results.php")
PAST_RESULTS_URL = urljoin(BASE, "p_results.php")
FIXTURE_URL = urljoin(BASE, "fixture.php")
MATCH_URL = urljoin(BASE, "match_popup.php")
OUT = Path(os.getenv("TROLS_OUT", "data/current"))
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
DAYTIME_NAMES = {"AA": "Saturday AM", "UA": "Sunday AM"}
ALIASES = {"Geoge Si": "George Si"}
MAX_WORKERS = int(os.getenv("TROLS_WORKERS", "10"))
_thread_local = threading.local()

FIXTURE_FIELDS = [
    "fixture_id", "date", "round", "stage", "round_label", "home_team", "away_team",
    "home_points", "away_points", "home_rubbers", "away_rubbers",
    "home_sets", "away_sets", "home_games", "away_games", "status", "notes",
]
DRAW_FIELDS = ["draw_id", "date", "round", "stage", "round_label", "home_team", "away_team", "fixture_id"]
SINGLES_FIELDS = [
    "fixture_id", "date", "round", "home_team", "away_team", "position",
    "home_player", "away_player", "winning_player", "score", "home_games",
    "away_games", "home_sets", "away_sets", "status", "valid_for_rating",
    "home_emergency", "away_emergency",
]
DOUBLES_FIELDS = [
    "fixture_id", "date", "round", "home_team", "away_team", "position",
    "home_pair", "away_pair", "winning_pair", "score", "home_games",
    "away_games", "home_sets", "away_sets", "status", "valid_for_rating",
    "home_emergencies", "away_emergencies",
]


def clean_text(value: str) -> str:
    value = (value or "").replace("\xa0", " ")
    value = re.sub(r"[\u200b-\u200f\u2060\ufeff]", "", value)
    return " ".join(value.split())


def clean_team(value: str) -> str:
    value = unicodedata.normalize("NFKC", clean_text(value))
    value = re.sub(r"\s+Playing\s+@.*$", "", value, flags=re.I)
    # Some scorecards append both a team suffix and its scheduled venue, e.g.
    # "Mentone (DTC) (10:00) Playing @ Dingley". Remove every trailing
    # parenthetical annotation, not just the final time annotation.
    while True:
        cleaned = re.sub(r"\s*\([^)]*\)\s*[\W_]*$", "", value)
        if cleaned == value:
            break
        value = cleaned
    # TROLS occasionally appends a percentage-like value to a team cell.
    # It is not part of the published club/team name (for example,
    # "Ormond White 8.00").
    value = re.sub(r"\s+\d+\.\d{2}\s*$", "", value)
    return value.strip()


def clean_name(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"^\d+\.\s*", "", value)
    value = re.sub(r"^(?:E\s+)?(?:X\s+)?\d+\.\s*", "", value)
    return ALIASES.get(value, value)


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", clean_text(value).casefold()).strip("-")


def _session() -> requests.Session:
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        retry = Retry(total=4, connect=4, read=4, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504))
        session.mount("https://", HTTPAdapter(max_retries=retry, pool_connections=MAX_WORKERS, pool_maxsize=MAX_WORKERS))
        session.headers.update({"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})
        _thread_local.session = session
    return session


def _get(url: str, **kwargs) -> requests.Response:
    response = _session().get(url, timeout=45, **kwargs)
    response.raise_for_status()
    return response


def _post(url: str, data: dict) -> requests.Response:
    response = _session().post(url, data=data, timeout=45)
    response.raise_for_status()
    return response


def select_options(soup: BeautifulSoup, select_id: str) -> list[tuple[str, str]]:
    select = soup.find("select", id=select_id)
    if select is None:
        raise RuntimeError(f"TROLS did not expose #{select_id}")
    return [
        (clean_text(option.get_text(" ", strip=True)), option.get("value", ""))
        for option in select.find_all("option")
        if clean_text(option.get_text(" ", strip=True)) and option.get("value", "")
    ]


def choose_option(soup: BeautifulSoup, select_id: str, wanted: str) -> str:
    options = select_options(soup, select_id)
    for label, value in options:
        if label.casefold() == wanted.casefold():
            return value
    raise RuntimeError(f"Could not find {wanted!r} in #{select_id}")


def discover_current_season(competition_code: str) -> dict:
    """Resolve the active season ID from TROLS instead of assuming a season name.

    The Past Results form exposes a stable "Current Season" option for each
    Saturday/Sunday competition. Its ID changes when TROLS rolls into a new
    season, so every live request below is explicitly tied to that ID.
    """
    if competition_code not in DAYTIME_NAMES:
        raise RuntimeError(f"Unsupported TROLS competition code {competition_code!r}")
    response = _post(PAST_RESULTS_URL, {"which": "0", "style": "", "daytime": competition_code})
    soup = BeautifulSoup(response.text, "html.parser")
    options = select_options(soup, "season")
    current = [(label, value) for label, value in options if label.casefold() in {"current season", "current"}]
    if len(current) != 1:
        raise RuntimeError(
            f"Could not identify exactly one current TROLS season for {DAYTIME_NAMES[competition_code]} "
            f"(found {len(current)} current options)"
        )
    option_label, season_id = current[0]
    season_label = _visible_season_label(soup, season_id, option_label)
    if season_label.casefold() in {"current season", "current"}:
        # The active results page sometimes includes a dated competition name
        # even though the archive selector uses the generic "Current Season".
        live_page = _post(RESULTS_URL, {"which": "0", "style": "", "daytime": competition_code})
        page_label = _visible_season_label(
            BeautifulSoup(live_page.text, "html.parser"), season_id, option_label
        )
        if page_label.casefold() not in {"current season", "current"}:
            season_label = page_label
    return {
        "competition_code": competition_code,
        "competition_name": DAYTIME_NAMES[competition_code],
        "season_id": season_id,
        "season_label": season_label,
        "competition_label": f"{DAYTIME_NAMES[competition_code]} - {season_label}",
    }


def _visible_season_label(soup: BeautifulSoup, season_id: str, placeholder: str) -> str:
    """Use an actual season name when TROLS supplies one; never retain a stale label."""
    select = soup.find("select", id="season")
    if select is not None:
        option = select.find("option", value=season_id)
        if option is not None:
            label = clean_text(option.get_text(" ", strip=True))
            if label.casefold() not in {"current season", "current", ""}:
                return label

    season_pattern = re.compile(r"\b(?:Summer|Autumn|Winter|Spring)\s+\d{4}\b", re.I)
    # TROLS sometimes writes the current season in a heading/data attribute,
    # while leaving the selector's option label as "Current Season".
    candidates = []
    for node in soup.find_all(["title", "h1", "h2", "h3", "strong", "b"]):
        candidates.extend(season_pattern.findall(clean_text(node.get_text(" ", strip=True))))
    for option in soup.select("select option[selected]"):
        candidates.extend(season_pattern.findall(clean_text(option.get_text(" ", strip=True))))
    for node in soup.find_all(attrs={"data-season-label": True}):
        candidates.extend(season_pattern.findall(clean_text(str(node.get("data-season-label", "")))))
    distinct = list(dict.fromkeys(candidates))
    if len(distinct) == 1:
        return distinct[0]
    # The stable value is intentionally preferred over last season's cached
    # text when TROLS exposes no name for its active option.
    return placeholder


def discover_sections(current_season: dict) -> list[dict]:
    """Read section options for one explicitly resolved current season."""
    competition_code = current_season["competition_code"]
    response = _post(PAST_RESULTS_URL, {
        "which": "0", "style": "", "daytime": competition_code,
        "season": current_season["season_id"],
    })
    options = select_options(BeautifulSoup(response.text, "html.parser"), "section")
    wanted = {x.strip() for x in os.getenv("TROLS_SECTIONS", "").split(",") if x.strip()}
    return [
        {**current_season, "section_code": code, "section_label": label}
        for label, code in options if not wanted or code in wanted or label in wanted
    ]


def _match_id(cell) -> str | None:
    anchor = cell.find("a")
    ids = re.findall(r"['\"]([A-Z]{2}\d{6})['\"]", anchor.get("onclick", "") if anchor else "")
    return ids[-1] if ids else None


def _numeric(value: str) -> int | float:
    number = float(clean_text(value))
    return int(number) if number.is_integer() else number


def parse_results_page(html: str, section_code: str = "section") -> tuple[list[dict], str | None]:
    soup = BeautifulSoup(html, "html.parser")
    fixtures, current_date, current_round, current_stage, current_label, loaded = [], "", None, "regular", "", None
    playoff_round, semifinal_events, final_events = 14, 0, 0
    for span in soup.find_all("span"):
        text = clean_text(span.get_text(" ", strip=True))
        if text.startswith("Results Loaded:"):
            loaded = text.removeprefix("Results Loaded:").strip()
            break
    for tr in soup.find_all("tr"):
        cells = tr.find_all("td", recursive=False)
        if len(cells) == 1:
            text = clean_text(cells[0].get_text(" ", strip=True))
            normalized = re.sub(r"[‐‑‒–—]", "-", text).casefold()
            date_match = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{2,4})", text, re.I)
            stage_date = f"{int(date_match.group(1)):02d} {date_match.group(2)[:3].title()} {date_match.group(3)[-2:]}" if date_match else ""
            if re.search(r"\bgrand\s*[- ]?\s*final\b", normalized):
                final_events += 1
                playoff_round += 1
                current_date, current_round, current_stage = stage_date, playoff_round, "grand_final"
                current_label = "Grand final" if final_events == 1 else f"Grand final · TROLS entry {final_events}"
                continue
            if re.search(r"\bsemi\s*[- ]?\s*finals?\b", normalized):
                semifinal_events += 1
                playoff_round += 1
                current_date, current_round, current_stage = stage_date, playoff_round, "semi_final"
                event_number = re.search(r"semi\s*[- ]?\s*final\s*(\d+)", normalized)
                current_label = f"Semi-final {event_number.group(1)}" if event_number else ("Semi-final" if semifinal_events == 1 else f"Semi-final · TROLS entry {semifinal_events}")
                continue
            match = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{2,4}).*?Rd\.?\s*(\d+)", text, re.I)
            if match:
                day, month, year, round_no = match.groups()
                year = year[-2:]
                current_date = f"{int(day):02d} {month[:3].title()} {year}"
                current_round, current_stage = int(round_no), "regular"
                current_label = f"Round {current_round}"
            continue
        if current_round is None or len(cells) < 3:
            continue
        texts = [clean_text(cell.get_text(" ", strip=True)) for cell in cells]
        home, away = clean_team(texts[0]), clean_team(texts[-1])
        if not home or not away or home.casefold().startswith("home team"):
            continue
        match_id = _match_id(cells[0])
        blank_indexes = [i for i, text in enumerate(texts[1:-1], 1) if not text]
        completed = len(cells) >= 9 and bool(blank_indexes)
        if completed:
            middle = blank_indexes[len(blank_indexes) // 2]
            left = [_numeric(value) for value in texts[1:middle] if value]
            right = [_numeric(value) for value in texts[middle + 1:-1] if value]
            if len(left) not in (3, 4) or len(right) != len(left):
                raise RuntimeError(f"Unexpected completed result row: {texts}")
            if not match_id:
                raise RuntimeError("MATCH ID PARSER BROKE: completed TROLS fixture has no official match ID")
            fixture = {
                "fixture_id": match_id, "date": current_date, "round": current_round,
                "stage": current_stage, "round_label": current_label,
                "home_team": home, "away_team": away, "home_points": left[0], "away_points": right[0],
                "home_rubbers": left[1], "away_rubbers": right[1],
                "home_sets": left[2] if len(left) == 4 else "", "away_sets": right[2] if len(right) == 4 else "",
                "home_games": left[-1], "away_games": right[-1], "status": "Completed", "notes": "",
            }
        else:
            status_text = texts[1]
            if home == "Bye" or away == "Bye":
                status = "Bye"
            elif "Wash Out" in status_text:
                status = "Wash Out"
            elif "Forfeit" in status_text:
                status = status_text
            elif "Missing Result" in status_text:
                status = "Missing Result"
            else:
                status = status_text or "Scheduled"
            match_id = match_id or f"pending-{section_code.lower()}-r{current_round}-{slug(home)}-{slug(away)}"
            fixture = {
                "fixture_id": match_id, "date": current_date, "round": current_round,
                "stage": current_stage, "round_label": current_label,
                "home_team": home, "away_team": away, "home_points": "", "away_points": "",
                "home_rubbers": "", "away_rubbers": "", "home_sets": "", "away_sets": "",
                "home_games": "", "away_games": "", "status": status,
                "notes": "No individual scorecard / no rubbers recorded",
            }
        fixtures.append(fixture)
    fixtures.sort(key=lambda row: (int(row["round"]), row["fixture_id"]))
    return fixtures, loaded


def parse_roster(table) -> list[dict]:
    """Read a TROLS roster without losing its emergency marker.

    TROLS renders the emergency flag in the first table cell as a visually
    hidden ``E`` plus a visible ``X``.  It is deliberately separate from the
    player's name, so taking only ``tr.get_text`` used to erase that fact.
    Keeping the original numbered code is essential: the scorecard's ``1``
    and ``1+2`` references refer to those codes, not a reordered list.
    """
    roster = []
    for fallback, tr in enumerate(table.find_all("tr"), 1):
        cells = tr.find_all("td", recursive=False)
        if not cells:
            continue
        raw_name = clean_text(cells[-1].get_text(" ", strip=True))
        if not raw_name:
            continue
        number = re.match(r"(\d+)\.\s*", raw_name)
        marker = cells[0] if len(cells) > 1 else None
        emergency = bool(marker and (marker.find(class_="xsr") or re.search(r"\bX\b", clean_text(marker.get_text(" ", strip=True)), re.I)))
        roster.append({
            "code": int(number.group(1)) if number else fallback,
            "name": clean_name(raw_name),
            "emergency": emergency,
        })
    return roster


def _unnamed_player(fixture_id: str, side: str, code: int, emergency: bool) -> str:
    label = "Unnamed emergency" if emergency else "Unnamed player"
    # The source has not supplied an identity.  Do not turn two unknown people
    # into one fake person or quietly guess from an opponent/partner.
    return f"[{label} — TROLS {fixture_id} {side} code {code}]"


def _is_unnamed_player(name: str) -> bool:
    return str(name).startswith("[Unnamed ")


def _contains_unnamed_identity(value: str) -> bool:
    return any(_is_unnamed_player(part.strip()) for part in str(value).split("/"))


def _contains_source_unknown(value: str) -> bool:
    return _contains_unnamed_identity(value) or "[Unlisted " in str(value)


def pair_from_code(players: list[dict], code: str, fixture_id: str, side: str) -> tuple[str, list[bool]]:
    codes = code.split("+")
    if len(codes) < 2 or len(codes) > 6:
        raise RuntimeError(f"Bad doubles code {code!r} for roster {players}")
    entries = [_player_from_code(players, value, fixture_id, side) for value in codes]
    return " / ".join(entry["name"] for entry in entries), [entry["emergency"] for entry in entries]


def _player_from_code(players: list[dict], code: str, fixture_id: str, side: str) -> dict:
    if not re.fullmatch(r"\d+", code):
        raise RuntimeError(f"Bad singles code {code!r}")
    number = int(code)
    if number < 1 or number > 6:
        raise RuntimeError(f"Bad singles code {code!r}; BRTA roster positions are 1 to 6")
    entry = next((row for row in players if row["code"] == number), None)
    if entry is None:
        # An old TROLS scorecard may reference a roster number whose name was
        # not published. Keep that official rubber visible without inventing a
        # player identity or admitting it to rating calculations.
        return {"code": number, "name": _unnamed_player(fixture_id, side, number, False), "emergency": False}
    name = entry["name"]
    if re.fullmatch(r"No Player\s*\d*", name, re.I):
        name = _unnamed_player(fixture_id, side, number, entry["emergency"])
    return {**entry, "name": name}


def _rubbers_score(raw_score: str, rubbers_format: bool) -> dict | None:
    """Parse a scorecard score without turning a Rubbers match tiebreak into games.

    BRTA Rubbers are best of three short sets.  At one set all the deciding
    score is a first-to-ten match tiebreak, not a 7–6 third set and not ten
    additional games for the ratings model or game totals.
    """
    values = [(int(a), int(b)) for a, b in re.findall(r"(\d+)\s*-\s*(\d+)", raw_score)]
    if not values:
        return None
    normal, match_tiebreak = values, None
    if rubbers_format and len(values) >= 3:
        preceding, candidate = values[:-1], values[-1]
        home_before = sum(a > b for a, b in preceding)
        away_before = sum(b > a for a, b in preceding)
        if home_before == away_before and max(candidate) >= 10 and max(candidate) <= 20 and candidate[0] != candidate[1]:
            normal, match_tiebreak = preceding, candidate
    # A historical team-total row can look like a rubber.  A valid deciding
    # match tiebreak is the sole permitted two-digit score component.
    if any(a > 13 or b > 13 for a, b in normal):
        return None
    if match_tiebreak is None and any(a > 13 or b > 13 for a, b in values):
        return None
    home_games = sum(a for a, _ in normal)
    away_games = sum(b for _, b in normal)
    home_sets = sum(a > b for a, b in normal)
    away_sets = sum(b > a for a, b in normal)
    if match_tiebreak:
        home_sets += int(match_tiebreak[0] > match_tiebreak[1])
        away_sets += int(match_tiebreak[1] > match_tiebreak[0])
    decisive = home_sets != away_sets and all(a != b and max(a, b) >= 5 for a, b in normal)
    score = " ".join(f"{a}-{b}" for a, b in normal)
    if match_tiebreak:
        score += f" [{match_tiebreak[0]}-{match_tiebreak[1]}]"
    return {"score": score, "home_games": home_games, "away_games": away_games,
            "home_sets": home_sets, "away_sets": away_sets, "decisive": decisive}


def parse_scorecard(html: str, fixture: dict) -> tuple[list[dict], list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    root = soup.find("table", attrs={"width": "99%"})
    if root is None:
        raise RuntimeError(f"No scorecard table for {fixture['fixture_id']}")
    outer = (root.find("tbody", recursive=False) or root).find_all("tr", recursive=False)
    if len(outer) < 2:
        raise RuntimeError(f"Malformed scorecard for {fixture['fixture_id']}")
    team_cells = outer[0].find_all("td", recursive=False)
    raw_home_team, raw_away_team = clean_text(team_cells[0].get_text(" ", strip=True)), clean_text(team_cells[-1].get_text(" ", strip=True))
    home_team, away_team = clean_team(raw_home_team), clean_team(raw_away_team)
    if home_team != fixture["home_team"] or away_team != fixture["away_team"]:
        raise RuntimeError(
            f"Team mismatch {fixture['fixture_id']}: scorecard {raw_home_team!r} -> {home_team!r} v "
            f"{raw_away_team!r} -> {away_team!r}; "
            f"results index {fixture['home_team']!r} v {fixture['away_team']!r}"
        )
    nested = outer[1].find_all("table")
    if len(nested) != 3:
        raise RuntimeError(f"Expected three scorecard tables for {fixture['fixture_id']}, found {len(nested)}")
    home_players, away_players = parse_roster(nested[0]), parse_roster(nested[2])
    expected_roster = 2 if fixture.get("home_sets", "") != "" else 4
    for side, roster in (("home", home_players), ("away", away_players)):
        codes = [entry["code"] for entry in roster]
        if len(roster) > 6 or any(code < 1 or code > 6 for code in codes) or len(codes) != len(set(codes)):
            raise RuntimeError(f"Invalid {side} roster for {fixture['fixture_id']}: {roster}")
    # TROLS occasionally omits a roster name altogether. Preserve the rubber,
    # but keep an explicit source-limited identity and exclude it from ratings.
    for side, roster in (("home", home_players), ("away", away_players)):
        used = {entry["code"] for entry in roster}
        for code in range(1, expected_roster + 1):
            if code not in used:
                roster.append({"code": code, "name": _unnamed_player(fixture["fixture_id"], side, code, False), "emergency": False})
    singles, doubles, singles_position, doubles_position = [], [], 0, 0
    for tr in nested[1].find_all("tr"):
        if tr.find("td", class_="separate") is not None:
            continue
        cells = [clean_text(td.get_text(" ", strip=True)) for td in tr.find_all("td")]
        if len(cells) != 3:
            continue
        home_code, raw_score, away_code = cells
        # Some incomplete TROLS rosters leave the numbered code blank (or
        # shorten a doubles code to its listed member). Mirror the opposing
        # positional code only to preserve the official row; the padded
        # participant remains visibly unlisted and is never rated.
        if not home_code and away_code:
            home_code = away_code
        if not away_code and home_code:
            away_code = home_code
        if "+" in away_code and "+" not in home_code:
            home_code = away_code
        if "+" in home_code and "+" not in away_code:
            away_code = home_code
        is_pair = "+" in home_code and "+" in away_code
        is_single = bool(re.fullmatch(r"\d+", home_code or "") and re.fullmatch(r"\d+", away_code or ""))
        if not is_pair and not is_single:
            continue
        score = _rubbers_score(raw_score, str(fixture.get("format", "")).casefold() == "rubbers")
        if not score:
            continue
        home_games, away_games = score["home_games"], score["away_games"]
        home_sets, away_sets, decisive = score["home_sets"], score["away_sets"], score["decisive"]
        base = {
            "fixture_id": fixture["fixture_id"], "date": fixture["date"], "round": fixture["round"],
            "home_team": home_team, "away_team": away_team, "score": score["score"],
            "home_games": home_games, "away_games": away_games, "home_sets": home_sets, "away_sets": away_sets,
            "status": "Completed", "valid_for_rating": str(decisive).lower(),
        }
        if is_pair:
            doubles_position += 1
            hp, he = pair_from_code(home_players, home_code, fixture["fixture_id"], "home")
            ap, ae = pair_from_code(away_players, away_code, fixture["fixture_id"], "away")
            home_pair_codes, away_pair_codes = home_code.split("+"), away_code.split("+")
            standard_pairs = (
                len(home_pair_codes) == len(away_pair_codes) == 2
                and len(set(home_pair_codes)) == len(set(away_pair_codes)) == 2
            )
            base["valid_for_rating"] = str(
                decisive and standard_pairs
                and not _contains_unnamed_identity(hp) and not _contains_unnamed_identity(ap)
            ).lower()
            doubles.append({**base, "position": f"No. {doubles_position}", "home_pair": hp, "away_pair": ap,
                            "winning_pair": hp if home_sets > away_sets else ap if away_sets > home_sets else "",
                            "home_emergencies": json.dumps(he), "away_emergencies": json.dumps(ae)})
        else:
            singles_position += 1
            home_entry = _player_from_code(home_players, home_code, fixture["fixture_id"], "home")
            away_entry = _player_from_code(away_players, away_code, fixture["fixture_id"], "away")
            hp, ap = home_entry["name"], away_entry["name"]
            base["valid_for_rating"] = str(decisive and not _is_unnamed_player(hp) and not _is_unnamed_player(ap)).lower()
            singles.append({**base, "position": f"No. {singles_position}", "home_player": hp, "away_player": ap,
                            "winning_player": hp if home_sets > away_sets else ap if away_sets > home_sets else "",
                            "home_emergency": str(home_entry["emergency"]).lower(),
                            "away_emergency": str(away_entry["emergency"]).lower()})
    return singles, doubles


def parse_draw_page(html: str, section_code: str) -> list[dict]:
    rows = BeautifulSoup(html, "html.parser").find_all("tr")
    header_index = None
    for index, tr in enumerate(rows):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in tr.find_all(["th", "td"], recursive=False)]
        if cells[:4] == ["Rd", "Date", "Home", "Away"]:
            header_index = index
            break
    if header_index is None:
        raise RuntimeError(f"No official fixture table for {section_code}")
    draw = []
    for tr in rows[header_index + 1:]:
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in tr.find_all("td", recursive=False)]
        if len(cells) < 4 or not cells[0].isdigit():
            continue
        round_no, date, home, away = int(cells[0]), cells[1], clean_team(cells[2]), clean_team(cells[3])
        if not home or not away or home == "Bye" or away == "Bye":
            continue
        draw.append({"draw_id": f"draw-{section_code.lower()}-r{round_no}-{slug(home)}-{slug(away)}",
                     "date": date, "round": round_no, "stage": "regular", "round_label": f"Round {round_no}",
                     "home_team": home, "away_team": away, "fixture_id": ""})
    return draw


def _section_results(meta: dict) -> dict:
    response = _post(PAST_RESULTS_URL, {
        "which": "1", "style": "", "daytime": meta["competition_code"],
        "season": meta["season_id"], "section": meta["section_code"],
    })
    fixtures, loaded = parse_results_page(response.text, meta["section_code"])
    return {**meta, "fixtures": fixtures, "results_loaded_by_trols": loaded}


def _scorecard(fixture: dict, season_id: str = "", rubbers_format: bool = False) -> tuple[str, list[dict], list[dict]]:
    response = _get(MATCH_URL, params={"matchid": fixture["fixture_id"], "seasonid": season_id})
    singles, doubles = parse_scorecard(response.text, {**fixture, "format": "rubbers" if rubbers_format else "sets"})
    return fixture["fixture_id"], singles, doubles


def _team_options(meta: dict) -> list[tuple[str, str]]:
    response = _post(FIXTURE_URL, {
        "which": "1", "style": "", "daytime": meta["competition_code"],
        "season": meta["season_id"], "section": meta["section_code"],
    })
    return select_options(BeautifulSoup(response.text, "html.parser"), "team")


def _team_draw(meta: dict, team_code: str) -> list[dict]:
    response = _post(FIXTURE_URL, {"which": "2", "style": "", "daytime": meta["competition_code"],
                                   "season": meta["season_id"], "section": meta["section_code"], "team": team_code})
    return parse_draw_page(response.text, meta["section_code"])


def _integer(value, label: str) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Invalid {label}: {value!r}") from exc


def validate_dataset(
    fixtures: list[dict], singles: list[dict], doubles: list[dict], section_code: str,
    *, green_ball: bool = False, allow_source_discrepancies: bool = False,
) -> list[str]:
    warnings = []

    def source_discrepancy(message: str) -> None:
        if not allow_source_discrepancies:
            raise RuntimeError(message)
        warnings.append(message)

    if not re.fullmatch(r"(?:AA|UA)\d{3}", section_code):
        raise RuntimeError(f"Unexpected section code {section_code!r}")
    official_ids = [row["fixture_id"] for row in fixtures if row["status"] == "Completed"]
    if len(official_ids) != len(set(official_ids)):
        raise RuntimeError(f"Duplicate completed fixture IDs in {section_code}")
    fixture_map = {row["fixture_id"]: row for row in fixtures}
    positions = set()
    for discipline, rows in (("singles", singles), ("doubles", doubles)):
        for row in rows:
            if row["fixture_id"] not in fixture_map:
                raise RuntimeError(f"{section_code}: rubber references unknown fixture")
            key = (discipline, row["fixture_id"], row["position"])
            if key in positions:
                raise RuntimeError(f"Duplicate fixture/position entry: {key}")
            positions.add(key)
            if str(row.get("valid_for_rating", "true")).lower() == "true":
                if _contains_source_unknown(row.get("home_player") or row.get("home_pair") or "") or _contains_source_unknown(row.get("away_player") or row.get("away_pair") or ""):
                    raise RuntimeError(f"Unnamed TROLS participant was incorrectly included in ratings for {key}")
                hs, aws = _integer(row["home_sets"], "home sets"), _integer(row["away_sets"], "away sets")
                winner = row.get("winning_player") or row.get("winning_pair")
                home_entry = row.get("home_player") or row.get("home_pair")
                away_entry = row.get("away_player") or row.get("away_pair")
                expected_winner = home_entry if hs > aws else away_entry if aws > hs else ""
                # Names are not globally unique in TROLS. If both opponents
                # have the same displayed name, the result is still coherent
                # when that shared name is the recorded winner.
                agrees = winner == expected_winner
                if not agrees:
                    source_discrepancy(f"Winner does not agree with score in {key}")
    for fixture in fixtures:
        if fixture["status"] != "Completed":
            continue
        fixture_singles = [row for row in singles if row["fixture_id"] == fixture["fixture_id"]]
        fixture_doubles = [row for row in doubles if row["fixture_id"] == fixture["fixture_id"]]
        rows = fixture_singles + fixture_doubles
        if not rows and any(_integer(fixture[field], field) for field in ("home_rubbers", "away_rubbers", "home_games", "away_games")):
            source_discrepancy(f"No scorecard rubbers for {fixture['fixture_id']}")
        hg = sum(_integer(row["home_games"], "home games") for row in rows)
        ag = sum(_integer(row["away_games"], "away games") for row in rows)
        scoring_rows = fixture_singles if fixture["home_sets"] != "" else rows
        scoring_rows = [row for row in scoring_rows if all(max(int(a), int(b)) >= 5 for a, b in re.findall(r"(\d+)\s*-\s*(\d+)", row["score"]))]
        hr = sum(_integer(row["home_sets"], "home sets") > _integer(row["away_sets"], "away sets") for row in scoring_rows)
        ar = sum(_integer(row["away_sets"], "away sets") > _integer(row["home_sets"], "home sets") for row in scoring_rows)
        if (hg, ag) != (_integer(fixture["home_games"], "fixture home games"), _integer(fixture["away_games"], "fixture away games")):
            source_discrepancy(f"Fixture game totals do not match rubbers for {fixture['fixture_id']}")
        green_ball = green_ball or section_code in {"AA013", "AA014", "UA026", "UA027"}
        complete_standard_card = len(rows) == 6 and all(not _contains_source_unknown(str(row)) for row in rows)
        if fixture["home_sets"] == "" and not green_ball and complete_standard_card and (hr, ar) != (_integer(fixture["home_rubbers"], "fixture home rubbers"), _integer(fixture["away_rubbers"], "fixture away rubbers")):
            source_discrepancy(f"Fixture rubber totals do not match rubbers for {fixture['fixture_id']}")
    return warnings


def attach_draw_ids(draw: list[dict], fixtures: list[dict]) -> list[dict]:
    result_map = {(int(row["round"]), clean_team(row["home_team"]), clean_team(row["away_team"])): row["fixture_id"] for row in fixtures}
    for row in draw:
        row["fixture_id"] = result_map.get((int(row["round"]), row["home_team"], row["away_team"]), "")
        row.setdefault("stage", "regular")
        row.setdefault("round_label", f"Round {int(row['round'])}")
    return draw


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def count_existing(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open(encoding="utf-8") as handle:
        return max(0, sum(1 for _ in handle) - 1)


def current_season_transitions(previous: dict, sections: list[dict]) -> list[dict]:
    """Return outgoing season IDs only when TROLS has advanced the live selector."""
    current = {}
    for section in sections:
        current[section["competition_code"]] = section["season_id"]
    transitions = []
    for code, season_id in current.items():
        prior = previous.get(code, {})
        prior_id = prior.get("season_id") if isinstance(prior, dict) else None
        if prior_id and prior_id != season_id:
            transitions.append({"competition_code": code, "season_id": prior_id})
    return sorted(transitions, key=lambda row: row["competition_code"])


def is_same_saved_season(section: dict, previous_metadata: dict) -> bool:
    """Whether row-count safety checks should compare against saved files.

    Current section IDs can be reused between seasons. Once TROLS changes its
    season ID, the previous season's larger CSV must not block the new season's
    smaller opening round. Older metadata has no season ID, so compare its
    explicit competition label as a migration fallback.
    """
    old_id, current_id = previous_metadata.get("season_id"), section.get("season_id")
    if old_id and current_id:
        return str(old_id) == str(current_id)

    old_label = clean_text(previous_metadata.get("competition_label", ""))
    current_label = clean_text(section.get("competition_label", ""))
    if old_label and current_label:
        return old_label.casefold() == current_label.casefold()
    # Missing metadata is not evidence that the season changed: retain the
    # conservative shrink guard until the prior season can be identified.
    return True


def _load_previous_current_seasons() -> dict:
    path = OUT / "catalog.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    stored = data.get("current_seasons")
    return stored if isinstance(stored, dict) else {}


def scrape_all() -> list[dict]:
    requested = {value.strip() for value in os.getenv("TROLS_COMPETITIONS", "AA,UA").split(",") if value.strip()}
    sections = []
    for code, competition_name in DAYTIME_NAMES.items():
        if code in requested or competition_name in requested:
            current_season = discover_current_season(code)
            print(f"{competition_name}: active TROLS season {current_season['season_label']} ({current_season['season_id']})")
            sections.extend(discover_sections(current_season))
    if not sections:
        raise RuntimeError("No target TROLS sections discovered")
    print(f"Discovered {len(sections)} sections; loading result indexes")
    loaded_sections = []
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(sections))) as pool:
        futures = {pool.submit(_section_results, meta): meta for meta in sections}
        for future in as_completed(futures):
            section = future.result()
            loaded_sections.append(section)
            print(f"  {section['section_code']} {section['section_label']}: {len(section['fixtures'])} result rows")
    loaded_sections.sort(key=lambda row: (row["competition_code"], row["section_code"]))
    fixture_owner, completed = {}, []
    for section in loaded_sections:
        section["singles"], section["doubles"] = [], []
        for fixture in section["fixtures"]:
            if fixture["status"] == "Completed":
                fixture_owner[fixture["fixture_id"]] = section
                completed.append(fixture)
    print(f"Loading {len(completed)} completed scorecards with {MAX_WORKERS} workers")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {
            pool.submit(_scorecard, fixture, fixture_owner[fixture["fixture_id"]]["season_id"], fixture_owner[fixture["fixture_id"]]["section_label"].casefold().startswith("rubbers")): fixture
            for fixture in completed
        }
        done = 0
        for future in as_completed(futures):
            fixture_id, singles, doubles = future.result()
            section = fixture_owner[fixture_id]
            section["singles"].extend(singles)
            section["doubles"].extend(doubles)
            done += 1
            if done % 50 == 0 or done == len(completed):
                print(f"  scorecards {done}/{len(completed)}")
    print("Loading official TROLS draws")
    options_by_code = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_team_options, section): section for section in loaded_sections}
        for future in as_completed(futures):
            section = futures[future]
            options_by_code[section["section_code"]] = future.result()
    draw_jobs = [(section, team_code) for section in loaded_sections for _, team_code in options_by_code[section["section_code"]]]
    draw_by_code = {section["section_code"]: [] for section in loaded_sections}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_team_draw, section, team_code): (section, team_code) for section, team_code in draw_jobs}
        for future in as_completed(futures):
            section, _ = futures[future]
            draw_by_code[section["section_code"]].extend(future.result())
    for section in loaded_sections:
        unique = {(row["round"], row["date"], row["home_team"], row["away_team"]): row for row in draw_by_code[section["section_code"]]}
        section["draw"] = attach_draw_ids(sorted(unique.values(), key=lambda row: (row["round"], row["home_team"])), section["fixtures"])
        section["singles"].sort(key=lambda row: (int(row["round"]), row["fixture_id"], row["position"]))
        section["doubles"].sort(key=lambda row: (int(row["round"]), row["fixture_id"], row["position"]))
        validate_dataset(section["fixtures"], section["singles"], section["doubles"], section["section_code"])
    return loaded_sections


def main() -> None:
    started = time.monotonic()
    previous_seasons = _load_previous_current_seasons()
    sections = scrape_all()
    catalog = []
    for section in sections:
        code = section["section_code"]
        section_dir = OUT / "sections" / code
        old_singles, old_doubles = count_existing(section_dir / "singles.csv"), count_existing(section_dir / "doubles.csv")
        old_metadata = {}
        old_metadata_path = section_dir / "metadata.json"
        if old_metadata_path.exists():
            try:
                old_metadata = json.loads(old_metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                old_metadata = {}
        if is_same_saved_season(section, old_metadata):
            if old_singles and len(section["singles"]) < old_singles:
                raise RuntimeError(f"Dataset shrank. Manual review required: {code} singles {old_singles} -> {len(section['singles'])}")
            if old_doubles and len(section["doubles"]) < old_doubles:
                raise RuntimeError(f"Dataset shrank. Manual review required: {code} doubles {old_doubles} -> {len(section['doubles'])}")
        elif old_singles or old_doubles:
            print(f"{code}: TROLS season changed; starting fresh row counts for {section['season_label']}")
        write_csv(section_dir / "fixtures.csv", section["fixtures"], FIXTURE_FIELDS)
        write_csv(section_dir / "draw.csv", section["draw"], DRAW_FIELDS)
        write_csv(section_dir / "singles.csv", section["singles"], SINGLES_FIELDS)
        write_csv(section_dir / "doubles.csv", section["doubles"], DOUBLES_FIELDS)
        completed = sum(row["status"] == "Completed" for row in section["fixtures"])
        metadata = {
            "competition_code": section["competition_code"], "competition_label": section["competition_label"],
            "season_id": section["season_id"], "season_label": section["season_label"],
            "section_code": code, "section_label": section["section_label"],
            "format": "rubbers" if section["section_label"].casefold().startswith("rubbers") else "sets",
            "green_ball": "green ball" in section["section_label"].casefold(),
            "results_loaded_by_trols": section["results_loaded_by_trols"],
            "fixtures": len(section["fixtures"]), "completed_fixtures": completed, "draw_fixtures": len(section["draw"]),
            "singles_rubbers": len(section["singles"]), "doubles_rubbers": len(section["doubles"]),
            "latest_round": max((int(row["round"]) for row in section["fixtures"]), default=0), "validation": "passed",
        }
        (section_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        catalog.append(metadata)
    synced_at = datetime.now(timezone.utc).isoformat()
    competitions = {
        row["competition_code"]: row["competition_label"]
        for row in catalog
    }
    current_seasons = {
        row["competition_code"]: {
            "competition_label": row["competition_label"], "season_id": row["season_id"],
            "season_label": row["season_label"],
        }
        for row in catalog
    }
    (OUT / "catalog.json").write_text(json.dumps({
        "synced_at_utc": synced_at, "competitions": competitions,
        "current_seasons": current_seasons, "sections": catalog,
    }, indent=2) + "\n", encoding="utf-8")
    status = {
        "source": PAST_RESULTS_URL, "fixture_source": FIXTURE_URL, "synced_at_utc": synced_at,
        "competitions": len(set(row["competition_code"] for row in catalog)), "sections": len(catalog),
        "current_seasons": current_seasons,
        "fixtures": sum(row["fixtures"] for row in catalog), "completed_fixtures": sum(row["completed_fixtures"] for row in catalog),
        "singles_rubbers": sum(row["singles_rubbers"] for row in catalog), "doubles_rubbers": sum(row["doubles_rubbers"] for row in catalog),
        "validation": "passed", "elapsed_seconds": round(time.monotonic() - started, 1),
    }
    (OUT / "sync_status.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    transitions = current_season_transitions(previous_seasons, catalog)
    (OUT / "season_transition.json").write_text(
        json.dumps({"previous_seasons": transitions}, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()
