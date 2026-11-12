"""Regression tests for the finalization bug and the recovery tool. Proves:
  * a checkpoint with real adapter weights but no finalization is RECOVERABLE without retraining;
  * recovery never modifies the source checkpoint;
  * the recovered manifest uses the canonical schema with verification_passed/safety_passed = null;
  * the fail-closed completeness check (adapter_finalize.missing_required) catches an incomplete adapter;
  * train_qlora.py's finalization is reordered so eval runs AFTER the adapter is saved (the root-cause fix).

Run: python training/tests/test_recovery.py <tiny-model-dir>   (CPU only; no GPU, no Hub)
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAINING))
import adapter_finalize as finalize  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  — {detail}"))
    if not cond:
        FAILS.append(name)


def make_checkpoint(ck: Path, tiny: str):
    """A real LoRA adapter checkpoint (tiny base) with the run stamp — weights present, finalization absent."""
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM
    torch.manual_seed(3)
    m = AutoModelForCausalLM.from_pretrained(tiny)
    p = get_peft_model(m, LoraConfig(r=4, lora_alpha=8, target_modules=["q_proj", "v_proj"], init_lora_weights=False))
    ck.mkdir(parents=True, exist_ok=True)
    p.save_pretrained(str(ck), safe_serialization=True)
    (ck / "approx_run.json").write_text(json.dumps({"run_name": "nick-4.8-qlora", "dataset_fingerprint": "f" * 64,
        "train_sha256": "a" * 64, "base_model": tiny, "base_model_revision": None, "smoke_test": True}))
    (ck / "trainer_state.json").write_text(json.dumps({"global_step": 21, "max_steps": 21, "epoch": 3.0,
        "log_history": [{"loss": 7.0, "step": 1}, {"loss": 6.7, "step": 21}]}))
    for f in ("optimizer.pt", "scheduler.pt", "rng_state.pth", "training_args.bin"):
        (ck / f).write_bytes(b"\x00" * 16)


def sha(p: Path):
    import hashlib
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_required_files_contract():
    check("required files include tokenizer + manifest", set(["adapter_model.safetensors", "adapter_config.json",
          "tokenizer_config.json", "approx_adapter_manifest.json"]).issubset(set(finalize.REQUIRED_ADAPTER_FILES)))
    with tempfile.TemporaryDirectory() as d:
        dd = Path(d)
        (dd / "adapter_model.safetensors").write_bytes(b"x")
        miss = finalize.missing_required(dd)
        check("missing_required flags an incomplete adapter", "approx_adapter_manifest.json" in miss and "tokenizer_config.json" in miss, miss)


def test_recovery(tiny: str):
    with tempfile.TemporaryDirectory() as d:
        ck = Path(d) / "checkpoint-21"
        out = Path(d) / "recovered_adapter"
        make_checkpoint(ck, tiny)
        before = sha(ck / "adapter_model.safetensors")
        before_files = sorted(p.name for p in ck.iterdir())

        r = subprocess.run([sys.executable, str(TRAINING / "recover_adapter.py"), "--checkpoint", str(ck),
                            "--out", str(out), "--allow-smoke"], capture_output=True, text=True)
        check("recovery exits 0", r.returncode == 0, r.stderr[-300:])
        # checkpoint untouched
        check("checkpoint weights unchanged", sha(ck / "adapter_model.safetensors") == before)
        check("checkpoint files unchanged", sorted(p.name for p in ck.iterdir()) == before_files)
        # recovered dir complete
        check("recovered adapter is complete", finalize.missing_required(out) == [], finalize.missing_required(out))
        man = json.loads((out / "approx_adapter_manifest.json").read_text())
        check("manifest verification_passed is null", man["verification_passed"] is None)
        check("manifest safety_passed is null", man["safety_passed"] is None)
        check("manifest keeps smoke_test=true", man["smoke_test"] is True)
        check("manifest base model matches the run stamp", man["base_model"] == tiny)
        check("recovered weights sha matches checkpoint", man["files_sha256"]["adapter_model.safetensors"] == before)
        check("real tokenizer restored (not invented)", (out / "tokenizer.json").exists() and (out / "tokenizer_config.json").exists())
        meta = json.loads((out / "train_metadata.json").read_text())
        check("metadata marks recovery, not completed training", meta["status"] == "recovered_from_checkpoint")


def test_recovery_requires_run_stamp(tiny: str):
    with tempfile.TemporaryDirectory() as d:
        ck = Path(d) / "checkpoint-9"
        out = Path(d) / "rec"
        make_checkpoint(ck, tiny)
        (ck / "approx_run.json").unlink()   # a checkpoint with no identity stamp
        r = subprocess.run([sys.executable, str(TRAINING / "recover_adapter.py"), "--checkpoint", str(ck),
                            "--out", str(out), "--allow-smoke"], capture_output=True, text=True)
        check("recovery refuses without approx_run.json (no guessing)", r.returncode != 0 and "approx_run.json" in r.stderr)


def test_trainer_reorder_source():
    """Static guard: in train_qlora.py the adapter is saved BEFORE trainer.evaluate(), and eval is non-fatal."""
    src = (TRAINING / "train_qlora.py").read_text()
    i_save = src.find("model.save_pretrained(str(adapter_dir)")
    i_eval = src.find("trainer.evaluate()")
    check("adapter is saved before evaluation (root-cause fix)", 0 < i_save < i_eval, f"save@{i_save} eval@{i_eval}")
    check("evaluation is wrapped non-fatally", "metrics[\"eval_error\"]" in src or "eval_error" in src)
    check("fail-closed EXIT_INCOMPLETE exists", "EXIT_INCOMPLETE" in src and "missing_required" in src)


def main(tiny: str):
    test_required_files_contract()
    test_recovery(tiny)
    test_recovery_requires_run_stamp(tiny)
    test_trainer_reorder_source()
    print(f"\n{'ALL PASS' if not FAILS else str(len(FAILS)) + ' FAILED: ' + ', '.join(FAILS)}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(TRAINING / "tests" / "tiny"))
