import csv
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import pandas as pd

import generate_archive_site_data as archive_generator
from generate_site_data import apply_official_standings, brta_scoring_rules, build_section, knockout_summary
from scraper import backfill_history as history_importer
from scraper.backfill_history import ARCHIVE_RESULTS_URL, discover_seasons, merge_archive_catalog, parse_official_ladder
from scraper.sync_trols import parse_results_page, parse_scorecard, validate_dataset


class HistoryArchiveTests(unittest.TestCase):
    def test_archive_seasons_are_discovered_from_trols_past_results_page(self):
        response = type("Response", (), {"text": """<select id='season'>
          <option value='UA39'>Current Season</option><option value='UA5'>Spring 2009</option>
        </select>"""})()
        with patch("scraper.backfill_history.sync._post", return_value=response) as request:
            seasons = discover_seasons("UA")
        self.assertEqual(request.call_args.args[0], ARCHIVE_RESULTS_URL)
        self.assertEqual(request.call_args.args[1]["daytime"], "UA")
        self.assertEqual(seasons, [{"competition_code": "UA", "season_id": "UA5", "season_label": "Spring 2009"}])

    def test_history_catalog_keeps_current_season_and_duplicate_trols_ids(self):
        raw = {
            "seasons": [
                {"competition_code": "AA", "season_id": "AA42", "season_label": "Autumn 2018"},
                {"competition_code": "AA", "season_id": "AA43", "season_label": "Autumn 2018"},
                {"competition_code": "UA", "season_id": "UA5", "season_label": "Spring 2009"},
            ],
            "sections": [
                {"asset_id": "AA42-AA001", "section_code": "AA42-AA001", "source_section_code": "AA001",
                 "competition_code": "AA", "season_id": "AA42", "season_label": "Autumn 2018",
                 "section_label": "Sets 1", "format": "sets", "green_ball": False},
                {"asset_id": "AA43-AA001", "section_code": "AA43-AA001", "source_section_code": "AA001",
                 "competition_code": "AA", "season_id": "AA43", "season_label": "Autumn 2018",
                 "section_label": "Sets 1", "format": "sets", "green_ball": False},
                {"asset_id": "UA5-UA001", "section_code": "UA5-UA001", "source_section_code": "UA001",
                 "competition_code": "UA", "season_id": "UA5", "season_label": "Spring 2009",
                 "section_label": "Rubbers 1", "format": "rubbers", "green_ball": False},
            ],
        }
        current = {"sections": [
            {"competition_code": "AA", "competition_label": "Saturday AM - Spring 2026",
             "section_code": "AA001", "section_label": "Sets 1", "format": "sets"},
            {"competition_code": "UA", "competition_label": "Sunday AM - Spring 2026",
             "section_code": "UA001", "section_label": "Sets 1", "format": "sets"},
        ]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw_path, current_path = root / "raw.json", root / "current.json"
            raw_path.write_text(json.dumps(raw))
            current_path.write_text(json.dumps(current))
            with patch.object(archive_generator, "RAW_CATALOG", raw_path), \
                    patch.object(archive_generator, "CURRENT_CATALOG", current_path):
                catalog = archive_generator.build_catalog()
        current_ids = [season["id"] for season in catalog["seasons"] if season["is_current"]]
        self.assertEqual(current_ids, ["AA:current", "UA:current"])
        duplicate_rows = [x for x in catalog["seasons"] if x["season_label"] == "Autumn 2018"]
        self.assertEqual({x["id"] for x in duplicate_rows}, {"AA:AA42", "AA:AA43"})
        self.assertIn("AA42", {x["season_option_label"].split()[-1] for x in duplicate_rows})
        paths = {row["sections"][0]["data_path"] for row in duplicate_rows}
        self.assertEqual(paths, {
            "data/archive/site/sections/AA42-AA001.json",
            "data/archive/site/sections/AA43-AA001.json",
        })

    def test_current_history_entry_follows_the_live_season_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw_path, current_path = root / "raw.json", root / "current.json"
            raw_path.write_text(json.dumps({"seasons": [], "sections": []}))
            current_path.write_text(json.dumps({"sections": [
                {"competition_code": "UA", "competition_label": "Sunday AM - Summer 2027",
                 "section_code": "UA001", "section_label": "Sets 1", "format": "sets"},
            ]}))
            with patch.object(archive_generator, "RAW_CATALOG", raw_path), \
                    patch.object(archive_generator, "CURRENT_CATALOG", current_path):
                season = archive_generator.build_catalog()["seasons"][0]
        self.assertTrue(season["is_current"])
        self.assertEqual(season["season_label"], "Summer 2027")

    def test_rollover_import_requests_only_the_outgoing_season(self):
        available = {
            "AA": [
                {"competition_code": "AA", "season_id": "AA41", "season_label": "Spring 2026"},
                {"competition_code": "AA", "season_id": "AA40", "season_label": "Winter 2026"},
            ],
        }
        calls = []
        def fake_fetch(meta):
            return {**meta, "asset_id": history_importer._asset_id(meta), "fixtures": [], "singles": []}
        with patch.object(history_importer, "discover_seasons", side_effect=lambda code: calls.append(code) or available[code]) as discover, \
                patch.object(history_importer, "discover_season_sections", return_value=[
                    {"source_section_code": "AA001", "section_label": "Sets 1"}
                ]) as sections, \
                patch.object(history_importer, "_fetch_section", side_effect=fake_fetch):
            loaded, seasons = history_importer._load_all_sections([
                {"competition_code": "AA", "season_id": "AA41"}
            ])
        self.assertEqual(calls, ["AA"])
        self.assertEqual([row["season_id"] for row in seasons], ["AA41"])
        self.assertEqual([row["season_id"] for row in loaded], ["AA41"])
        self.assertEqual(sections.call_args.args, ("AA", "AA41"))

    def test_rollover_merge_preserves_existing_archived_seasons(self):
        existing = {
            "seasons": [{"competition_code": "UA", "season_id": "UA41", "season_label": "Spring 2026"}],
            "sections": [{"asset_id": "UA41-UA001", "competition_code": "UA", "season_id": "UA41",
                          "season_label": "Spring 2026", "section_label": "Sets 1", "fixtures": 14}],
        }
        merged = merge_archive_catalog(
            existing,
            [{"competition_code": "UA", "season_id": "UA42", "season_label": "Summer 2027"}],
            [{"asset_id": "UA42-UA001", "competition_code": "UA", "season_id": "UA42",
              "season_label": "Summer 2027", "section_label": "Sets 1", "fixtures": 2}],
        )
        self.assertEqual({row["season_id"] for row in merged["seasons"]}, {"UA41", "UA42"})
        self.assertEqual({row["asset_id"] for row in merged["sections"]}, {"UA41-UA001", "UA42-UA001"})

    def test_missing_only_generator_does_not_refit_existing_archive_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            site_sections = Path(tmp) / "site" / "sections"
            site_sections.mkdir(parents=True)
            (site_sections / "old.json").write_text("{}")
            raw = {"sections": [{"asset_id": "old"}, {"asset_id": "new"}]}
            with patch.object(archive_generator, "SITE_SECTIONS", site_sections), \
                    patch.object(archive_generator, "ARCHIVE_SECTIONS", Path(tmp) / "raw"), \
                    patch.object(archive_generator, "build_section", return_value={"results": [], "singles": []}) as fit:
                count = archive_generator.write_archive_payloads(raw, missing_only=True)
        self.assertEqual(count, 1)
        self.assertEqual(fit.call_args.args[0]["asset_id"], "new")

    def test_official_ladder_preserves_trols_order_points_and_percentage(self):
        html = """<table><tr><td>1</td><td>Won</td><td>Pts</td><td>%</td><td></td></tr>
        <tr><td>Kooyong</td><td>11</td><td>104.5</td><td>152.42</td><td>P</td></tr>
        <tr><td>BLTC</td><td>9</td><td>91</td><td>120.00</td><td></td></tr></table>"""
        rows = parse_official_ladder(html)
        self.assertEqual([row["team"] for row in rows], ["Kooyong", "BLTC"])
        self.assertEqual([row["position"] for row in rows], [1, 2])
        self.assertEqual(rows[0]["points"], 104.5)
        self.assertEqual(rows[0]["percentage"], 152.42)

    def test_historical_results_keep_semifinal_and_grand_final_stage(self):
        html = """<table>
        <tr><td colspan="11">13 Sep 09 · Rd. 14</td></tr>
        <tr><td><a onclick="open_match(event,'UA5','UA037301')">Alpha</a></td><td>10</td><td>4</td><td>3</td><td>35</td><td></td><td>4</td><td>2</td><td>3</td><td>29</td><td>Beta</td></tr>
        <tr><td colspan="11">Semi Final</td></tr>
        <tr><td><a onclick="open_match(event,'UA5','UA037302')">Alpha</a></td><td>10</td><td>4</td><td>3</td><td>35</td><td></td><td>4</td><td>2</td><td>3</td><td>29</td><td>Gamma</td></tr>
        <tr><td colspan="11">Grand Final</td></tr>
        <tr><td><a onclick="open_match(event,'UA5','UA037321')">Alpha</a></td><td>10</td><td>4</td><td>3</td><td>35</td><td></td><td>4</td><td>2</td><td>3</td><td>29</td><td>Delta</td></tr>
        </table>"""
        fixtures, _ = parse_results_page(html, "UA037")
        self.assertEqual([(row["stage"], row["round_label"], row["round"]) for row in fixtures], [
            ("regular", "Round 14", 14),
            ("semi_final", "Semi-final", 15),
            ("grand_final", "Grand final", 16),
        ])
        self.assertEqual(fixtures[1]["date"], "")

    def test_repeated_grand_final_header_preserves_washout_and_official_date(self):
        html = """<table>
        <tr><td colspan="11">Grand Final</td></tr>
        <tr><td>Alpha</td><td>Wash Out</td><td>Beta</td></tr>
        <tr><td colspan="11">20 Sep 09 · Grand Final</td></tr>
        <tr><td><a onclick="open_match(event,'UA5','UA037322')">Alpha</a></td><td>10</td><td>4</td><td>3</td><td>35</td><td></td><td>4</td><td>2</td><td>3</td><td>29</td><td>Beta</td></tr>
        </table>"""
        fixtures, _ = parse_results_page(html, "UA037")
        self.assertEqual([row["round"] for row in fixtures], [15, 16])
        self.assertEqual([row["status"] for row in fixtures], ["Wash Out", "Completed"])
        self.assertEqual([row["date"] for row in fixtures], ["", "20 Sep 09"])
        self.assertEqual(fixtures[1]["round_label"], "Grand final · TROLS entry 2")

    def test_aggregate_set_total_is_not_counted_as_a_player_rubber(self):
        html = """<table width="99%"><tr><td>Alpha</td><td></td><td>Beta</td></tr><tr><td>
        <table><tr><td>&nbsp;</td><td>1. A One</td></tr><tr><td>&nbsp;</td><td>2. A Two</td></tr>
        <tr><td>&nbsp;</td><td>3. A Three</td></tr><tr><td>&nbsp;</td><td>4. A Four</td></tr></table></td><td>
        <table><tr><td>1</td><td>6-2</td><td>1</td></tr><tr><td>2</td><td>6-3</td><td>2</td></tr>
        <tr><td>3</td><td>6-4</td><td>3</td></tr><tr><td>4</td><td>6-1</td><td>4</td></tr>
        <tr><td>1+2</td><td>6-4</td><td>1+2</td></tr><tr><td>3+4</td><td>6-2</td><td>3+4</td></tr>
        <tr><td>4</td><td>36-16</td><td>2</td></tr></table></td><td>
        <table><tr><td>&nbsp;</td><td>1. B One</td></tr><tr><td>&nbsp;</td><td>2. B Two</td></tr>
        <tr><td>&nbsp;</td><td>3. B Three</td></tr><tr><td>&nbsp;</td><td>4. B Four</td></tr></table></td></tr></table>"""
        fixture = {"fixture_id": "UA037301", "date": "13 Sep 09", "round": 14,
                   "home_team": "Alpha", "away_team": "Beta", "home_sets": ""}
        singles, doubles = parse_scorecard(html, fixture)
        self.assertEqual((len(singles), len(doubles)), (4, 2))
        source_fixture = {"fixture_id": fixture["fixture_id"], "round": 14, "date": fixture["date"],
                          "home_team": "Alpha", "away_team": "Beta", "home_points": 10,
                          "away_points": 0, "home_rubbers": 6, "away_rubbers": 0,
                          "home_sets": "", "away_sets": "", "home_games": 36, "away_games": 16,
                          "status": "Completed"}
        validate_dataset([source_fixture], singles, doubles, "UA037")

    def test_trols_ladder_is_used_for_historical_final_order_and_points(self):
        rows = [{"team": "Kooyong", "played": 18, "wins": 12, "draws": 0, "losses": 6,
                 "rubbersFor": 70, "rubbersAgainst": 38, "gamesFor": 500, "gamesAgainst": 400, "points": 99},
                {"team": "BLTC", "played": 18, "wins": 10, "draws": 0, "losses": 8,
                 "rubbersFor": 61, "rubbersAgainst": 47, "gamesFor": 450, "gamesAgainst": 430, "points": 90}]
        official = [{"team": "BLTC", "position": 1, "wins": 11, "points": 105, "percentage": 156.84, "marker": "P"},
                    {"team": "Kooyong", "position": 2, "wins": 9, "points": 86, "percentage": 115.03, "marker": "R"}]
        final = apply_official_standings(rows, official)
        self.assertEqual([row["team"] for row in final], ["BLTC", "Kooyong"])
        self.assertEqual((final[0]["points"], final[0]["officialWins"], final[0]["officialPercentage"]), (105, 11, 156.84))

    def test_round_fourteen_projects_one_v_four_and_two_v_three(self):
        fixtures = pd.DataFrame([{"fixture_id": f"r{i}", "round": i, "stage": "regular", "date": "1 Sep 09",
                                  "home_team": "A", "away_team": "B", "status": "Completed",
                                  "home_points": 8, "away_points": 4, "home_rubbers": 4, "away_rubbers": 2,
                                  "home_sets": 4, "away_sets": 2, "home_games": 30, "away_games": 20}
                                 for i in range(1, 15)])
        standings = [{"team": name} for name in ("A", "B", "C", "D", "E")]
        result = knockout_summary(fixtures, standings, brta_scoring_rules({"format": "sets"}), {})
        self.assertEqual(result["source"], "projected")
        self.assertEqual([(x["home"], x["away"]) for x in result["semifinals"]], [("A", "D"), ("B", "C")])

    def test_official_playoff_history_keeps_a_washout_and_later_final(self):
        regular = [{"fixture_id": f"r{i}", "round": i, "stage": "regular", "date": "1 Sep 09",
                    "home_team": "A", "away_team": "B", "status": "Completed",
                    "home_points": 8, "away_points": 4, "home_rubbers": 4, "away_rubbers": 2,
                    "home_sets": 4, "away_sets": 2, "home_games": 30, "away_games": 20}
                   for i in range(1, 15)]
        semi1 = {"fixture_id": "semi1", "round": 15, "stage": "semi_final", "round_label": "Semi-final 1",
                 "date": None, "home_team": "A", "away_team": "D", "status": "Completed",
                 "home_points": 10, "away_points": 4, "home_rubbers": 4, "away_rubbers": 2,
                 "home_sets": 4, "away_sets": 2, "home_games": 35, "away_games": 29}
        semi2 = {**semi1, "fixture_id": "semi2", "home_team": "B", "away_team": "C"}
        washout = {**semi1, "fixture_id": "final-washout", "round": 16, "stage": "grand_final",
                   "round_label": "Grand final", "home_team": "A", "away_team": "B", "status": "Wash Out",
                   "home_points": None, "away_points": None, "home_rubbers": None, "away_rubbers": None,
                   "home_sets": None, "away_sets": None, "home_games": None, "away_games": None}
        final = {**semi1, "fixture_id": "final-played", "round": 17, "stage": "grand_final",
                 "round_label": "Grand final · TROLS entry 2", "date": "20 Sep 09",
                 "home_team": "A", "away_team": "B"}
        result = knockout_summary(pd.DataFrame(regular + [semi1, semi2, washout, final]),
                                  [{"team": name} for name in "ABCDE"],
                                  brta_scoring_rules({"format": "sets"}), {})
        self.assertEqual(result["semifinalSource"], "TROLS")
        self.assertEqual(result["grandFinalSource"], "TROLS")
        self.assertEqual([row["date"] for row in result["grandFinalHistory"]], ["", "20 Sep 09"])
        self.assertEqual((result["champion"], result["runnerUp"]), ("A", "B"))

    def test_archived_payload_uses_the_official_ladder_and_keeps_playoff_fixtures(self):
        from scraper.sync_trols import DOUBLES_FIELDS, DRAW_FIELDS, FIXTURE_FIELDS, SINGLES_FIELDS

        fixtures = []
        draw = []
        for round_number in range(1, 15):
            fixture = {"fixture_id": f"regular-{round_number}", "date": "1 Sep 09", "round": round_number,
                       "stage": "regular", "round_label": f"Round {round_number}", "home_team": "A",
                       "away_team": "B", "home_points": 8, "away_points": 4, "home_rubbers": 4,
                       "away_rubbers": 2, "home_sets": 4, "away_sets": 2, "home_games": 30,
                       "away_games": 20, "status": "Completed", "notes": ""}
            fixtures.append(fixture)
            draw.append({"draw_id": fixture["fixture_id"], "date": fixture["date"], "round": round_number,
                         "stage": "regular", "round_label": fixture["round_label"], "home_team": "A",
                         "away_team": "B", "fixture_id": fixture["fixture_id"]})
        for match in (
            {"fixture_id": "semi-1", "round": 15, "stage": "semi_final", "round_label": "Semi-final 1",
             "home_team": "A", "away_team": "D", "status": "Completed", "home_points": 10,
             "away_points": 4, "home_rubbers": 4, "away_rubbers": 2, "home_sets": 4,
             "away_sets": 2, "home_games": 35, "away_games": 29},
            {"fixture_id": "semi-2", "round": 15, "stage": "semi_final", "round_label": "Semi-final 2",
             "home_team": "B", "away_team": "C", "status": "Completed", "home_points": 10,
             "away_points": 4, "home_rubbers": 4, "away_rubbers": 2, "home_sets": 4,
             "away_sets": 2, "home_games": 35, "away_games": 29},
            {"fixture_id": "final-washout", "round": 16, "stage": "grand_final", "round_label": "Grand final",
             "home_team": "A", "away_team": "B", "status": "Wash Out", "home_points": "",
             "away_points": "", "home_rubbers": "", "away_rubbers": "", "home_sets": "",
             "away_sets": "", "home_games": "", "away_games": ""},
            {"fixture_id": "final-played", "round": 17, "stage": "grand_final",
             "round_label": "Grand final · TROLS entry 2", "date": "20 Sep 09",
             "home_team": "A", "away_team": "B", "status": "Completed", "home_points": 10,
             "away_points": 4, "home_rubbers": 4, "away_rubbers": 2, "home_sets": 4,
             "away_sets": 2, "home_games": 35, "away_games": 29},
        ):
            fixtures.append({"date": "" if "date" not in match else match["date"], "notes": "", **match})

        meta = {"competition_code": "UA", "competition_label": "Sunday AM - Spring 2009",
                "season_id": "UA5", "season_label": "Spring 2009", "section_code": "UA5-UA037",
                "source_section_code": "UA037", "section_label": "Sets 1", "format": "sets",
                "green_ball": False, "is_archive": True, "regular_season_rounds": 14,
                "latest_round": 17, "official_standings": [
                    {"team": "A", "position": 1, "wins": 14, "points": 105, "percentage": 156.84, "marker": "P"},
                    {"team": "B", "position": 2, "wins": 12, "points": 86, "percentage": 115.03, "marker": "R"},
                    {"team": "C", "position": 3, "wins": 10, "points": 81, "percentage": 97.24, "marker": ""},
                    {"team": "D", "position": 4, "wins": 9, "points": 80, "percentage": 118.69, "marker": ""},
                ]}
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / meta["section_code"]
            folder.mkdir()
            for name, rows, fields in (("fixtures.csv", fixtures, FIXTURE_FIELDS),
                                       ("draw.csv", draw, DRAW_FIELDS),
                                       ("singles.csv", [], SINGLES_FIELDS),
                                       ("doubles.csv", [], DOUBLES_FIELDS)):
                with (folder / name).open("w", encoding="utf-8", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=fields)
                    writer.writeheader()
                    writer.writerows(rows)
            payload = build_section(meta, sections_dir=Path(tmp))
        self.assertEqual(payload["standings"][0]["team"], "A")
        self.assertEqual(payload["standings"][0]["points"], 105)
        self.assertEqual(payload["knockout"]["champion"], "A")
        self.assertEqual([row["status"] for row in payload["knockout"]["grandFinalHistory"]], ["Wash Out", "Completed"])
        final_rounds = [row for row in payload["upcomingFixtures"] if row["stage"] == "grand_final"]
        self.assertEqual([row["round"] for row in final_rounds], [16, 17])


if __name__ == "__main__":
    unittest.main()
