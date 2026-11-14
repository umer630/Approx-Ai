# Approx AI data pipeline (`datahub`)

One pipeline builds every model's dataset. It replaces `approx_data/build.py` (now deprecated; `--legacy` still runs it)
and the dataset step inside `engine/runner.py`, which now calls `datahub` through `prepare_dataset()`.

## Flow

```
registry/sources.json ──► connectors (approved only; provenance: URL, revision, SHA-256, time)
   ──► normalise ──► PII scrub ──► content gates (engine.dataset_validator)
   ──► prompt-injection check ──► language ID (+ declared-language mismatch) ──► domain ──► quality score
   ──► review state (ledger) ──► POOL
POOL ──► exact dedup ──► contradictions (all conflicting answers dropped) ──► MinHash near-dup (0.85)
     ──► benchmark / unseen-suite leakage removal
     ──► per-model selection (profile quotas: domain min/max share, language minimums, synthetic cap, excluded sources)
     ──► deterministic split (hash of normalised prompt → train/eval/test, no prompt in two splits)
     ──► datasets/<model>/build/{train,eval,test}.jsonl + manifest.json (gates, counts, hashes)
```

`production_ready` is the AND of all gates. Profiles cannot set it (the key is removed on load).

Gates: `quantity`, `licenses`, `synthetic_ratio`, `domain_minimums`, `domain_maximums`, `language_minimums`,
`human_review`, `no_split_leakage`, `benchmark_leakage_removed`, `no_missing_sources`, `user_history_policy`.

## Commands (run from `training/`)

```bash
pip install -r requirements-kaggle.txt          # includes pyarrow
python -m datahub sources                       # registry status table
python -m datahub fetch                         # download approved sources into datasets/.cache (gitignored)
python -m datahub build                         # all five models; --models nick-4.8,hike-6.5 to limit
python -m datahub eval-suites                   # held-out evaluation suites
python -m datahub review-sheet --model nick-4.8          # stratified CSV batches (see HUMAN_REVIEW.md)
python -m datahub review-import --model nick-4.8 --csv completed.csv
python -m datahub review-progress                       # reports/human_review_progress.md
python -m datahub.report                                # reports/dataset_status.md + domain_requirements.json
python -m unittest tests.test_datahub -v
```

## Records

Each record carries `id, messages, lang, script, lang_confidence, domain, source, license, origin, review_state,
quality, split`. Origins: `human_authored`, `synthetic`, `programmatic`, `machine_translated`; the last three count
toward the 60 % synthetic cap, as do `templated_human` (human-written text under a fixed prompt template, e.g. Wikipedia
lead sections) and `transliteration_unverified` (parallel corpora whose authorship is not documented).

A source's own per-record language label is authoritative unless language ID confidently contradicts it (then the
record is rejected). Translation/transliteration records take their language from the answer (`lang_from: answer`).

Review states:

| State | Meaning |
|---|---|
| `human_reviewed` | Present in `datasets/reviews/<model>.jsonl` with a named reviewer and an `accept` verdict. Nothing else sets it. |
| `source_community_reviewed` | The source's own community review (OASST1 ranking / review flags). Not counted as Approx human review. |
| `auto_verified` | Machine-checked: MBPP code executed against its tests; programmatic curriculum answers. |
| `unreviewed` | Everything else. |

## Human review workflow

See [HUMAN_REVIEW.md](HUMAN_REVIEW.md). Sheets are issued per model, imports are validated against the issued sheet
(content hash, reviewer ID, verdict, reasons), the ledger is append-only, a reject from any reviewer wins, accepted
records are always selected first, and reviews of text that later changed stop counting.

## Adding a source

Add an entry to `datasets/sources/registry/sources.json` with `id, name, hub_repo, revision, license,
commercial_use, origin, use (train|eval), status`. Connector types: `hf_parquet` (Hub parquet export; `max_files`
limits shards), `hf_files` (specific repo files downloaded at the pinned `revision_full` — for very large repos),
`local_jsonl`, `curriculum`. Optional sources (`"optional": true`) are reported as absent instead of failing the
`no_missing_sources` gate. Record any residual concern in `upstream_risk`; it is copied into every manifest that uses
the source. Profiles may cap a source with `source_max_share`. Only `status: approved` with `commercial_use: yes` is ingested;
anything else raises `PermissionError`. Add a mapper in `datahub/connectors.py` that yields
`{"messages": [...], "lang": ..., "domain": ...}`. Record the license and attribution in
`datasets/sources/licenses/README.md` (regenerate from the registry).

## Adding a language

Add its script range or function-word list in `datahub/langid.py`, add a Belebele config (if one exists) to
`eval-belebele`, and add a `language_min` entry to the profiles that should require it. Measured accuracy is in
`reports/langid_accuracy.json`; re-measure after changes.

## Training runs

`run_all_training.py --run-id <id>` writes to `<work-dir>/<model>/runs/<id>/` and refuses to reuse a non-empty
directory unless `--resume` is given. The Nick 4.8 adapter (SHA-256 `2faae216…09c34c4`) lives in the old
`work/nick-4.8/` path and is never written to by new runs.
