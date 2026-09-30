from __future__ import annotations
import json, math, re
from collections import Counter, defaultdict
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.special import expit

from model import (
    GAME_SCALE, HALF_LIFE_DAYS, L2, DISPLAY_CENTRE, DISPLAY_SCALE,
    MIN_MATCHES, MIN_DOUBLES_MATCHES, centred_covariance, fit_power_ratings,
)

DATA_DIR = Path("data/current")
SECTIONS_DIR = DATA_DIR / "sections"
SITE_SECTIONS_DIR = Path("data/site/sections")
OUT = Path("data.js")
DEFAULT_SECTION = "UA009"
INDIVIDUAL_DOUBLES_MIN = 4
INDIVIDUAL_DOUBLES_MIN_PARTNERS = 2
# A player whose loading on an exact unidentifiable direction exceeds this is
# not publishable as an independently ranked doubles contributor.  This is a
# structural data check, not a judgement of playing ability.
IDENTIFIABILITY_EXPOSURE_THRESHOLD = 0.05
# Conditional pair effects are deliberately much more strongly shrunk than
# player effects. They are exploratory diagnostics, not a fourth leaderboard.
PAIR_SYNERGY_L2 = 50.0
# Generated analysis contracts are intentionally complete enough for client
# views to consume without reproducing statistical logic in the browser.

def canonical_pair(value: str) -> str:
    names = pair_members(value)
    return " / ".join(sorted(names, key=str.casefold))

def pair_members(value: str):
    raw=str(value).strip()
    if raw.casefold() in {"", "nan", "none", "null"}:
        return []
    return [x.strip() for x in raw.split("/") if x.strip()]

def display_pair(value: str) -> str:
    return str(value).strip() if pair_members(value) else "Not recorded"

def standard_doubles_rows(doubles):
    """Keep ordinary two-player pair rubbers for the doubles rating fits.

    Some historical TROLS scorecards list more or fewer than two names on a
    doubles side. Those official rows still belong in Results, but they do not
    provide an unambiguous two-player pair for the pair or individual model.
    Excluding them here lets the archive publish without silently inventing a
    pairing or dropping the source result from the site.
    """
    df = doubles[doubles["status"].eq("Completed")].copy()
    if "valid_for_rating" in df:
        df = df[df["valid_for_rating"].astype(str).str.casefold().isin({"true", "1", "yes"})].copy()
    if df.empty:
        return df
    valid = [len(pair_members(home)) == 2 and len(pair_members(away)) == 2
             for home, away in zip(df["home_pair"], df["away_pair"])]
    return df.loc[valid].copy()

def parse_dates(df):
    out = df.copy()
    parsed = pd.to_datetime(out["date"], format="%d %b %y", errors="coerce")
    # TROLS does not publish dates on some historic playoff scorecards. Keep
    # their stored date blank for display; for the rating likelihood only,
    # use the latest known match date so we do not invent a postponement gap.
    # If it publishes no dates for the season, one neutral common timestamp
    # makes all observations receive equal recency weight.
    reference_date = parsed.max() if not parsed.dropna().empty else pd.Timestamp("2000-01-01")
    out["match_date"] = parsed.fillna(reference_date)
    return out


def doubles_identifiability(design: np.ndarray) -> tuple[int, np.ndarray]:
    """Return rank and each player's exposure to an exact extra nullspace.

    A common shift is always unidentifiable in an additive rating model, so a
    connected doubles network should have rank ``n_players - 1``.  Any further
    null direction means that results cannot distinguish a redistribution of
    strength among some players.  We expose that fact instead of allowing the
    L2 prior to make a prior-selected ordering look data-identified.
    """
    n = design.shape[1]
    rank = int(np.linalg.matrix_rank(design))
    _, _, vh = np.linalg.svd(design, full_matrices=True)
    null_basis = vh[rank:].T
    if null_basis.size == 0:
        return rank, np.zeros(n)

    projection = np.eye(n) - np.ones((n, n)) / n
    centred_null = projection @ null_basis
    _, singular_values, vh_null = np.linalg.svd(centred_null, full_matrices=False)
    extra = singular_values > 1e-9
    if not np.any(extra):
        return rank, np.zeros(n)
    extra_basis = centred_null @ vh_null.T[:, extra]
    return rank, np.sqrt(np.sum(extra_basis**2, axis=1))

def team_maps(singles, doubles):
    pc = defaultdict(Counter)
    qc = defaultdict(Counter)
    for _, r in singles.iterrows():
        pc[str(r.home_player)][str(r.home_team)] += 1
        pc[str(r.away_player)][str(r.away_team)] += 1
    for _, r in doubles.iterrows():
        hp = canonical_pair(r.home_pair); ap = canonical_pair(r.away_pair)
        home_members=pair_members(r.home_pair); away_members=pair_members(r.away_pair)
        if len(home_members)==2: qc[hp][str(r.home_team)] += 1
        if len(away_members)==2: qc[ap][str(r.away_team)] += 1
        for p in home_members: pc[p][str(r.home_team)] += 1
        for p in away_members: pc[p][str(r.away_team)] += 1
    return ({p:c.most_common(1)[0][0] for p,c in pc.items()},
            {p:c.most_common(1)[0][0] for p,c in qc.items()})

def website_rows(ratings, teams):
    rows=[]
    for _,r in ratings.sort_values("power",ascending=False).iterrows():
        row={
            "player":str(r.player),"team":teams.get(str(r.player),""),
            "wins":int(r.wins),"losses":int(r.losses),
            "gf":int(r.games_for),"ga":int(r.games_against),"matches":int(r.matches),
            "rating":int(round(r.power)),"se":int(round(r.power_se)),
            "lo":int(round(r.ci95_low)),"hi":int(round(r.ci95_high)),
        }
        for field in ("partners", "partner_count", "network_rank", "identifiability_exposure", "qualified", "ranking_status"):
            if field in r.index:
                value=r[field]
                if isinstance(value, (np.integer,)):
                    value=int(value)
                elif isinstance(value, (np.floating,)):
                    value=float(value)
                row[field]=value
        rows.append(row)
    return rows

def fit_pairs(doubles):
    x=standard_doubles_rows(doubles)
    x["home_player"]=x["home_pair"].map(canonical_pair)
    x["away_player"]=x["away_pair"].map(canonical_pair)
    x["winning_player"]=x["winning_pair"].map(canonical_pair)
    return fit_power_ratings_from_df(x)

def fit_power_ratings_from_df(df):
    df=df[df["status"].eq("Completed")].copy()
    if "valid_for_rating" in df:
        df=df[df["valid_for_rating"].astype(str).str.casefold().isin({"true","1","yes"})].copy()
    if df.empty:
        return pd.DataFrame(columns=["player","matches","wins","losses","games_for","games_against","power","power_se","ci95_low","ci95_high"])
    df=parse_dates(df)
    players=sorted(set(df["home_player"])|set(df["away_player"]))
    ix={p:k for k,p in enumerate(players)}; n=len(players)
    i=df["home_player"].map(ix).to_numpy(); j=df["away_player"].map(ix).to_numpy()
    gi=df["home_games"].astype(float).to_numpy(); gj=df["away_games"].astype(float).to_numpy(); games=gi+gj
    ref=df["match_date"].max(); age=(ref-df["match_date"]).dt.days.to_numpy()
    weight=2.0**(-np.maximum(age,0)/HALF_LIFE_DAYS)
    def fg(theta):
        p=expit((theta[i]-theta[j])/GAME_SCALE); eps=1e-12
        ll=gi*np.log(p+eps)+gj*np.log(1-p+eps)
        objective=weight@ll-(L2/2)*np.sum(theta**2)
        z=-weight*(gi-games*p)/GAME_SCALE
        grad=L2*theta.copy(); np.add.at(grad,i,z); np.add.at(grad,j,-z)
        return -objective,grad
    res=minimize(fg,np.zeros(n),jac=True,method="L-BFGS-B",options={"maxiter":2000,"ftol":1e-12})
    if not res.success: raise RuntimeError(res.message)
    theta=res.x.copy(); theta-=theta.mean()
    power=DISPLAY_CENTRE+DISPLAY_SCALE*theta
    p=expit((theta[i]-theta[j])/GAME_SCALE)
    curv=weight*games*p*(1-p)/(GAME_SCALE**2)
    H=L2*np.eye(n)
    for a,b,c in zip(i,j,curv):
        H[a,a]+=c; H[b,b]+=c; H[a,b]-=c; H[b,a]-=c
    cov=centred_covariance(np.linalg.inv(H)); se=DISPLAY_SCALE*np.sqrt(np.diag(cov))
    rows=[]
    for player in players:
        k=ix[player]; m=df[(df.home_player==player)|(df.away_player==player)]
        wins=gf=ga=0
        for _,r in m.iterrows():
            home=r.home_player==player
            gf+=int(r.home_games if home else r.away_games)
            ga+=int(r.away_games if home else r.home_games)
            wins+=int(str(r.winning_player)==player)
        rows.append(dict(player=player,matches=len(m),wins=wins,losses=len(m)-wins,
                         games_for=gf,games_against=ga,power=power[k],power_se=se[k],
                         ci95_low=power[k]-1.96*se[k],ci95_high=power[k]+1.96*se[k]))
    return pd.DataFrame(rows).sort_values("power",ascending=False)

def fit_individual_doubles(doubles, *, rubbers_format=False):
    df=standard_doubles_rows(doubles)
    if df.empty:
        return pd.DataFrame(columns=["player","matches","wins","losses","games_for","games_against","power","power_se","ci95_low","ci95_high","partners","partner_count","network_rank","identifiability_exposure","qualified","ranking_status"])
    df=parse_dates(df)
    home_members=[pair_members(x) for x in df.home_pair]
    away_members=[pair_members(x) for x in df.away_pair]
    players=sorted(set(sum(home_members+away_members,[])))
    ix={p:k for k,p in enumerate(players)}; n=len(players)
    gi=df.home_games.astype(float).to_numpy(); gj=df.away_games.astype(float).to_numpy(); games=gi+gj
    ref=df.match_date.max(); age=(ref-df.match_date).dt.days.to_numpy()
    weight=2.0**(-np.maximum(age,0)/HALF_LIFE_DAYS)
    design=np.zeros((len(df),n))
    for row,(hs,as_) in enumerate(zip(home_members,away_members)):
        for p in hs: design[row,ix[p]] += .5
        for p in as_: design[row,ix[p]] -= .5
    network_rank, identifiability_exposure = doubles_identifiability(design)
    def fg(theta):
        delta=design@theta
        p=expit(delta/GAME_SCALE); eps=1e-12
        ll=gi*np.log(p+eps)+gj*np.log(1-p+eps)
        objective=weight@ll-(L2/2)*np.sum(theta**2)
        coeff=-weight*(gi-games*p)/GAME_SCALE
        grad=L2*theta+design.T@coeff
        return -objective,grad
    res=minimize(fg,np.zeros(n),jac=True,method="L-BFGS-B",options={"maxiter":3000,"ftol":1e-12})
    if not res.success: raise RuntimeError(res.message)
    theta=res.x.copy(); theta-=theta.mean()
    power=DISPLAY_CENTRE+DISPLAY_SCALE*theta
    p=expit((design@theta)/GAME_SCALE)
    curv=weight*games*p*(1-p)/(GAME_SCALE**2)
    H=L2*np.eye(n)+design.T@(design*curv[:,None])
    cov=centred_covariance(np.linalg.inv(H)); se=DISPLAY_SCALE*np.sqrt(np.diag(cov))
    stats={p:dict(matches=0,wins=0,gf=0,ga=0,partners=set()) for p in players}
    for row,r in df.reset_index(drop=True).iterrows():
        home_win=canonical_pair(r.winning_pair)==canonical_pair(r.home_pair)
        for p0 in home_members[row]:
            s=stats[p0]; s["matches"]+=1; s["wins"]+=int(home_win); s["gf"]+=int(r.home_games); s["ga"]+=int(r.away_games)
            s["partners"].update(p for p in home_members[row] if p != p0)
        for p0 in away_members[row]:
            s=stats[p0]; s["matches"]+=1; s["wins"]+=int(not home_win); s["gf"]+=int(r.away_games); s["ga"]+=int(r.home_games)
            s["partners"].update(p for p in away_members[row] if p != p0)
    rows=[]
    for p0 in players:
        k=ix[p0]; s=stats[p0]
        partner_count=len(s["partners"])
        structurally_unidentified=identifiability_exposure[k] >= IDENTIFIABILITY_EXPOSURE_THRESHOLD
        # Rubbers divisions have two-player teams. Their doubles evidence is
        # inherently partner-dependent, so hiding every doubles/Overall entry
        # is less useful than publishing the evidence with that limitation
        # explicit. Other formats retain the stricter identifiable-network
        # qualification rule.
        qualified=(s["matches"] >= INDIVIDUAL_DOUBLES_MIN and
                   (rubbers_format or
                    (partner_count >= INDIVIDUAL_DOUBLES_MIN_PARTNERS and
                     not structurally_unidentified)))
        if rubbers_format and s["matches"] >= INDIVIDUAL_DOUBLES_MIN:
            ranking_status="Partner-dependent"
        elif qualified:
            ranking_status="Established"
        elif structurally_unidentified or (s["matches"] >= INDIVIDUAL_DOUBLES_MIN and partner_count < INDIVIDUAL_DOUBLES_MIN_PARTNERS):
            ranking_status="Partner-dependent"
        else:
            ranking_status="Provisional"
        rows.append(dict(player=p0,matches=s["matches"],wins=s["wins"],losses=s["matches"]-s["wins"],
                         games_for=s["gf"],games_against=s["ga"],power=power[k],power_se=se[k],
                         ci95_low=power[k]-1.96*se[k],ci95_high=power[k]+1.96*se[k],
                         partners=partner_count,partner_count=partner_count,network_rank=network_rank,
                         identifiability_exposure=float(identifiability_exposure[k]),
                         qualified=qualified,ranking_status=ranking_status))
    return pd.DataFrame(rows).sort_values("power",ascending=False)


def fit_pair_synergies(doubles, individual_ratings):
    """Estimate a strongly regularised residual pair effect, conditional on players.

    The main individual-doubles rating stays additive.  This auxiliary model
    estimates ``gamma_pair`` in ``pair strength = mean(player strengths) +
    gamma_pair`` while holding the individual estimates fixed.  It avoids
    reassigning individual ability to one-off partnerships and is published as
    an exploratory signal only.
    """
    df=doubles[doubles["status"].eq("Completed")].copy()
    if "valid_for_rating" in df:
        df=df[df["valid_for_rating"].astype(str).str.casefold().isin({"true","1","yes"})].copy()
    df=parse_dates(df)
    df["home_key"]=df["home_pair"].map(canonical_pair)
    df["away_key"]=df["away_pair"].map(canonical_pair)
    pairs=sorted(set(df.home_key)|set(df.away_key))
    index={pair:k for k,pair in enumerate(pairs)}
    i=df.home_key.map(index).to_numpy(); j=df.away_key.map(index).to_numpy()
    home_base=np.array([np.mean([(individual_ratings[p]-DISPLAY_CENTRE)/DISPLAY_SCALE for p in pair_members(pair)]) for pair in df.home_key])
    away_base=np.array([np.mean([(individual_ratings[p]-DISPLAY_CENTRE)/DISPLAY_SCALE for p in pair_members(pair)]) for pair in df.away_key])
    home_games=df.home_games.astype(float).to_numpy(); away_games=df.away_games.astype(float).to_numpy(); games=home_games+away_games
    age=(df.match_date.max()-df.match_date).dt.days.to_numpy()
    weight=2.0**(-np.maximum(age,0)/HALF_LIFE_DAYS)

    def fg(gamma):
        delta=home_base-away_base+gamma[i]-gamma[j]
        p=expit(delta/GAME_SCALE); eps=1e-12
        ll=home_games*np.log(p+eps)+away_games*np.log(1-p+eps)
        objective=weight@ll-(PAIR_SYNERGY_L2/2)*np.sum(gamma**2)
        coefficient=-weight*(home_games-games*p)/GAME_SCALE
        gradient=PAIR_SYNERGY_L2*gamma.copy()
        np.add.at(gradient,i,coefficient); np.add.at(gradient,j,-coefficient)
        return -objective,gradient

    result=minimize(fg,np.zeros(len(pairs)),jac=True,method="L-BFGS-B",options={"maxiter":2000,"ftol":1e-12})
    if not result.success:
        raise RuntimeError(result.message)
    return {pair:float(DISPLAY_SCALE*result.x[k]) for pair,k in index.items()}

def singles_match_array(singles):
    out=[]
    for _,r in singles.sort_values(["round","fixture_id","position"]).iterrows():
        out.append([int(r["round"]),str(r["date"]),str(r["home_player"]),str(r["away_player"]),
                    int(r["home_games"]),int(r["away_games"]),str(r["winning_player"]),str(r["score"]),str(r["fixture_id"])])
    return out

def brta_scoring_rules(meta):
    """Return the 2026 Weekend Junior By-Law scoring constants.

    Rules 2.1–2.4 and 14 use one points system for Sets/Green Ball and a
    smaller one for two-player Rubbers: team-result points plus one point per
    won set and half a point per unfinished set. Keeping this here means Team
    Power and the ladder cannot quietly use different rules.
    """
    rubbers = str(meta.get("format", "")).casefold() == "rubbers" or \
              str(meta.get("section_label", "")).casefold().startswith("rubbers")
    green_ball = bool(meta.get("green_ball", False)) or "green ball" in str(meta.get("section_label", "")).casefold()
    return {
        "format": "rubbers" if rubbers else "sets",
        "green_ball": green_ball,
        "team_win": 2.0 if rubbers else 4.0,
        "team_draw": 1.0 if rubbers else 2.0,
        "scheduled_sets": 5 if rubbers else 6,
    }


def _number(value):
    try:
        if pd.isna(value) or str(value).strip() == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def fixture_points(r, rules):
    """Return the official or By-Law-derived ledger for one fixture.

    Completed scorecards retain the published TROLS points. TROLS does not
    include numeric cells for a washout or a full-team forfeit, so Rule 14 is
    applied directly instead of guessing from the most common result score.
    A full forfeit gives every set point to the receiving team, but no game
    percentage (Rule 14.4).
    """
    status = str(r.get("status", ""))
    home, away = _number(r.get("home_points", "")), _number(r.get("away_points", ""))
    if home is not None and away is not None:
        return home, away
    if status == "Wash Out":
        each = rules["team_draw"] + rules["scheduled_sets"] * 0.5
        return each, each
    # TROLS displays "Forfeited To" between home and away when the home side
    # concedes to the visitor, and "Forfeited By" when the visitor concedes.
    if status == "Forfeited To":
        return 0.0, rules["team_win"] + rules["scheduled_sets"]
    if status == "Forfeited By":
        return rules["team_win"] + rules["scheduled_sets"], 0.0
    return None, None


def ladder(fixtures, rules):
    pts=Counter()
    for _,r in fixtures.iterrows():
        h,a=str(r.home_team),str(r.away_team)
        if str(r.status)=="Bye":
            continue
        home_points, away_points=fixture_points(r, rules)
        if home_points is None or away_points is None:
            continue
        pts[h]+=home_points; pts[a]+=away_points
    return pts

def team_rows(single_rows, fixtures, rules):
    pts=ladder(fixtures, rules); by=defaultdict(list)
    for x in single_rows:
        # Team Power measures the active modelled roster, not only the public
        # leaderboard.  Low-sample ratings are already shrunk toward 1500.
        by[x["team"]].append(x["rating"])
    all_teams=sorted((set(fixtures.home_team)|set(fixtures.away_team))-{"Bye"})
    rows=[]
    for t in all_teams:
        vals=by.get(t,[])
        avg=float(np.mean(vals)) if vals else 0.0
        best4=float(np.mean(sorted(vals,reverse=True)[:4])) if vals else 0.0
        ladder_points=float(pts[t])
        rows.append({"team":t,"avg":round(avg,1),"best4":round(best4,1),"modelled":len(vals),
                     "ladder":int(ladder_points) if ladder_points.is_integer() else ladder_points})
    return sorted(rows,key=lambda x:x["avg"],reverse=True)

def reconstructed_standings(fixtures, rules):
    if "stage" in fixtures.columns:
        stages = fixtures["stage"].fillna("").astype(str).str.casefold()
        fixtures = fixtures[~stages.isin({"semi_final", "grand_final", "semi-final", "grand-final"})].copy()
    if "round" in fixtures.columns:
        fixtures = fixtures[pd.to_numeric(fixtures["round"], errors="coerce").fillna(0).astype(int).le(14)].copy()
    teams = sorted((set(fixtures.home_team) | set(fixtures.away_team))-{"Bye"})
    s = {t: dict(team=t, played=0, wins=0, draws=0, losses=0, rubbersFor=0, rubbersAgainst=0,
                 gamesFor=0, gamesAgainst=0, points=0) for t in teams}
    for _, r in fixtures.iterrows():
        h, a, status = str(r.home_team), str(r.away_team), str(r.status)
        if h=="Bye" or a=="Bye": continue
        home_points, away_points=fixture_points(r, rules)
        if status == "Wash Out":
            # Rule 14 gives both teams draw points plus a half point per
            # uncompleted set. With no scorecard this is a draw, but contributes
            # no game percentage.
            s[h]["played"] += 1; s[a]["played"] += 1
            s[h]["draws"] += 1; s[a]["draws"] += 1
            s[h]["points"] += home_points; s[a]["points"] += away_points
            continue
        if status in {"Forfeited To", "Forfeited By"}:
            s[h]["played"] += 1; s[a]["played"] += 1
            s[h]["points"] += home_points; s[a]["points"] += away_points
            if home_points > away_points:
                s[h]["wins"] += 1; s[a]["losses"] += 1
            else:
                s[a]["wins"] += 1; s[h]["losses"] += 1
            continue
        if status != "Completed":
            continue
        hr, ar = int(r.home_rubbers), int(r.away_rubbers)
        hg, ag = int(r.home_games), int(r.away_games)
        for t in (h, a): s[t]["played"] += 1
        s[h]["rubbersFor"] += hr; s[h]["rubbersAgainst"] += ar
        s[a]["rubbersFor"] += ar; s[a]["rubbersAgainst"] += hr
        s[h]["gamesFor"] += hg; s[h]["gamesAgainst"] += ag
        s[a]["gamesFor"] += ag; s[a]["gamesAgainst"] += hg
        s[h]["points"] += home_points; s[a]["points"] += away_points
        # Rules 2.1–2.4 decide a tied match on sets, then games. Sets-format
        # result rows have one set per rubber, so the published rubber figure
        # is the set total in that format.
        hs, ass=_number(r.home_sets), _number(r.away_sets)
        hs, ass=(hs, ass) if hs is not None and ass is not None else (hr, ar)
        home_win = hs > ass or (hs == ass and hg > ag)
        away_win = ass > hs or (hs == ass and ag > hg)
        if home_win:
            s[h]["wins"] += 1; s[a]["losses"] += 1
        elif away_win:
            s[a]["wins"] += 1; s[h]["losses"] += 1
        else:
            s[h]["draws"] += 1; s[a]["draws"] += 1
    for row in s.values():
        if float(row["points"]).is_integer(): row["points"]=int(row["points"])
    # Rule 14.4 uses games-for / games-against percentage, not the rubber
    # difference. Complete forfeits deliberately have no percentage.
    def standing_key(x):
        total=x["gamesFor"]+x["gamesAgainst"]
        percentage=x["gamesFor"] / total if total else -1.0
        return (-x["points"], -percentage, x["team"])
    return sorted(s.values(), key=standing_key)


def apply_official_standings(rows, official_rows):
    """Use TROLS' published points and order where an archived ladder exists."""
    if not official_rows:
        return rows
    by_team = {str(item.get("team", "")).casefold(): item for item in official_rows}
    seen = set()
    for row in rows:
        official = by_team.get(str(row["team"]).casefold())
        if not official:
            continue
        seen.add(str(row["team"]).casefold())
        row["officialPosition"] = int(official.get("position", 0) or 0) or None
        row["officialWins"] = _number(official.get("wins"))
        if _number(official.get("points")) is not None:
            row["points"] = _number(official["points"])
        row["officialPercentage"] = _number(official.get("percentage"))
        row["officialMarker"] = str(official.get("marker", ""))
        row["standingsSource"] = "TROLS"
    for official in official_rows:
        team = str(official.get("team", ""))
        if not team or team.casefold() in seen:
            continue
        rows.append({"team": team, "played": 0, "wins": 0, "draws": 0, "losses": 0,
                     "rubbersFor": 0, "rubbersAgainst": 0, "gamesFor": 0, "gamesAgainst": 0,
                     "points": _number(official.get("points")) or 0,
                     "officialPosition": int(official.get("position", 0) or 0) or None,
                     "officialWins": _number(official.get("wins")),
                     "officialPercentage": _number(official.get("percentage")),
                     "officialMarker": str(official.get("marker", "")), "standingsSource": "TROLS"})
    if any(row.get("officialPosition") for row in rows):
        rows.sort(key=lambda row: (row.get("officialPosition") is None,
                                   row.get("officialPosition") or 10**6,
                                   row["team"].casefold()))
    return rows


def _fixture_winner(row, rules):
    status = str(row.get("status", ""))
    home, away = str(row.get("home_team", "")), str(row.get("away_team", ""))
    if status == "Forfeited To": return away
    if status == "Forfeited By": return home
    if status != "Completed": return None
    home_sets, away_sets = _number(row.get("home_sets")), _number(row.get("away_sets"))
    if home_sets is None or away_sets is None:
        home_sets, away_sets = _number(row.get("home_rubbers")), _number(row.get("away_rubbers"))
    home_games, away_games = _number(row.get("home_games")), _number(row.get("away_games"))
    if home_sets is not None and away_sets is not None and home_sets != away_sets:
        return home if home_sets > away_sets else away
    if home_games is not None and away_games is not None and home_games != away_games:
        return home if home_games > away_games else away
    return None


def _knockout_record(row, rules):
    home_points, away_points = fixture_points(row, rules)
    winner = _fixture_winner(row, rules)
    home_rubbers, away_rubbers = _number(row.get("home_rubbers")), _number(row.get("away_rubbers"))
    home_games, away_games = _number(row.get("home_games")), _number(row.get("away_games"))
    date_value = row.get("date", "")
    date = "" if pd.isna(date_value) else str(date_value or "")
    stage = str(row.get("stage", "") or "")
    label = str(row.get("round_label", "") or "")
    if label.casefold() in {"nan", "none"}: label = ""
    if not label:
        label = "Grand final" if stage.casefold() in {"grand_final", "grand-final"} else "Semi-final"
    return {
        "fixtureId": str(row.get("fixture_id", "")), "date": date,
        "home": str(row.get("home_team", "")), "away": str(row.get("away_team", "")),
        "status": str(row.get("status", "")), "winner": winner, "stage": stage, "label": label,
        "score": (f"{home_rubbers:g}–{away_rubbers:g}" if home_rubbers is not None and away_rubbers is not None else ""),
        "homePoints": home_points, "awayPoints": away_points,
        "homeGames": home_games, "awayGames": away_games,
    }


def knockout_summary(fixtures, standings, rules, meta):
    """Record TROLS playoff results, or a clearly marked 1v4 / 2v3 projection."""
    if fixtures.empty:
        return {"source": "none", "status": "regular_season_in_progress", "regularSeasonComplete": False,
                "qualifiers": [], "semifinals": [], "grandFinal": None, "champion": None, "runnerUp": None,
                "semifinalSource": "none", "grandFinalSource": "none"}
    rounds = pd.to_numeric(fixtures.get("round", pd.Series(dtype=float)), errors="coerce").fillna(0).astype(int)
    stages = fixtures.get("stage", pd.Series([""] * len(fixtures), index=fixtures.index)).fillna("").astype(str).str.casefold()
    semi_stage = stages.isin({"semi_final", "semi-final"})
    final_stage = stages.isin({"grand_final", "grand-final"})
    semis_mask = semi_stage | (rounds.eq(15) & ~final_stage)
    final_mask = final_stage | (rounds.ge(16) & ~semi_stage)
    regular_mask = ~semis_mask & ~final_mask & rounds.le(14)
    regular = fixtures[regular_mask]
    unresolved = regular[regular["status"].astype(str).isin({"Missing Result", "Scheduled", "Pending"})]
    expected_rounds = int(meta.get("regular_season_rounds", 14) or 14)
    published_rounds = set(rounds[regular_mask].tolist())
    all_regular_rounds_present = all(round_no in published_rounds for round_no in range(1, expected_rounds + 1))
    regular_complete = bool(all_regular_rounds_present and unresolved.empty)
    semi_history = [_knockout_record(row, rules) for _, row in fixtures[semis_mask].iterrows()]
    final_history = [_knockout_record(row, rules) for _, row in fixtures[final_mask].iterrows()]
    actual_semi = bool(semi_history)
    qualifiers = []
    if actual_semi:
        seed = {row["team"]: i + 1 for i, row in enumerate(standings)}
        for match in semi_history:
            for team in (match["home"], match["away"]):
                if team and team not in [x["team"] for x in qualifiers]:
                    qualifiers.append({"team": team, "seed": seed.get(team)})
        semifinal_matches = semi_history
    elif regular_complete:
        qualifiers = [{"team": row["team"], "seed": i + 1} for i, row in enumerate(standings[:4])]
        semifinal_matches = []
        if len(qualifiers) >= 4:
            semifinal_matches = [
                {"fixtureId": None, "date": "", "home": qualifiers[0]["team"], "away": qualifiers[3]["team"],
                 "status": "Projected", "winner": None, "score": "", "homePoints": None, "awayPoints": None,
                 "homeGames": None, "awayGames": None, "label": "Semi-final 1"},
                {"fixtureId": None, "date": "", "home": qualifiers[1]["team"], "away": qualifiers[2]["team"],
                 "status": "Projected", "winner": None, "score": "", "homePoints": None, "awayPoints": None,
                 "homeGames": None, "awayGames": None, "label": "Semi-final 2"},
            ]
    else:
        semifinal_matches = []
    completed_semis = [match for match in semi_history if match["winner"]]
    actual_final = next((match for match in reversed(final_history) if match["winner"]), None)
    grand_final = actual_final or (final_history[-1] if final_history else None)
    if grand_final is None:
        if actual_semi:
            semi_winners = [match["winner"] for match in completed_semis]
            if len(semi_winners) >= 2:
                grand_final = {"fixtureId": None, "date": "", "home": semi_winners[0], "away": semi_winners[1],
                               "status": "Awaiting TROLS result", "winner": None, "score": "",
                               "homePoints": None, "awayPoints": None, "homeGames": None, "awayGames": None}
        elif regular_complete and len(qualifiers) >= 4:
            grand_final = {"fixtureId": None, "date": "", "home": "Semi-final 1 winner", "away": "Semi-final 2 winner",
                           "status": "Projected", "winner": None, "score": "",
                           "homePoints": None, "awayPoints": None, "homeGames": None, "awayGames": None}
    champion = actual_final["winner"] if actual_final else None
    runner_up = None
    if actual_final and champion:
        runner_up = actual_final["away"] if champion == actual_final["home"] else actual_final["home"]
    if actual_final:
        status = "complete"
    elif final_history:
        status = "grand_final_pending"
    elif actual_semi:
        status = "semifinals_recorded"
    elif regular_complete:
        status = "projected"
    else:
        status = "regular_season_in_progress"
    semifinal_source = "TROLS" if actual_semi else ("projected" if regular_complete else "none")
    grand_final_source = "TROLS" if final_history else ("pending" if actual_semi else ("projected" if regular_complete else "none"))
    return {"source": "TROLS" if actual_semi or final_history else ("projected" if regular_complete else "none"),
            "status": status, "regularSeasonComplete": regular_complete, "qualifiers": qualifiers,
            "semifinals": semifinal_matches, "semifinalHistory": semi_history,
            "grandFinal": grand_final, "grandFinalHistory": final_history,
            "semifinalSource": semifinal_source, "grandFinalSource": grand_final_source,
            "champion": champion, "runnerUp": runner_up}

def draw_fixtures(draw, fixtures, rules):
    """Return the whole official draw, enriched with published results."""
    result_by_key={(int(r["round"]),str(r.home_team),str(r.away_team)):r for _,r in fixtures.iterrows()}
    by_round=defaultdict(list)
    for _,r in draw.iterrows():
        key=(int(r["round"]),str(r.home_team),str(r.away_team))
        result=result_by_key.get(key)
        fid=str(r.fixture_id) if pd.notna(r.fixture_id) else ""
        fid=fid if fid and fid!="nan" else (str(result.fixture_id) if result is not None else str(r.draw_id))
        stage=str(r.get("stage", "regular") or "regular")
        label=str(r.get("round_label", "") or "")
        if label.casefold() in {"nan", "none"}: label=""
        if not label:
            label={"semi_final":"Semi-final", "grand_final":"Grand final"}.get(stage.casefold(), f"Round {int(r['round'])}")
        draw_date="" if pd.isna(r.get("date")) else str(r.get("date", ""))
        result_date="" if result is None or pd.isna(result.get("date")) else str(result.get("date", ""))
        item={"home":str(r.home_team),"away":str(r.away_team),"fixtureId":fid,
              "status":str(result.status) if result is not None else "Scheduled",
              "stage":stage,"label":label,"date":draw_date or result_date}
        if result is not None:
            hp,ap=fixture_points(result, rules)
            if hp is not None and ap is not None:
                item.update({"homePoints":hp,"awayPoints":ap})
            if str(result.status)=="Completed":
                item.update({"homeRubbers":int(result.home_rubbers),"awayRubbers":int(result.away_rubbers),
                             "homeGames":int(result.home_games),"awayGames":int(result.away_games)})
        by_round[int(r["round"])].append(item)
    # Some TROLS fixtures pages omit the bye row, leaving seven-team rounds
    # with only three cards. Reconstruct it only when the full section draw
    # contains an odd team count and a regular round has the expected number
    # of real fixtures with exactly one team absent. An incomplete scrape will
    # therefore not be mistaken for a bye.
    def is_bye_name(value):
        return str(value).strip().casefold() == "bye"

    def is_regular_stage(value):
        return str(value or "regular").strip().casefold() in {"", "regular", "nan", "none"}

    teams=set()
    for frame in (draw, fixtures):
        for column in ("home_team", "away_team"):
            if column not in frame:
                continue
            teams.update(
                str(value).strip() for value in frame[column].dropna()
                if str(value).strip() and not is_bye_name(value)
            )
    if teams and len(teams) % 2:
        for rnd, games in list(by_round.items()):
            regular=[game for game in games if is_regular_stage(game.get("stage", "regular"))]
            if not regular or any(is_bye_name(game["home"]) or is_bye_name(game["away"]) for game in regular):
                continue
            expected_fixtures=len(teams)//2
            if len(regular)!=expected_fixtures:
                continue
            participating={team for game in regular for team in (game["home"], game["away"])}
            absent=teams-participating
            if len(absent)!=1:
                continue
            bye_team=next(iter(absent))
            sample=regular[0]
            by_round[rnd].append({
                "home":"Bye", "away":bye_team,
                "fixtureId":f"bye:{rnd}",
                "status":"Bye", "stage":"regular",
                "label":sample.get("label", f"Round {rnd}"),
                "date":sample.get("date", ""),
            })
    return [{"round":rnd,"label":games[0].get("label", f"Round {rnd}"),
             "stage":games[0].get("stage", "regular"),"date":games[0].get("date", ""),
             "fixtures":games,"source":"official TROLS draw"} for rnd,games in sorted(by_round.items())]

def round_rating_history(singles, player_teams, round_calendar=None):
    """Fit the model as it stood after every published round.

    The official draw supplies the round calendar so washout/no-evidence rounds
    remain visible. When a round adds no valid singles evidence, the previous
    model state is carried forward unchanged instead of silently skipping it.
    Historical snapshots also retain the player's team as known at that point.
    """
    history = defaultdict(list)
    rounds = []
    if round_calendar is None:
        round_calendar = [
            {"round": rnd, "date": str(singles[singles["round"].astype(int).eq(rnd)].iloc[0]["date"])}
            for rnd in sorted({int(value) for value in singles["round"]})
        ]

    def valid_rows(frame):
        if "valid_for_rating" not in frame:
            return frame
        valid = frame["valid_for_rating"].astype(str).str.casefold().isin({"true", "1", "yes"})
        return frame[valid]

    def teams_as_of(frame):
        counts = defaultdict(Counter)
        for _, row in frame.iterrows():
            counts[str(row.home_player)][str(row.home_team)] += 1
            counts[str(row.away_player)][str(row.away_team)] += 1
        return {player: team_counts.most_common(1)[0][0] for player, team_counts in counts.items()}

    previous = {}
    for item in round_calendar:
        rnd, date = int(item["round"]), str(item["date"])
        observed = singles[singles["round"].astype(int).le(rnd)].copy()
        current_round = valid_rows(singles[singles["round"].astype(int).eq(rnd)].copy())
        if len(valid_rows(observed)) and (len(current_round) or not previous):
            fitted_teams = teams_as_of(observed)
            fitted = website_rows(fit_power_ratings_from_df(observed), fitted_teams or player_teams)
            previous = {
                row["player"]: [rnd, row["rating"], row["se"], row["matches"], row.get("team", "")]
                for row in fitted
            }
        elif previous:
            previous = {
                player: [rnd, snap[1], snap[2], snap[3], snap[4] if len(snap) > 4 else player_teams.get(player, "")]
                for player, snap in previous.items()
            }
        for player, snap in previous.items():
            history[player].append(snap)
        rounds.append({"round": rnd, "date": date, "players": len(previous)})
    return {"rounds": rounds, "players": dict(history)}


def _short_set_win_probability(game_probability, *, green_ball=False):
    """Project a BRTA six-game set from an independent game probability."""
    p = float(np.clip(game_probability, 0.0, 1.0))
    q = 1.0 - p
    win = sum(math.comb(5 + lost, lost) * (p ** 6) * (q ** lost) for lost in range(5))
    five_all = math.comb(10, 5) * (p ** 5) * (q ** 5)
    if green_ball:
        # BRTA Green Ball is first to six games with no tiebreak. At 5-5,
        # the next game ends the set 6-5.
        return win + five_all * p
    continuation = p * p + 2 * p * q * p
    return win + five_all * continuation


def _singles_match_probability(home_rating, away_rating, rules):
    """Project one singles contest from displayed Power values."""
    rating_denominator = DISPLAY_SCALE * GAME_SCALE
    game_probability = float(expit((home_rating - away_rating) / rating_denominator))
    set_probability = _short_set_win_probability(
        game_probability, green_ball=bool(rules.get("green_ball", False))
    )
    if rules["format"] == "rubbers":
        match_probability = (
            set_probability * set_probability
            + 2 * set_probability * (1 - set_probability) * game_probability
        )
    else:
        match_probability = set_probability
    return game_probability, float(match_probability)


def matchup_matrix(single_rows, rules):
    """Precompute every current-model singles matchup in the section."""
    players = [
        {
            "player": row["player"],
            "team": row.get("team", ""),
            "rating": int(row["rating"]),
            "matches": int(row["matches"]),
        }
        for row in sorted(single_rows, key=lambda row: (-row["rating"], row["player"].casefold()))
    ]
    probabilities = []
    for home in players:
        row = []
        for away in players:
            if home["player"] == away["player"]:
                probability = 0.5
            else:
                _, probability = _singles_match_probability(home["rating"], away["rating"], rules)
            row.append(round(probability, 4))
        probabilities.append(row)
    projection = (
        "rubbers-best-of-three"
        if rules["format"] == "rubbers"
        else "green-ball-first-to-six"
        if rules.get("green_ball")
        else "short-set"
    )
    return {
        "players": players,
        "probabilities": probabilities,
        "projection": projection,
        "ratingDenominator": round(float(DISPLAY_SCALE * GAME_SCALE), 6),
    }


def results_expectation(singles, rating_history, player_teams, rules):
    """Compare actual singles results with genuinely pre-round expectations."""
    rows = singles[singles["status"].eq("Completed")].copy()
    if "valid_for_rating" in rows:
        rows = rows[rows["valid_for_rating"].astype(str).str.casefold().isin({"true", "1", "yes"})].copy()

    histories = rating_history.get("players", {})

    def rating_before(player, round_number):
        snapshots = histories.get(player, [])
        previous = [snapshot for snapshot in snapshots if int(snapshot[0]) < int(round_number)]
        return (int(previous[-1][1]), True) if previous else (int(DISPLAY_CENTRE), False)

    stats = defaultdict(lambda: {
        "matches": 0,
        "actualWins": 0,
        "expectedWins": 0.0,
        "actualGames": 0,
        "expectedGames": 0.0,
        "totalGames": 0,
        "coldStartMatches": 0,
    })
    match_rows = []

    sort_columns = [column for column in ("round", "fixture_id", "position") if column in rows.columns]
    for _, row in rows.sort_values(sort_columns).iterrows():
        rnd = int(row["round"])
        home, away = str(row.home_player), str(row.away_player)
        (home_rating, home_known), (away_rating, away_known) = rating_before(home, rnd), rating_before(away, rnd)
        game_probability, match_probability = _singles_match_probability(home_rating, away_rating, rules)
        home_games, away_games = int(row.home_games), int(row.away_games)
        total_games = home_games + away_games
        winner = str(row.winning_player)

        for player, actual_games, expected_win, expected_game_share, known in (
            (home, home_games, match_probability, game_probability, home_known),
            (away, away_games, 1 - match_probability, 1 - game_probability, away_known),
        ):
            item = stats[player]
            item["matches"] += 1
            item["actualWins"] += int(winner == player)
            item["expectedWins"] += expected_win
            item["actualGames"] += actual_games
            item["expectedGames"] += total_games * expected_game_share
            item["totalGames"] += total_games
            item["coldStartMatches"] += int(not known)

        match_rows.append({
            "fixtureId": str(row.fixture_id),
            "round": rnd,
            "date": str(row.date),
            "position": str(row.position),
            "home": home,
            "away": away,
            "homeRatingBefore": home_rating,
            "awayRatingBefore": away_rating,
            "homeHadPriorRating": home_known,
            "awayHadPriorRating": away_known,
            "homeWinProbability": round(match_probability, 4),
            "homeGameProbability": round(game_probability, 4),
            "winner": winner,
            "score": str(row.score),
        })

    player_rows = []
    for player, values in stats.items():
        expected_wins = round(values["expectedWins"], 3)
        wins_above = round(values["actualWins"] - values["expectedWins"], 3)
        actual_share = 100 * values["actualGames"] / values["totalGames"] if values["totalGames"] else 0.0
        expected_share = 100 * values["expectedGames"] / values["totalGames"] if values["totalGames"] else 0.0
        player_rows.append({
            "player": player,
            "team": player_teams.get(player, ""),
            "matches": values["matches"],
            "actualWins": values["actualWins"],
            "expectedWins": expected_wins,
            "winsAboveExpected": wins_above,
            "actualGameShare": round(actual_share, 1),
            "expectedGameShare": round(expected_share, 1),
            "gameShareAboveExpected": round(actual_share - expected_share, 1),
            "coldStartMatches": values["coldStartMatches"],
            "qualified": values["matches"] >= MIN_MATCHES,
            "resultsOverExpectationRank": None,
            "gameShareOverExpectationRank": None,
        })

    player_rows.sort(key=lambda row: (-row["winsAboveExpected"], -row["gameShareAboveExpected"], row["player"].casefold()))
    qualified_results = [row for row in player_rows if row["qualified"]]
    for rank, row in enumerate(qualified_results, 1):
        row["resultsOverExpectationRank"] = rank

    game_order = sorted(
        (row for row in player_rows if row["qualified"]),
        key=lambda row: (-row["gameShareAboveExpected"], -row["winsAboveExpected"], row["player"].casefold())
    )
    for rank, row in enumerate(game_order, 1):
        row["gameShareOverExpectationRank"] = rank

    projection = (
        "rubbers-best-of-three"
        if rules["format"] == "rubbers"
        else "green-ball-first-to-six"
        if rules.get("green_ball")
        else "short-set"
    )
    return {
        "players": player_rows,
        "matches": match_rows,
        "method": {
            "ratingState": "latest completed round strictly before each match",
            "unseenPlayerRating": int(DISPLAY_CENTRE),
            "rankingMinimumMatches": MIN_MATCHES,
            "matchProjection": projection,
        },
    }


def _position_number(value):
    match = re.search(r"\d+", str(value or ""))
    return int(match.group()) if match else None


def _oriented_score(score, home_side):
    text = str(score or "")
    if home_side:
        return text
    return re.sub(r"(\d+)(\s*[-–]\s*)(\d+)", lambda match: match.group(3) + match.group(2) + match.group(1), text)


def _score_profile(score, home_side):
    """Extract safe set/tiebreak signals from an official score string.

    TROLS score formats vary, so malformed or unrecognised strings simply
    contribute no set-level statistic rather than inventing an outcome.
    """
    text = str(score or "")
    plain = re.sub(r"[\(\[].*?[\)\]]", "", text)
    pairs = [(int(a), int(b)) for a, b in re.findall(r"(\d+)\s*[-–]\s*(\d+)", plain)]
    own_pairs = [(a, b) if home_side else (b, a) for a, b in pairs]
    match_tiebreak = bool(own_pairs and len(own_pairs) >= 3 and max(own_pairs[-1]) >= 10)
    normal = own_pairs[:-1] if match_tiebreak else own_pairs
    won_sets = sum(1 for mine, theirs in normal if mine > theirs)
    lost_sets = sum(1 for mine, theirs in normal if mine < theirs)
    tiebreaks = [(mine, theirs) for mine, theirs in normal if max(mine, theirs) == 7 and min(mine, theirs) == 6]
    straight = int(len(normal) == 2 and ((won_sets == 2 and lost_sets == 0) or (lost_sets == 2 and won_sets == 0)))
    deciding = int(match_tiebreak or len(normal) >= 3)
    return {
        "setsWon": won_sets, "setsLost": lost_sets,
        "tiebreaksWon": sum(1 for mine, theirs in tiebreaks if mine > theirs),
        "tiebreaksLost": sum(1 for mine, theirs in tiebreaks if mine < theirs),
        "decidingMatch": deciding, "straightSets": straight,
    }


def _record_summary(rows):
    wins = sum(1 for row in rows if row["result"] == "W")
    losses = sum(1 for row in rows if row["result"] == "L")
    draws = len(rows) - wins - losses
    games_for = sum(int(row.get("gamesFor", 0) or 0) for row in rows)
    games_against = sum(int(row.get("gamesAgainst", 0) or 0) for row in rows)
    return {
        "matches": len(rows), "wins": wins, "losses": losses, "draws": draws,
        "record": f"{wins}–{draws}–{losses}",
        "gamesFor": games_for, "gamesAgainst": games_against,
        "gameShare": round(100 * games_for / (games_for + games_against), 1) if games_for + games_against else None,
    }


def player_insights(singles, fixtures, expectation, player_teams):
    """Build readable player-role, volatility, score and rivalry evidence."""
    expected = {}
    for match in expectation.get("matches", []):
        expected[(str(match["fixtureId"]), str(match["home"]))] = {
            "rating": int(match["homeRatingBefore"]), "opponentRating": int(match["awayRatingBefore"]),
            "winProbability": float(match["homeWinProbability"]),
        }
        expected[(str(match["fixtureId"]), str(match["away"]))] = {
            "rating": int(match["awayRatingBefore"]), "opponentRating": int(match["homeRatingBefore"]),
            "winProbability": 1 - float(match["homeWinProbability"]),
        }

    completed_ties = Counter()
    for _, fixture in fixtures.iterrows():
        if str(fixture.get("status", "")) != "Completed":
            continue
        for team in (str(fixture.get("home_team", "")), str(fixture.get("away_team", ""))):
            if team and team != "Bye":
                completed_ties[team] += 1

    by_player = defaultdict(lambda: {
        "matches": [], "positions": defaultdict(list), "rivals": defaultdict(list),
        "emergencyAppearances": 0, "performanceDeltas": [], "score": Counter(),
    })
    for _, row in singles.iterrows():
        fixture_id = str(row["fixture_id"])
        home_player, away_player = str(row["home_player"]), str(row["away_player"])
        for home_side, player, opponent, team, emergency in (
            (True, home_player, away_player, str(row["home_team"]), row.get("home_emergency", "")),
            (False, away_player, home_player, str(row["away_team"]), row.get("away_emergency", "")),
        ):
            games_for = int(row["home_games"]) if home_side else int(row["away_games"])
            games_against = int(row["away_games"]) if home_side else int(row["home_games"])
            won = str(row["winning_player"]) == player
            prior = expected.get((fixture_id, player), {"rating": 1500, "opponentRating": 1500, "winProbability": 0.5})
            performance = round(prior["opponentRating"] + 450 * math.log((games_for + .5) / (games_against + .5)))
            position = _position_number(row["position"])
            entry = {
                "fixtureId": fixture_id, "round": int(row["round"]), "date": str(row["date"]),
                "position": position, "opponent": opponent, "result": "W" if won else "L",
                "score": _oriented_score(row["score"], home_side), "gamesFor": games_for, "gamesAgainst": games_against,
                "ratingAtTime": prior["rating"], "opponentRatingAtTime": prior["opponentRating"],
                "expectedWinProbability": round(prior["winProbability"], 4), "performance": performance,
                "performanceDelta": performance - prior["rating"],
            }
            item = by_player[player]
            item["matches"].append(entry)
            if position is not None:
                item["positions"][position].append(entry)
            item["rivals"][opponent].append(entry)
            item["emergencyAppearances"] += int(str(emergency).casefold() in {"true", "1", "yes"})
            item["performanceDeltas"].append(entry["performanceDelta"])
            shape = _score_profile(row["score"], home_side)
            for key, value in shape.items():
                item["score"][key] += value

    output = {}
    for player, item in by_player.items():
        matches = sorted(item["matches"], key=lambda row: (row["round"], row["fixtureId"], row["position"] or 99))
        deltas = item["performanceDeltas"]
        volatility = round(float(np.std(deltas)), 1) if len(deltas) >= 2 else None
        mean_delta = round(float(np.mean(deltas)), 1) if deltas else None
        positions = []
        for position, rows in sorted(item["positions"].items()):
            wins = sum(row["result"] == "W" for row in rows)
            games_for = sum(row["gamesFor"] for row in rows)
            games_against = sum(row["gamesAgainst"] for row in rows)
            positions.append({
                "position": position, "matches": len(rows), "wins": int(wins), "losses": len(rows) - int(wins),
                "record": f"{wins}–{len(rows) - int(wins)}", "gamesFor": games_for, "gamesAgainst": games_against,
                "gameShare": round(100 * games_for / (games_for + games_against), 1) if games_for + games_against else None,
                "expectedWins": round(sum(row["expectedWinProbability"] for row in rows), 2),
            })
        rivalries = []
        for opponent, rows in item["rivals"].items():
            rows = sorted(rows, key=lambda row: (row["round"], row["fixtureId"], row["position"] or 99))
            wins = sum(row["result"] == "W" for row in rows)
            games_for = sum(row["gamesFor"] for row in rows)
            games_against = sum(row["gamesAgainst"] for row in rows)
            rivalries.append({
                "opponent": opponent, "matches": len(rows), "wins": int(wins), "losses": len(rows) - int(wins),
                "record": f"{wins}–{len(rows) - int(wins)}", "gamesFor": games_for, "gamesAgainst": games_against,
                "expectedWins": round(sum(row["expectedWinProbability"] for row in rows), 2),
                "winsAboveExpected": round(wins - sum(row["expectedWinProbability"] for row in rows), 2),
                "rows": rows,
            })
        rivalries.sort(key=lambda row: (-row["matches"], row["opponent"].casefold()))
        score = item["score"]
        total_sets = score["setsWon"] + score["setsLost"]
        total_tb = score["tiebreaksWon"] + score["tiebreaksLost"]
        deciding_wins = sum(row["result"] == "W" for row in matches if _score_profile(row["score"], True)["decidingMatch"])
        deciding_losses = sum(row["result"] == "L" for row in matches if _score_profile(row["score"], True)["decidingMatch"])
        team = player_teams.get(player, "")
        average_position = round(float(np.mean([row["position"] for row in matches if row["position"] is not None])), 2) if any(row["position"] is not None for row in matches) else None
        output[player] = {
            "team": team, "roundsPlayed": len({row["fixtureId"] for row in matches}),
            "teamCompletedTies": int(completed_ties.get(team, 0)),
            "availabilityPercent": round(100 * len({row["fixtureId"] for row in matches}) / completed_ties[team], 1) if completed_ties.get(team) else None,
            "averageListedPosition": average_position, "emergencyAppearances": item["emergencyAppearances"],
            "positions": positions, "rivalries": rivalries,
            "consistency": {
                "matches": len(matches), "averagePerformanceDelta": mean_delta, "volatility": volatility,
                "score": round(100 / (1 + (volatility or 999) / 220)) if volatility is not None else None,
            },
            "scoreProfile": {
                "setsWon": score["setsWon"], "setsLost": score["setsLost"],
                "tiebreaksWon": score["tiebreaksWon"], "tiebreaksLost": score["tiebreaksLost"],
                "decidingWins": deciding_wins, "decidingLosses": deciding_losses,
                "straightSetMatches": score["straightSets"],
                "scoredMatches": len(matches),
            },
        }
    return output


def team_lineup_insights(fixtures, singles, doubles, rules):
    """Summarise real four-player lineups and doubles pairs from scored ties."""
    singles_by_fixture = defaultdict(list)
    doubles_by_fixture = defaultdict(list)
    for _, row in singles.iterrows():
        singles_by_fixture[str(row["fixture_id"])].append(row)
    for _, row in doubles.iterrows():
        doubles_by_fixture[str(row["fixture_id"])].append(row)
    by_team = defaultdict(list)
    for _, fixture in fixtures.iterrows():
        if str(fixture.get("status", "")) != "Completed":
            continue
        fixture_id = str(fixture["fixture_id"])
        winner = _fixture_winner(fixture, rules)
        for home_side, team, opponent in (
            (True, str(fixture["home_team"]), str(fixture["away_team"])),
            (False, str(fixture["away_team"]), str(fixture["home_team"])),
        ):
            if team == "Bye":
                continue
            player_column = "home_player" if home_side else "away_player"
            pair_column = "home_pair" if home_side else "away_pair"
            lineup_rows = sorted(singles_by_fixture.get(fixture_id, []), key=lambda row: (_position_number(row["position"]) or 99, str(row[player_column]).casefold()))
            lineup = [str(row[player_column]) for row in lineup_rows]
            pairs = [display_pair(row[pair_column]) for row in doubles_by_fixture.get(fixture_id, [])]
            result = "D" if winner is None else ("W" if winner == team else "L")
            games_for = int(fixture["home_games"]) if home_side else int(fixture["away_games"])
            games_against = int(fixture["away_games"]) if home_side else int(fixture["home_games"])
            by_team[team].append({
                "fixtureId": fixture_id, "round": int(fixture["round"]), "date": str(fixture["date"]),
                "opponent": opponent, "result": result, "gamesFor": games_for, "gamesAgainst": games_against,
                "score": f"{int(fixture['home_rubbers']) if home_side else int(fixture['away_rubbers'])}–{int(fixture['away_rubbers']) if home_side else int(fixture['home_rubbers'])}",
                "lineup": lineup, "pairs": pairs,
            })
    output = {}
    for team, rows in by_team.items():
        lineup_groups = defaultdict(list)
        pair_groups = defaultdict(list)
        for row in rows:
            if row["lineup"]:
                lineup_groups[" | ".join(row["lineup"])].append(row)
            for pair in row["pairs"]:
                if pair != "Not recorded":
                    pair_groups[canonical_pair(pair)].append(row)
        lineups = []
        for key, group in lineup_groups.items():
            summary = _record_summary(group)
            lineups.append({"players": key.split(" | "), **summary, "rows": sorted(group, key=lambda row: (row["round"], row["fixtureId"]))})
        pairs = []
        for key, group in pair_groups.items():
            summary = _record_summary(group)
            pairs.append({"pair": key, **summary, "rows": sorted(group, key=lambda row: (row["round"], row["fixtureId"]))})
        lineups.sort(key=lambda row: (-row["matches"], -row["wins"], row["players"]))
        pairs.sort(key=lambda row: (-row["matches"], -row["wins"], row["pair"]))
        output[team] = {
            "completedTies": len(rows), "lineupCount": len(lineups),
            "lineupStability": round(100 * lineups[0]["matches"] / len(rows), 1) if lineups and rows else None,
            "lineups": lineups, "pairs": pairs,
        }
    return output


def strength_of_schedule(singles, rating_map, player_teams):
    """Current-model average opponent rating, ranked across every participant."""
    opponents = defaultdict(list)
    for _, row in singles.iterrows():
        home, away = str(row.home_player), str(row.away_player)
        if away in rating_map:
            opponents[home].append(rating_map[away])
        if home in rating_map:
            opponents[away].append(rating_map[home])
    rows = [{"player": player, "team": player_teams.get(player, ""),
             "matches": len(values), "averageOpponent": round(float(np.mean(values)))}
            for player, values in opponents.items() if values]
    rows.sort(key=lambda row: (-row["averageOpponent"], -row["matches"], row["player"].casefold()))
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
        row["total"] = len(rows)
    return rows


def team_order_evidence(singles, rating_map, player_teams):
    # TROLS marks emergency players separately from the roster number; retain
    # that source ordering signal so inferred future line-ups list emergencies last.
    """Preserve official playing-order continuity for the predictor.

    ``precedence`` records every direct scorecard observation that one player
    was listed above another.  The client only uses this objective evidence;
    it never assumes a subjective preferred doubles partnership.
    """
    appearances = defaultdict(lambda: defaultdict(list))
    emergency_appearances = defaultdict(Counter)
    relations = defaultdict(Counter)
    for _, fixture in singles.groupby("fixture_id"):
        for team_col, player_col, emergency_col in (("home_team", "home_player", "home_emergency"),
                                                    ("away_team", "away_player", "away_emergency")):
            team = str(fixture.iloc[0][team_col])
            listed = []
            for _, row in fixture.iterrows():
                digits = "".join(ch for ch in str(row.position) if ch.isdigit())
                if not digits:
                    continue
                player, position = str(row[player_col]), int(digits)
                if player.startswith("[Unnamed "):
                    # A score is retained for transparency, but TROLS did not
                    # identify this person, so it cannot be a selectable
                    # future-lineup player.
                    continue
                emergency = str(row.get(emergency_col, "")).casefold() in {"true", "1", "yes"}
                appearances[team][player].append(position)
                emergency_appearances[team][player] += int(emergency)
                listed.append((emergency, position, player))
            # TROLS labels emergency entries with X/E but may still retain a
            # nominal roster number.  For an inferred selection order they
            # belong below every listed regular, while their actual scorecard
            # row remains untouched elsewhere in the data.
            listed.sort(key=lambda item: (item[0], item[1], item[2].casefold()))
            # Every later entry in this sorted official row is below the
            # current one.  Recording only this direction matters: adding
            # both directions would erase the precedence evidence entirely.
            for index, (_, _, player_a) in enumerate(listed):
                for _, _, player_b in listed[index + 1:]:
                    relations[team][(player_a, player_b)] += 1
    output = {}
    for team, players in appearances.items():
        roster = []
        for player, positions in players.items():
            emergency_only = emergency_appearances[team][player] == len(positions)
            roster.append({"player": player, "rating": rating_map.get(player, DISPLAY_CENTRE),
                           "appearances": len(positions), "averagePosition": round(float(np.mean(positions)), 2),
                           "emergencyOnly": emergency_only})
        # An actual named substitute is still a real player and keeps their
        # official result, but a player who has only appeared as an emergency
        # never becomes the default No. 1 in a future fixture prediction.
        roster.sort(key=lambda row: (row["emergencyOnly"], row["averagePosition"], -row["appearances"], row["player"].casefold()))
        output[team] = {"players": roster,
                        "precedence": [{"above": a, "below": b, "count": count}
                                       for (a, b), count in relations[team].items()]}
    return output

def sync_meta(metadata, fixtures):
    status = json.loads((DATA_DIR / "sync_status.json").read_text()) if (DATA_DIR / "sync_status.json").exists() else {}
    check = json.loads((DATA_DIR / "last_check.json").read_text()) if (DATA_DIR / "last_check.json").exists() else {}
    updated = None
    raw = metadata.get("results_loaded_by_trols")
    if raw:
        try:
            cleaned = raw.replace("st ", " ").replace("nd ", " ").replace("rd ", " ").replace("th ", " ")
            dt = datetime.strptime(cleaned, "%d %B %y @ %I:%M:%S %p").replace(tzinfo=ZoneInfo("Australia/Melbourne"))
            updated = dt.isoformat()
        except ValueError:
            pass
    return {
        "checkedAt": check.get("checked_at_utc") or status.get("synced_at_utc"),
        "updatedAt": updated,
        "latestRound": metadata.get("latest_round"),
        "validation": metadata.get("validation"),
        "newResultsLastCheck": bool(check.get("new_results", False)),
        "missingFixtures": int(sum(1 for _, r in fixtures.iterrows() if str(r.status) == "Missing Result")),
        "resultsLoadedByTrols": raw,
    }

def round_overview(fixtures, singles, doubles, rating_map, rating_history=None):
    completed_rounds=sorted(set(int(x) for x in singles["round"]))
    latest=max(completed_rounds)
    fx=fixtures[fixtures["round"].astype(int).eq(latest)].copy()
    round_label=str(fx.iloc[0].get("round_label", "") or "") if len(fx) else ""
    if round_label.casefold() in {"nan", "none"}: round_label=""
    if not round_label: round_label=f"Round {latest}"
    sr=singles[singles["round"].astype(int).eq(latest)].copy()
    fixture_cards=[]
    for _,r in fx.iterrows():
        card={"fixtureId":str(r.fixture_id),"home":str(r.home_team),"away":str(r.away_team),"status":str(r.status)}
        if str(r.status)=="Completed":
            card.update({"homeRubbers":int(r.home_rubbers),"awayRubbers":int(r.away_rubbers),
                         "homeGames":int(r.home_games),"awayGames":int(r.away_games)})
            home_sets, away_sets=_number(r.home_sets), _number(r.away_sets)
            home_sets, away_sets=(home_sets, away_sets) if home_sets is not None and away_sets is not None else (int(r.home_rubbers), int(r.away_rubbers))
            if home_sets>away_sets or (home_sets==away_sets and int(r.home_games)>int(r.away_games)):
                card["winner"]=str(r.home_team)
            elif away_sets>home_sets or (home_sets==away_sets and int(r.away_games)>int(r.home_games)):
                card["winner"]=str(r.away_team)
            else: card["winner"]="Draw"
        fixture_cards.append(card)
    performances=[]; upsets=[]
    for _,r in sr.iterrows():
        hp,ap=str(r.home_player),str(r.away_player); hg,ag=int(r.home_games),int(r.away_games)
        winner=str(r.winning_player)
        loser=ap if winner==hp else hp
        gf,ga=(hg,ag) if winner==hp else (ag,hg)
        wr,lr=rating_map.get(winner,1500),rating_map.get(loser,1500)
        perf=round(lr+450*math.log((gf+.5)/(ga+.5)))
        item={"winner":winner,"loser":loser,"score":f"{gf}–{ga}","winnerRating":wr,"loserRating":lr,
              "gap":lr-wr,"performance":perf,"margin":gf-ga}
        performances.append(item)
        if wr<lr: upsets.append(item)
    top=max(performances,key=lambda x:x["performance"]) if performances else None
    upset=max(upsets,key=lambda x:x["gap"]) if upsets else None
    dominant=max(performances,key=lambda x:(x["margin"],x["performance"])) if performances else None
    closest=min(performances,key=lambda x:(x["margin"],-x["performance"])) if performances else None
    date_value=sr.iloc[0]["date"] if len(sr) else (fx.iloc[0]["date"] if len(fx) else "")
    date="" if pd.isna(date_value) else str(date_value or "")
    completed_cards=[card for card in fixture_cards if card["status"]=="Completed"]
    average_margin=round(float(np.mean([abs(int(row.home_games)-int(row.away_games))
                                        for _, row in sr.iterrows()])), 1) if len(sr) else None
    movers=[]
    if rating_history and latest > min(item["round"] for item in rating_history["rounds"]):
        for player, values in rating_history["players"].items():
            current=next((value for value in values if value[0]==latest), None)
            previous=next((value for value in reversed(values) if value[0]<latest), None)
            if current and previous:
                movers.append({"player":player,"change":current[1]-previous[1],"rating":current[1]})
    movers.sort(key=lambda row:(-row["change"],row["player"].casefold()))
    return {"round":latest,"label":round_label,"date":date,"fixtures":fixture_cards,"topPerformance":top,
            "biggestUpset":upset,"dominantWin":dominant,"closestMatch":closest,
            "summary":{"completedFixtures":len(completed_cards),"singlesRubbers":len(sr),
                       "doublesRubbers":int(doubles["round"].astype(int).eq(latest).sum()),
                       "averageSinglesMargin":average_margin,
                       "topMover":movers[0] if movers else None,
                       "biggestDrop":min(movers,key=lambda row:row["change"]) if movers else None}}

def result_rounds(fixtures, singles, doubles, rules):
    rubbers=defaultdict(list)
    for discipline,df,home_col,away_col,winner_col,home_emergency_col,away_emergency_col in (
        ("Singles",singles,"home_player","away_player","winning_player","home_emergency","away_emergency"),
        ("Doubles",doubles,"home_pair","away_pair","winning_pair","home_emergencies","away_emergencies"),
    ):
        for _,r in df.iterrows():
            def emergency_flags(column):
                value=r.get(column, "")
                if discipline == "Doubles":
                    try:
                        parsed=json.loads(value) if isinstance(value,str) else value
                        return [bool(flag) for flag in parsed] if isinstance(parsed,list) else [False,False]
                    except (TypeError, ValueError, json.JSONDecodeError):
                        return [False,False]
                return [str(value).casefold() in {"true","1","yes"}]
            home_flags=emergency_flags(home_emergency_col)
            away_flags=emergency_flags(away_emergency_col)
            item={
                "type":discipline,"position":str(r.position),
                "home":display_pair(r[home_col]) if discipline=="Doubles" else str(r[home_col]),
                "away":display_pair(r[away_col]) if discipline=="Doubles" else str(r[away_col]),
                "winner":str(r[winner_col]),"score":str(r.score),
                "homeEmergency":any(home_flags),
                "awayEmergency":any(away_flags),
            }
            if discipline=="Doubles":
                item["homeEmergencies"]=home_flags
                item["awayEmergencies"]=away_flags
            rubbers[str(r.fixture_id)].append(item)
    by_round=defaultdict(list)
    for _,r in fixtures.iterrows():
        if str(r.home_team)=="Bye" or str(r.away_team)=="Bye": continue
        stage=str(r.get("stage", "regular") or "regular")
        label=str(r.get("round_label", "") or "")
        if label.casefold() in {"nan", "none"}: label=""
        if not label:
            label={"semi_final":"Semi-final", "grand_final":"Grand final"}.get(stage.casefold(), f"Round {int(r['round'])}")
        date="" if pd.isna(r.get("date")) else str(r.get("date", ""))
        match={"fixtureId":str(r.fixture_id),"date":date,"round":int(r["round"]),"label":label,"stage":stage,
               "home":str(r.home_team),"away":str(r.away_team),"status":str(r.status),
               "rubbers":rubbers.get(str(r.fixture_id),[])}
        home_points, away_points=fixture_points(r, rules)
        if home_points is not None and away_points is not None:
            match.update({"homePoints":home_points,"awayPoints":away_points})
        if str(r.status)=="Completed":
            match.update({"homeRubbers":int(r.home_rubbers),"awayRubbers":int(r.away_rubbers),
                          "homeSets":_number(r.home_sets),"awaySets":_number(r.away_sets),
                          "homeGames":int(r.home_games),"awayGames":int(r.away_games)})
        by_round[int(r["round"])].append(match)
    return [{"round":rnd,"label":matches[0].get("label", f"Round {rnd}"),"stage":matches[0].get("stage", "regular"),
             "date":matches[0]["date"],"fixtures":matches} for rnd,matches in sorted(by_round.items(),reverse=True)]


def build_section(meta, *, sections_dir=None):
    section_dir=(sections_dir or SECTIONS_DIR)/meta["section_code"]
    singles=pd.read_csv(section_dir/"singles.csv")
    doubles=pd.read_csv(section_dir/"doubles.csv")
    fixtures=pd.read_csv(section_dir/"fixtures.csv")
    draw=pd.read_csv(section_dir/"draw.csv")
    if "stage" not in fixtures: fixtures["stage"]="regular"
    if "round_label" not in fixtures: fixtures["round_label"]=""
    if "stage" not in draw: draw["stage"]="regular"
    if "round_label" not in draw: draw["round_label"]=""
    # A team's official draw page is the authoritative regular-season order.
    # TROLS publishes knockout matches on its Results page instead, so retain
    # those exact source rows in the fixture calendar when the draw omits them.
    if len(fixtures):
        draw_keys={(int(row["round"]),str(row["home_team"]),str(row["away_team"])) for _,row in draw.iterrows()}
        playoff_rows=[]
        for _,row in fixtures.iterrows():
            stage=str(row.get("stage", "regular") or "regular").casefold()
            if stage not in {"semi_final","semi-final","grand_final","grand-final"}:
                continue
            key=(int(row["round"]),str(row["home_team"]),str(row["away_team"]))
            if key in draw_keys: continue
            playoff_rows.append({
                "draw_id":str(row.get("fixture_id", "")),
                "date":"" if pd.isna(row.get("date")) else str(row.get("date", "")),
                "round":int(row["round"]),"stage":stage,
                "round_label":str(row.get("round_label", "") or ""),
                "home_team":str(row["home_team"]),"away_team":str(row["away_team"]),
                "fixture_id":str(row.get("fixture_id", "")),
            })
        if playoff_rows:
            draw=pd.concat([draw,pd.DataFrame(playoff_rows)],ignore_index=True)
    singles=singles[singles.status.eq("Completed")].copy()
    doubles=doubles[doubles.status.eq("Completed")].copy()
    rules=brta_scoring_rules(meta)
    player_teams,pair_teams=team_maps(singles,doubles)
    standard_doubles=standard_doubles_rows(doubles)
    nonstandard_doubles=[{
        "fixtureId":str(row.fixture_id),"position":str(row.position),"score":str(row.score),
        "home":display_pair(row.home_pair),"away":display_pair(row.away_pair),
    } for _,row in doubles.iterrows()
      if len(pair_members(row.home_pair))!=2 or len(pair_members(row.away_pair))!=2]
    sr=fit_power_ratings_from_df(singles)
    pr=fit_pairs(standard_doubles)
    dr=fit_individual_doubles(standard_doubles, rubbers_format=rules["format"]=="rubbers")
    srows=website_rows(sr,player_teams)
    prows=website_rows(pr,pair_teams)
    drows=website_rows(dr,player_teams)
    individual_power={x["player"]:x["rating"] for x in drows}
    pair_synergy=fit_pair_synergies(standard_doubles,individual_power) if len(standard_doubles) else {}
    for pair in prows:
        members=pair_members(pair["player"])
        pair["individualAverage"]=round(sum(individual_power[p] for p in members)/len(members))
        pair["pairEffect"]=pair["rating"]-pair["individualAverage"]
        pair["pairSynergy"]=round(pair_synergy.get(pair["player"],0))
    rmap={x["player"]:x["rating"] for x in srows}
    latest_round=int(meta.get("latest_round") or (fixtures["round"].astype(int).max() if len(fixtures) else 0))
    round_calendar=[]
    for rnd in sorted({int(value) for value in draw["round"] if int(value) <= latest_round}):
        group=draw[draw["round"].astype(int).eq(rnd)]
        row=group.iloc[0]
        date="" if pd.isna(row.get("date")) else str(row.get("date", ""))
        label=str(row.get("round_label", "") or "")
        if label.casefold() in {"nan", "none"}: label=""
        round_calendar.append({"round":rnd,"date":date,"label":label})
    if not round_calendar and len(fixtures):
        for rnd in sorted({int(value) for value in fixtures["round"] if int(value) <= latest_round}):
            row=fixtures[fixtures["round"].astype(int).eq(rnd)].iloc[0]
            date="" if pd.isna(row.get("date")) else str(row.get("date", ""))
            label=str(row.get("round_label", "") or "")
            if label.casefold() in {"nan", "none"}: label=""
            round_calendar.append({"round":rnd,"date":date,"label":label})
    history=round_rating_history(singles,player_teams,round_calendar)
    matchup=matchup_matrix(srows,rules)
    expectation=results_expectation(singles,history,player_teams,rules) if len(singles) else {"players":[],"matches":[]}
    schedule=strength_of_schedule(singles,rmap,player_teams)
    insights=player_insights(singles,fixtures,expectation,player_teams)
    team_insights=team_lineup_insights(fixtures,singles,doubles,rules)
    schedule_by_player={row["player"]:row for row in schedule}
    for row in srows:
        row.update({"averageOpponent":schedule_by_player.get(row["player"],{}).get("averageOpponent"),
                    "scheduleRank":schedule_by_player.get(row["player"],{}).get("rank"),
                    "scheduleTotal":schedule_by_player.get(row["player"],{}).get("total")})

    standings=apply_official_standings(reconstructed_standings(fixtures,rules),meta.get("official_standings", []))
    knockout=knockout_summary(fixtures,standings,rules,meta)
    team_data=team_rows(srows,fixtures,rules)
    ladder_points={row["team"]:row["points"] for row in standings}
    for team in team_data:
        if team["team"] in ladder_points:
            team["ladder"]=ladder_points[team["team"]]
    archive_note=("Historical season. Ratings use the current published V3 model on TROLS-entered results; standings use TROLS' final ladder where available."
                  if meta.get("is_archive") else
                  "Team Power uses every modelled singles player; low-sample ratings are regularised toward the section centre. Standings use official TROLS points and current BRTA scoring rules for unresolved washouts and forfeits.")
    payload={
        "meta":meta,
        "singles":srows,
        "doubles":prows,
        "doublesIndividuals":drows,
        "singlesMatches":singles_match_array(singles),
        "ratingHistory":history,
        "matchupMatrix":matchup,
        "resultsExpectation":expectation,
        "strengthOfSchedule":schedule,
        "playerInsights":insights,
        "teamInsights":team_insights,
        "teamOrderEvidence":team_order_evidence(singles,rmap,player_teams),
        "format":rules["format"],
        "greenBall":bool(rules.get("green_ball",False)),
        "teams":team_data,
        "note":archive_note,
        "roundOverview":round_overview(fixtures,singles,doubles,rmap,history) if len(singles) else None,
        "standings":standings,
        "knockout":knockout,
        "results":result_rounds(fixtures,singles,doubles,rules),
        "upcomingFixtures":draw_fixtures(draw,fixtures,rules),
        "sync":sync_meta(meta,fixtures),
    }
    if nonstandard_doubles:
        payload["dataQuality"]={
            "nonstandardDoubles":nonstandard_doubles,
            "note":"Official TROLS doubles results with a side that does not list exactly two players remain in Results, but are excluded from doubles rating calculations because the pairing is ambiguous.",
        }
    qualified=[row for row in srows if row["matches"]>=MIN_MATCHES]
    if qualified:
        leader=qualified[0]; runner=qualified[1] if len(qualified)>1 else None
        payload["leader"]={"player":leader["player"],"team":leader["team"],"rating":leader["rating"],
                           "matches":leader["matches"],"wins":leader["wins"],"losses":leader["losses"],
                           "dominanceGap":leader["rating"]-DISPLAY_CENTRE,
                           "runnerUpGap":leader["rating"]-(runner["rating"] if runner else DISPLAY_CENTRE),
                           "expectedGameShare":round(100*float(expit((leader["rating"]-DISPLAY_CENTRE)/450)),1)}
    return payload

def main():
    catalog_doc=json.loads((DATA_DIR/"catalog.json").read_text(encoding="utf-8"))
    SITE_SECTIONS_DIR.mkdir(parents=True,exist_ok=True)
    section_payloads={}
    catalog=[]
    for meta in catalog_doc["sections"]:
        payload=build_section(meta)
        code=meta["section_code"]
        section_payloads[code]=payload
        summary={**meta}
        if payload.get("leader"): summary["leader"]=payload["leader"]
        catalog.append(summary)
        (SITE_SECTIONS_DIR/f"{code}.json").write_text(json.dumps(payload,separators=(",",":"),ensure_ascii=False,allow_nan=False)+"\n",encoding="utf-8")
        print(f"Wrote {code}: {len(payload['singles'])} singles ratings")
    global_players=[]
    for meta in catalog:
        payload=section_payloads[meta["section_code"]]
        smap={row["player"]:row for row in payload.get("singles",[])}
        dmap={row["player"]:row for row in payload.get("doublesIndividuals",[])}
        for player in sorted(set(smap)|set(dmap),key=str.casefold):
            s=smap.get(player); d=dmap.get(player)
            both=bool(s and d)
            overall=round((s["rating"]+d["rating"])/2) if both else (s or d or {}).get("rating")
            overall_se=round(math.hypot(s["se"],d["se"])/2) if both else (s or d or {}).get("se")
            global_players.append({
                "player":player,
                "team":(s or d or {}).get("team",""),
                "sectionCode":meta["section_code"],
                "sectionLabel":meta["section_label"],
                "competitionCode":meta["competition_code"],
                "competitionLabel":meta["competition_label"],
                "singlesRating":s.get("rating") if s else None,
                "singlesSe":s.get("se") if s else None,
                "singlesMatches":s.get("matches") if s else 0,
                "singlesWins":s.get("wins") if s else 0,
                "singlesLosses":s.get("losses") if s else 0,
                "singlesGf":s.get("gf") if s else 0,
                "singlesGa":s.get("ga") if s else 0,
                "doublesRating":d.get("rating") if d else None,
                "doublesSe":d.get("se") if d else None,
                "doublesMatches":d.get("matches") if d else 0,
                "doublesWins":d.get("wins") if d else 0,
                "doublesLosses":d.get("losses") if d else 0,
                "doublesGf":d.get("gf") if d else 0,
                "doublesGa":d.get("ga") if d else 0,
                "doublesQualified":bool(d.get("qualified")) if d else False,
                "doublesStatus":d.get("ranking_status") if d else None,
                "overallRating":overall,
                "overallSe":overall_se,
                "overallQualified":bool(s and s.get("matches",0)>=MIN_MATCHES and d and d.get("qualified")),
            })

    leaders=[{**row["leader"],"sectionCode":row["section_code"],"sectionLabel":row["section_label"],
              "competitionCode":row["competition_code"],"competitionLabel":row["competition_label"]}
             for row in catalog if row.get("leader")]
    leaders.sort(key=lambda row:(-row["expectedGameShare"],-row["runnerUpGap"],row["sectionCode"]))
    for rank,row in enumerate(leaders,1): row["dominanceRank"]=rank
    model={
        "version":"V3","centre":int(DISPLAY_CENTRE),"displayScale":int(DISPLAY_SCALE),
        "singlesMinMatches":MIN_MATCHES,"doublesMinMatches":MIN_DOUBLES_MATCHES,
        "doublesIndividualMinMatches":INDIVIDUAL_DOUBLES_MIN,
        "doublesIndividualMinPartners":INDIVIDUAL_DOUBLES_MIN_PARTNERS,
        "overallRule":"50/50 average of singles and individual doubles ratings; ranked overall requires 4 singles matches and a publishable doubles contribution. In two-player Rubbers sections that doubles component is labelled partner-dependent.",
        "doublesIndividualRule":"Individual doubles is partner-adjusted and experimental. Sets and Green Ball ranking requires 4 appearances, 2 distinct partners and no exact unresolved direction. Two-player Rubbers sections publish 4+ appearance pair-dependent evidence with that limitation shown.",
        "pairSynergyRule":"Exploratory, conditional pair-effect signal. It is strongly regularised (lambda=50) and does not affect the published singles, individual-doubles, Overall or Team Power ratings.",
        "dominanceRule":"Section leaders are ranked by expected game share against their own section's 1500-rated average player. This measures within-section dominance, not absolute strength between disconnected sections.",
        "matchupMatrixRule":"Dense current-model player-v-player singles win probabilities, ordered by the accompanying player axis and projected with the same short-set / Rubbers match logic as fixture predictions.",
        "resultsExpectationRule":"Actual singles wins and game share compared with expectations from the latest rating snapshot strictly before each round; unseen players start at 1500 and ranking requires 4 matches.",
    }
    global_sync=json.loads((DATA_DIR/"sync_status.json").read_text()) if (DATA_DIR/"sync_status.json").exists() else {}
    check=json.loads((DATA_DIR/"last_check.json").read_text()) if (DATA_DIR/"last_check.json").exists() else {}
    data={"catalog":catalog,"leaders":leaders,"globalPlayers":global_players,"model":model,"globalSync":{**global_sync,"checkedAt":check.get("checked_at_utc") or global_sync.get("synced_at_utc"),"newResultsLastCheck":bool(check.get("new_results",False))},
          "defaultSectionCode":DEFAULT_SECTION}
    OUT.write_text("const DATA="+json.dumps(data,separators=(",",":"),ensure_ascii=False,allow_nan=False)+";\n",encoding="utf-8")
    print(f"Wrote {OUT}: {len(catalog)} sections and {len(leaders)} qualified section leaders")

if __name__=="__main__":
    main()
