import copy
import csv
import unittest
from pathlib import Path
from unittest import mock

from scraper import sync_trols
from scraper.sync_trols import clean_team, is_same_saved_season, parse_draw_page, parse_results_page, parse_scorecard, validate_dataset


ROOT = Path(__file__).resolve().parents[1]


def load_csv(name):
    with (ROOT / "data/current/sections/UA009" / name).open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


class DatasetValidationTests(unittest.TestCase):
    def setUp(self):
        self.fixtures = load_csv("fixtures.csv")
        self.singles = load_csv("singles.csv")
        self.doubles = load_csv("doubles.csv")

    def test_live_season_is_resolved_from_trols_each_run(self):
        response = type("Response", (), {"text": """<h1>Saturday AM - Summer 2027</h1>
          <select id='season'><option value='AA99'>Current Season</option>
          <option value='AA98'>Spring 2026</option></select>"""})()
        with mock.patch.object(sync_trols, "_post", return_value=response) as request:
            season = sync_trols.discover_current_season("AA")
        self.assertEqual(request.call_args_list[0].args[0], sync_trols.PAST_RESULTS_URL)
        self.assertEqual(season, {
            "competition_code": "AA", "competition_name": "Saturday AM",
            "season_id": "AA99", "season_label": "Summer 2027",
            "competition_label": "Saturday AM - Summer 2027",
        })

    def test_live_season_never_reuses_old_label_when_trols_only_says_current(self):
        response = type("Response", (), {"text": """<select id='season'>
          <option value='UA42' selected>Current Season</option><option value='UA41'>Spring 2026</option>
        </select>"""})()
        with mock.patch.object(sync_trols, "_post", return_value=response):
            season = sync_trols.discover_current_season("UA")
        self.assertEqual(season["season_id"], "UA42")
        self.assertEqual(season["season_label"], "Current Season")
        self.assertNotIn("Spring 2026", season["competition_label"])

    def test_live_results_selector_can_supply_the_actual_current_season_name(self):
        archive_response = type("Response", (), {"text": """<select id='season'>
          <option value='UA42'>Current Season</option><option value='UA41'>Spring 2026</option>
        </select>"""})()
        live_response = type("Response", (), {"text": """<select id='daytime'>
          <option value='UA' selected>Sunday AM - Summer 2027</option></select>"""})()
        with mock.patch.object(sync_trols, "_post", side_effect=[archive_response, live_response]) as request:
            season = sync_trols.discover_current_season("UA")
        self.assertEqual(request.call_args_list[1].args[0], sync_trols.RESULTS_URL)
        self.assertEqual(season["season_label"], "Summer 2027")

    def test_current_section_discovery_is_pinned_to_resolved_season(self):
        current = {"competition_code": "UA", "competition_name": "Sunday AM",
                   "season_id": "UA42", "season_label": "Current Season",
                   "competition_label": "Sunday AM - Current Season"}
        response = type("Response", (), {"text": "<select id='section'><option value='UA001'>Sets 1</option></select>"})()
        with mock.patch.object(sync_trols, "_post", return_value=response) as request:
            sections = sync_trols.discover_sections(current)
        self.assertEqual(request.call_args.args[0], sync_trols.PAST_RESULTS_URL)
        self.assertEqual(request.call_args.args[1]["season"], "UA42")
        self.assertEqual(sections, [{**current, "section_code": "UA001", "section_label": "Sets 1"}])

    def test_results_and_fixture_draw_requests_keep_current_season_id(self):
        meta = {"competition_code": "AA", "season_id": "AA99", "section_code": "AA001"}
        response = type("Response", (), {"text": "<select id='team'><option value='T1'>Alpha</option></select>"})()
        with mock.patch.object(sync_trols, "_post", return_value=response) as request:
            result = sync_trols._section_results(meta)
        self.assertEqual(request.call_args.args[0], sync_trols.PAST_RESULTS_URL)
        self.assertEqual(request.call_args.args[1]["season"], "AA99")
        self.assertEqual(result["fixtures"], [])
        with mock.patch.object(sync_trols, "_post", return_value=response) as request:
            sync_trols._team_options(meta)
        self.assertEqual(request.call_args.args[1]["season"], "AA99")
        with mock.patch.object(sync_trols, "_post", return_value=type("Response", (), {"text": ""})()) as request, \
                mock.patch.object(sync_trols, "parse_draw_page", return_value=[]):
            sync_trols._team_draw(meta, "T1")
        self.assertEqual(request.call_args.args[1]["season"], "AA99")

    def test_scorecard_lookup_is_pinned_to_current_season_id(self):
        fixture = {"fixture_id": "AA001001"}
        with mock.patch.object(sync_trols, "_get", return_value=type("Response", (), {"text": ""})()) as request, \
                mock.patch.object(sync_trols, "parse_scorecard", return_value=([], [])):
            sync_trols._scorecard(fixture, "AA99")
        self.assertEqual(request.call_args.args[0], sync_trols.MATCH_URL)
        self.assertEqual(request.call_args.kwargs["params"]["seasonid"], "AA99")

    def test_season_transition_only_marks_the_finished_competition(self):
        previous = {
            "AA": {"season_id": "AA41"},
            "UA": {"season_id": "UA41"},
        }
        sections = [
            {"competition_code": "AA", "season_id": "AA42"},
            {"competition_code": "UA", "season_id": "UA41"},
        ]
        self.assertEqual(sync_trols.current_season_transitions(previous, sections), [
            {"competition_code": "AA", "season_id": "AA41"},
        ])
        self.assertEqual(sync_trols.current_season_transitions({}, sections), [])

    def test_current_dataset_passes_internal_arithmetic_checks(self):
        self.assertEqual(validate_dataset(self.fixtures, self.singles, self.doubles, "UA009"), [])

    def test_archive_keeps_scorecards_with_trols_total_discrepancies_and_reports_them(self):
        fixtures = copy.deepcopy(self.fixtures)
        fixtures[0]["home_games"] = str(int(fixtures[0]["home_games"]) + 1)
        with self.assertRaisesRegex(RuntimeError, "Fixture game totals do not match"):
            validate_dataset(fixtures, self.singles, self.doubles, "UA009")
        warnings = validate_dataset(
            fixtures, self.singles, self.doubles, "UA009", allow_source_discrepancies=True
        )
        self.assertTrue(any("Fixture game totals do not match" in warning for warning in warnings))

    def test_same_display_name_for_both_opponents_is_not_a_false_winner_error(self):
        singles = copy.deepcopy(self.singles)
        row = singles[0]
        row["away_player"] = row["home_player"]
        row["winning_player"] = row["home_player"] if int(row["home_sets"]) > int(row["away_sets"]) else row["away_player"]
        validate_dataset(self.fixtures, singles, self.doubles, "UA009")

    def test_wrong_rubber_score_is_rejected(self):
        bad_singles = copy.deepcopy(self.singles)
        row = next(row for row in bad_singles if int(row["home_games"]) > int(row["away_games"]))
        row["winning_player"] = row["away_player"]
        with self.assertRaisesRegex(RuntimeError, "Winner does not agree"):
            validate_dataset(self.fixtures, bad_singles, self.doubles, "UA009")

    def test_wrong_section_code_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Unexpected section code"):
            validate_dataset(self.fixtures, self.singles, self.doubles, "BAD")

    def test_pending_fixture_without_scorecard_id_gets_non_match_placeholder(self):
        html = """
        <table><tr><td colspan="9">13 Sep 26 · Rd. 9</td></tr>
        <tr><td>Coatesville</td><td>Missing Result</td><td>Lauriston</td></tr></table>
        """
        fixtures, _ = parse_results_page(html, "UA009")
        self.assertEqual(fixtures[0]["fixture_id"], "pending-ua009-r9-coatesville-lauriston")

    def test_team_normalization_removes_source_invisible_marks_before_comparing_scorecards(self):
        self.assertEqual(clean_team("Mentone (DTC)\u200b"), "Mentone")
        self.assertEqual(clean_team("Mentone (DTC) •"), "Mentone")
        self.assertEqual(clean_team("Mentone （DTC）"), "Mentone")
        self.assertEqual(clean_team("Mentone (DTC) (10:00) Playing @ Dingley"), "Mentone")
        self.assertEqual(clean_team("Ormond White 8.00"), "Ormond White")

    def test_new_season_does_not_compare_its_opening_counts_to_last_season(self):
        current = {
            "competition_label": "Sunday AM - Summer 2027",
            "season_id": "UA42",
        }
        previous = {
            "competition_label": "Sunday AM - Spring 2026",
            "season_id": "UA41",
        }
        self.assertFalse(is_same_saved_season(current, previous))
        self.assertTrue(is_same_saved_season(
            {**current, "season_id": "UA41", "competition_label": "Sunday AM - Spring 2026"},
            previous,
        ))

    def test_legacy_metadata_uses_competition_label_for_season_comparison(self):
        self.assertFalse(is_same_saved_season(
            {"competition_label": "Sunday AM - Summer 2027", "season_id": "UA42"},
            {"competition_label": "Sunday AM - Spring 2026"},
        ))

    def test_rubbers_result_keeps_points_rubbers_sets_and_games(self):
        html = """
        <table><tr><td colspan="11">13 Sep 26 Rd. 9</td></tr>
        <tr><td><a onclick="open_match(event,'','UA001091')">Alpha</a></td>
        <td>7.0</td><td>3</td><td>5</td><td>32</td><td></td>
        <td>0.0</td><td>0</td><td>0</td><td>15</td><td>Beta</td></tr></table>
        """
        fixtures, _ = parse_results_page(html, "UA001")
        self.assertEqual((fixtures[0]["home_points"], fixtures[0]["home_rubbers"], fixtures[0]["home_sets"], fixtures[0]["home_games"]), (7, 3, 5, 32))

    def test_official_draw_parser_preserves_published_order(self):
        html = """<table><tr><th>Rd</th><th>Date</th><th>Home</th><th>Away</th></tr>
        <tr><td>10</td><td>11 Oct 26</td><td>Kings Park (10:00)</td><td>Kooyong</td></tr></table>"""
        draw = parse_draw_page(html, "UA009")
        self.assertEqual((draw[0]["round"], draw[0]["home_team"], draw[0]["away_team"]), (10, "Kings Park", "Kooyong"))

    def test_scorecard_preserves_named_emergency_marker(self):
        html = """
        <table width="99%"><tr><td><b>Home</b></td><td></td><td><b>Away</b></td></tr><tr><td>
        <table><tr><td>&nbsp;</td><td>1. Alice Regular</td></tr><tr><td>&nbsp;</td><td>2. Bob Regular</td></tr><tr><td>&nbsp;</td><td>3. Cara Regular</td></tr><tr><td>&nbsp;</td><td>4. Dan Regular</td></tr></table>
        </td><td><table><tr><td>1</td><td>6-3</td><td>1</td></tr><tr><td>2</td><td>6-1</td><td>2</td></tr><tr><td>3</td><td>6-2</td><td>3</td></tr><tr><td>4</td><td>6-4</td><td>4</td></tr><tr><td>1+2</td><td>6-4</td><td>1+2</td></tr><tr><td>3+4</td><td>6-2</td><td>3+4</td></tr></table></td><td>
        <table><tr><td>&nbsp;</td><td>1. Eve Regular</td></tr><tr><td>&nbsp;</td><td>2. Finn Regular</td></tr><tr><td>&nbsp;</td><td>3. Gail Regular</td></tr><tr><td valign="top"><span class="xsr">E</span>&nbsp;</td><td>4. Holly Emergency</td></tr></table>
        </td></tr></table>
        """
        fixture = {"fixture_id":"UA999001", "date":"1 Jul 26", "round":1, "home_team":"Home", "away_team":"Away", "home_sets":""}
        singles, doubles = parse_scorecard(html, fixture)
        self.assertEqual(singles[3]["away_player"], "Holly Emergency")
        self.assertEqual(singles[3]["away_emergency"], "true")
        self.assertEqual(doubles[1]["away_emergencies"], "[false, true]")

    def test_scorecard_keeps_larger_historical_rosters_and_marks_substitution_doubles_unrated(self):
        html = """
        <table width="99%"><tr><td><b>Home</b></td><td></td><td><b>Away</b></td></tr><tr><td>
        <table><tr><td>&nbsp;</td><td>1. Alice</td></tr><tr><td>&nbsp;</td><td>2. Bob</td></tr><tr><td>&nbsp;</td><td>3. Cara</td></tr><tr><td>&nbsp;</td><td>4. Dan</td></tr><tr><td>&nbsp;</td><td>5. Eve</td></tr></table>
        </td><td><table><tr><td>1</td><td>6-2</td><td>1</td></tr><tr><td>1+2+3</td><td>6-4</td><td>1+2</td></tr></table></td><td>
        <table><tr><td>&nbsp;</td><td>1. Finn</td></tr><tr><td>&nbsp;</td><td>2. Gail</td></tr><tr><td>&nbsp;</td><td>3. Holly</td></tr><tr><td>&nbsp;</td><td>4. Ian</td></tr><tr><td>&nbsp;</td><td>5. Jane</td></tr><tr><td>&nbsp;</td><td>6. Kyle</td></tr></table>
        </td></tr></table>
        """
        fixture = {"fixture_id":"UA999002", "date":"1 Jul 26", "round":1, "home_team":"Home", "away_team":"Away", "home_sets":""}
        singles, doubles = parse_scorecard(html, fixture)
        self.assertEqual(singles[0]["home_player"], "Alice")
        self.assertEqual(doubles[0]["home_pair"], "Alice / Bob / Cara")
        self.assertEqual(doubles[0]["valid_for_rating"], "false")

    def test_scorecard_keeps_unknown_emergency_out_of_ratings(self):
        html = """
        <table width="99%"><tr><td><b>Home</b></td><td></td><td><b>Away</b></td></tr><tr><td>
        <table><tr><td valign="top"><span class="xsr">E</span>X</td><td>1. No Player 1</td></tr><tr><td>&nbsp;</td><td>2. Bob</td></tr><tr><td>&nbsp;</td><td>3. Cara</td></tr><tr><td>&nbsp;</td><td>4. Dan</td></tr></table>
        </td><td><table><tr><td>1</td><td>0-6</td><td>1</td></tr></table></td><td>
        <table><tr><td>&nbsp;</td><td>1. Eve</td></tr><tr><td>&nbsp;</td><td>2. Finn</td></tr><tr><td>&nbsp;</td><td>3. Gail</td></tr><tr><td>&nbsp;</td><td>4. Holly</td></tr></table>
        </td></tr></table>
        """
        fixture = {"fixture_id":"AA999001", "date":"1 Jul 26", "round":1, "home_team":"Home", "away_team":"Away", "home_sets":""}
        singles, _ = parse_scorecard(html, fixture)
        self.assertIn("Unnamed emergency", singles[0]["home_player"])
        self.assertIn("AA999001", singles[0]["home_player"])
        self.assertEqual((singles[0]["home_emergency"], singles[0]["valid_for_rating"]), ("true", "false"))

    def test_rubbers_match_tiebreak_is_not_parsed_as_a_third_set_or_ten_games(self):
        parsed = sync_trols._rubbers_score("6-4 4-6 10-8", True)
        self.assertEqual(parsed["score"], "6-4 4-6 [10-8]")
        self.assertEqual((parsed["home_games"], parsed["away_games"]), (10, 10))
        self.assertEqual((parsed["home_sets"], parsed["away_sets"]), (2, 1))
        self.assertTrue(parsed["decisive"])


if __name__ == "__main__":
    unittest.main()
