# Nick 4.8 training pipeline (Kaggle GPU)

Base `Qwen/Qwen2.5-3B-Instruct` · QLoRA (4-bit NF4 + double quant) · LoRA r=16, α=32, dropout 0.05 on
q/k/v/o/gate/up/down projections · assistant-only loss · seed 4848.

## Status
**Nick 4.8 is NOT trained yet.** The pipeline is ready and validated as far as possible without a GPU (see
"What was validated"). The single remaining action is running the notebook on a Kaggle GPU.

## Run it on Kaggle (no code edits)
1. https://www.kaggle.com/code/ → **New Notebook** → File → **Import Notebook** → GitHub tab →
   `umer630/Approx-Ai`, branch `ccr-b9e70091-57vl48`, file `training/kaggle/nick_4_8_qlora.ipynb`
   (or upload the `.ipynb` file).
2. Settings → **Accelerator: GPU T4** · **Internet: On** (phone-verified account required).
3. Repository is public — no secret needed. If it becomes private: Add-ons → Secrets → `GITHUB_TOKEN`.
4. **Save Version → Save & Run All (Commit)** (background, keeps outputs) — or Run All interactively.
5. Last cell must print `✅ COMPLETE`. Download from the Output tab: `nick-4.8-output/`
   `nick-4.8-adapter-1.0.0.tar.gz`, `verification.json`, `SHA256SUMS`, `train_metadata.json`, `completion_status.json`.

Interrupted? Run All again in the same session (auto-resume), or in a new session add the interrupted
version's output as **Input** and Run All — the newest `/kaggle/input/**/checkpoint-*` is resumed (refused if
the dataset changed).

## Stages (`kaggle/kaggle_pipeline.py`)
| Stage | What it does | Stops when |
|---|---|---|
| preflight | GPU/CUDA/versions, **real 4-bit NF4 kernel test on the GPU**, VRAM ≥14 GB, disk ≥10 GB, base model reachable on the Hub (resolved commit SHA recorded) | no GPU, bnb broken, model unavailable (never substitutes) |
| data | seed → `approx_data.build` → `train_qlora.py --dry-run` | malformed/hash-mismatched data |
| train | QLoRA; checkpoints twice per epoch; auto-resume; GPU 0 only; fp16 on T4 / bf16 on Ampere+ | no GPU, non-finite loss, missing safetensors |
| verify | real generation: adapter load, LoRA-B ≠ 0 (proves training), identity, English, Urdu, Roman Urdu, maths, reasoning, coding (executed), safety (refuse harmful + don't over-refuse), 6 malformed-input cases, base-vs-adapter perplexity | never hides failures — recorded in verification.json |
| package | deterministic `nick-4.8-adapter-1.0.0.tar.gz`, `verification.json`, `SHA256SUMS`, self-check of the safetensors inside the tarball | refuses missing/empty safetensors or missing verification |
| status | strict completion check (6 evidence items) | prints ❌ NOT COMPLETE unless every item is true |

`verification_passed=true` requires all 7 checks, capability pass rate ≥ 0.8 and all safety probes passing.
The backend registry (`POST /api/admin/training/adapters`) additionally rejects smoke adapters, failed safety,
wrong base model, SHA-256 not matching `verification.json`, and duplicates.

## Dataset
`configs/dataset_sources.json` lists sources; only `approved: true` sources with a verified license are
ingested. The builder rejects malformed lines/records, scrubs PII and secrets, filters low-quality, harmful and
**time-sensitive** content (changing facts belong in Approx Research / retrieval, not weights), removes exact
and near duplicates, balances domains, splits train/eval with a fixed seed, and writes `manifest.json`
(per-source file SHA-256 + license, parameters, rejection reasons + samples, domain/language coverage, output
hashes, reproducibility fingerprint, `production_ready` verdict).

**The current dataset is the 45-record Approx seed set — NOT production-quality** (`production_ready: false`:
< 20,000 records, every domain < 500). A run on it validates the pipeline and teaches identity/format only.
To add data: convert a license-checked dataset to the message schema
(`{"domain": ..., "messages": [{"role": "user"|"assistant"|"system", "content": ...}]}`) as
`data/external/<name>.jsonl`, set `approved: true` + the verified license in the registry, rebuild.

## What was validated without a GPU (this environment)
- `tests/test_pipeline.py` — PII, language detection, schema/quality/time-sensitive filters, malformed lines,
  unlicensed sources, dedupe, reproducibility, dry-run.
- `tests/test_smoke_cpu.py` — real train → interrupt → resume → verify → package → status on a **tiny random
  local Qwen2-architecture model** with the pinned transformers 4.46.3 / peft 0.13.2 / accelerate 1.1.1 /
  datasets 3.1.0 and torch 2.5.1 (CPU). Proves the code paths; it is not Nick and is labelled SMOKE everywhere.
- Notebook JSON validated (nbformat) and executed locally up to preflight, which correctly stops with "no GPU".
- **Not validatable here:** 4-bit bitsandbytes on CUDA, downloading/loading Qwen2.5-3B-Instruct, GPU memory fit,
  real generation quality. Those are exercised by the preflight/train/verify stages on Kaggle.
