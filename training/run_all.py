"""Approx AI — ONE command for the whole model pipeline.

    python training/run_all.py --models all --run-id approx-full-r1 --time-budget-minutes 240

For each model in order (nick-4.8 → hike-6.5 → sona-9.0 → fab-100x → fab-500x):

    restore the approved dataset from the repository (Git LFS shards) → verify every SHA-256 against
    training/datasets/DATASETS.lock.json → detect the GPU → pick the training profile that fits (engine/hardware.py)
    → QLoRA training with checkpoints → independent verification → unseen evaluation (base vs adapter) → safety +
    regression gates → release package under <models-dir>/<model>/versions/<version>/

Rules
  * Resume: progress is kept in <work-dir>/runs/<RUN_ID>/state.json. Re-running the SAME command with the same
    --run-id skips finished models, resumes a paused/interrupted one from its last checkpoint, and continues with the
    first incomplete model. A different --run-id starts fresh.
  * Hardware: a model whose smallest profile does not fit the detected GPU is SKIPPED with the exact requirement
    (e.g. FAB 500X needs an A100/H100-class GPU); it is never "trained" on a GPU that cannot hold it. Without a CUDA
    GPU nothing is trained (no CPU fallback).
  * Failures: if one model fails, its logs/checkpoints stay in its run directory, the failure + reason is recorded,
    and the pipeline continues with the next model.
  * Time budget: training pauses at a checkpoint when the budget is used up; rerun to continue.
  * Nothing is ever published as production-ready unless every gate passed (engine/release_manager.py).
Exit code: 0 = every requested model completed; 3 = paused (rerun to resume); 1 = something failed/was skipped.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

TRAINING = Path(__file__).resolve().parent
REPO = TRAINING.parent
for _p in (str(TRAINING), str(REPO)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

ORDER = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"]
DONE = {"completed"}


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class State:
    """Durable per-run progress (written atomically after every change)."""

    def __init__(self, path: Path, run_id: str, models: list):
        self.path = path
        if path.exists():
            self.data = json.loads(path.read_text())
            if self.data.get("run_id") != run_id:
                raise SystemExit(f"{path} belongs to run {self.data.get('run_id')}, not {run_id}")
        else:
            self.data = {"schema": "approx.pipeline-state/v1", "run_id": run_id, "created_at": now(), "models": {}}
        for m in models:
            self.data["models"].setdefault(m, {"status": "pending", "attempts": 0})
        self.save()

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, default=str))
        tmp.replace(self.path)

    def set(self, model: str, **kw):
        self.data["models"][model].update(kw, updated_at=now())
        self.save()

    def get(self, model: str) -> dict:
        return self.data["models"][model]


def feasibility(models: list, cfg_dir: Path, gpu) -> dict:
    from engine import hardware, runner
    vram, cc, _ = gpu
    out = {}
    for m in models:
        cfg = runner.load_model_cfg(cfg_dir / f"{m}.yaml")
        p = hardware.plan(cfg, vram, cc)
        out[m] = {"feasible": p["feasible"], "profile": (p["chosen_profile"] or {}).get("name"), "reason": p["reason"],
                  "recommended": p.get("recommended_hardware")}
    return out


def restore_datasets(models: list, skip: bool) -> dict:
    from datahub import dist
    if skip:
        lock = json.loads(dist.LOCK.read_text())
        bad = [m for m in models if not dist.verify_one(m, lock["models"][m])]
        if bad:
            raise SystemExit(f"--skip-restore: local datasets for {bad} do not match DATASETS.lock.json")
        return {m: "verified (local)" for m in models}
    return dist.restore(models)


def main(argv=None, *, train_fn=None, gpu=None, restore_fn=None) -> int:
    ap = argparse.ArgumentParser(description="Approx AI one-command training pipeline")
    ap.add_argument("--models", nargs="+", default=["all"], help="'all' or any of: " + " ".join(ORDER))
    ap.add_argument("--run-id", default=os.environ.get("APPROX_RUN_ID") or "approx-full-r1")
    ap.add_argument("--time-budget-minutes", type=float, default=float(os.environ.get("APPROX_TIME_BUDGET", "0") or 0),
                    help="total minutes for this invocation (0 = unlimited); training pauses at a checkpoint when used up")
    ap.add_argument("--work-dir", default=os.environ.get("APPROX_WORK_DIR", str(TRAINING / "outputs" / "pipeline")))
    ap.add_argument("--models-dir", default=os.environ.get("APPROX_MODELS_DIR", str(REPO / "models")))
    ap.add_argument("--config-dir", default=str(TRAINING / "models"))
    ap.add_argument("--skip-restore", action="store_true", help="use local datasets (still SHA-256 verified against the lock)")
    ap.add_argument("--retry-failed", action="store_true", help="retry models that failed in an earlier invocation of this run")
    ap.add_argument("--signing-key", default=os.environ.get("APPROX_RELEASE_SIGNING_KEY", ""))
    a = ap.parse_args(argv)

    models = ORDER if a.models in (["all"], ["ALL"]) else a.models
    unknown = [m for m in models if m not in ORDER]
    if unknown:
        print(f"unknown model(s): {unknown}; choose from {ORDER}", file=sys.stderr)
        return 2
    models = [m for m in ORDER if m in models]          # always the documented order
    work = Path(a.work_dir)
    models_dir = Path(a.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    state = State(work / "runs" / a.run_id / "state.json", a.run_id, models)
    started = time.time()

    from engine import hardware, runner
    gpu = gpu or hardware.detect_gpu()
    vram, cc, name = gpu
    print("=" * 78)
    print(f"Approx AI pipeline · run {a.run_id} · models {models} · budget {a.time_budget_minutes or 'unlimited'} min")
    print(f"GPU: {name or 'none'} · {vram or 0} GB · compute capability {cc}")
    plan = feasibility(models, Path(a.config_dir), gpu)
    print("\nWhat this GPU can train:")
    for m in models:
        st = state.get(m)["status"]
        f = plan[m]
        print(f"  {m:10s} {'YES' if f['feasible'] else 'NO ':3s}  {('profile ' + f['profile']) if f['feasible'] else f['reason']}"
              + (f"   [already {st}]" if st in DONE else ""))
        if not f["feasible"] and f.get("recommended"):
            print(f"  {'':10s}      needs: {f['recommended']}")
    state.data["last_invocation"] = {"at": now(), "gpu": {"name": name, "vram_gb": vram, "compute_capability": cc}, "feasibility": plan}
    state.save()
    print("=" * 78, flush=True)

    todo = [m for m in models if state.get(m)["status"] not in DONE and (a.retry_failed or state.get(m)["status"] != "failed")]
    try:
        restored = (restore_fn or restore_datasets)([m for m in todo if plan[m]["feasible"]], a.skip_restore)
        for m, r in restored.items():
            print(f"dataset {m:10s} {r}")
    except SystemExit as e:
        print(f"\nDATASET RESTORE FAILED: {e}", file=sys.stderr)
        return 1

    train = train_fn or runner.train_one
    paused = False
    for m in todo:
        if not plan[m]["feasible"]:
            state.set(m, status="skipped_hardware", reason=plan[m]["reason"], needs=plan[m].get("recommended"))
            print(f"\n---- {m}: SKIPPED on this GPU — {plan[m]['reason']}")
            continue
        remaining = 0.0
        if a.time_budget_minutes:
            remaining = a.time_budget_minutes - (time.time() - started) / 60
            if remaining < 5:
                paused = True
                print(f"\n---- time budget used; {m} not started. Rerun the same command to continue.")
                break
        prev = state.get(m)
        resume = prev["status"] in ("paused", "running", "interrupted", "failed") and prev.get("attempts", 0) > 0
        state.set(m, status="running", attempts=prev.get("attempts", 0) + 1, started_at=now())
        print(f"\n######## {m} ({'resume' if resume else 'start'}) ########", flush=True)
        try:
            res = train(Path(a.config_dir) / f"{m}.yaml", models_dir, work, run_id=a.run_id, resume=resume,
                        time_budget_minutes=remaining, signing_key=a.signing_key)
        except KeyboardInterrupt:
            state.set(m, status="interrupted")
            print("\nINTERRUPTED — rerun the same command to resume from the last checkpoint.")
            return 3
        except Exception as e:   # one model failing never stops the others
            state.set(m, status="failed", reason=f"{type(e).__name__}: {e}", traceback=traceback.format_exc()[-4000:])
            print(f"---- {m}: FAILED ({type(e).__name__}: {e}); logs kept under {work / m / 'runs' / a.run_id}; continuing")
            continue
        st = res.get("status")
        if st == "completed":
            rel = res.get("release", {})
            state.set(m, status="completed", release={k: rel.get(k) for k in ("version", "status", "production_ready", "blockers", "adapter_sha256", "dir", "archive_sha256")},
                      evaluation=res.get("evaluation"))
            print(f"---- {m}: COMPLETED · release {rel.get('version')} status={rel.get('status')} production_ready={rel.get('production_ready')}")
        elif st == "paused":
            state.set(m, status="paused")
            paused = True
            print(f"---- {m}: PAUSED at a checkpoint (time budget). Rerun the same command to resume.")
            break
        else:
            state.set(m, status="failed", reason="; ".join(res.get("blockers", [])) or st, code=res.get("blocker_code"), stages=res.get("stages"))
            print(f"---- {m}: {st.upper()} · {res.get('blocker_code')} · {res.get('blockers')}; continuing")

    summary = {m: {k: v for k, v in state.get(m).items() if k not in ("traceback", "stages")} for m in models}
    state.data["summary"] = summary
    state.save()
    (models_dir / "pipeline_report.json").write_text(json.dumps({"run_id": a.run_id, "generated_at": now(), "gpu": state.data["last_invocation"]["gpu"],
                                                                "models": summary}, indent=2, default=str))
    print("\n" + "=" * 78)
    for m in models:
        s = summary[m]
        extra = s.get("release", {}) and f" v{s['release'].get('version')} production_ready={s['release'].get('production_ready')}" or ""
        print(f"  {m:10s} {s['status']:17s}{extra}{(' · ' + str(s.get('reason'))[:160]) if s.get('reason') and s['status'] != 'completed' else ''}")
    first = next((m for m in models if summary[m]["status"] not in DONE), None)
    if first:
        print(f"\nFirst incomplete model: {first}. Same command resumes it (on hardware that fits).")
    print(f"State: {state.path}\nReport: {models_dir / 'pipeline_report.json'}")
    if paused:
        return 3
    return 0 if all(summary[m]["status"] in DONE for m in models) else 1


if __name__ == "__main__":
    sys.exit(main())
