# Human review progress

Computed by `python -m datahub review-progress` from `datasets/reviews/*.jsonl` (the ledger) and the current builds.
Only named human reviewers count. Automatic checks (unit tests, answer matching, OASST community ranking) are tracked separately and are **not** human review.

| Model | Required | Accepted in dataset | Rejected | Remaining | Sheets issued | Rows issued | Rows decided | Rows pending | Gate |
|---|---|---|---|---|---|---|---|---|---|
| nick-4.8 | 500 | 0 | 0 | 500 | 6 | 550 | 0 | 550 | FAIL |
| hike-6.5 | 800 | 0 | 0 | 800 | 9 | 881 | 0 | 881 | FAIL |
| sona-9.0 | 1,200 | 0 | 0 | 1,200 | 14 | 1,320 | 0 | 1,320 | FAIL |
| fab-100x | 1,500 | 0 | 0 | 1,500 | 17 | 1,651 | 0 | 1,651 | FAIL |
| fab-500x | 5,000 | 0 | 0 | 5,000 | 55 | 5,500 | 0 | 5,500 | FAIL |
