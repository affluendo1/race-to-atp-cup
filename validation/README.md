# Validation

`validate_v2_v3.py` evaluates the legacy V2 and current V3 formulations with
walk-forward folds. For each later round, it fits only earlier completed rounds,
then reports per-game negative log loss and match-outcome Brier score.

Use source CSVs with the same schema as `data/current/section6_singles_results.csv`:

```bash
python validation/validate_v2_v3.py validation/datasets/*.csv --output validation/results.json
```

Historical development datasets are not checked into this public repository at
present, so this folder intentionally contains the reproducible code and input
contract rather than unverifiable result claims. Add only source datasets that
are cleared for publication.
