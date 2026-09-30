"""Reproducible walk-forward comparison of the legacy V2 and current V3 models.

Usage:
    python validation/validate_v2_v3.py validation/datasets/*.csv

Each input uses the public singles CSV schema.  At every evaluated round, the
models fit only earlier completed rounds and score that round's games and set
winners.  Unknown players receive a neutral 50% pre-match probability.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import expit

GAME_SCALE = 0.75
MATCH_SCALE_V2 = 0.55
V2_MATCH_WEIGHT = 1.8
V2_L2 = 0.75
V2_RECENCY = 0.90
V3_L2 = 5.0
V3_HALF_LIFE_DAYS = 365.0


def completed(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df[df["status"].eq("Completed")].dropna(subset=["home_player", "away_player", "home_games", "away_games"]).copy()
    df["round"] = pd.to_numeric(df["round"], errors="raise").astype(int)
    df["date"] = pd.to_datetime(df["date"], format="%d %b %y", errors="raise")
    return df


def _fit(df: pd.DataFrame, version: str):
    players = sorted(set(df.home_player) | set(df.away_player))
    index = {player: i for i, player in enumerate(players)}
    i = df.home_player.map(index).to_numpy()
    j = df.away_player.map(index).to_numpy()
    home_games = df.home_games.astype(float).to_numpy()
    away_games = df.away_games.astype(float).to_numpy()
    games = home_games + away_games
    if version == "v2":
        age = df["round"].max() - df["round"].to_numpy()
        weight = V2_RECENCY**np.maximum(age, 0)
        l2 = V2_L2
    else:
        age = (df.date.max() - df.date).dt.days.to_numpy()
        weight = 2.0**(-np.maximum(age, 0) / V3_HALF_LIFE_DAYS)
        l2 = V3_L2

    def objective(theta):
        game_p = expit((theta[i] - theta[j]) / GAME_SCALE)
        eps = 1e-12
        likelihood = home_games * np.log(game_p + eps) + away_games * np.log(1 - game_p + eps)
        gradient_factor = -weight * (home_games - games * game_p) / GAME_SCALE
        grad = l2 * theta.copy()
        np.add.at(grad, i, gradient_factor)
        np.add.at(grad, j, -gradient_factor)
        if version == "v2":
            match_p = expit((theta[i] - theta[j]) / MATCH_SCALE_V2)
            home_win = (home_games > away_games).astype(float)
            likelihood += V2_MATCH_WEIGHT * (home_win * np.log(match_p + eps) + (1 - home_win) * np.log(1 - match_p + eps))
            match_factor = -weight * V2_MATCH_WEIGHT * (home_win - match_p) / MATCH_SCALE_V2
            np.add.at(grad, i, match_factor)
            np.add.at(grad, j, -match_factor)
        return -(weight @ likelihood - l2 * np.sum(theta**2) / 2), grad

    result = minimize(objective, np.zeros(len(players)), jac=True, method="L-BFGS-B", options={"maxiter": 2000, "ftol": 1e-12})
    if not result.success:
        raise RuntimeError(result.message)
    theta = result.x - result.x.mean()
    return index, theta


def first_to_six_probability(game_probability: float) -> float:
    """Probability that the home player wins a first-to-six-games BRTA set."""
    return sum(math.comb(5 + lost, lost) * game_probability**6 * (1 - game_probability)**lost for lost in range(6))


def score_round(test: pd.DataFrame, index, theta, version: str) -> tuple[float, float, int, int]:
    game_nll = match_brier = 0.0
    games_count = matches_count = 0
    for row in test.itertuples(index=False):
        if row.home_player not in index or row.away_player not in index:
            game_p = 0.5
        else:
            game_p = float(expit((theta[index[row.home_player]] - theta[index[row.away_player]]) / GAME_SCALE))
        match_p = float(expit((theta[index[row.home_player]] - theta[index[row.away_player]]) / MATCH_SCALE_V2)) if version == "v2" and row.home_player in index and row.away_player in index else first_to_six_probability(game_p)
        game_nll -= row.home_games * math.log(game_p) + row.away_games * math.log(1 - game_p)
        game_nll += 0.0
        home_win = float(row.home_games > row.away_games)
        match_brier += (match_p - home_win) ** 2
        games_count += int(row.home_games + row.away_games)
        matches_count += 1
    return game_nll, match_brier, games_count, matches_count


def validate_file(path: Path, min_train_rounds: int) -> list[dict]:
    df = completed(path)
    rows = []
    for round_number in sorted(df["round"].unique()):
        train = df[df["round"] < round_number]
        test = df[df["round"] == round_number]
        if train["round"].nunique() < min_train_rounds or test.empty:
            continue
        for version in ("v2", "v3"):
            index, theta = _fit(train, version)
            nll, brier, games, matches = score_round(test, index, theta, version)
            rows.append({"dataset": path.name, "round": int(round_number), "model": version,
                         "game_nll": nll, "match_brier_sum": brier, "games": games, "matches": matches})
    return rows


def summarise(rows: list[dict]) -> list[dict]:
    out = []
    for version in ("v2", "v3"):
        matching = [r for r in rows if r["model"] == version]
        games = sum(r["games"] for r in matching)
        matches = sum(r["matches"] for r in matching)
        out.append({"model": version, "game_negative_log_loss": sum(r["game_nll"] for r in matching) / games,
                    "match_brier_score": sum(r["match_brier_sum"] for r in matching) / matches,
                    "games": games, "matches": matches, "folds": len(matching)})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("datasets", nargs="+", type=Path)
    parser.add_argument("--min-train-rounds", type=int, default=2)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    rows = [row for path in args.datasets for row in validate_file(path, args.min_train_rounds)]
    if not rows:
        raise SystemExit("No walk-forward folds were available.")
    report = {"settings": {"min_train_rounds": args.min_train_rounds}, "summary": summarise(rows), "folds": rows}
    print(json.dumps(report, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
