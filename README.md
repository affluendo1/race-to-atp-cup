# BRTA Power Ratings

[Open the live site](https://affluendo1.github.io/brta-power-ratings/)

BRTA Power Ratings is an unofficial analytics site for BRTA Saturday AM and Sunday AM junior tennis. It is not affiliated with BRTA, Tennis Australia or UTR. Match records come from TROLS and are treated as official-as-entered records; the site does not claim that a nominated player was necessarily the player who physically took the court.

## What the site does

The site lets you select a competition, season and section, then view that section's results, standings, ratings, team summaries and fixtures. Each section is fitted as its own opponent network. Ratings from different sections are not a combined ranking and should not be compared as if the players had all played one another.

The five main views are:

- **Results** — round-by-round fixture results and scorecards, including singles and doubles order where TROLS provides it. A bye occupies its own card in seven-team rounds.
- **Standings** — current-season ladder calculations, or the published final TROLS ladder for an archived season when one is available. The standings view also shows recorded or projected semifinals and grand finals.
- **Ratings** — singles, recurring doubles pairs, individual doubles and Overall tables. Player rows open Player Lab.
- **Teams** — average modelled singles Power and the average of each team's four strongest modelled singles ratings.
- **Fixtures** — the official TROLS draw, including completed and future fixtures. A recorded fixture opens its result; a scheduled fixture opens the Prediction Centre. Upcoming rounds have a button to simulate their scheduled ties.

Other views are opened from the header or player profiles:

- **Player Lab** includes the player's matchup outlook, actual-versus-expected results, schedule difficulty, form, rating history and doubles evidence. Historical Player Lab views use the selected round's ratings and results.
- **Club Zone** combines colour-suffixed teams into one club and shows its complete Saturday or Sunday AM archive, with club totals and filterable section-by-section standings.
- **Latest round** summarizes the latest round and links to its scorecards.
- **Settings** contains display preferences, season History, methodology and BRTA rules, plus a JSON model-audit export. The section picker also links directly to past seasons. A separate control exports the selected section's match and fixture data as CSV.

## Competition and historical coverage

The live scraper discovers the active Saturday AM and Sunday AM seasons from TROLS and follows the season IDs TROLS marks as current. Routine checks update those active seasons only; they do not repeatedly fetch finished seasons. The checked-in Spring 2026 live snapshot contains 44 sections. Future section counts depend on what TROLS publishes.

The History selector is backed by a separate archive catalogue and set of section files under `data/archive/`. The archive importer reads the past seasons and sections exposed by TROLS, including published scorecards, official fixture order, final ladders and playoffs. Only seasons successfully imported into that catalogue can be selected. TROLS' archive has gaps, so the feature does not imply a complete year-by-year record for both competitions. Missing results and dates are not fabricated.

Historical ratings are refitted from the archived match records using the site's current V3 model. They are retrospective estimates, not historical BRTA or TROLS ratings. Where TROLS publishes a final ladder, its recorded order and points are retained. Where the source has no date or an internal score discrepancy, the importer preserves the source record and records the limitation rather than silently correcting it.

Semifinals and grand finals are shown from TROLS when published. Before a semifinal draw is published, the site projects the 1-v-4 and 2-v-3 matchups only once all 14 regular rounds are present and resolved. Rescheduled or repeated grand-final entries remain separate records; unpublished dates stay blank.

## Ratings

### Singles

For each completed, valid singles rubber, the model treats games as scoreline evidence. If player `i` wins `g_i` games and player `j` wins `g_j` games:

```text
p_ij = logistic((theta_i - theta_j) / 0.75)

weight_m = 2^(-age_days / 365)

maximize  sum_m weight_m * [g_i * log(p_ij) + g_j * log(1 - p_ij)]
          - (5 / 2) * sum_i theta_i^2

Power_i = 1500 + 600 * theta_i
```

`age_days` is measured relative to the newest dated match in that fit, not to the date the site is opened. An undated source record is not assigned an invented postponement interval. The scoreline likelihood already includes whether the player won or lost, so the model does not add a separate win/loss likelihood.

A 100-point Power gap corresponds to a game probability of approximately 55.5% under the fitted model; in general, `p_ij = logistic((Power_i - Power_j) / 450)`. L2 regularization shrinks estimates toward the section centre when evidence is limited. Every valid player result contributes to the opponent network, but the public singles ranking requires four completed singles rubbers.

Displayed uncertainty uses a centred inverse-Hessian (Laplace) approximation. It is an estimate of rating uncertainty under this model, not a guaranteed range of future performance.

### Doubles and Overall

- **Doubles pairs** treat a recurring pair as one rated entity; a pair needs two recorded appearances to qualify for its table.
- **Individual doubles** assumes pair strength is the mean of its players' latent strengths: `theta_pair = (theta_A + theta_B) / 2`. It is experimental because partner patterns can leave some player strengths unidentifiable. In formats with enough partner diversity, publication requires four appearances, at least two partners and an identifiable position in the results network. Two-player Rubbers sections can only provide partner-dependent evidence, which is labelled as such.
- **Overall** is the arithmetic mean of Singles Power and Individual Doubles Power. A ranked Overall entry needs at least four singles rubbers and a publishable doubles contribution; below-threshold entries can be shown as provisional.
- **Team Power** uses every modelled singles rating for that team's average, including ratings below the individual publication threshold. The best-four figure is the mean of its four strongest modelled ratings.

Adaptive rating bands are calculated from qualified entries in the selected section and rating view. They are display groupings; they do not affect fitted Power or ranking order.

### Match predictions and round history

The Prediction Centre converts Power differences to game probabilities, then uses the competition format to estimate rubber and team outcomes. It distinguishes standard Sets, Green Ball and Rubbers singles scoring. Selected players' default singles order is inferred from continuity in previous official playing orders and average position, with TROLS emergency markers kept at the bottom; it is not simply sorted by rating. Users may replace the singles order and choose both doubles pairs from the drafted players. For Sets playoffs, each side may draft up to six players, use four in singles and independently choose four for doubles.

Run Simulation samples each rubber from those same game probabilities and displays one possible scorecard, game totals, set totals and estimated team points. The simulated score is illustrative and can change on every run; the projected win percentages are long-run averages, not a promise about any particular set of 100 runs. The round simulator samples each remaining scheduled fixture using its default lineup. These results do not alter the official TROLS data.

Round-by-round snapshots refit the ratings using results available through each round in the official draw. A round without new valid singles evidence carries the previous state forward. Results-versus-expectation calculations use pre-round ratings; players without an earlier snapshot start at the neutral 1500 section centre.

## Results, standings and BRTA scoring

TROLS is the source for entered fixture results, scorecards, fixture order and current published points. For the current season, the site reconstructs standings from the fixture data, retains published points where available, and applies the 2026 BRTA Weekend Junior By-Laws when a washout or full-team forfeit has no numeric points in the source. Under those rules, Sets and Green Ball use a 4-point team-win / 2-point team-draw base; Rubbers use 2 / 1. Set points are added separately. Current reconstructed ties are ordered by points, then games-for divided by total games.

For archived seasons, a published TROLS final ladder takes precedence over a reconstructed table. If no final ladder is published, the site reconstructs the table from the available results and labels that limitation. The full rule summary and official by-law link are in Settings.

## Data flow and automation

```text
TROLS current results and fixture pages
            ↓
scraper/sync_trols.py
            ↓
data/current/
            ↓
generate_site_data.py  →  data/site/ and data.js
            ↓
static site on GitHub Pages
```

`scraper/sync_trols.py` discovers the active competitions and sections, downloads the results and scorecards, reads each team's official draw, validates the records, and writes the current-season source data. `generate_site_data.py` fits the section models and creates the data consumed by the website. The default section is embedded in `data.js`; other section payloads are loaded when selected.

The routine GitHub Actions sync runs Sunday, Monday and Wednesday at 7:17 PM Australia/Melbourne time, and can also be started manually. It runs the regression tests, regenerates the current-season site data, and records a heartbeat. On a later first visit in a browser, the site shows a short plain-English notice describing whether that check found updated results.

Historical importing is separate from routine sync: `scraper/backfill_history.py` fetches the past seasons listed by TROLS, and `generate_archive_site_data.py` builds their rating payloads and History catalogue. The archive workflow is manually dispatchable and code-triggered; normal scheduled checks do not rescan the past.

The site is a static client-side app. Its manifest and service worker support installation on desktop and iOS and cache the app shell. Section data is loaded on demand, so offline access to every section or archived season is not guaranteed.

## Repository map

| Path | Purpose |
| --- | --- |
| `index.html`, `app.js` | Site structure and interface behavior |
| `prediction.js` | Fixture prediction and tie-probability calculations |
| `pwa.js`, `sw.js`, `manifest.webmanifest` | Install guidance, app metadata and service-worker caching |
| `future.css`, `style.css`, `site.css` | Default and Classic presentation styles |
| `model.py` | V3 singles rating fit and uncertainty |
| `generate_site_data.py` | Current-section ratings, doubles, history, standings, results and fixtures |
| `generate_archive_site_data.py` | Archived-section payloads and History catalogue |
| `scraper/sync_trols.py` | Active-season TROLS scraper |
| `scraper/backfill_history.py` | Past-season TROLS importer |
| `data/current/` | Active-season catalogue and source result files |
| `data/site/` | Generated current-season section payloads |
| `data/archive/` | Imported historical records and generated archive payloads |
| `tests/` | Model, scraper, generator and prediction regression tests |
| `validation/` | Walk-forward V2/V3 evaluation harness and input contract |

## Run locally

Install the pinned Python dependencies, run the tests, then serve the static files over HTTP so the browser can load section JSON:

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node tests/test_prediction.js
python -m http.server 8000
```

Open `http://localhost:8000`. To fetch current data and rebuild its site payloads:

```bash
python scraper/sync_trols.py
python generate_site_data.py
```

To run the full historical backfill locally, use `python -m scraper.backfill_history` followed by `python generate_archive_site_data.py`. This is network-intensive and can take substantially longer than a current-season sync.

`validation/validate_v2_v3.py` contains a walk-forward comparison harness for game log loss and match Brier score. The development datasets used for tuning are not included in this repository, so those historical comparison results cannot be reproduced from the checked-in files alone.

## Disclaimer

This project is an independent statistical analysis of publicly entered competition data. BRTA, Tennis Australia and UTR do not endorse or operate it.
