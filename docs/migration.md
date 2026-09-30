# Implementation audit

The source copy contained a monolithic UI (~150 KB), static generated data, Python rating/build scripts, three ingestion scripts, thousands of historical section files, a synthetic-player module and a themed archive with unrelated audio/image assets. Data loading, seasonal selection, ladders and match parsing all assumed the source competition format. No inherited workflow was present at the audited copy’s head.

The reusable mathematical infrastructure was extracted by behavior: coherent scoreline likelihood, game scale 0.75, 365-day elapsed-time weighting, L2 5, display transform 1500+600theta, centered Laplace uncertainty, additive individual doubles and stable partnership entities. The original fixed 50/50 Overall publication threshold penalized missing disciplines; the replacement is missing-data-aware. The original prediction format used short sets and different rubber totals, so it required a replacement format implementation.

`src/config.js` owns rule defaults and override composition. `src/scores.js` normalizes tennis scores and fixture decisions. `src/validation.js` audits identities, registration, scoring, schedule and bracket integrity. `src/ratings.js` fits the adapted model. `src/derive.js` produces standings, profiles, histories, Finals and schedule metrics. `src/worker.js` caches computation away from the UI thread. `src/store.js` handles validated packages/local persistence. `src/admin.js` provides content editors. `src/app.js`, `src/ui.js` and `site.css` provide the new responsive presentation.

Content is solely administrator-entered JSON. The seed contains explicitly provided teams/season hosts only. No initializer embeds player allocations or rewrites manual data. Synthetic examples occur exclusively in tests.

Pending sporting decisions remain configurable: Race Points and standings tiebreaks, roster composition, participation-related registration rules, transfers, Finals host order and manual exact-tie resolution. No S/C participation limits were invented. Future expansion beyond an eight-team bracket requires implementing its topology rather than accepting inconsistent rules silently.
