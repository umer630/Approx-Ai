# Human review — instructions for reviewers and operators

Every model's dataset has a human-review gate (`min_human_reviewed` in `datasets/<model>/profile.json`).
Only a **person** reading a record and recording a decision counts. Unit tests, answer matching, OASST community
ranking and any other automatic check are tracked as separate review states and **never** count as human review.

| Model | Required accepted reviews |
|---|---|
| nick-4.8 | 500 |
| hike-6.5 | 800 |
| sona-9.0 | 1,200 |
| fab-100x | 1,500 |
| fab-500x | 5,000 |

A record accepted for one model also counts for any other model whose dataset contains the same record.

## Operator: issue sheets

```bash
cd training
python -m datahub build                        # sheets are drawn from the current build
python -m datahub review-sheet --model nick-4.8          # remaining requirement + 10 %, batches of 100
python -m datahub review-sheet --model fab-500x --n 300  # or an explicit number
```

Sheets are written to `datasets/reviews/sheets/<model>/<sheet_id>.csv` with a `.meta.json` next to each. Sheets
contain dataset text and are **not committed**; share them with reviewers privately (e.g. Google Drive). Rows are
sampled round-robin across language × domain so every language and domain gets reviewed.

## Reviewer: fill in a sheet

For each row read `prompt` and `answer`, then fill only these columns:

| Column | What to write |
|---|---|
| `reviewer` | Your reviewer ID (2–40 characters, starts with a letter, e.g. `ayesha.k`). Use the same ID every time. Use an ID, not your full name or email. |
| `verdict` | `accept` or `reject` |
| `issue_tags` | Required for `reject`: comma-separated from `incorrect, unsafe, low_quality, wrong_language, pii, formatting, incomplete, license, other` |
| `notes` | Optional for accept; explain the problem for reject |

**Accept** only if all are true:

1. The answer is factually and logically correct (check maths and code yourself; if you cannot verify it, skip the row).
2. It actually answers the prompt and is complete.
3. It is safe and appropriate for a general assistant.
4. It is in the expected language/script (`lang` column; `roman_ur` = Urdu in Latin letters).
5. It contains no personal data (names with contact details, phone numbers, addresses, IDs).
6. It is readable: no broken formatting, no garbled text, no copied boilerplate.

**Reject** if any of these fail. Never edit `prompt`, `answer`, `record_id` or `content_hash`: edited rows are
refused on import. If an answer could be fixed, reject it with a note — corrected answers are a separate, human-authored
contribution, not a review.

Leave a row completely blank (no reviewer, no verdict) if you did not review it. Do not let a script, macro or AI tool
fill in verdicts: reviewer IDs that look like programs (`auto`, `bot`, `ai`, `gpt`, `claude`, `script`, …) are refused,
and filling verdicts automatically is falsified review.

## Operator: import and track

```bash
python -m datahub review-import --model nick-4.8 --csv path/to/completed1.csv path/to/completed2.csv
python -m datahub build                       # accepted records are prioritised; rejected ones are removed
python -m datahub review-progress             # writes reports/human_review_progress.md (+ .json)
```

Import validation refuses a whole sheet if its `sheet_id` was not issued by `review-sheet` or belongs to another model,
and refuses individual rows that:

- are not in the issued sheet, or whose `content_hash` differs from the issued text;
- have a missing/invalid reviewer ID, or one that looks like a program;
- have a verdict other than `accept`/`reject`, or a `reject` without issue tags or notes;
- use unknown issue tags.

Re-importing the same sheet is safe (duplicates are skipped). If two reviewers disagree, `reject` wins. If a record's
text changes later (source update), its earlier review no longer counts (`review_stale_content_changed` in the build
stats) and it must be reviewed again.

The ledger `datasets/reviews/<model>.jsonl` (record id, reviewer ID, verdict, tags, notes, content hash, sheet id, import
time, CSV hash) is committed: it is the audit trail for every `human_reviewed` record.
