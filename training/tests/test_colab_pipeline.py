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


if __name__ == "__main__":
    unittest.main()
