# ATP Cup

A static analytics application for a fictional alternate-history professional tennis competition. The **Race to ATP Cup** is the regular-season qualification race; the top eight advance to **ATP Cup Finals**.

## Content belongs to the administrator

**No team, player, roster, fixture, result, venue, surface assignment or host city is embedded in application code.** The initial `data/events.json` contains only the 18 teams and 2017 season/hosting facts supplied by the administrator. Players, registrations and fixtures start empty. No match results or player ability are invented.

Names and all metadata can be changed in Manual data. There is no external sporting-results source, scheduled data collection or client-side repository credential. The only workflow validates, builds and publishes checked-in manual data on a push or manual invocation.

## Architecture

`data/events.json` → normalization and validation → fixture calculations → records / standings / ratings → UI.

The versioned JSON package has these collections:

- `config`: application names and global rules overrides.
- `seasons`: dates, team IDs, seasonal rules, venue overrides and Finals hosting.
- `teams`: stable identity and editable metadata, including aliases, colours, venues, surfaces, logos and history.
- `players`: identity, nationality, optional birthdate, handedness, aliases and photo. No permanent team field.
- `rosters`: season/team/player registrations, roster order, neutral S/C/D classification, active status and optional registration dates.
- `fixtures`: dates, stages, home/away teams, venue, surface, neutral host, squads and normalized rubbers. Results are nested within their authoritative fixture; totals are never entered separately.

The normalized score stores normal `sets` separately from `matchTiebreak`. IDs remain stable after a display-name change or transfer. Adding metadata does not require changing UI code: use a record’s Additional metadata field or the advanced package editor.

## Manual entry

1. Open **Manual data → Seasons** to add a season and register its teams.
2. Add/edit teams and players. Enter venue and home surface; the seed intentionally does not invent them.
3. Open **Rosters** to register each player with roster position and S/C/D career designation. The default composition is 2 S, 6 C, 4 D. Career type never assigns skill or preferential badge status.
4. Open **Fixture editor**, create a stable fixture ID, choose its date, round, teams, stage and status. Regular fixtures inherit the entered home venue/surface; overrides are supported.
5. Select eight unique rostered players on each side. Assign four singles and four doubles pairs; the pairs collectively use all eight players once.
6. Enter scores **from the home side’s perspective**, for example `6-4 3-6 6-2` or `6-4 3-6 [10-7]`. Winner normally derives from score. Retirement, walkover and default require an explicit winner.
7. Review the live rubbers/sets/games summary, set status to Completed and save. The audit blocks invalid entries. All tables and profiles rebuild automatically.
8. Export `events.json` and replace `data/events.json` in the repository. Commit normally to publish. ChatGPT’s authenticated GitHub integration can commit it when requested; the deployed site does not write to GitHub.

**Save is local to this browser, not publication.** A Local draft badge identifies local data. Browser storage retains a previous local save. Export a backup for durable preservation; local storage is not a remote account or multi-device sync. The Published data button discards the local draft and loads repository data after confirmation.

Data & rules provides Import JSON, Export JSON, Backup all data, Restore backup, previous-save restoration, a readable audit and a complete validated JSON editor. Imports must use the versioned package; results are normalized before adoption. Invalid imports leave the current dataset intact.

## Rules and scoring

Defaults live in `src/config.js`. All can be overridden in `config.rules` and then per-season `rules`. Application names live in `config`, not in team or result logic.

Defaults: 18 teams, 12 roster positions, 8 selected players, 4 singles + 4 doubles, 34 regular rounds and 8 Finals places. Race points default to 3/1/0. Sporting table tiebreaks default to points, rubber differential, set differential, game differential, then fixture wins. Equal sporting totals are marked with an asterisk; stable ID order is only display order. A tie at the qualification boundary does not silently lock seeds.

Singles is best of three normal sets. Doubles uses two normal sets and, at 1–1, a match tiebreak to 10 with a two-point margin. A normal 7–6 set contributes 7–6 games. A deciding doubles `[10-7]` contributes **one set and 2–0 fixture games**. Actual tiebreak points are stored separately. Walkovers/defaults contribute a rubber outcome without invented played sets/games; retirements retain actually entered games and complete sets.

Fixture winner: **rubbers → sets → games → true draw**. Exact knockout ties are flagged and await a manual winner plus procedure note. There is no coin flip or hidden permanent deciding rule.

Regular schedule data is entered manually. The audit detects repeated home/away pairings, duplicate teams in a round, missing/extra rubbers and incomplete schedule coverage. No automatic schedule or results generator runs. Postponements use status `postponed`; edit the date to reschedule and optionally retain `originalDate` and `rescheduleHistory` metadata through the advanced editor.

## ATP Cup Finals

Default QFs are 1–8 and 4–5 on one side; 2–7 and 3–6 on the other. Bracket slots are QF 1–4, SF 1–2, Final 1. Semifinal participants come from QF 1/2 and 3/4 respectively. Completed knockout fixtures must match qualification and preceding winners.

`season.finals.cycle` stores a two-year cycle with `startYear`, `endYear`, `hostA` and `hostB`, each with city, venue and surface. The default final-host order is B in year one, A in year two. Finals dates are entered in `season.finals.dates`, including a two-date quarterfinal array, semifinal date and final date. Every actual Finals fixture carries its own host and venue. Finals surfaces are restricted to Hard/Indoor Hard.

Seeds automatically lock once the full regular schedule has completed and the cutoff is unambiguous. Optional `season.finals.seeds` provides explicit sporting resolution of equal table totals, but cannot include a team below the qualifying cutoff. Qualification labels use conservative mathematical bounds; undecided ties remain in contention.

## Ratings

The adapted V3 model fits one game-score likelihood, not a second win/loss reward:

```
p = logistic((theta_home - theta_away) / 0.75)
weight = 2 ** (-age_days / 365)
maximize sum(weight * (home_games * log(p) + away_games * log(1-p)))
         - (5 / 2) * sum(theta ** 2)
Power = 1500 + 600 * theta
```

The implementation uses sparse Newton / conjugate-gradient optimization in JavaScript. Standard errors use a Laplace covariance from the full Hessian, centered on the displayed mean-zero strength scale. Ratings include only entered ATP Cup rubbers; no individual-tour results are imported. Walkovers/defaults are excluded from rating evidence. Retirement inclusion is configurable and defaults off. Doubles match tiebreak evidence follows the configured 2–0 game equivalent and never counts 10 points as games.

Singles fits individual strengths. Doubles fits the mean of the two players’ strengths. Pairs additionally have a separate stable partnership fit. Individual doubles is explicitly partner-dependent when the recorded network cannot distinguish contributors; this diagnostic is conservative across disconnected networks. Pair histories persist across seasons and team changes because partnership keys use player IDs.

Overall is the 50/50 average when both disciplines exist; with one discipline it uses that discipline and states the coverage. No-sample players have no published rating. Standard error, sample count and small-sample labels remain visible. Overall SE combines fitted discipline SEs assuming independence; it is a descriptive combined view, not a third fitted ability model.

Fits replay chronologically after corrections. Historical views stop at their selected season cutoff. Ratings carry prior ATP Cup evidence with recency weighting; W–L evidence in rating rows is the available cumulative training sample. Season player/team records remain season-specific. Opponent-strength summaries use selected-season snapshot ratings, not pre-match ability estimates.

The calculation worker keeps costly work off the rendering thread, and the UI caches a derived season until content changes. Build generates optional precomputed derived snapshots. Data content hashes invalidate them after corrections.

## Pages

Overview, Results, Race, Singles/Doubles/Overall/Pair Ratings, Teams, Fixtures, Finals and Manual data. Player Lab includes season and career records, uncertainty, rating chart and numerical history, opponent records, partnerships, surfaces, home/away form and clickable rubber logs. Team pages include metadata, full roster, leaders, surface/home-away records, opposition and remaining schedule strength, season schedules and history. Native dialogs, mobile table scrolling, safe areas, light/dark themes, deep links and a versioned offline shell are supported.

Use `?season=2017&tab=standings` or `?season=2017#/standings`. Profiles link with `#/player/<id>`, `#/team/<id>` and `#/fixture/<id>`. Global search respects selected-season player context and links fixtures to their own season.

Prediction Center accepts singles and doubles assignments from a roster. It publishes the rubber-level estimate separately from an explicitly experimental fixture simulation, which uses the actual rubbers/sets/games hierarchy. The independent-game/tiebreak approximation is not calibrated to this fictional competition; no forecast is shown without rating evidence. Displayed probabilities are rounded.

## Local development and deployment

Node 20+ and Python 3:

```sh
npm ci
npm test
npm run audit
npm run build
npm run serve
```

Open `http://localhost:8080`. Root files work directly on static hosting; `dist/` is the validated publishable build.

Browser tests require Playwright’s Chromium runtime and a running local server:

```sh
npx playwright install chromium
npm run test:browser
```

The GitHub workflow performs engine tests, audit, build and browser integration tests before publishing `dist/` through Pages. In repository Settings → Pages, choose GitHub Actions if it is not already configured. It has no scheduled trigger and does not download sporting data. Service-worker activation clears only this site’s scoped cache entries, preserving neighboring applications on the same origin; each response is network-first, with an offline fallback. Bump its cache version when changing the shell inventory.

## Backup, migration and limitations

Keep exported packages and git commits as durable backups. Restore with Import JSON/Restore backup. Raw identity, fixtures and sporting scores are authoritative; rebuilds replace derived totals, so a correction cannot double-count a prior score.

The prior source application’s section datasets, ingestion scripts, generated caches, secret assets and source-specific UI were removed from this copy. Old source data is not converted into fictional results. Existing history in git remains available, but none of that code/data ships in the current tree.

Intentional limits: no server-side accounts or remote writes; no invented 2017 player assignments/schedule/results; no automated transfers, promotion/relegation or individual-tour integration; no calibrated surface-specific rating fit; and no automatic knockout deciding mechanism. Neutral-host venues and home surfaces await administrator input. Team-strength measures average available roster ratings and do not estimate an optimal selected lineup. Titles credit registered membership rather than requiring a Finals appearance by every credited player. Default bracket rendering currently targets an eight-team Finals; expansion requires a new configured bracket topology and corresponding UI validation.
