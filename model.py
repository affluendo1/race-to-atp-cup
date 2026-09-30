"""BRTA Power Ratings V3.

V3 fits one coherent scoreline likelihood instead of separately rewarding the
same result as both games and a W/L outcome. It uses real elapsed time,
regularization selected by walk-forward development validation, and a Laplace
posterior approximation for rating uncertainty.

Expected CSV columns include:
date, round, home_team, away_team, home_player, away_player,
winning_player, home_games, away_games, status
"""
import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import expit

GAME_SCALE = 0.75
HALF_LIFE_DAYS = 365.0
L2 = 5.0
DISPLAY_CENTRE = 1500.0
DISPLAY_SCALE = 600.0
MIN_MATCHES = 4
MIN_DOUBLES_MATCHES = 2


def centred_covariance(covariance: np.ndarray) -> np.ndarray:
    """Return covariance on the displayed, mean-zero strength scale.

    The fitted latent strengths are recentered before they are converted to
    Power.  Their uncertainty must undergo the same linear transformation;
    otherwise every displayed standard error retains an irrelevant common
    shift component.
    """
    n = covariance.shape[0]
    projection = np.eye(n) - np.ones((n, n)) / n
    return projection @ covariance @ projection.T

def prepare(df):
    df = df[df["status"].eq("Completed")].copy()
    if "valid_for_rating" in df:
        valid = df["valid_for_rating"].astype(str).str.casefold().isin({"true", "1", "yes"})
        df = df[valid].copy()
    df = df.dropna(subset=["home_player","away_player","home_games","away_games"])
    for col in ["home_player","away_player","winning_player"]:
        if col in df:
            df[col] = df[col].replace({"Geoge Si":"George Si"})
    parsed = pd.to_datetime(df["date"], format="%d %b %y", errors="coerce")
    valid_dates = parsed.dropna()
    reference_date = valid_dates.max() if not valid_dates.empty else pd.Timestamp("2000-01-01")
    def inferred_date(row):
        dt = pd.to_datetime(row.get("date"), format="%d %b %y", errors="coerce")
        if pd.notna(dt): return dt
        # TROLS often omits dates for playoff scorecards. Do not invent a
        # one-week delay: a washout can move finals by any amount. Use the
        # latest dated result as a neutral recency fallback. If TROLS gives no
        # dates anywhere in the season, all records receive the same neutral
        # timestamp so recency weighting cannot invent an order.
        return reference_date
    df["match_date"]=df.apply(inferred_date,axis=1)
    return df

def fit_power_ratings(csv_path):
    df=prepare(pd.read_csv(csv_path))
    players=sorted(set(df["home_player"])|set(df["away_player"]))
    ix={p:k for k,p in enumerate(players)}; n_players=len(players)
    i=df["home_player"].map(ix).to_numpy(); j=df["away_player"].map(ix).to_numpy()
    gi=df["home_games"].astype(float).to_numpy(); gj=df["away_games"].astype(float).to_numpy(); games=gi+gj
    reference_date=df["match_date"].max()
    age_days=(reference_date-df["match_date"]).dt.days.to_numpy()
    weight=2.0**(-np.maximum(age_days,0)/HALF_LIFE_DAYS)
    def objective_and_gradient(theta):
        p=expit((theta[i]-theta[j])/GAME_SCALE); eps=1e-12
        score_ll=gi*np.log(p+eps)+gj*np.log(1-p+eps)
        objective=weight@score_ll-(L2/2.0)*np.sum(theta**2)
        z=-weight*(gi-games*p)/GAME_SCALE
        grad=L2*theta.copy(); np.add.at(grad,i,z); np.add.at(grad,j,-z)
        return -objective,grad
    result=minimize(objective_and_gradient,np.zeros(n_players),jac=True,method="L-BFGS-B",options={"maxiter":2000,"ftol":1e-12})
    if not result.success: raise RuntimeError(result.message)
    theta=result.x.copy(); theta-=theta.mean()
    power=DISPLAY_CENTRE+DISPLAY_SCALE*theta
    p=expit((theta[i]-theta[j])/GAME_SCALE)
    curvature=weight*games*p*(1-p)/(GAME_SCALE**2)
    H=L2*np.eye(n_players)
    for a,b,c in zip(i,j,curvature):
        H[a,a]+=c; H[b,b]+=c; H[a,b]-=c; H[b,a]-=c
    covariance=centred_covariance(np.linalg.inv(H))
    power_se=DISPLAY_SCALE*np.sqrt(np.diag(covariance))
    rows=[]
    for player in players:
        k=ix[player]; m=df[(df["home_player"]==player)|(df["away_player"]==player)]
        wins=int((m["winning_player"]==player).sum()); gf=ga=0
        for _,r in m.iterrows():
            if r["home_player"]==player: gf+=r["home_games"]; ga+=r["away_games"]
            else: gf+=r["away_games"]; ga+=r["home_games"]
        rows.append({"player":player,"matches":len(m),"wins":wins,"losses":len(m)-wins,
                     "games_for":int(gf),"games_against":int(ga),"power":power[k],
                     "power_se":power_se[k],"ci95_low":power[k]-1.96*power_se[k],
                     "ci95_high":power[k]+1.96*power_se[k]})
    out=pd.DataFrame(rows).sort_values("power",ascending=False)
    out["qualified"]=out["matches"]>=MIN_MATCHES
    return out

if __name__=="__main__":
    import argparse
    parser=argparse.ArgumentParser(); parser.add_argument("csv"); parser.add_argument("--all",action="store_true")
    args=parser.parse_args(); ratings=fit_power_ratings(args.csv)
    if not args.all: ratings=ratings[ratings["qualified"]]
    fmts={"power":"{:.0f}".format,"power_se":"{:.0f}".format,"ci95_low":"{:.0f}".format,"ci95_high":"{:.0f}".format}
    print(ratings.to_string(index=False,formatters=fmts))


# ---------------------------------------------------------------------------
# INDIVIDUAL DOUBLES EXTENSION
# ---------------------------------------------------------------------------
# The website's individual-doubles table uses the same scoreline likelihood
# and V3 constants, but a doubles side's latent strength is the mean of its
# two players:
#
#     theta_team = (theta_player_1 + theta_player_2) / 2
#
# Therefore, for A/B vs C/D:
#
#     p = logistic((((theta_A + theta_B)/2) -
#                   ((theta_C + theta_D)/2)) / GAME_SCALE)
#
# This separates a player's contribution from the particular partner used.
# Published individual-doubles ratings require 4 doubles appearances.
#
# The website's Overall rating is deliberately transparent rather than a
# second fitted model:
#
#     Overall = (Singles Power + Individual Doubles Power) / 2
#
# A ranked Overall entry requires 4 singles and 4 doubles appearances.
# Entries below any publication threshold may still be shown as provisional.
