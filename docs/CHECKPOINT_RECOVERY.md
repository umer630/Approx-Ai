# Checkpoint Recovery & Finalization-Bug Fix

This covers two things: the **root-cause fix** for a training run that produced real adapter weights but never
finalized, and the **recovery tool** that rebuilds a final adapter directory from such a checkpoint **without
retraining and without touching the checkpoint**.

## The bug (root cause)

In `training/train_qlora.py`, after `trainer.train()` wrote the real LoRA adapter into a checkpoint
(`checkpoint-N/adapter_model.safetensors`), the code ran `trainer.evaluate()` and computed metrics **before**
saving the final adapter directory. If evaluation raised (e.g. eval-time OOM / CUDA error) — or the non-finite
loss branch returned early — the process exited non-zero with **real weights in the checkpoint but no final
adapter directory, tokenizer, manifest, or package**. That is "exit 1 after `adapter_model.safetensors` was
written, before finalization."

## The fix (fail-closed, applied)

- **Finalize first.** The adapter directory (weights + tokenizer + `adapter_config.json` + `training_config.json`
  + `dataset_manifest.json` + `train_metadata.json` + `approx_adapter_manifest.json`) is now written **immediately
  after training succeeds, before evaluation**. A later crash cannot lose it.
- **Evaluation is non-fatal.** `trainer.evaluate()` is wrapped; an eval error is recorded (`metrics.eval_error`)
  and never aborts finalization.
- **Completeness gate.** A shared module, `training/adapter_finalize.py`, defines `REQUIRED_ADAPTER_FILES` and
  `missing_required()`. A run is reported **completed only if every required file is present**; otherwise
  `train_qlora.py` exits `EXIT_INCOMPLETE (8)` and writes `train_status.json = {"status": "incomplete", ...}`.
- **An interrupted/terminated run can no longer be reported as completed.** SIGTERM/SIGHUP are recorded as
  non-zero exits; non-finite loss saves the adapter but marks `status=failed`.
- **Downstream fail-closed.** `training/engine/runner.py` and `training/colab/colab_pipeline.py` refuse to verify
  or package unless the full required set is present, and point at the recovery tool.
- **Verifier robustness.** `verify_adapter.py` no longer hard-crashes when `training_config.json` lacks an optional
  `dataset_dir` (the recovered-config case).

`train_qlora.py` and `recover_adapter.py` share `adapter_finalize.write_adapter_manifest()`, so a recovered
adapter's `approx_adapter_manifest.json` is byte-for-byte the same schema and SHA-256 logic as a normally trained
one, with `verification_passed` / `safety_passed` set to **null** until the real verifier runs.

## Recovering checkpoint-21 (run this on your Colab/GPU runtime)

The checkpoint lives on your runtime, not in CI. On the runtime that has the checkpoint and the base model cached
(or internet access to the Hub), from the repo root:

```bash
python training/recover_adapter.py \
  --checkpoint "/content/drive/MyDrive/ApproxAI/work/nick-4.8/train_output/checkpoint-21" \
  --out        "/content/drive/MyDrive/ApproxAI/work/nick-4.8/recovered_adapter" \
  --config     training/models/nick-4.8.yaml
```

What it does (all real, nothing invented):
1. Reads the checkpoint's `approx_run.json` for the run identity (base model, revision, dataset fingerprint,
   smoke flag). **Stops** if that stamp is absent — identity is never guessed.
2. Copies **only** the real `adapter_model.safetensors` + `adapter_config.json` into the new directory. **The
   checkpoint is never modified.**
3. Restores the tokenizer from the **exact** configured base model + revision (cache or Hub). **Stops** with a
   clear blocker if it cannot be obtained — the tokenizer is never fabricated.
4. Reconstructs `training_config.json` + `train_metadata.json` (`status="recovered_from_checkpoint"`) from the
   real checkpoint metadata and the repo config.
5. Writes `approx_adapter_manifest.json` with real SHA-256s and `verification_passed=null` / `safety_passed=null`.

Then run the **real** verifier (it sets the real pass/fail — this tool never does):

```bash
python training/verify_adapter.py  --adapter "/content/drive/MyDrive/ApproxAI/work/nick-4.8/recovered_adapter"
# only if verification passes:
python training/package_adapter.py --adapter "/content/drive/MyDrive/ApproxAI/work/nick-4.8/recovered_adapter"
```

### Honesty rules the tools enforce
- A checkpoint trained on the **smoke dataset** stays `smoke_test=true` and `production_ready=false`. Recovery
  cannot turn a smoke run into a production result.
- `production_ready=true` requires the real production dataset and the real quality/safety/regression gates to
  actually pass — none of which recovery bypasses.
- If the real tokenizer or base model cannot be obtained on the runtime, recovery **stops and reports the exact
  blocker** instead of inventing files.

## All four models

The fix and the recovery tool are model-agnostic — they read each model's `approx_run.json` and
`training/models/<id>.yaml`. The same commands recover a Hike 6.5 / Sona 9.0 / FAB 500X checkpoint by pointing
`--checkpoint` / `--config` at that model's paths. Recovery only applies where a **real** adapter checkpoint
already exists; where none was ever trained, the tool reports that and nothing is fabricated.

## Tests

`training/tests/test_recovery.py` (CPU, no GPU/Hub) proves: recovery rebuilds a complete adapter without changing
the checkpoint; the manifest keeps `verification_passed/safety_passed = null`; recovery refuses without
`approx_run.json`; `missing_required()` catches an incomplete adapter; and the trainer saves the adapter **before**
evaluation. The existing `test_smoke_cpu.py` exercises the reordered finalization end-to-end.
