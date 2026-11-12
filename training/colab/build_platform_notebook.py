"""Generate training/colab/approx_training_colab.ipynb — the SINGLE entry point for the whole platform on Colab.
Run: python colab/build_platform_notebook.py

The notebook mounts Drive, clones the repo, checks the GPU, installs pinned deps, and runs
`run_all_training.py`, which does dataset → train → verify → evaluate → safety → regression → release for each
selected model and writes importable release artifacts to Drive. Defaults to Nick 4.8; set MODELS to add more.
"""
import json
from pathlib import Path

REPO, BRANCH = "umer630/Approx-Ai", "ccr-b9e70091-57vl48"


def md(s):
    return {"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")}


def code(s):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n")}


cells = [
    md(f"""
# Approx AI — model training (Google Colab)

One notebook for the whole training platform. It runs, for each selected model:
**dataset build → QLoRA training → independent verification → unseen evaluation (base vs adapter) → safety gate →
regression → release packaging**, and writes a registry-ready release artifact to Google Drive.

**Default:** Nick 4.8 (`Qwen/Qwen2.5-3B-Instruct`, fits a free T4). Others (Hike 6.5, Sona 9.0, FAB 500X) need more
VRAM — see the hardware table printed by the preflight.

### Steps
1. **Runtime → Change runtime type → T4 GPU (or better) → Save.**
2. **Runtime → Run all.** Approve the Drive mount pop-up in cell 2.
3. A Hugging Face token is only needed if a base model is gated — add `HF_TOKEN` in the 🔑 *Secrets* sidebar (never paste it into a cell).

### Honesty
A model is **production-ready only** if its dataset is production-ready and training, verification, the weighted
evaluation gate, the safety gate and the regression check all pass. The current curriculum is a seed set and is
deliberately **not** production-ready — the run will say so and write a `smoke`/`validated` (not production) release.
Nothing is faked: no GPU → it stops with `GPU_REQUIRED`.
"""),
    code('''
#@title 1 · Which models to train { display-mode: "form" }
MODELS = "nick-4.8"  #@param {type:"string"}
#@markdown Space-separated subset of: nick-4.8 hike-6.5 sona-9.0 fab-500x
TIME_BUDGET_MINUTES = 0  #@param {type:"integer"}
#@markdown 0 = run to completion. Otherwise the run saves a checkpoint and pauses after this long; re-run to resume.
print("models:", MODELS, "| time budget:", TIME_BUDGET_MINUTES or "none")
'''),
    code('''
#@title 2 · Mount Drive + clone the repo
import os, subprocess, sys
from google.colab import drive
drive.mount("/content/drive")
DRIVE_ROOT = "/content/drive/MyDrive/ApproxAI"
MODELS_DIR = os.path.join(DRIVE_ROOT, "registry")      # release artifacts (survive runtime resets)
WORK_DIR   = os.path.join(DRIVE_ROOT, "work")
os.makedirs(MODELS_DIR, exist_ok=True); os.makedirs(WORK_DIR, exist_ok=True)
REPO_DIR = "/content/Approx-Ai"
if not os.path.isdir(REPO_DIR):
    subprocess.run(["git", "clone", "--depth", "1", "--branch", "%s" % "''' + BRANCH + '''",
                    "https://github.com/''' + REPO + '''.git", REPO_DIR], check=True)
else:
    subprocess.run(["git", "-C", REPO_DIR, "fetch", "--depth", "1", "origin", "''' + BRANCH + '''"], check=True)
    subprocess.run(["git", "-C", REPO_DIR, "checkout", "''' + BRANCH + '''"], check=True)
    subprocess.run(["git", "-C", REPO_DIR, "reset", "--hard", "origin/''' + BRANCH + '''"], check=True)
print("repo at", subprocess.run(["git","-C",REPO_DIR,"rev-parse","HEAD"], capture_output=True, text=True).stdout.strip())
'''),
    code('''
#@title 3 · GPU preflight (stops here if no GPU)
import torch
if not torch.cuda.is_available():
    raise RuntimeError("GPU_REQUIRED: no CUDA GPU. Runtime → Change runtime type → T4 GPU, then Run all again. "
                       "Nothing is installed or trained without a GPU.")
p = torch.cuda.get_device_properties(0)
print(f"GPU: {p.name} · {p.total_memory/1e9:.1f} GB · compute capability {torch.cuda.get_device_capability(0)}")
print("torch", torch.__version__, "| cuda", torch.version.cuda, "| bf16", torch.cuda.is_bf16_supported())
'''),
    code('''
#@title 4 · Install pinned dependencies (only what's missing)
import subprocess, sys, os
TRAINING = os.path.join(REPO_DIR, "training")
# colab_pipeline.py's deps stage installs only missing/mismatched pins and runs a real 4-bit NF4 kernel check.
rc = subprocess.run([sys.executable, "-u", "colab/colab_pipeline.py", "deps"], cwd=TRAINING).returncode
if rc != 0:
    raise RuntimeError("dependency install / NF4 kernel check failed — see the message above.")
'''),
    code('''
#@title 5 · Hardware feasibility for the selected models
import subprocess, sys, os, yaml
sys.path.insert(0, TRAINING)
from engine import hardware
vram, cc, name = hardware.detect_gpu()
print(f"detected: {name} {vram} GB (cc {cc})\\n")
for m in MODELS.split():
    cfg = yaml.safe_load(open(os.path.join(TRAINING, "models", f"{m}.yaml")))
    plan = hardware.plan(cfg, vram, cc)
    print(f"{m:10} feasible={plan['feasible']!s:5} · {plan['reason']}")
    if not plan['feasible']:
        print(f"    recommended: {plan['recommended_hardware']}")
'''),
    code('''
#@title 6 · Run the training platform (dataset → train → evaluate → release)
import subprocess, sys, os
cmd = [sys.executable, "-u", "run_all_training.py", "--models", *MODELS.split(),
       "--models-dir", MODELS_DIR, "--work-dir", WORK_DIR, "--resume"]
if TIME_BUDGET_MINUTES:
    cmd += ["--time-budget-minutes", str(TIME_BUDGET_MINUTES)]
# Optional: push finished artifacts straight into your backend registry (fill in and uncomment).
# cmd += ["--worker", "--control-plane-url", "https://your-backend.example", "--api-key", "apx_...training-worker-key..."]
rc = subprocess.run(cmd, cwd=TRAINING).returncode
print("\\nexit code:", rc, "(0 = all selected models finished; 1 = at least one was blocked — read its blockers above)")
'''),
    code('''
#@title 7 · Summary + where the artifacts are
import json, os, glob
rep = os.path.join(MODELS_DIR, "training_report.json")
if os.path.exists(rep):
    data = json.load(open(rep))
    print(json.dumps(data["flags"], indent=2))
    for m in data["models"]:
        rel = m.get("release", {})
        print(f"\\n{m['model_id']}: {m['status']}" + (f" · v{rel.get('version')} status={rel.get('status')} "
              f"production_ready={rel.get('production_ready')}" if rel else "") )
        for b in m.get("blockers", []):
            print(f"    blocker: {b}")
print("\\nRelease artifacts (import these into the backend registry):")
for tgz in sorted(glob.glob(os.path.join(MODELS_DIR, "*.tar.gz"))):
    print("  ", tgz)
print("\\nImport on the server:  python backend/src/cli.js models import <artifact.tar.gz>")
print("or upload via the admin API:  POST /api/admin/registry/import  (X-Artifact-Sha256 header)")
'''),
]

nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "toc_visible": True},
                                   "kernelspec": {"display_name": "Python 3", "name": "python3"},
                                   "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 0}

out = Path(__file__).resolve().parent / "approx_training_colab.ipynb"
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"wrote {out} ({len(cells)} cells)")
