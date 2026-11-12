"""Recover a FINAL adapter directory from a training CHECKPOINT that has real LoRA weights but never reached the
finalization stage (no tokenizer / no approx_adapter_manifest.json / no package). Does NOT retrain and NEVER
modifies the source checkpoint.

    python training/recover_adapter.py \
        --checkpoint /content/drive/MyDrive/ApproxAI/work/nick-4.8/train_output/checkpoint-21 \
        --out        /content/drive/MyDrive/ApproxAI/work/nick-4.8/recovered_adapter \
        [--config training/models/nick-4.8.yaml]   # optional; else derived from the checkpoint's approx_run.json

What it does (all real, nothing invented):
  1. Reads the checkpoint's approx_run.json (base_model, base_model_revision, dataset fingerprint, smoke_test) and
     trainer_state.json (steps, losses). STOPS if approx_run.json is absent — the run identity cannot be guessed.
  2. Copies ONLY the real adapter weights + adapter_config.json into a NEW output directory (checkpoint untouched).
  3. Restores the tokenizer from the EXACT configured base model + revision (from cache, or downloaded on a runtime
     with Hub access). STOPS with a clear blocker if the tokenizer cannot be obtained — it is never fabricated.
  4. Reconstructs training_config.json + train_metadata.json (status="recovered_from_checkpoint") from the real
     checkpoint metadata and the repository config.
  5. Writes approx_adapter_manifest.json with REAL file SHA-256s and verification_passed=null / safety_passed=null,
     using the SAME schema/logic as training/train_qlora.py (shared training/adapter_finalize.py).
  6. Prints the exact verify command. Verification/evaluation/safety/packaging are run separately and set the
     real pass/fail — this tool never sets them.

Exit codes: 0 recovered · 3 base/tokenizer unavailable · 4 bad/edited checkpoint · 5 no approx_run.json.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import adapter_finalize as finalize  # noqa: E402

EXIT_OK, EXIT_BASE_UNAVAILABLE, EXIT_BAD_CHECKPOINT, EXIT_NO_RUN_STAMP = 0, 3, 4, 5
# Only these are copied from the checkpoint — the real training outputs. Optimizer/scheduler/rng state are NOT.
COPY_FROM_CHECKPOINT = ["adapter_model.safetensors", "adapter_config.json"]
OPTIONAL_COPY = ["README.md"]


def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Recover a final adapter directory from a training checkpoint (no retrain).")
    ap.add_argument("--checkpoint", required=True, help="path to checkpoint-N (left unchanged)")
    ap.add_argument("--out", required=True, help="NEW recovery directory to create")
    ap.add_argument("--config", default=None, help="optional model config (YAML/JSON); else derived from the checkpoint")
    ap.add_argument("--allow-smoke", action="store_true", help="allow recovering a smoke-test checkpoint (local tiny base)")
    a = ap.parse_args(argv)

    ckpt = Path(a.checkpoint).resolve()
    out = Path(a.out).resolve()
    if not ckpt.is_dir():
        print(f"BLOCKER: checkpoint directory does not exist: {ckpt}", file=sys.stderr)
        return EXIT_BAD_CHECKPOINT
    if out == ckpt or str(out).startswith(str(ckpt) + "/"):
        print("BLOCKER: --out must be a separate directory, never inside the checkpoint.", file=sys.stderr)
        return EXIT_BAD_CHECKPOINT

    weights = ckpt / "adapter_model.safetensors"
    if not weights.exists() or weights.stat().st_size == 0:
        print(f"BLOCKER: no real adapter weights in the checkpoint ({weights} missing/empty). Nothing to recover.", file=sys.stderr)
        return EXIT_BAD_CHECKPOINT
    if not (ckpt / "adapter_config.json").exists():
        print("BLOCKER: adapter_config.json missing from the checkpoint — cannot load the adapter.", file=sys.stderr)
        return EXIT_BAD_CHECKPOINT

    run = load_json(ckpt / "approx_run.json")
    if not run:
        print("BLOCKER: approx_run.json is missing from the checkpoint. The run identity (base model, revision, "
              "dataset fingerprint, smoke flag) cannot be recovered without it, and must not be guessed.", file=sys.stderr)
        return EXIT_NO_RUN_STAMP
    base_model = run.get("base_model")
    base_revision = run.get("base_model_revision")
    smoke = bool(run.get("smoke_test"))
    if not base_model:
        print("BLOCKER: approx_run.json has no base_model — cannot restore the correct tokenizer.", file=sys.stderr)
        return EXIT_NO_RUN_STAMP
    if smoke and not a.allow_smoke:
        print("NOTE: this checkpoint is a SMOKE TEST (tiny random base). Recovering it will stay smoke_test=true and "
              "production_ready=false. Re-run with --allow-smoke to proceed.", file=sys.stderr)
        return EXIT_BAD_CHECKPOINT

    # Optional repo config → model_id / adapter_version (else fall back to the run stamp / 'unknown').
    cfg = None
    if a.config:
        cp = Path(a.config)
        if cp.suffix in (".yaml", ".yml"):
            import yaml
            cfg = yaml.safe_load(cp.read_text())
        else:
            cfg = load_json(cp)
    trainer_state = load_json(ckpt / "trainer_state.json") or {}
    model_id = (cfg or {}).get("model_id") or run.get("model_id") or "unknown"
    adapter_version = ((cfg or {}).get("version_series", "") and f"{cfg['version_series']}.0") or run.get("adapter_version") or "recovered"
    if smoke:
        model_id, adapter_version = "SMOKE-TEST-NOT-NICK", "smoke"

    out.mkdir(parents=True, exist_ok=True)
    # 1. copy ONLY the real adapter weights/config (never modify the checkpoint)
    copied = []
    for name in COPY_FROM_CHECKPOINT + OPTIONAL_COPY:
        src = ckpt / name
        if src.exists():
            shutil.copy2(src, out / name)
            copied.append(name)
    print(f"copied from checkpoint (unchanged source): {copied}")

    # 2. restore the tokenizer from the EXACT base model + revision — real, never invented
    try:
        from transformers import AutoTokenizer
    except Exception as e:  # noqa: BLE001
        print(f"BLOCKER: transformers is not available to load the tokenizer ({e}).", file=sys.stderr)
        return EXIT_BASE_UNAVAILABLE
    try:
        kw = {} if (smoke or not base_revision) else {"revision": base_revision}
        tok = AutoTokenizer.from_pretrained(base_model, use_fast=True, **kw)
    except Exception as e:  # noqa: BLE001
        print(f"BLOCKER: could not obtain the tokenizer for base model '{base_model}'"
              + (f"@{base_revision}" if base_revision else "") + f" ({type(e).__name__}: {e}).\n"
              "This runtime has no cached copy and no Hub access. Run this on the SAME runtime that trained (where the "
              "base model is cached) or a runtime with internet, so the tokenizer comes from the real base model. "
              "It is never fabricated.", file=sys.stderr)
        return EXIT_BASE_UNAVAILABLE
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    tok.save_pretrained(str(out))
    if not (out / "tokenizer_config.json").exists():
        print("BLOCKER: tokenizer_config.json was not written by the tokenizer — cannot finalize.", file=sys.stderr)
        return EXIT_BASE_UNAVAILABLE
    print(f"tokenizer restored from {base_model}" + (f"@{base_revision}" if base_revision else "") + f": {tok.__class__.__name__}")

    # 3. dataset manifest: copy the real one if the checkpoint recorded its location; else record what we know
    ds_manifest = None
    for cand in [ckpt / "dataset_manifest.json", ckpt.parent / "dataset" / "manifest.json", ckpt.parent.parent / "dataset" / "manifest.json"]:
        if cand.exists():
            ds_manifest = load_json(cand)
            shutil.copy2(cand, out / "dataset_manifest.json")
            break

    # 4. training_config.json (from repo config if given, else a minimal real record)
    training_config = cfg or {"model_id": model_id, "base_model": base_model, "base_model_revision": base_revision,
                              "note": "reconstructed from checkpoint approx_run.json; full training config not present in checkpoint"}
    (out / "training_config.json").write_text(json.dumps(training_config, indent=2))

    # 5. canonical metadata + manifest (SAME schema/SHA-256 as train_qlora.py)
    losses = [h.get("loss") for h in trainer_state.get("log_history", []) if "loss" in h]
    meta = {
        "status": "recovered_from_checkpoint", "smoke_test": smoke,
        "model_id": model_id, "adapter_version": adapter_version,
        "base_model": base_model, "base_model_revision": base_revision,
        "method": "recovered from existing checkpoint (not retrained)",
        "recovered_from": str(ckpt),
        "run_name": run.get("run_name"),
        "dataset": {"version": (ds_manifest or {}).get("dataset_version"),
                    "fingerprint": run.get("dataset_fingerprint") or (ds_manifest or {}).get("content_fingerprint_sha256"),
                    "train_sha256": run.get("train_sha256"),
                    "production_ready": (ds_manifest or {}).get("production_ready")},
        "checkpoint": {"global_step": trainer_state.get("global_step"), "max_steps": trainer_state.get("max_steps"),
                       "loss_first": losses[0] if losses else None, "loss_last": losses[-1] if losses else None,
                       "epoch": trainer_state.get("epoch")},
        "recovered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    manifest = finalize.write_adapter_manifest(out, meta)

    # 6. completeness check (fail closed) + next steps
    missing = finalize.missing_required(out)
    print(json.dumps({
        "recovered_adapter": str(out),
        "source_checkpoint": str(ckpt),
        "checkpoint_unchanged": True,
        "files_recovered": copied,
        "files_generated": sorted(p.name for p in out.iterdir() if p.name not in copied),
        "adapter_model.safetensors_sha256": manifest["files_sha256"].get("adapter_model.safetensors"),
        "adapter_model.safetensors_bytes": (out / "adapter_model.safetensors").stat().st_size,
        "model_id": model_id, "adapter_version": adapter_version,
        "base_model": base_model, "base_model_revision": base_revision, "smoke_test": smoke,
        "verification_passed": None, "safety_passed": None,
        "missing_required": missing,
    }, indent=2))
    if missing:
        print(f"\nBLOCKER: recovery is incomplete, still missing: {missing}", file=sys.stderr)
        return EXIT_BAD_CHECKPOINT
    print(f"\nRECOVERED. Now run the REAL verifier (it sets verification_passed / safety_passed):")
    print(f"  python training/verify_adapter.py --adapter {out}")
    print(f"Then, only if verification passes, package:")
    print(f"  python training/package_adapter.py --adapter {out}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
