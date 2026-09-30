"""Fit each archived TROLS season and publish its static site payloads."""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from generate_site_data import build_section

ARCHIVE = Path("data/archive")
RAW_CATALOG = ARCHIVE / "raw_catalog.json"
ARCHIVE_SECTIONS = ARCHIVE / "sections"
SITE_SECTIONS = ARCHIVE / "site" / "sections"
CURRENT_CATALOG = Path("data/current/catalog.json")
CURRENT_SECTIONS = Path("data/site/sections")
SITE_CATALOG = ARCHIVE / "catalog.json"
CLUB_INDEX = ARCHIVE / "clubs.json"
COLOUR_SUFFIX = re.compile(r"\s+(aqua|azure|beige|black|blue|brown|burgundy|charcoal|coral|cream|crimson|cyan|gold|golden|gray|grey|green|indigo|lime|magenta|maroon|navy|orange|pink|purple|red|scarlet|silver|tan|teal|turquoise|violet|white|yellow)\s*$", re.I)


def _season_sort_key(season: dict) -> tuple[int, int, str]:
    label = season.get("season_label", "")
    match = re.search(r"(Spring|Autumn|Winter)\s+(\d{4})", label, re.I)
    if not match:
        return (0, 0, str(season.get("season_id", "")))
    term, year = match.group(1).casefold(), int(match.group(2))
    term_order = {"spring": 3, "autumn": 2, "winter": 1}[term]
    return (year, term_order, str(season.get("season_id", "")))


def _current_seasons() -> list[dict]:
    current = json.loads(CURRENT_CATALOG.read_text(encoding="utf-8"))
    grouped: dict[str, list[dict]] = {}
    for item in current["sections"]:
        code = item["competition_code"]
        grouped.setdefault(code, []).append(item)
    seasons = []
    for code in ("AA", "UA"):
        sections = grouped.get(code, [])
        if not sections:
            continue
        competition = sections[0]["competition_label"].split(" - ", 1)[0]
        label = sections[0]["competition_label"].split(" - ", 1)[1]
        seasons.append({
            "id": f"{code}:current", "competition_code": code,
            "competition_label": competition, "season_id": "current",
            "season_label": label, "season_option_label": label,
            "is_current": True,
            "sections": [{
                **meta,
                "asset_id": meta["section_code"],
                "data_path": f"data/site/sections/{meta['section_code']}.json",
                "source_section_code": meta["section_code"],
                "is_archive": False,
            } for meta in sections],
        })
    return seasons


def build_catalog() -> dict:
    raw = json.loads(RAW_CATALOG.read_text(encoding="utf-8"))
    sections_by_season: dict[tuple[str, str], list[dict]] = {}
    for meta in raw["sections"]:
        key = (meta["competition_code"], meta["season_id"])
        sections_by_season.setdefault(key, []).append(meta)

    archive_seasons = []
    for season in raw["seasons"]:
        if season.get("season_label", "").casefold() in {"current season", "current"}:
            continue
        key = (season["competition_code"], season["season_id"])
        section_rows = sorted(
            sections_by_season.get(key, []),
            key=lambda row: (int(re.search(r"\d+", row["section_label"]).group()) if re.search(r"\d+", row["section_label"]) else 0,
                             row["section_label"].casefold()),
        )
        if not section_rows:
            continue
        competition = "Saturday AM" if season["competition_code"] == "AA" else "Sunday AM"
        same_label_count = sum(
            1 for other in raw["seasons"]
            if other["competition_code"] == season["competition_code"]
            and other["season_label"].casefold() == season["season_label"].casefold()
        )
        option_label = season["season_label"]
        if same_label_count > 1:
            option_label += f" · TROLS {season['season_id']}"
        archive_seasons.append({
            "id": f"{season['competition_code']}:{season['season_id']}",
            "competition_code": season["competition_code"],
            "competition_label": competition,
            "season_id": season["season_id"],
            "season_label": season["season_label"],
            "season_option_label": option_label,
            "is_current": False,
            "sections": [{
                "section_code": meta["section_code"],
                "asset_id": meta["asset_id"],
                "source_section_code": meta["source_section_code"],
                "section_label": meta["section_label"],
                "format": meta["format"],
                "green_ball": meta["green_ball"],
                "is_archive": True,
                "data_path": f"data/archive/site/sections/{meta['asset_id']}.json",
            } for meta in section_rows],
        })

    current = _current_seasons()
    seasons = current + sorted(archive_seasons, key=_season_sort_key, reverse=True)
    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": "Official-as-entered TROLS archive. Ratings use the site's current V3 model.",
        "season_count": len(seasons),
        "section_count": sum(len(row["sections"]) for row in seasons),
        "seasons": seasons,
    }


def write_catalog() -> dict | None:
    if not RAW_CATALOG.exists():
        print("No historical archive is published yet; skipped the History catalogue refresh.")
        return None
    catalog = build_catalog()
    SITE_CATALOG.parent.mkdir(parents=True, exist_ok=True)
    SITE_CATALOG.write_text(json.dumps(catalog, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    write_club_index(catalog)
    return catalog



def _club_name(team: str) -> str:
    name = re.sub(r"\s+", " ", str(team or "")).strip()
    colour = r"aqua|azure|beige|black|blue|brown|burgundy|charcoal|coral|cream|crimson|cyan|gold|golden|gray|grey|green|indigo|lime|magenta|maroon|navy|orange|pink|purple|red|scarlet|silver|tan|teal|turquoise|violet|white|yellow"
    partner = r"ap|gp|gm|gphc|mlc|scot|scotch|xavier|bodley|beech|beec|st\s+kevin'?s?"
    previous = None
    while name and name != previous:
        previous = name
        name = re.sub(r"\s+(?:no\.?\s*)?#?\d+\s*$", "", name, flags=re.I)
        name = re.sub(r"\s+(?:" + colour + r")(?:s\d+)?\s*$", "", name, flags=re.I)
        name = re.sub(r"\s+(?:" + partner + r")#?\s*$", "", name, flags=re.I)
        name = re.sub(r"\s+(?:" + partner + r")\s*#?\d+\s*$", "", name, flags=re.I)
    aliases = {
        "kptc": "Kings Park",
        "kings park tc": "Kings Park",
        "kings park tennis club": "Kings Park",
    }
    return aliases.get(name.casefold(), name).strip()


def _season_order(label: str) -> int:
    match = re.search(r"(Spring|Autumn|Winter)\s+(\d{4})", str(label), re.I)
    if not match:
        return 0
    term = {"winter": 1, "autumn": 2, "spring": 3}[match.group(1).casefold()]
    return int(match.group(2)) * 10 + term


def _fixture_outcome(fixture: dict, side: str, home_club: str, away_club: str) -> str:
    opponent = away_club if side == "home" else home_club
    winner = _club_name(fixture.get("winner", ""))
    if winner:
        return "W" if winner == (home_club if side == "home" else away_club) else "L" if winner == opponent else "D"
    mine = fixture.get(f"{side}Points")
    theirs = fixture.get("awayPoints" if side == "home" else "homePoints")
    if mine is None or theirs is None:
        mine = fixture.get(f"{side}Rubbers")
        theirs = fixture.get("awayRubbers" if side == "home" else "homeRubbers")
    if mine is None or theirs is None:
        return "D"
    return "W" if mine > theirs else "L" if mine < theirs else "D"


def _club_fixture(fixture: dict, section: dict, season: dict, side: str, home_club: str, away_club: str) -> dict:
    other_side = "away" if side == "home" else "home"
    return {
        "fixture_id": fixture.get("fixtureId", ""),
        "season_id": season["season_id"], "season_label": season["season_label"],
        "season_order": _season_order(season["season_label"]),
        "section_code": section["section_code"], "section_label": section["section_label"],
        "team": fixture.get(side, ""), "opponent": fixture.get(other_side, ""),
        "opponent_club": away_club if side == "home" else home_club,
        "date": fixture.get("date", ""), "round": fixture.get("round"),
        "label": fixture.get("label", ""), "stage": fixture.get("stage", "regular"),
        "result": _fixture_outcome(fixture, side, home_club, away_club),
        "points_for": fixture.get(f"{side}Points"), "points_against": fixture.get(f"{other_side}Points"),
        "rubbers_for": fixture.get(f"{side}Rubbers"), "rubbers_against": fixture.get(f"{other_side}Rubbers"),
        "games_for": fixture.get(f"{side}Games"), "games_against": fixture.get(f"{other_side}Games"),
    }


def write_club_index(catalog: dict) -> None:
    competitions: dict[str, dict] = {}
    for season in catalog["seasons"]:
        code = season["competition_code"]
        bucket = competitions.setdefault(code, {
            "label": season["competition_label"], "sections": set(), "clubs": {},
            "fixtures": {}, "players": {},
        })
        for section in season["sections"]:
            bucket["sections"].add(section["section_label"])
            path = Path(section["data_path"])
            if not path.exists():
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            standings = payload.get("standings") or []
            knockout = payload.get("knockout") or {}
            champion = _club_name(knockout.get("champion", ""))
            final = knockout.get("grandFinal") or {}
            finalists = {_club_name(final.get("home", "")), _club_name(final.get("away", ""))}
            semifinalists = set()
            for fixture in knockout.get("semifinalHistory") or knockout.get("semifinals") or []:
                semifinalists.update({_club_name(fixture.get("home", "")), _club_name(fixture.get("away", ""))})
            for index, row in enumerate(standings):
                team = str(row.get("team", "")).strip()
                club = _club_name(team)
                if not club:
                    continue
                entry = {
                    "season_id": season["season_id"], "season_label": season["season_label"],
                    "season_order": _season_order(season["season_label"]),
                    "section_code": section["section_code"], "section_label": section["section_label"],
                    "team": team, "position": row.get("officialPosition") or index + 1,
                    "played": row.get("played", 0), "wins": row.get("officialWins", row.get("wins", 0)),
                    "draws": row.get("draws", 0), "losses": row.get("losses", 0),
                    "rubbers_for": row.get("rubbersFor", 0), "rubbers_against": row.get("rubbersAgainst", 0),
                    "games_for": row.get("gamesFor", 0), "games_against": row.get("gamesAgainst", 0),
                    "points": row.get("points", 0), "percentage": row.get("officialPercentage"),
                    "champion": club == champion and bool(champion),
                    "finalist": club in finalists and bool(finalists - {""}),
                    "semifinalist": club in semifinalists,
                }
                bucket["clubs"].setdefault(club, []).append(entry)
            seen_fixtures: set[str] = set()
            for result_round in payload.get("results") or []:
                for fixture in result_round.get("fixtures") or []:
                    if fixture.get("status") != "Completed":
                        continue
                    fixture_id = str(fixture.get("fixtureId") or f"{section['section_code']}:{fixture.get('round')}:{fixture.get('home')}:{fixture.get('away')}")
                    if fixture_id in seen_fixtures:
                        continue
                    seen_fixtures.add(fixture_id)
                    home_club, away_club = _club_name(fixture.get("home", "")), _club_name(fixture.get("away", ""))
                    for side, club in (("home", home_club), ("away", away_club)):
                        if not club:
                            continue
                        bucket["fixtures"].setdefault(club, []).append(_club_fixture(fixture, section, season, side, home_club, away_club))
                    for rubber in fixture.get("rubbers") or []:
                        if str(rubber.get("type", "")).casefold() != "singles":
                            continue
                        for side, club in (("home", home_club), ("away", away_club)):
                            player = str(rubber.get(side, "")).strip()
                            if not club or not player:
                                continue
                            player_row = bucket["players"].setdefault(club, {}).setdefault(player, {
                                "name": player, "appearances": 0, "wins": 0,
                                "first_order": _season_order(season["season_label"]),
                                "first_season": season["season_label"],
                                "last_order": _season_order(season["season_label"]),
                                "last_season": season["season_label"],
                            })
                            player_row["appearances"] += 1
                            if rubber.get("winner") == player:
                                player_row["wins"] += 1
                            order = _season_order(season["season_label"])
                            if order < player_row["first_order"]:
                                player_row["first_order"], player_row["first_season"] = order, season["season_label"]
                            if order > player_row["last_order"]:
                                player_row["last_order"], player_row["last_season"] = order, season["season_label"]
    manifest = {"generated_at_utc": datetime.now(timezone.utc).isoformat(), "source": "Official-as-entered TROLS archive and current season data.", "competitions": {}}
    for code, bucket in competitions.items():
        clubs = []
        for name, entries in sorted(bucket["clubs"].items()):
            entries = sorted(entries, key=lambda entry: (-entry["season_order"], entry["section_label"], entry["team"]))
            details = {
                "name": name, "entries": entries,
                "fixtures": sorted(bucket["fixtures"].get(name, []), key=lambda item: (-item["season_order"], str(item["date"]), str(item["fixture_id"]))),
                "players": sorted(bucket["players"].get(name, {}).values(), key=lambda item: (-item["appearances"], -item["wins"], item["name"])),
            }
            clubs.append(details)
        detail_path = ARCHIVE / f"clubs-{code}.json"
        detail_path.write_text(json.dumps({"code": code, "label": bucket["label"], "sections": sorted(bucket["sections"]), "clubs": clubs}, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
        manifest["competitions"][code] = {
            "label": bucket["label"], "sections": sorted(bucket["sections"]),
            "path": f"data/archive/clubs-{code}.json",
            "clubs": [{"name": club["name"], "entries": len(club["entries"])} for club in clubs],
        }
    CLUB_INDEX.write_text(json.dumps(manifest, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")



def write_archive_payloads(raw: dict, *, missing_only: bool = False) -> int:
    SITE_SECTIONS.mkdir(parents=True, exist_ok=True)
    count = 0
    for meta in raw["sections"]:
        path = SITE_SECTIONS / f"{meta['asset_id']}.json"
        if missing_only and path.exists():
            continue
        payload = build_section(meta, sections_dir=ARCHIVE_SECTIONS)
        path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
        count += 1
        print(f"Wrote {meta['asset_id']}: {len(payload['results'])} results, {len(payload['singles'])} singles ratings")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description="Build static ratings payloads for TROLS history.")
    parser.add_argument("--catalog-only", action="store_true",
                        help="Refresh the current/past season picker without refitting archived sections.")
    parser.add_argument("--missing-only", action="store_true",
                        help="Build payloads only for newly imported historical sections, then refresh the picker.")
    args = parser.parse_args()
    if args.catalog_only and args.missing_only:
        parser.error("--catalog-only and --missing-only cannot be used together")

    count = 0
    if args.catalog_only:
        catalog = write_catalog()
        if catalog is None:
            return
    else:
        raw = json.loads(RAW_CATALOG.read_text(encoding="utf-8"))
        count = write_archive_payloads(raw, missing_only=args.missing_only)
        catalog = write_catalog()
        if catalog is None:
            return
    print(json.dumps({"generated_sections": count, "seasons": catalog["season_count"], "sections": catalog["section_count"]}, indent=2))


if __name__ == "__main__":
    main()
