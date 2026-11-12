# Approx AI — Training Platform & Model Release Runbook

This describes the multi-model training engine, the release-artifact format, and how a trained model becomes
live in the API. It is honest about what has and has not run: **no model has been trained on a GPU in this
build. The pipeline, configs, evaluation and packaging are implemented and exercised end-to-end on CPU with a
tiny random model (a smoke test), which proves the code path but produces no real model.**

## 1. One engine, per-model config

```
training/
  run_all_training.py          single entry point (GPU preflight → per-model pipeline → report)
  models/<id>.yaml             per-model config: base model, LoRA, hardware profiles, eval gate
  engine/
    dataset_builder.py         curriculum → quality gates → train/eval/test split → manifest
    dataset_validator.py       all quality gates (schema, unicode, leakage, injection, dedupe, contradiction…)
    curriculum/                generators (computed answers) + authored records + held-out eval suite
    hardware.py                VRAM planner (picks the first profile that fits the detected GPU)
    runner.py                  the per-model pipeline (train → verify → evaluate → safety → release)
    evaluator.py               objective graders; BASE vs ADAPTER; weighted gate (out of 100)
    safety_evaluator.py        safety gate (every safety item must pass)
    release_manager.py         writes the verified, registry-ready release artifact
  train_qlora.py               the validated QLoRA trainer (unchanged contract; driven by the engine)
  verify_adapter.py            independent reload + generation + safety probes
  colab/approx_training_colab.ipynb   single Run-all notebook that drives run_all_training.py
approx_artifacts/              shared release rules (used by the trainer AND the inference server & backend)
```

Per-model configs: `nick-4.8` (Qwen2.5-3B, the default, fits a T4), `hike-6.5` (Qwen2.5-7B), `sona-9.0`
(Qwen2.5-14B), `fab-500x` (Qwen2.5-Coder-32B + a media-planning capability).

> **Base-model note.** Nick's base `Qwen/Qwen2.5-3B-Instruct` is **locked** — the trainer stops rather than
> substitute it, and its licence (Qwen Research License, non-commercial) is recorded as a release blocker for
> commercial use. The base models for Hike/Sona/FAB are **engineering proposals** and must be confirmed by Approx
> Technology before training.

## 2. Dataset quality gates

Every record passes record-level gates (schema, empty turns, Unicode/mojibake/control chars, raw chat-template
tokens, unbalanced code fences, foreign identity, prompt-leakage, prompt-injection compliance, harmful targets,
time-sensitive facts, degenerate repetition, nonsensical text) and corpus-level gates (exact duplicates,
MinHash-LSH **number-aware** near-duplicates, contradictions — the same question with conflicting answers).

The builder then holds out the **unseen evaluation suite** (drops any training record whose prompt matches a
suite item), balances domains, and makes a deterministic **train / eval / test** split with a cross-split leakage
check. The manifest records full statistics, a reproducibility fingerprint, and an explicit
`production_ready` verdict with reasons.

> The current curriculum is a **seed set** (authored safety/identity records + programmatic generators whose
> answers are computed and self-checked). It is deliberately **not production-ready**: the manifest says so (too
> few records, mostly template-generated, authored records not yet human-reviewed). Real production training needs
> a much larger, human-reviewed corpus.

## 3. Evaluation (objective, no model judges another)

The held-out suite is graded by deterministic rules (substring / number / regex / JSON-valid / code-runs /
refusal / humility). Each model is scored **BASE vs ADAPTER** per category (English, Urdu, Roman Urdu, maths,
science, reasoning, coding, education, instruction following, structured responses, safety, hallucination
resistance, malformed input). The weighted **quality gate** (out of 100) passes only if every category passes,
the safety pass-rate is met, and the adapter does not regress below the base in any category. A failure reports
the failing category, the reason, the evidence (failing item ids) and the required fix.

## 4. Running it

```bash
# On a GPU machine (Colab T4+, or NEBIUS). No GPU → it stops with GPU_REQUIRED.
python training/run_all_training.py --models nick-4.8            # default: nick-4.8
python training/run_all_training.py --models all                 # all four
python training/run_all_training.py --smoke --smoke-base <tiny>  # CPU pipeline test (not a real model)
python training/run_all_training.py --worker --control-plane-url https://… --api-key apx_…  # backend-driven
```

Or open `training/colab/approx_training_colab.ipynb` on Colab → set a GPU runtime → **Run all**. Artifacts are
written to Google Drive and survive runtime resets; training resumes from checkpoints.

Pausable runs: `--time-budget-minutes N` saves a checkpoint and exits with code 7; rerun to resume.

## 5. Release artifact format

```
<models_dir>/<model-id>/versions/<x.y.z>/
  adapter/   adapter_model.safetensors, adapter_config.json, tokenizer files     (safetensors only; no pickle)
  release.json      status (validated|failed|smoke_test), production_ready, blockers, hashes, evaluation evidence
  metadata.json  evaluation.json  training.json
  SHA256SUMS        every file; SIGNATURE (optional HMAC) when APPROX_RELEASE_SIGNING_KEY is set
<models_dir>/<model-id>-<x.y.z>.tar.gz     portable archive for import (no absolute paths)
```

Rules (enforced identically in `approx_artifacts` (Python), `backend/src/registry.js` (Node) and the inference
server): only an allow-list of file types; every file hashed in SHA256SUMS; versions are immutable;
`production_ready=true` must be consistent with the evidence (status validated, no blockers, gates passed,
dataset production-ready).

## 6. Training → API handoff

1. **Import** the artifact into the backend registry (shared volume, or upload):
   ```bash
   node backend/src/cli.js models import <artifact.tar.gz>
   # or: POST /api/admin/registry/import   (raw tar.gz, header X-Artifact-Sha256, superadmin or registry:import key)
   ```
   Import verifies the artifact; it never activates it.
2. **Activate** a version (controlled, audited):
   ```bash
   node backend/src/cli.js models activate nick-4.8 1.0.0        # [--allow-non-production --reason "…"]
   # or: POST /api/admin/registry/activate  (superadmin)        # or the Android/web admin console
   ```
   Only verified, `validated` releases can be activated; a non-production release needs an explicit override.
   Activation rewrites `<models_dir>/active.json` and calls the inference server's `/admin/reload`.
3. The **inference server** (`inference/server.py`) re-verifies the artifact, loads the LoRA adapter next to the
   base model, and switches the serving pointer. The backend then addresses it as `nick-4.8@<version>`. A newly
   activated version serves **without a code change or restart**. If the artifact is tampered with on disk, it is
   taken **offline** (fail closed) and a security event is raised.

Auto-activation policy (`APPROX_AUTO_ACTIVATE=off|production|validated`) can promote new releases automatically;
it never downgrades and never activates a failed or smoke artifact.

## 7. What is NOT done

- No GPU training has run; **no real adapter exists**; no model is `production_ready`.
- The curriculum is a seed set, not a production corpus.
- Hike/Sona/FAB base-model choices are proposals pending confirmation.
- FAB 500X video generation/understanding are separate pipelines (not the text adapter); until a pipeline URL is
  configured the media endpoints answer `501 capability_unavailable`. Storyboard is text planning only.
