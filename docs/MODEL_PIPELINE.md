# Approx AI — model pipeline (datasets → training → releases → inference → backend)

## 1. Approved datasets

| Model | Target (exact) | Base model (pinned revision) | Min GPU |
|---|---|---|---|
| Nick 4.8 | 30,000 | microsoft/Phi-4-mini-instruct @ cfbefacb | T4 16 GB |
| Hike 6.5 | 50,000 | Qwen/Qwen2.5-7B-Instruct @ a09a3545 | T4 16 GB |
| Sona 9.0 | 70,000 | Qwen/Qwen2.5-14B-Instruct @ cf98f3b3 | L4 24 GB / A100 |
| FAB 100X | 100,000 | Qwen/Qwen2.5-32B-Instruct @ 5ede1c97 | A100 40 GB+ |
| FAB 500X | 500,000 | Qwen/Qwen2.5-Coder-32B-Instruct @ 381fc969 | A100 40 GB+ (80 GB / H100 recommended) |

Datasets come from the verified datahub pipeline (`python -m datahub build`): approved, licensed sources only;
quality, language, PII, dedup/near-dup, contradiction and benchmark-leakage gates; leakage-free train/eval/test
splits. Each model has `training/datasets/<model>/profile.json` (targets and mix) and a committed `manifest.json`
(counts, distributions, provenance, gates, SHA-256 of every split).

**Review.** The project owner attested on 2026-11-15 that human review is complete
(`training/datasets/reviews/attestation.json`). Datasets whose other gates all pass are approved for training with
`review_basis: owner_attestation`. The `human_review` gate still reports the real number of per-record reviewer
decisions in the ledger (0 imported); no reviewer decisions were invented.

## 2. Storage and restore (GitHub, Git LFS)

* `training/datasets/DATASETS.lock.json` (normal Git) — version, fingerprint, counts and the SHA-256 of every split
  and every shard.
* `training/datasets/dist/<model>/<split>.<n>.jsonl.gz` (Git LFS, `.gitattributes`) — deterministic gzip shards.
  Normal clones and Vercel deploys download only pointers.
* `python -m datahub.dist restore --models nick-4.8 …` pulls only the requested models' LFS objects, checks every
  shard and every decompressed split against the lock, and writes `training/datasets/<model>/build/`. A mismatch
  stops the restore; nothing is regenerated silently. `verify` checks local builds; `pack` (maintainers) produces
  the shards and lock from the builds.
* GitHub LFS quota: the free plan includes 1 GB storage and 1 GB/month bandwidth for the account that owns the
  repository. A full restore of all five datasets downloads the full shard set (see the lock for sizes); restoring
  only the models a GPU can train downloads less. Buy an LFS data pack if several full restores per month are needed.

## 3. One command

```
python training/run_all.py --models all --run-id approx-full-r1 --time-budget-minutes 240
```

Colab: `training/colab/approx_training_colab.ipynb` — set `MODELS`, `RUN_ID`, `TIME_BUDGET_MINUTES`, then
*Runtime → Run all*. It mounts Drive (checkpoints + releases survive disconnects), clones the repo, installs git-lfs
and pinned dependencies (with a real 4-bit kernel check), and runs the command above.

* Order: Nick → Hike → Sona → FAB 100X → FAB 500X; each: restore + SHA-256 verify → GPU detection → profile →
  QLoRA training with checkpoints → verification → unseen evaluation (base vs adapter) → safety + regression →
  release package.
* Models that do not fit the detected GPU are skipped with the exact requirement (never reported as trained).
* A failure is recorded (logs/checkpoints kept) and the pipeline continues with the next model.
* Resume: rerun with the same `--run-id`; finished models are skipped, the first incomplete one resumes from its last
  checkpoint (`--retry-failed` retries failed ones). State: `<work-dir>/runs/<RUN_ID>/state.json`;
  summary: `<models-dir>/pipeline_report.json`.

## 4. Release format

`models/<model>/versions/<version>/`: `adapter/` (safetensors LoRA), `tokenizer/`, `config/` (training, trainer and
adapter config), `manifest.json`, `release.json` (registry contract), `evaluation.json`, `training_report.json`,
`SHA256SUMS` (+ `SIGNATURE` if signed), plus `<model>-<version>.tar.gz` for registry import.

`manifest.json` contains: model_id, version, base_model, base_model_revision, training_dataset_version,
dataset_sha256 (fingerprint + per-split SHA-256), adapter_type, lora config, training_run_id, hardware,
training_duration_s, evaluation metrics, artifact_sha256, created_at, status, production_ready, blockers.
`production_ready` is true only if verification, the evaluation gate, safety and regression all passed.

## 5. Inference deployment

`deploy/models-gpu-compose.yml` defines one inference server per model (`inference/server.py`). Each server serves
only its model, verifies every release (SHA256SUMS, allow-list, base model, optional signature/pin) and refuses CPU
loading. Point the backend at each server with server-side variables only:

| Model | URL variable | Key variable |
|---|---|---|
| Nick 4.8 | `APPROX_MODEL_NICK_4_8_URL` | `APPROX_MODEL_NICK_4_8_KEY` |
| Hike 6.5 | `APPROX_MODEL_HIKE_6_5_URL` | `APPROX_MODEL_HIKE_6_5_KEY` |
| Sona 9.0 | `APPROX_MODEL_SONA_9_0_URL` | `APPROX_MODEL_SONA_9_0_KEY` |
| FAB 100X | `APPROX_MODEL_FAB_100X_URL` | `APPROX_MODEL_FAB_100X_KEY` |
| FAB 500X | `APPROX_MODEL_FAB_500X_URL` | `APPROX_MODEL_FAB_500X_KEY` |

(Family variables such as `APPROX_MODEL_NICK_URL` still work; a per-model variable takes precedence.)

Going live: import the release into the registry → deploy via the lifecycle (`POST /api/admin/models/:id/lifecycle`)
→ `verify-deployment` checks `/health`, the exact version, the adapter SHA-256 and a real generation → `ACTIVE`. Only
then does the model report `online` and become selectable. The owner-pinned Nick SHA-256 applies to the recovered
Qwen2.5-3B adapter; Nick releases on the current Phi-4-mini base go through the normal evaluate → verify path.

## 6. Live end-to-end check (no mocks)

```
APPROX_LIVE_BASE=https://approx-ai.vercel.app APPROX_LIVE_EMAIL=… APPROX_LIVE_PASSWORD=… node backend/test/live/live-inference.mjs
```
A real Supabase user → backend → router → each model's inference server → streamed answer. A model counts as
connected only when it is online, the router selected it, a version is reported and the text is not the simulator.
