"""Static/CPU tests for training/colab/colab_pipeline.py (no GPU needed).

Covers: VRAM profile selection, config derivation, gate pass/fail logic, train refusal without a passed gate,
report status (BLOCKED / FAILED / never COMPLETE for smoke adapters), notebook structure and no Kaggle dependency."""
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_pipeline(drive: Path):
    os.environ["APPROX_DRIVE_ROOT"] = str(drive)
    sys.path.insert(0, str(ROOT / "colab"))
    import colab_pipeline
    importlib.reload(colab_pipeline)
    colab_pipeline.ensure_dirs()
    return colab_pipeline


class ColabPipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.drive = Path(self.tmp.name) / "ApproxAI" / "Nick_4_8"
        self.cp = load_pipeline(self.drive)

    def tearDown(self):
        self.tmp.cleanup()

    def test_vram_profiles(self):
        p = self.cp.vram_profile
        self.assertEqual(p(15.8)["name"], "T4 16GB")
        self.assertEqual(p(15.8)["per_device_batch_size"] * p(15.8)["gradient_accumulation_steps"], 16)
        self.assertEqual(p(12)["per_device_batch_size"], 1)
        self.assertEqual(p(40)["per_device_batch_size"] * p(40)["gradient_accumulation_steps"], 16)
        self.assertEqual(p(8), {})  # refuses instead of crashing later

    QWEN25_3B = {"hidden_size": 2048, "intermediate_size": 11008, "num_hidden_layers": 36, "num_attention_heads": 16,
                 "num_key_value_heads": 2, "vocab_size": 151936, "tie_word_embeddings": True}

    def _write(self, name, data):
        """Writes like a stage of THIS runtime (stamped with the current runtime id)."""
        self.cp.save(name, data)

    def _all_ready(self, vram=15.64):
        prof = self.cp.vram_profile(vram)
        self._write("gpu.json", {"GPU_READY": True, "CUDA_READY": True, "gpu_name": "Tesla T4", "vram_gb": vram, "bf16_supported": False,
                                 "profile": prof})
        self._write("internet.json", {"INTERNET_READY": True})
        self._write("repo.json", {"REPO_READY": True, "commit": "abc"})
        self._write("deps.json", {"DEPS_READY": True})
        self._write("model.json", {"MODEL_READY": True, "fits_vram": True, "training_profile": prof})
        self._write("dataset.json", {"DATASET_READY": True, "fingerprint": "f"})

    def test_memory_estimate_matches_actual_qlora_setup_on_t4(self):
        prof = self.cp.vram_profile(15.64)
        e = self.cp.estimate_qlora_peak_gb(self.QWEN25_3B, prof, 16, self.cp.BASE_CFG["lora"]["target_modules"])
        self.assertEqual(e["lora_trainable_params"], 29_933_568)          # PEFT's count for Qwen2.5-3B, r=16, 7 projections
        self.assertAlmostEqual(e["breakdown_gb"]["base_weights_nf4"], 1.43, places=1)
        self.assertTrue(10 < e["peak_gb"] < 12)
        self.assertLessEqual(e["peak_gb"], 15.64 * 0.90)                   # fits a T4 with 10% headroom
        # a genuinely too-small configuration is still rejected (the check is not a rubber stamp)
        big = {**prof, "per_device_batch_size": 8}
        self.assertGreater(self.cp.estimate_qlora_peak_gb(self.QWEN25_3B, big, 16, ["q_proj"])["peak_gb"], 15.64 * 0.90)

    def test_stale_results_from_previous_runtime_are_ignored(self):
        self._all_ready(); self.cp.config()
        md = json.loads((self.drive / "metadata/model.json").read_text())
        md["_runtime_id"] = "previous-runtime"
        (self.drive / "metadata/model.json").write_text(json.dumps(md))
        with self.assertRaises(SystemExit):
            self.cp.gate()
        pf = json.loads((self.drive / "metadata/preflight.json").read_text())
        self.assertFalse(pf["MODEL_READY"])
        self.assertIn("model.json", pf["stale_from_previous_runtime"])

    def test_config_refuses_profile_not_fit_checked(self):
        self._all_ready()
        self._write("model.json", {"MODEL_READY": False, "fits_vram": False, "training_profile": {}})
        with self.assertRaises(SystemExit):
            self.cp.config()

    def test_config_uses_fp16_on_t4_and_locked_base(self):
        self._all_ready()
        self.cp.config()
        cfg = json.loads((self.drive / "metadata/training_config.resolved.json").read_text())
        self.assertEqual(cfg["base_model"], "Qwen/Qwen2.5-3B-Instruct")
        self.assertEqual(cfg["quantization"]["bnb_4bit_compute_dtype"], "float16")
        self.assertEqual(cfg["quantization"]["bnb_4bit_quant_type"], "nf4")
        self.assertTrue(cfg["train"]["gradient_checkpointing"])
        self.assertEqual(cfg["train"]["per_device_batch_size"], 2)

    def test_gate_passes_only_when_everything_ready(self):
        self._all_ready()
        self.cp.config()
        self.cp.gate()
        self.assertTrue(json.loads((self.drive / "metadata/preflight.json").read_text())["TRAINING_READY"])
        self._write("internet.json", {"INTERNET_READY": False})
        with self.assertRaises(SystemExit):
            self.cp.gate()
        pf = json.loads((self.drive / "metadata/preflight.json").read_text())
        self.assertEqual(pf["not_run_in_this_runtime"], [])
        self.assertFalse(json.loads((self.drive / "metadata/preflight.json").read_text())["TRAINING_READY"])

    def test_train_refuses_without_gate(self):
        with self.assertRaises(SystemExit):
            self.cp.train()

    def test_report_blocked_then_never_complete_for_smoke(self):
        with self.assertRaises(SystemExit):
            self.cp.report()
        self.assertEqual(json.loads((self.drive / "metadata/completion_report.json").read_text())["status"], "BLOCKED")
        # simulate artifacts of a smoke run that passed the gate: must be FAILED, never COMPLETE
        self._all_ready(); self.cp.config(); self.cp.gate()
        self._write("train_metadata.json", {"status": "completed", "gpu": None, "smoke_test": True})
        (self.drive / "adapter/adapter_model.safetensors").write_bytes(b"x")
        (self.drive / "evaluation/inference_check.json").write_text(json.dumps({"PASSED": True}))
        (self.drive / "evaluation/verification.json").write_text(json.dumps({"verification_passed": True}))
        self._write("artifact_manifest.json", {"sha256sums_verified": True})
        with self.assertRaises(SystemExit):
            self.cp.report()
        rep = json.loads((self.drive / "metadata/completion_report.json").read_text())
        self.assertEqual(rep["status"], "FAILED")
        self.assertFalse(rep["evidence"]["gpu_training_completed"])

    def test_notebook_structure_and_no_kaggle(self):
        subprocess.run([sys.executable, str(ROOT / "colab/build_notebook.py")], check=True, capture_output=True)
        nb = json.loads((ROOT / "colab/nick_4_8_qlora_colab.ipynb").read_text())
        heads = [c["source"] for c in nb["cells"] if c["cell_type"] == "markdown" and c["source"].startswith("## CELL")]
        self.assertEqual(len(heads), 14)
        self.assertEqual(sum(1 for c in nb["cells"] if c["cell_type"] == "code"), 14)
        allsrc = json.dumps(nb).lower() + (ROOT / "colab/colab_pipeline.py").read_text().lower()
        self.assertNotIn("kaggle", allsrc)
        self.assertIn("qwen/qwen2.5-3b-instruct", allsrc)
        self.assertNotIn("print(tok", allsrc)  # HF token is never printed

    # ---------------- training-failure diagnosis (read-only) ----------------
    def _log(self, body, rc):
        (self.drive / "logs").mkdir(parents=True, exist_ok=True)
        (self.drive / "logs/train.log").write_text(
            "\n=== 2026-11-08T10:00:00Z $ /usr/bin/python3 train_qlora.py --config x --output-dir y\n" + body +
            (f"\n=== exit code {rc}\n" if rc is not None else ""))

    def test_diagnose_no_training_attempt(self):
        r = self.cp.diagnose()
        self.assertEqual(r["TRAINING_STAGE_ENTERED"], "NO")
        self.assertEqual(r["CHECKPOINT_FOUND"], "NO")
        self.assertEqual(r["ADAPTER_FOUND"], "NO")

    def test_diagnose_cuda_oom_from_legacy_log(self):
        self._log("dataset OK: 41 train / 4 eval\ntrainable params: 29,933,568 / 3,115,872,256 (0.961%)\n"
                  "tokenized: 41 train (dropped 0), 4 eval (dropped 0); plan {}\n  0%|          | 0/6 [00:00<?, ?it/s]\n"
                  "Traceback (most recent call last):\n  File \"train_qlora.py\", line 300, in <module>\n"
                  "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.32 GiB.", 1)
        r = self.cp.diagnose()
        self.assertEqual((r["TRAINING_STAGE_ENTERED"], r["BASE_MODEL_LOADED"], r["QLORA_INITIALIZED"], r["DATASET_READY"]), ("YES",) * 4)
        self.assertEqual(r["TRAINING_STEPS_COMPLETED"], 0)
        self.assertIn("CUDA out of memory", r["FIRST_REAL_ERROR"])
        self.assertIn("out of memory", r["ROOT_CAUSE"].lower())

    def test_diagnose_signal_kill_and_checkpoint_resume(self):
        self._log('APPROX_PHASE {"phase": "entered"}\nAPPROX_PHASE {"phase": "base_model_loaded"}\n'
                  'APPROX_PHASE {"phase": "qlora_initialized"}\nAPPROX_PHASE {"phase": "dataset_tokenized"}\n'
                  'APPROX_PHASE {"phase": "trainer_started"}\nAPPROX_PHASE {"phase": "step_completed", "step": 3}', -9)
        ck = self.drive / "checkpoints/checkpoint-3"
        ck.mkdir(parents=True)
        (ck / "trainer_state.json").write_text("{}")
        man = json.loads((ROOT / "data/processed/manifest.json").read_text()) if (ROOT / "data/processed/manifest.json").exists() else None
        if man:
            (ck / "approx_run.json").write_text(json.dumps({"train_sha256": man["files"]["train.jsonl"]["sha256"]}))
        r = self.cp.diagnose()
        self.assertEqual(r["TRAINING_STEPS_COMPLETED"], 3)
        self.assertIn("signal 9", r["FIRST_REAL_ERROR"])
        self.assertEqual(r["CHECKPOINT_FOUND"], "YES")
        self.assertTrue(r["CHECKPOINT_PATH"].endswith("checkpoint-3"))
        if man:
            self.assertEqual(r["RESUME_OR_FRESH"], "RESUME")
        self.assertTrue(ck.exists(), "diagnose must not delete anything")

    def test_trainer_exception_is_exposed(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("torch not installed")
        tmp = Path(self.tmp.name)
        subprocess.run([sys.executable, str(ROOT / "tests/make_tiny_model.py"), str(tmp / "tiny")], cwd=ROOT, check=True, capture_output=True)
        cfg = json.loads((ROOT / "configs/nick-4.8-qlora.json").read_text())
        cfg["train"]["lr_scheduler"] = "not-a-real-scheduler"          # makes TrainingArguments raise inside training
        (tmp / "bad.json").write_text(json.dumps(cfg))
        r = subprocess.run([sys.executable, str(ROOT / "train_qlora.py"), "--config", str(tmp / "bad.json"),
                            "--smoke-base", str(tmp / "tiny"), "--output-dir", str(tmp / "run")], cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("APPROX_TRAIN_EXCEPTION", r.stdout)
        self.assertIn("Traceback (most recent call last)", r.stderr)
        st = json.loads((tmp / "run-SMOKE/train_status.json").read_text())
        self.assertEqual(st["status"], "failed")
        self.assertIn("ValueError", st["type"])
        phases = [json.loads(l)["phase"] for l in (tmp / "run-SMOKE/train_phases.jsonl").read_text().splitlines()]
        self.assertEqual(phases[:4], ["entered", "base_model_loaded", "qlora_initialized", "dataset_tokenized"])
        self.assertEqual(phases[-1], "failed")
        # the diagnosis reads it back from a launcher-style log
        self._log(r.stdout + r.stderr, r.returncode)
        d = self.cp.diagnose()
        self.assertEqual(d["QLORA_INITIALIZED"], "YES")
        self.assertEqual(d["TRAINING_STEP_STARTED"], "NO")
        self.assertIn("ValueError", d["FIRST_REAL_ERROR"])

if __name__ == "__main__":
    unittest.main()
