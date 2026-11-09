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

    def _fake_gpu_ready(self, vram=15.64):
        """Simulated GPU_READY hardware (this test container has no GPU)."""
        prof = self.cp.vram_profile(vram)
        info = {"GPU_STATUS": "GPU_READY", "GPU_READY": True, "CUDA_READY": True, "reasons": [], "gpu_name": "Tesla T4",
                "vram_gb": vram, "bf16_supported": False, "compute_capability": [7, 5], "profile": prof, "is_t4": True,
                "torch": "x", "torch_cuda_build": "12.4", "cuda_available": True, "nvidia_smi": "Tesla T4", "cuda_matmul_ok": True}
        self.cp.gpu_status = lambda: dict(info)
        return info

    def _all_ready(self, vram=15.64):
        self._fake_gpu_ready(vram)
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
        order = [phases.index(p) for p in ("entered", "training_start_probe", "base_model_loaded", "qlora_initialized", "dataset_tokenized")]
        self.assertEqual(order, sorted(order))
        self.assertNotIn("trainer_started", phases)
        self.assertEqual(phases[-1], "failed")
        # the diagnosis reads it back from a launcher-style log
        self._log(r.stdout + r.stderr, r.returncode)
        d = self.cp.diagnose()
        self.assertEqual(d["QLORA_INITIALIZED"], "YES")
        self.assertEqual(d["TRAINING_STEP_STARTED"], "NO")
        self.assertIn("ValueError", d["FIRST_REAL_ERROR"])
    # ---------------- detached supervisor (real processes, tiny CPU smoke model) ----------------
    def _tiny(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("torch not installed")
        tiny = Path(self.tmp.name) / "tiny"
        if not tiny.exists():
            subprocess.run([sys.executable, str(ROOT / "tests/make_tiny_model.py"), str(tiny)], cwd=ROOT, check=True, capture_output=True)
        return tiny

    def _launch(self, name, extra=()):
        import time as _t
        tmp = Path(self.tmp.name)
        log = (tmp / f"{name}.log").open("a")
        status = tmp / f"{name}.json"
        subprocess.Popen([sys.executable, "-u", "colab/train_supervisor.py", "--status-file", str(status), "--", sys.executable, "-u",
                          "train_qlora.py", "--smoke-base", str(self._tiny()), "--output-dir", str(tmp / name), *extra],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        log.close()
        return status, tmp / f"{name}.log"

    def _wait(self, status, cond, timeout=240):
        import time as _t
        end = _t.time() + timeout
        while _t.time() < end:
            if status.exists():
                try:
                    d = json.loads(status.read_text())
                    if cond(d):
                        return d
                except ValueError:
                    pass
            _t.sleep(1)
        self.fail(f"timeout waiting on {status}")

    def test_supervised_training_survives_launcher_exit_and_records_phases(self):
        status, log = self._launch("detached")          # this test process never reads the trainer's output
        d = self._wait(status, lambda d: d.get("state") == "finished")
        self.assertEqual(d["exit_code"], 0)
        self.assertTrue((Path(self.tmp.name) / "detached-SMOKE/adapter/adapter_model.safetensors").exists())
        phases = [json.loads(l[13:])["phase"] for l in log.read_text().splitlines() if l.startswith("APPROX_PHASE ")]
        for ph in ("entered", "training_start_probe", "tokenizer_load_start", "tokenizer_loaded", "base_model_load_start",
                   "base_model_loaded", "lora_init_start", "qlora_initialized", "dataset_tokenized", "trainer_init_start",
                   "trainer_init_done", "resume_decision", "trainer_started", "first_training_step_start", "adapter_saved"):
            self.assertIn(ph, phases)
        probe = json.loads((Path(self.tmp.name) / "detached-SMOKE/training_start_probe.json").read_text())
        for k in ("runtime_id", "gpu_name", "gpu_memory_total_gb", "python_version", "torch_version", "transformers_version",
                  "peft_version", "bitsandbytes_version", "model_id", "cache_location", "drive_mount_status", "free_system_ram_gb",
                  "free_disk_space_gb"):
            self.assertIn(k, probe)
        self.assertNotIn("token", json.dumps(probe).lower().replace("tokenizer", ""))
        self.assertIn("=== exit code 0", log.read_text())

    def test_supervisor_records_sigkill_of_trainer(self):
        import signal as _s
        status, log = self._launch("killed", ("--smoke-max-steps", "400"))
        d = self._wait(status, lambda d: d.get("state") == "running" and d.get("trainer_pid"))
        self._wait(status, lambda d: "first_training_step_start" in log.read_text())
        os.kill(d["trainer_pid"], _s.SIGKILL)
        d = self._wait(status, lambda d: d.get("state") == "finished")
        self.assertEqual(d["exit_code"], -9)
        self.assertEqual(d["signal"], "SIGKILL")
        self.assertIn("=== exit code -9", log.read_text())

    def test_supervisor_forwards_sigterm(self):
        import signal as _s
        status, log = self._launch("termed", ("--smoke-max-steps", "400"))
        d = self._wait(status, lambda d: d.get("state") == "running" and d.get("supervisor_pid"))
        self._wait(status, lambda d: "first_training_step_start" in log.read_text())
        os.kill(d["supervisor_pid"], _s.SIGTERM)
        d = self._wait(status, lambda d: d.get("state") == "finished")
        self.assertEqual(d["exit_code"], 143)
        self.assertIn("SIGTERM", d["forwarded_signals"])
        self.assertIn("terminated_by_signal_15", log.read_text())

    def test_diagnose_reports_still_running_and_last_phase(self):
        self._log('APPROX_PHASE {"phase": "entered"}\nAPPROX_PHASE {"phase": "base_model_download_start"}', None)
        (self.drive / "checkpoints").mkdir(parents=True, exist_ok=True)
        (self.drive / "checkpoints/supervisor_status.json").write_text(json.dumps({"state": "running", "supervisor_pid": os.getpid()}))
        r = self.cp.diagnose()
        self.assertEqual(r["STILL_RUNNING"], "YES")
        self.assertEqual(r["LAST_PHASE"], "base_model_download_start")
        self.assertIn("still running", r["ROOT_CAUSE"])
        self.assertEqual(r["RESUME_OR_FRESH"], "FRESH")

    # ---------------- hardware classification + GPU-only stage guards ----------------
    def test_this_cpu_container_is_classified_no_gpu_attached(self):
        info = self.cp.gpu_status()
        self.assertEqual(info["GPU_STATUS"], "NO_GPU_ATTACHED")
        self.assertFalse(info["GPU_READY"])
        self.assertFalse(info["CUDA_READY"])

    def test_cuda_unavailable_when_device_visible_but_torch_is_cpu_build(self):
        from unittest import mock
        import torch
        with mock.patch("glob.glob", return_value=["/dev/nvidia0"]), mock.patch.object(torch.version, "cuda", None), \
                mock.patch.object(torch.cuda, "is_available", return_value=False):
            info = self.cp.gpu_status()
        self.assertEqual(info["GPU_STATUS"], "CUDA_UNAVAILABLE")
        self.assertIn("CPU-only build", info["reasons"][0])
        self.assertFalse(info["GPU_READY"])

    def _mock_cuda(self, name, total_bytes, cap):
        from types import SimpleNamespace
        from unittest import mock
        import torch
        real_randn = torch.randn
        return [mock.patch.object(torch.cuda, "is_available", return_value=True),
                mock.patch.object(torch.cuda, "get_device_properties", return_value=SimpleNamespace(name=name, total_memory=total_bytes)),
                mock.patch.object(torch.cuda, "get_device_capability", return_value=cap),
                mock.patch.object(torch.cuda, "is_bf16_supported", return_value=False),
                mock.patch.object(torch, "randn", side_effect=lambda *a, **k: real_randn(*a)),
                mock.patch("glob.glob", return_value=["/dev/nvidia0"])]

    def _status_with(self, patches):
        import contextlib
        with contextlib.ExitStack() as st:
            for p in patches:
                st.enter_context(p)
            return self.cp.gpu_status()

    def test_gpu_ready_for_t4(self):
        info = self._status_with(self._mock_cuda("Tesla T4", int(15.64e9), (7, 5)))
        self.assertEqual(info["GPU_STATUS"], "GPU_READY")
        self.assertTrue(info["GPU_READY"] and info["CUDA_READY"] and info["is_t4"])
        self.assertEqual(info["profile"]["name"], "T4 16GB")

    def test_gpu_attached_but_incompatible(self):
        old = self._status_with(self._mock_cuda("Tesla K80", int(12e9), (3, 7)))
        self.assertEqual(old["GPU_STATUS"], "GPU_ATTACHED_BUT_INCOMPATIBLE")
        self.assertIn("compute capability", " ".join(old["reasons"]))
        small = self._status_with(self._mock_cuda("Small GPU", int(8e9), (8, 6)))
        self.assertEqual(small["GPU_STATUS"], "GPU_ATTACHED_BUT_INCOMPATIBLE")
        self.assertFalse(small["GPU_READY"])

    def test_gpu_stages_refuse_on_cpu_runtime_before_any_install_or_download(self):
        for name in ("deps", "model", "config", "train", "evaluate", "verify"):
            with self.assertRaises(SystemExit, msg=name):
                self.cp.STAGES[name]()
            g = json.loads((self.drive / "metadata/gpu.json").read_text())
            self.assertEqual(g["GPU_STATUS"], "NO_GPU_ATTACHED")
        self.assertFalse((self.drive / "logs/deps.log").exists(), "pip must not run on a CPU-only runtime")
        self.assertFalse((self.drive / "metadata/deps.json").exists())
        self.assertFalse((self.drive / "metadata/model.json").exists())
        self.assertFalse((self.drive / "logs/model.log").exists(), "no model download on a CPU-only runtime")

    def test_cpu_runtime_never_training_ready(self):
        # even if every OTHER check were green, a CPU-only gpu.json keeps the hard gate closed
        self._all_ready()
        self.cp.config()
        del self.cp.gpu_status          # back to the real (CPU) classifier
        import importlib
        self.cp = importlib.reload(self.cp)
        self.cp.save("gpu.json", self.cp.gpu_status())
        with self.assertRaises(SystemExit):
            self.cp.gate()
        pf = json.loads((self.drive / "metadata/preflight.json").read_text())
        self.assertFalse(pf["GPU_READY"])
        self.assertFalse(pf["TRAINING_READY"])

    def test_notebook_cell2_classifies_and_guards_gpu_cells(self):
        subprocess.run([sys.executable, str(ROOT / "colab/build_notebook.py")], check=True, capture_output=True)
        nb = json.loads((ROOT / "colab/nick_4_8_qlora_colab.ipynb").read_text())
        code = [c["source"] for c in nb["cells"] if c["cell_type"] == "code"]
        cell2 = code[1]
        for state in ("NO_GPU_ATTACHED", "CUDA_UNAVAILABLE", "GPU_ATTACHED_BUT_INCOMPATIBLE", "GPU_READY"):
            self.assertIn(state, cell2)
        for printed in ("torch.version.cuda", "torch.cuda.is_available", "GPU name", "VRAM", "CUDA capability", "GPU_READY"):
            self.assertIn(printed, cell2)
        self.assertNotIn("pip", cell2)
        helper = code[3]
        self.assertIn('GPU_STAGES = {"deps", "model", "config", "gate", "train", "evaluate", "verify"}', helper)
        # executing cell 2 here (CPU container) must stop with NO_GPU_ATTACHED
        ns = {}
        with self.assertRaises(RuntimeError) as ctx:
            exec(cell2, ns)
        self.assertIn("NO_GPU_ATTACHED", str(ctx.exception))
        self.assertEqual(ns["GPU_STATUS"], "NO_GPU_ATTACHED")


if __name__ == "__main__":
    unittest.main()
