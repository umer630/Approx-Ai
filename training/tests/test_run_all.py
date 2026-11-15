"""Orchestration tests for training/run_all.py (no GPU needed: the GPU and the per-model trainer are injected).
They prove the control flow only — order, hardware gating, continue-on-failure, resume by RUN_ID, time budget —
not that any model trains. Also checks the release layout writer. Run: python -m pytest training/tests/test_run_all.py
"""
import json
import sys
import tempfile
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
for _p in (str(TRAINING), str(TRAINING.parent)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import run_all  # noqa: E402

T4 = (15.0, 7.5, "Tesla T4")
A100 = (85.0, 8.0, "NVIDIA A100-SXM4-80GB")
NO_RESTORE = lambda models, skip: {m: "test" for m in models}   # noqa: E731


def fake_trainer(log, fail=(), pause=()):
    def train(cfg_path, models_dir, work, *, run_id, resume, time_budget_minutes, signing_key):
        m = Path(cfg_path).stem
        log.append((m, resume))
        if m in fail:
            raise RuntimeError(f"{m} exploded")
        if m in pause and not resume:
            return {"model_id": m, "status": "paused"}
        return {"model_id": m, "status": "completed", "release": {"version": "1.0.0", "status": "validated", "production_ready": False, "blockers": [], "dir": "x"},
                "evaluation": {"adapter_score": 1}}
    return train


def run(args, **kw):
    return run_all.main(args, restore_fn=NO_RESTORE, **kw)


def test_t4_trains_only_what_fits_and_reports_the_rest():
    with tempfile.TemporaryDirectory() as d:
        log = []
        rc = run(["--models", "all", "--run-id", "r1", "--work-dir", d, "--models-dir", d + "/m"], train_fn=fake_trainer(log), gpu=T4)
        assert [m for m, _ in log] == ["nick-4.8", "hike-6.5"]          # never "trains" Sona/FAB on a T4
        st = json.loads((Path(d) / "runs/r1/state.json").read_text())["models"]
        assert st["nick-4.8"]["status"] == st["hike-6.5"]["status"] == "completed"
        for m in ("sona-9.0", "fab-100x", "fab-500x"):
            assert st[m]["status"] == "skipped_hardware" and ("GPU_REQUIREMENT_NOT_MET" in st[m]["reason"] or "compute capability" in st[m]["reason"])
        assert rc == 1
        rep = json.loads((Path(d) / "m/pipeline_report.json").read_text())
        assert rep["models"]["fab-500x"]["needs"].startswith("1× NVIDIA A100")


def test_resume_same_run_id_continues_from_first_incomplete_model_on_bigger_gpu():
    with tempfile.TemporaryDirectory() as d:
        log = []
        args = ["--models", "all", "--run-id", "r2", "--work-dir", d, "--models-dir", d + "/m"]
        run(args, train_fn=fake_trainer(log), gpu=T4)
        log.clear()
        rc = run(args, train_fn=fake_trainer(log), gpu=A100)
        assert [m for m, _ in log] == ["sona-9.0", "fab-100x", "fab-500x"], "finished models are not retrained"
        assert rc == 0


def test_one_failure_does_not_stop_the_pipeline_and_retry_resumes():
    with tempfile.TemporaryDirectory() as d:
        log = []
        args = ["--models", "all", "--run-id", "r3", "--work-dir", d, "--models-dir", d + "/m"]
        rc = run(args, train_fn=fake_trainer(log, fail={"hike-6.5"}), gpu=A100)
        assert [m for m, _ in log] == ORDER_ALL
        st = json.loads((Path(d) / "runs/r3/state.json").read_text())["models"]
        assert st["hike-6.5"]["status"] == "failed" and "exploded" in st["hike-6.5"]["reason"]
        assert all(st[m]["status"] == "completed" for m in ORDER_ALL if m != "hike-6.5")
        assert rc == 1
        log.clear()
        assert run(args, train_fn=fake_trainer(log), gpu=A100) == 1 and log == [], "failed models wait for --retry-failed"
        assert run(args + ["--retry-failed"], train_fn=fake_trainer(log), gpu=A100) == 0
        assert log == [("hike-6.5", True)], "retry resumes from the failed run's checkpoints"


def test_pause_stops_and_rerun_resumes_the_same_model():
    with tempfile.TemporaryDirectory() as d:
        log = []
        args = ["--models", "nick-4.8", "hike-6.5", "--run-id", "r4", "--work-dir", d, "--models-dir", d + "/m", "--time-budget-minutes", "240"]
        assert run(args, train_fn=fake_trainer(log, pause={"nick-4.8"}), gpu=T4) == 3
        assert log == [("nick-4.8", False)]
        log.clear()
        assert run(args, train_fn=fake_trainer(log, pause={"nick-4.8"}), gpu=T4) == 0
        assert log == [("nick-4.8", True), ("hike-6.5", False)]


def test_no_gpu_trains_nothing():
    with tempfile.TemporaryDirectory() as d:
        log = []
        assert run(["--models", "all", "--run-id", "r5", "--work-dir", d, "--models-dir", d + "/m"], train_fn=fake_trainer(log), gpu=(None, None, None)) == 1
        assert log == []


def test_release_layout_has_the_documented_files_and_manifest_fields():
    from engine import release_manager as rm
    with tempfile.TemporaryDirectory() as d:
        r = Path(d)
        (r / "adapter").mkdir()
        for f in ("adapter_config.json", "tokenizer.json", "tokenizer_config.json"):
            (r / "adapter" / f).write_text("{}")
        rel = {"model_id": "nick-4.8", "version": "1.0.0", "base_model": "microsoft/Phi-4-mini-instruct", "base_model_revision": "abc",
               "dataset": {"version": "v", "fingerprint": "f"}, "adapter_sha256": "0" * 64, "created_at": "now", "status": "validated",
               "production_ready": False, "smoke_test": False, "blockers": ["x"]}
        rm.write_release_layout(r, {"lora": {"r": 16}, "base_model_revision": "abc"}, rel, {"metrics": {"global_step": 5}}, {"passed": True, "adapter_score": 90},
                                {"passed": True}, {"passed": True}, {"run_id": "approx-full-r1", "hardware": {"gpu": "T4"}, "duration_s": 12.5,
                                                                    "dataset": {"version": "v", "fingerprint": "f", "files": {"train.jsonl": "1" * 64}}})
        assert (r / "tokenizer/tokenizer.json").exists() and (r / "config/adapter_config.json").exists() and (r / "config/training_config.json").exists()
        man = json.loads((r / "manifest.json").read_text())
        for k in ("model_id", "version", "base_model", "base_model_revision", "training_dataset_version", "dataset_sha256", "adapter_type", "lora",
                  "training_run_id", "hardware", "training_duration_s", "evaluation", "artifact_sha256", "created_at", "status"):
            assert k in man, k
        assert man["production_ready"] is False and man["training_run_id"] == "approx-full-r1"
        assert json.loads((r / "training_report.json").read_text())["steps"] == 5


ORDER_ALL = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"]

if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))
