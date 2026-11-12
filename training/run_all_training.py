"""Approx AI — single entry point for the whole training platform.

    python run_all_training.py                 # GPU preflight → for each model: dataset, train, verify,
                                               #   evaluate (base vs adapter), safety, regression, release
    python run_all_training.py --models nick-4.8 hike-6.5
    python run_all_training.py --smoke         # CPU smoke run on a tiny random model (pipeline test, NOT real models)
    python run_all_training.py --worker --control-plane-url https://… --api-key apx_…   # GPU runner driven by the backend
    python run_all_training.py --resume        # continue from checkpoints; supports --time-budget-minutes for pausable runs

Per model the engine blocks on any failure and records an explicit reason. No model is marked production_ready
unless its dataset is production-ready AND training, verification, the weighted evaluation gate, the safety gate
and the regression check all pass. Release artifacts are written to --models-dir and are ready for the backend to
import/activate (or uploaded directly in --worker mode).

GPU is REQUIRED for real training; without it the run stops with GPU_REQUIRED (never a CPU fallback).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

TRAINING = Path(__file__).resolve().parent
REPO_ROOT = TRAINING.parent
for _p in (str(TRAINING), str(REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from engine import runner, hardware   # noqa: E402

ALL_MODELS = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-500x"]


class ControlPlane:
    """Reports progress to the backend compute API and (on success) uploads the release artifact. No-op if unset."""

    def __init__(self, url: str, api_key: str, job_id: str | None, worker: dict):
        self.url, self.api_key, self.job_id, self.worker = url.rstrip("/") if url else "", api_key, job_id, worker

    def _post(self, path: str, body: dict, raw: bytes | None = None, headers: dict | None = None):
        if not self.url:
            return {}
        data = raw if raw is not None else json.dumps(body).encode()
        rq = urllib.request.Request(f"{self.url}{path}", data=data, method="POST",
                                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": headers.get("content-type", "application/json") if headers else "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(rq, timeout=180) as r:
                return json.loads(r.read().decode() or "{}")
        except Exception as e:
            print(f"[control-plane] {path} failed: {type(e).__name__}: {e}", flush=True)
            return {}

    def report(self, **kw):
        if self.url and self.job_id:
            out = self._post(f"/api/admin/compute/jobs/{self.job_id}/report", {"worker": self.worker, **kw})
            if out.get("stop_requested"):
                raise KeyboardInterrupt("stop requested by the control plane")

    def upload(self, archive: Path, sha256: str):
        if not self.url:
            return {}
        return self._post("/api/admin/registry/import", {}, raw=archive.read_bytes(),
                          headers={"content-type": "application/gzip", "X-Artifact-Sha256": sha256})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Approx AI unified training platform entry point.")
    ap.add_argument("--models", nargs="*", default=None, help=f"subset of {ALL_MODELS} (default: all)")
    ap.add_argument("--models-dir", default=os.environ.get("APPROX_MODELS_DIR", str(REPO_ROOT / "release" / "models")),
                    help="where release artifacts are written (shared with the backend registry)")
    ap.add_argument("--work-dir", default=os.environ.get("APPROX_WORK_DIR", str(TRAINING / "outputs" / "engine")))
    ap.add_argument("--config-dir", default=str(TRAINING / "models"))
    ap.add_argument("--smoke", action="store_true", help="CPU smoke run on a tiny random model (pipeline validation only)")
    ap.add_argument("--smoke-base", default=os.environ.get("APPROX_SMOKE_BASE"), help="path to the tiny model for --smoke")
    ap.add_argument("--resume", action="store_true", help="resume from existing checkpoints")
    ap.add_argument("--time-budget-minutes", type=float, default=float(os.environ.get("APPROX_TIME_BUDGET", "0")))
    ap.add_argument("--signing-key", default=os.environ.get("APPROX_RELEASE_SIGNING_KEY", ""))
    ap.add_argument("--worker", action="store_true", help="act as a GPU worker driven by the backend compute API")
    ap.add_argument("--control-plane-url", default=os.environ.get("APPROX_CONTROL_PLANE_URL", ""))
    ap.add_argument("--api-key", default=os.environ.get("APPROX_WORKER_API_KEY", ""))
    ap.add_argument("--job-id", default=os.environ.get("APPROX_JOB_ID"))
    a = ap.parse_args(argv)

    models = a.models or (["nick-4.8"] if a.smoke else ALL_MODELS)
    if a.smoke and not a.smoke_base:
        print("ERROR: --smoke needs --smoke-base <tiny model dir> (e.g. from tests/make_tiny_model.py)", file=sys.stderr)
        return 2
    models_dir = Path(a.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)

    vram, cc, gpu_name = hardware.detect_gpu()
    preflight = {"gpu": gpu_name, "vram_gb": vram, "compute_capability": cc, "cuda": vram is not None}
    print("=" * 70)
    print(f"Approx AI training platform · models={models} · smoke={a.smoke}")
    print(f"GPU preflight: {json.dumps(preflight)}")
    if not a.smoke and vram is None:
        print("\nGPU_REQUIRED: no CUDA GPU detected. Real QLoRA training cannot run here (no CPU fallback).", file=sys.stderr)
        print("On Google Colab: Runtime → Change runtime type → T4 GPU, then rerun this cell.", file=sys.stderr)
        # still emit per-model hardware feasibility so the operator sees requirements
    print("=" * 70, flush=True)

    worker = {"id": os.environ.get("APPROX_WORKER_ID", f"{gpu_name or 'cpu'}-{os.getpid()}").replace(" ", "-"),
              "name": gpu_name or "local", "gpu": {"name": gpu_name, "vram_gb": vram, "compute_capability": cc}, "runtime": preflight}
    cp = ControlPlane(a.control_plane_url, a.api_key, a.job_id, worker)

    results = []
    for model_id in models:
        cfg_path = Path(a.config_dir) / f"{model_id}.yaml"
        if not cfg_path.exists():
            results.append({"model_id": model_id, "status": "blocked", "blockers": [f"no config at {cfg_path}"]})
            continue
        print(f"\n######## {model_id} ########", flush=True)

        def report(**kw):
            cp.report(phase=f"{kw.get('model_id')}: {kw.get('stage')}", progress={kw.get("model_id"): kw}, log_append=json.dumps(kw) + "\n")
        try:
            res = runner.train_one(cfg_path, models_dir, Path(a.work_dir), smoke=a.smoke, smoke_base=a.smoke_base,
                                   time_budget_minutes=a.time_budget_minutes, signing_key=a.signing_key, report=report)
        except KeyboardInterrupt as e:
            print(f"\nSTOPPED: {e}", flush=True)
            res = {"model_id": model_id, "status": "stopped", "blockers": [str(e)]}
            results.append(res)
            break
        results.append(res)
        if res.get("status") == "completed" and res.get("release"):
            up = cp.upload(Path(res["release"]["dir"]).parent.parent.parent / f"{model_id}-{res['release']['version']}.tar.gz", res["release"]["archive_sha256"])
            if up:
                res["uploaded"] = {"status": up.get("status"), "version": up.get("version")}
        status = res.get("status")
        rel = res.get("release", {})
        print(f"---- {model_id}: {status}" + (f" · release {rel.get('version')} status={rel.get('status')} production_ready={rel.get('production_ready')}" if rel else "")
              + (f" · BLOCKERS: {res.get('blockers')}" if res.get("blockers") else ""), flush=True)

    # final machine-readable report
    report = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "preflight": preflight, "smoke": a.smoke, "models": results,
              "flags": {}}
    for model_id in ALL_MODELS:
        r = next((x for x in results if x["model_id"] == model_id), None)
        ready = bool(r and r.get("status") == "completed" and r.get("release", {}).get("production_ready"))
        pipeline_ready = bool(r and r.get("status") in ("completed", "blocked") and (r.get("release") or r.get("blocker_code") in ("GPU_REQUIRED", "GPU_REQUIREMENT_NOT_MET")))
        report["flags"][f"{model_id.replace('-', '_').replace('.', '_').upper()}_PRODUCTION_READY"] = "YES" if ready else "NO"
        report["flags"][f"{model_id.replace('-', '_').replace('.', '_').upper()}_PIPELINE_READY"] = "YES" if pipeline_ready or (r and r.get("status") == "completed") else "NO"
    out = models_dir / "training_report.json"
    out.write_text(json.dumps(report, indent=2, default=str))
    print("\n" + "=" * 70)
    print(json.dumps(report["flags"], indent=2))
    print(f"full report: {out}")
    print("=" * 70)
    any_blocked = any(r.get("status") in ("blocked", "stopped") for r in results)
    return 1 if any_blocked and not a.smoke else 0


if __name__ == "__main__":
    sys.exit(main())
