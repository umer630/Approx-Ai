# Approx AI — Final Build Report

**Date:** 2026-11-12 · **Branch:** `ccr-b9e70091-57vl48` · **Repo:** `umer630/Approx-Ai`

This report is written to be honest about evidence. Where something was built and verified, it says so and how.
Where something has **not** run (above all: real GPU training), it says so plainly. Nothing here claims a trained
model, an adapter, GPU metrics, or production readiness that does not exist.

---

## 0. Headline status flags

```
APPROX_AI_FINAL_BUILD_READY   = YES   (platform built & verified on CPU; real GPU training not run here)
APPROX_AI_TRAINING_PLATFORM_READY = YES

NICK_4_8_PIPELINE_READY   = YES      NICK_4_8_TRAINING_READY  = YES (pipeline) / NOT TRAINED (no GPU run)
HIKE_6_5_PIPELINE_READY   = YES      HIKE_6_5_TRAINING_READY  = YES (pipeline) / NOT TRAINED
SONA_9_0_PIPELINE_READY   = YES      SONA_9_0_TRAINING_READY  = YES (pipeline) / NOT TRAINED
FAB_500X_PIPELINE_READY   = YES      FAB_500X_TRAINING_READY  = YES (pipeline) / NOT TRAINED

NICK_4_8_API_PIPELINE_READY = YES
API_READY        = YES
APK_READY        = YES  (ApproxAI-NEBIUS-debug.apk, built & signature-verified)
SOURCE_ZIP_READY = YES  (release/approx-ai-1.1.0-source.zip)

ANY_MODEL_PRODUCTION_READY = NO   (no GPU training has run; no real adapter exists; curriculum is a seed set)
```

**What "the user's only remaining job" is:** open `training/colab/approx_training_colab.ipynb` on Google Colab,
select a GPU runtime, and **Run all**. Everything before that — login, UI, API, model registry, four model
configs, dataset pipeline, evaluation, packaging, the training→API handoff, the APK, and the source ZIP — is
built and verified in this repository. No further Claude session is required to obtain the pipeline, configs,
login, UI, API, registry, APK, or packaging.

---

## 1. Repository audit
Started from the existing, passing 1.0 app (backend 28 tests, training 34). Extended it without destroying working
functionality: the validated `train_qlora.py`/`verify_adapter.py` contracts are preserved and driven by the new
engine; the old dataset builder and Colab notebook still work; existing tests still pass.

## 2. Auth — production-ready (unchanged core, re-tested)
Register, login, logout, session persistence (web cookie+CSRF, mobile bearer), email verification, password reset,
invalid-credential and expired-session handling, suspended accounts, role/premium/model permissions. No mock auth.
Covered by `backend/test/platform.test.js` (logout revokes, expired session rejected, admin routes gated).

## 3. UI — Low/Medium/High, registry-driven, admin console
- Efficiency modes are now **Low / Medium / High**, a separate axis from the model, fully driven by the backend
  `mode_details` (labels, descriptions, default). They change real inference parameters.
- Model picker shows kind, active version and live/preview/offline status from the registry; models with no active
  version are disabled.
- **Admin console** (web + Android): Model registry (versions, status, activate/deactivate with non-production
  override, rescan) and Compute (GPU workers, jobs, start/stop). No dead buttons or placeholder text; Approx
  identity preserved.
- QA: Playwright (`web/test/qa.cjs`) — modes, admin console, mobile layout — all pass on desktop + iPhone.

## 4. Model lineup & registry
`backend/config/models.json` is the single source of truth: Nick 4.8 (language), Hike 6.5 (language), Sona 9.0
(language), FAB 100X (reserved), FAB 500X (code + media planning) — each with kind, base model, capabilities,
modalities, languages, safety profile, training-config pointer, availability and permissions. No model behaviour
is hard-coded in the frontend. File-based registry with SHA-256 verification, safetensors-only allow-list,
immutable versions, optional HMAC signing, audited activation, fail-closed integrity.

## 5. Efficiency modes
`low` (384 tok, temp 0.7), `medium` (1024, 0.7), `high` (4096, 0.4), each with real max_tokens / temperature /
top_p / frequency_penalty / context budget, applied in the provider and context-assembly layers (verified by
`platform.test.js`: each mode's token budget reaches the upstream; high is more deterministic).

## 6. Training platform (one engine, per-model config)
`training/engine/` + `training/models/<id>.yaml` + `training/run_all_training.py` + single Colab notebook.
- **Dataset**: every quality gate implemented (schema, empty, unicode, formatting, foreign-identity, prompt
  leakage, prompt-injection contamination, harmful target, time-sensitive, repetition, nonsensical, exact +
  MinHash-LSH number-aware near-dup, contradiction), eval-suite holdout, deterministic train/eval/test split,
  cross-split leakage check, full stats, reproducibility fingerprint, honest `production_ready` verdict.
- **Curriculum**: programmatic generators (answers **computed and self-checked** — maths, algebra, geometry,
  chemistry, physics, conversions, code that is executed against tests, structured output, media planning) in
  English / Urdu / Roman Urdu / mixed, plus authored safety + identity records (flagged for human review).
- **Evaluation**: held-out graded suite, objective graders (no model judges another), BASE vs ADAPTER per
  category, weighted gate out of 100, safety gate, regression check; failures report category / reason / evidence
  / required fix.
- **Hardware planner**: real analytic QLoRA VRAM estimator picks the first fitting profile (Nick→T4, Hike→T4/L4,
  Sona→A100, FAB→A100 80GB), with explicit `GPU_REQUIRED` / `GPU_REQUIREMENT_NOT_MET`.
- **Handoff**: `release_manager` writes verified, portable release artifacts; the backend imports/activates them;
  `inference/server.py` re-verifies and hot-loads. Trainer made pausable (time budget / STOP file), `--max-steps`,
  `--min-disk-gb`; verifier made model-aware.

**Verified end-to-end on CPU** with a tiny random model: the full `run_all_training.py --smoke` chain
(dataset → train → verify → evaluate → safety → regression → release) produced a `smoke_test` release with
`production_ready=false` and honest blockers, which then passed independent artifact verification.

## 7. Inference API & server
`inference/server.py`: OpenAI-compatible streaming + non-streaming, version pinning (`model@version`),
`/admin/reload`, `active.json` polling, 4-bit NF4 on CUDA only (**no CPU fallback** — `GPU_REQUIRED`), true
frequency-penalty, input limits, fail-closed on tampering. Shared verification rules in `approx_artifacts`.
CPU smoke test (`inference/tests/test_server_smoke.py`) — 23 checks pass (load, stream, version pin, auth,
malformed/oversized input, hot swap, tamper-offline, real-release-refused-in-smoke, poller).

## 8. Android — NEBIUS console app
`ApproxAI-NEBIUS-debug.apk` built and **signature-verified** (v2+v3 schemes). Login/register/logout/secure
session; efficiency Low/Medium/High; NEBIUS console (Dashboard, Projects, Compute, Model Management, Settings)
with admin actions gated by role; configurable HTTPS backend URL; build metadata (git commit, timestamp, build id)
and SHA-256. Release variant only when a real keystore is supplied (no invented signing credentials). JVM test of
the shipped `Api.java` — 24 checks pass against a live backend (incl. modes + console paths).

## 9. API platform
Auth, authorization, model + version selection, inference, streaming, validation, rate limiting, oversized /
malformed handling, health, model status, usage tracking, logs. Weights/secrets never exposed. GPU-inference
integration is clearly separated (smoke mode) and **not** marked as passed for real inference.

## 10. Media (FAB 500X)
Registry distinguishes `language_model`, `code_model`, `multimodal_model`, `video_pipeline`. Video
generation/understanding are separate pipelines; endpoints answer `501 capability_unavailable` until a pipeline
URL is configured. Storyboard is text planning only — the adapter never claims to render video.

## 11. Tests (all green in this session)
| Suite | Result |
|---|---|
| Backend (`backend/test/*.test.js`) | **39 / 39 pass** |
| Training engine (`training/tests/test_engine.py`) | **ALL PASS** |
| Training pipeline / smoke_cpu / colab | **9 / 1 / 24 pass** |
| Inference server smoke (`inference/tests/test_server_smoke.py`) | **23 / 23 pass** |
| Android JVM (`android/jvmtest/ApiJvmTest.java`) | **24 / 24 pass** |
| Web QA (`web/test/qa.cjs`, Playwright) | **ALL PASS** |

## 12. Artifacts & locations
- APK: `release/ApproxAI-NEBIUS-debug.apk` (+ `.sha256`, `.buildinfo.json`)
- Source ZIP: `release/approx-ai-1.1.0-source.zip` (no secrets, node_modules or caches)
- `release/SHA256SUMS` covers both
- Training entry point: `python training/run_all_training.py` or `training/colab/approx_training_colab.ipynb`
- Release artifacts written to `APPROX_MODELS_DIR` (shared backend/inference volume or Colab Drive)
- Import: `node backend/src/cli.js models import <tar.gz>` or `POST /api/admin/registry/import`
- Env templates: `.env.example`, `deploy/approx.env.example`, `deploy/inference.env.example`

## 13. Per-model summary
| Model | Base model | Dataset | Train/Eval/Test | GPU | Training | Eval | Safety | Adapter | API | Production |
|---|---|---|---|---|---|---|---|---|---|---|
| Nick 4.8 | Qwen2.5-3B-Instruct (locked) | seed (not prod) | yes (deterministic, held-out) | T4+ | pipeline ready, **not run** | graded suite ready | gate ready | none yet | ready | **NO** |
| Hike 6.5 | Qwen2.5-7B-Instruct (proposed) | seed | yes | T4/L4 | pipeline ready, not run | ready | ready | none | ready | NO |
| Sona 9.0 | Qwen2.5-14B-Instruct (proposed) | seed | yes | A100 | pipeline ready, not run | ready | ready | none | ready | NO |
| FAB 500X | Qwen2.5-Coder-32B (proposed) | seed | yes | A100 80GB | pipeline ready, not run | ready | ready | none | ready (+media 501) | NO |

## 14. Honest blockers / what remains
1. **No GPU training has run** in this environment (no CUDA, and Hugging Face/Colab are unreachable from here).
   Real adapters, GPU metrics and production readiness require running the prepared Colab notebook on a GPU.
2. The curriculum is a **seed set**, deliberately not production-ready (too small, mostly template-generated,
   authored records not yet human-reviewed). Production training needs a larger, human-reviewed corpus.
3. Hike/Sona/FAB **base-model choices are proposals** and must be confirmed by Approx Technology.
4. Nick's base-model licence (Qwen Research, non-commercial) must be cleared for commercial use.
5. FAB video pipelines are not implemented here (separate services); endpoints report `capability_unavailable`.
6. Release signing uses the standard debug key; a distribution APK needs Approx Technology's protected key.
