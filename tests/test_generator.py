import unittest

import pandas as pd

from generate_site_data import (_short_set_win_probability, brta_scoring_rules, fixture_points, matchup_matrix,
                                 reconstructed_standings, results_expectation, round_rating_history,
                                 strength_of_schedule, team_order_evidence, team_rows)


class TeamPowerTests(unittest.TestCase):
    def test_team_power_uses_all_modelled_players_not_display_cutoff(self):
        players = [
            {"team": "Alpha", "rating": 1600, "matches": 6},
            {"team": "Alpha", "rating": 1400, "matches": 1},
        ]
        fixtures = pd.DataFrame([{"home_team": "Alpha", "away_team": "Beta", "status": "Missing Result", "home_rubbers": "", "away_rubbers": "", "home_games": "", "away_games": ""}])
        rows = team_rows(players, fixtures, brta_scoring_rules({"format": "sets"}))
        alpha = next(row for row in rows if row["team"] == "Alpha")
        self.assertEqual(alpha["avg"], 1500.0)
        self.assertEqual(alpha["modelled"], 2)


class BrtaStandingsTests(unittest.TestCase):
    def test_washout_points_follow_the_format_not_the_section_score_mode(self):
        rubbers = brta_scoring_rules({"format": "rubbers"})
        sets = brta_scoring_rules({"format": "sets"})
        row = pd.Series({"status": "Wash Out", "home_points": "", "away_points": ""})
        self.assertEqual(fixture_points(row, rubbers), (3.5, 3.5))
        self.assertEqual(fixture_points(row, sets), (5.0, 5.0))

    def test_forfeit_awards_all_set_points_and_no_percentage(self):
        fixtures = pd.DataFrame([
            {"home_team": "Home", "away_team": "Away", "status": "Forfeited To", "home_points": "", "away_points": "",
             "home_rubbers": "", "away_rubbers": "", "home_sets": "", "away_sets": "", "home_games": "", "away_games": ""},
        ])
        rows = reconstructed_standings(fixtures, brta_scoring_rules({"format": "sets"}))
        home, away = rows[1], rows[0]
        self.assertEqual((home["points"], away["points"]), (0, 10))
        self.assertEqual((home["gamesFor"], away["gamesFor"]), (0, 0))

    def test_ladder_tie_uses_game_percentage(self):
        fixtures = pd.DataFrame([
            {"home_team": "Alpha", "away_team": "Beta", "status": "Completed", "home_points": 5, "away_points": 5,
             "home_rubbers": 3, "away_rubbers": 3, "home_sets": "", "away_sets": "", "home_games": 24, "away_games": 20},
            {"home_team": "Gamma", "away_team": "Delta", "status": "Completed", "home_points": 5, "away_points": 5,
             "home_rubbers": 3, "away_rubbers": 3, "home_sets": "", "away_sets": "", "home_games": 30, "away_games": 10},
        ])
        rows = reconstructed_standings(fixtures, brta_scoring_rules({"format": "sets"}))
        self.assertEqual([row["team"] for row in rows], ["Gamma", "Alpha", "Beta", "Delta"])


class HiddenAnalyticsPayloadTests(unittest.TestCase):
    def test_matchup_matrix_is_complementary_and_uses_display_order(self):
        rows = [
            {"player": "High", "team": "A", "rating": 1800, "matches": 6},
            {"player": "Mid", "team": "B", "rating": 1500, "matches": 6},
            {"player": "Low", "team": "C", "rating": 1200, "matches": 6},
        ]
        matrix = matchup_matrix(rows, brta_scoring_rules({"format": "sets"}))
        self.assertEqual([row["player"] for row in matrix["players"]], ["High", "Mid", "Low"])
        self.assertEqual(matrix["probabilities"][0][0], 0.5)
        self.assertGreater(matrix["probabilities"][0][2], 0.5)
        self.assertAlmostEqual(matrix["probabilities"][0][2] + matrix["probabilities"][2][0], 1.0, places=4)

    def test_green_ball_is_first_to_six_without_tiebreak(self):
        rules = brta_scoring_rules({"format":"sets","green_ball":True,"section_label":"Sets 1 Green Ball"})
        self.assertTrue(rules["green_ball"])
        self.assertAlmostEqual(_short_set_win_probability(0.5, green_ball=True), 0.5)
        self.assertNotAlmostEqual(
            _short_set_win_probability(0.62, green_ball=True),
            _short_set_win_probability(0.62, green_ball=False),
        )

    def test_results_expectation_uses_only_prior_round_state(self):
        singles = pd.DataFrame([
            {"fixture_id":"f1","round":1,"date":"1 Jul 26","status":"Completed","position":"No. 1",
             "home_team":"A","away_team":"B","home_player":"Alice","away_player":"Bob",
             "home_games":6,"away_games":2,"winning_player":"Alice","score":"6-2"},
            {"fixture_id":"f2","round":2,"date":"8 Jul 26","status":"Completed","position":"No. 1",
             "home_team":"A","away_team":"B","home_player":"Alice","away_player":"Bob",
             "home_games":6,"away_games":3,"winning_player":"Alice","score":"6-3"},
        ])
        history = {
            "rounds": [{"round":1,"date":"1 Jul 26","players":2},{"round":2,"date":"8 Jul 26","players":2}],
            "players": {
                "Alice": [[1, 1700, 120, 1], [2, 1750, 110, 2]],
                "Bob": [[1, 1300, 120, 1], [2, 1250, 110, 2]],
            },
        }
        analysis = results_expectation(
            singles, history, {"Alice":"A","Bob":"B"}, brta_scoring_rules({"format":"sets"})
        )
        self.assertEqual(analysis["matches"][0]["homeWinProbability"], 0.5)
        self.assertGreater(analysis["matches"][1]["homeWinProbability"], 0.5)
        alice = next(row for row in analysis["players"] if row["player"] == "Alice")
        self.assertEqual(alice["actualWins"], 2)
        self.assertGreater(alice["winsAboveExpected"], 0)
        self.assertGreater(alice["actualGameShare"], alice["expectedGameShare"])
        self.assertIsNone(alice["resultsOverExpectationRank"])
        self.assertFalse(alice["qualified"])


class HistoricalDataTests(unittest.TestCase):
    def setUp(self):
        self.singles = pd.DataFrame([
            {"fixture_id":"f1","round":1,"date":"1 Jul 26","status":"Completed","position":"No. 1","home_team":"A","away_team":"B","home_player":"Alice","away_player":"Bob","home_games":6,"away_games":2,"winning_player":"Alice"},
            {"fixture_id":"f1","round":1,"date":"1 Jul 26","status":"Completed","position":"No. 2","home_team":"A","away_team":"B","home_player":"Amy","away_player":"Ben","home_games":6,"away_games":4,"winning_player":"Amy"},
            {"fixture_id":"f2","round":2,"date":"8 Jul 26","status":"Completed","position":"No. 1","home_team":"A","away_team":"B","home_player":"Alice","away_player":"Ben","home_games":6,"away_games":1,"winning_player":"Alice"},
            {"fixture_id":"f2","round":2,"date":"8 Jul 26","status":"Completed","position":"No. 2","home_team":"A","away_team":"B","home_player":"Amy","away_player":"Bob","home_games":4,"away_games":6,"winning_player":"Bob"},
        ])

    def test_history_is_as_of_each_round_and_schedule_is_ranked(self):
        teams = {"Alice":"A", "Amy":"A", "Bob":"B", "Ben":"B"}
        history = round_rating_history(self.singles, teams)
        self.assertEqual([row["round"] for row in history["rounds"]], [1, 2])
        self.assertEqual(history["players"]["Alice"][0][3], 1)
        self.assertEqual(history["players"]["Alice"][1][3], 2)
        schedule = strength_of_schedule(self.singles, {"Alice":1700,"Amy":1600,"Bob":1400,"Ben":1500}, teams)
        self.assertEqual(schedule[0]["rank"], 1)
        self.assertEqual(len(schedule), 4)

    def test_history_carries_forward_a_washout_round(self):
        teams = {"Alice":"A", "Amy":"A", "Bob":"B", "Ben":"B"}
        calendar = [
            {"round":1,"date":"1 Jul 26"},
            {"round":2,"date":"8 Jul 26"},
            {"round":3,"date":"15 Jul 26"},
        ]
        history = round_rating_history(self.singles, teams, calendar)
        self.assertEqual([row["round"] for row in history["rounds"]], [1, 2, 3])
        alice = history["players"]["Alice"]
        self.assertEqual(alice[-1][0], 3)
        self.assertEqual(alice[-1][1:4], alice[-2][1:4])

    def test_official_order_evidence_records_direct_precedence(self):
        evidence = team_order_evidence(self.singles, {"Alice":1700,"Amy":1600,"Bob":1400,"Ben":1500}, {})
        edges = {(row["above"], row["below"]): row["count"] for row in evidence["A"]["precedence"]}
        self.assertEqual(edges[("Alice", "Amy")], 2)

    def test_emergency_is_ordered_below_regular_roster_entries(self):
        rows = pd.DataFrame([
            {"fixture_id":"f1", "position":"No. 1", "home_team":"A", "away_team":"B", "home_player":"Emergency", "away_player":"Bob", "home_emergency":"true", "away_emergency":"false"},
            {"fixture_id":"f1", "position":"No. 4", "home_team":"A", "away_team":"B", "home_player":"Regular", "away_player":"Ben", "home_emergency":"false", "away_emergency":"false"},
        ])
        evidence = team_order_evidence(rows, {"Emergency":1500,"Regular":1500,"Bob":1500,"Ben":1500}, {})
        edges = {(row["above"], row["below"]): row["count"] for row in evidence["A"]["precedence"]}
        self.assertIn(("Regular", "Emergency"), edges)
        self.assertNotIn(("Emergency", "Regular"), edges)
        roster = {row["player"]: row for row in evidence["A"]["players"]}
        self.assertTrue(roster["Emergency"]["emergencyOnly"])


if __name__ == "__main__":
    unittest.main()
