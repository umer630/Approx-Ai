"""End-to-end CPU smoke test of train → resume → verify → package → status using a tiny random model.
Validates the CODE PATHS only (no GPU, no 4-bit). Skipped when torch/transformers/peft are not installed."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
try:
    import torch, transformers, peft  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False


@unittest.skipUnless(HAVE, "torch/transformers/peft not installed")
class SmokeCPU(unittest.TestCase):
    def run_py(self, *args, env=None, ok=(0,)):
        r = subprocess.run([sys.executable, *args], cwd=ROOT, capture_output=True, text=True, env=env)
        self.assertIn(r.returncode, ok, r.stdout[-2000:] + r.stderr[-3000:])
        return r

    def test_full_pipeline(self):
        import os
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            self.run_py("data/seed/make_seed.py")
            self.run_py("-m", "approx_data.build")
            self.run_py("tests/make_tiny_model.py", str(d / "tiny"))
            self.run_py("train_qlora.py", "--smoke-base", str(d / "tiny"), "--output-dir", str(d / "run"))
            out = d / "run-SMOKE"
            w = out / "adapter" / "adapter_model.safetensors"
            self.assertTrue(w.exists() and w.stat().st_size > 0)
            meta = json.loads((out / "train_metadata.json").read_text())
            self.assertTrue(meta["smoke_test"])
            self.assertEqual(meta["metrics"]["global_step"], 6)
            # interruption → resume
            shutil.rmtree(out / "adapter")
            for c in out.glob("checkpoint-*"):
                if c.name != "checkpoint-4":
                    shutil.rmtree(c)
            r = self.run_py("train_qlora.py", "--smoke-base", str(d / "tiny"), "--output-dir", str(d / "run"))
            self.assertIn("resuming from", r.stdout)
            # verification runs real generation; a random model must FAIL capability probes honestly
            self.run_py("verify_adapter.py", "--adapter", str(out / "adapter"), "--max-new-tokens", "8", ok=(1,))
            v = json.loads((out / "verification.json").read_text())
            for k in ("files_exist", "hashes_match", "weights_nonempty", "adapter_trained", "adapter_loads", "malformed_input_handled"):
                self.assertTrue(v["checks"][k], k)
            self.assertFalse(v["verification_passed"])
            self.assertIn("eval_perplexity", v)
            r = self.run_py("package_adapter.py", "--adapter", str(out / "adapter"))
            s = json.loads((out / "package_summary.json").read_text())
            self.assertTrue(s["safetensors_inside_tarball_matches"])
            self.assertTrue(s["tarball"].endswith("SMOKE-TEST-NOT-NICK-adapter-smoke.tar.gz"))
            r = self.run_py("kaggle/kaggle_pipeline.py", "status", env={**os.environ, "APPROX_OUTPUT_DIR": str(out)}, ok=(1,))
            self.assertIn("NOT COMPLETE", r.stdout)
            st = json.loads((out / "completion_status.json").read_text())
            self.assertFalse(st["evidence"]["gpu_training_completed"])


if __name__ == "__main__":
    unittest.main()
