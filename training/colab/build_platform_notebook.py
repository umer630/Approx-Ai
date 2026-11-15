"""Generate training/colab/approx_training_colab.ipynb — the production, one-command training notebook.

    python training/colab/build_platform_notebook.py

Cells: (0) overview, (1) configuration (MODELS, RUN_ID, TIME_BUDGET_MINUTES), (2) the single run cell
(Drive → clone → git-lfs → pinned deps → training/run_all.py), (3) summary. No secrets are ever stored in the notebook.
"""
import json
from pathlib import Path

BRANCH = "ccr-b9e70091-57vl48"
REPO = "https://github.com/umer630/Approx-Ai.git"


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text, title=None):
    return {"cell_type": "code", "metadata": {"cellView": "form"} if title else {}, "execution_count": None, "outputs": [],
            "source": text.strip("\n").splitlines(keepends=True)}


cells = [
    md("""
# Approx AI — production training (one command)

This notebook trains **every Approx model** with one command:

`python training/run_all.py --models all --run-id approx-full-r1 --time-budget-minutes 240`

For each model in order — **Nick 4.8 → Hike 6.5 → Sona 9.0 → FAB 100X → FAB 500X** — it:
restores the approved dataset from the GitHub repository (Git LFS) → verifies every SHA-256 against
`training/datasets/DATASETS.lock.json` → detects the GPU → picks the training profile that fits → trains with
checkpoints → verifies → evaluates (base vs adapter, safety, regression) → packages a release on Google Drive.

| Model | Dataset | Base model | Minimum GPU |
|---|---|---|---|
| Nick 4.8 | 30,000 | microsoft/Phi-4-mini-instruct (MIT) | T4 16 GB |
| Hike 6.5 | 50,000 | Qwen/Qwen2.5-7B-Instruct (Apache-2.0) | T4 16 GB (L4/A100 faster) |
| Sona 9.0 | 70,000 | Qwen/Qwen2.5-14B-Instruct (Apache-2.0) | L4 24 GB (A100 recommended) |
| FAB 100X | 100,000 | Qwen/Qwen2.5-32B-Instruct (Apache-2.0) | A100 40 GB / H100 |
| FAB 500X | 500,000 | Qwen/Qwen2.5-Coder-32B-Instruct (Apache-2.0) | A100 40 GB / H100 (80 GB recommended) |

**How to use**
1. *Runtime → Change runtime type →* pick a GPU (T4 trains Nick + Hike; A100/H100 trains all five) → Save.
2. *Runtime → Run all.* Approve the Google Drive pop-up (checkpoints and releases are saved there).
3. If Colab disconnects or the time budget ends: **run all again with the same `RUN_ID`** — finished models are
   skipped and the first incomplete model resumes from its last checkpoint.

Models that do not fit the detected GPU are **skipped and reported with the exact requirement** — they are never
reported as trained. Releases are only marked production-ready when every evaluation/safety gate passes.
"""),
    code("""
#@title 1 · Configuration { display-mode: "form" }
MODELS = "all"  #@param {type:"string"}
#@markdown `all`, or a space-separated subset of: nick-4.8 hike-6.5 sona-9.0 fab-100x fab-500x
RUN_ID = "approx-full-r1"  #@param {type:"string"}
#@markdown Keep the SAME RUN_ID to resume. A new RUN_ID starts a fresh run (earlier releases are kept).
TIME_BUDGET_MINUTES = 240  #@param {type:"integer"}
#@markdown Training pauses at a checkpoint after this many minutes (0 = no limit). Run all again to continue.
BRANCH = "%s"  #@param {type:"string"}
print(f"models={MODELS} · run={RUN_ID} · budget={TIME_BUDGET_MINUTES} min · branch={BRANCH}")
""" % BRANCH, title=True),
    code("""
#@title 2 · Run the pipeline (one command) { display-mode: "form" }
import os, subprocess, sys, shlex
from google.colab import drive
drive.mount("/content/drive")
ROOT = "/content/drive/MyDrive/ApproxAI"
WORK_DIR, MODELS_DIR = f"{ROOT}/pipeline", f"{ROOT}/models"
os.makedirs(WORK_DIR, exist_ok=True); os.makedirs(MODELS_DIR, exist_ok=True)
REPO_DIR = "/content/Approx-Ai"
sh = lambda c: subprocess.run(c, shell=True, check=True)
# 1. code + Git LFS (dataset shards are LFS objects; only the requested models' shards are downloaded)
sh("apt-get -qq install -y git-lfs >/dev/null 2>&1 || true; git lfs install --skip-repo >/dev/null")
if not os.path.isdir(REPO_DIR):
    sh(f"GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch {shlex.quote(BRANCH)} %s {REPO_DIR}")
else:
    sh(f"cd {REPO_DIR} && GIT_LFS_SKIP_SMUDGE=1 git fetch --depth 1 origin {shlex.quote(BRANCH)} && git reset --hard FETCH_HEAD")
# 2. pinned training dependencies + a real 4-bit kernel check (GPU runtimes only)
import torch
if torch.cuda.is_available():
    sh(f"cd {REPO_DIR}/training && {sys.executable} -u colab/colab_pipeline.py deps")
else:
    print("No GPU: nothing will be trained. The pipeline below still prints what each model needs.")
# 3. THE ONE COMMAND
cmd = [sys.executable, "-u", "training/run_all.py", "--models", *MODELS.split(), "--run-id", RUN_ID,
       "--time-budget-minutes", str(TIME_BUDGET_MINUTES), "--work-dir", WORK_DIR, "--models-dir", MODELS_DIR]
print("$", " ".join(shlex.quote(c) for c in cmd), flush=True)
rc = subprocess.run(cmd, cwd=REPO_DIR).returncode
print({0: "\\nALL REQUESTED MODELS COMPLETED", 3: "\\nPAUSED — run all again with the same RUN_ID to resume",
       1: "\\nSOME MODELS DID NOT COMPLETE — see the table above (skipped models need a bigger GPU)"}.get(rc, f"exit {rc}"))
""" % REPO, title=True),
    code("""
#@title 3 · Summary { display-mode: "form" }
import json, os, glob
rep = os.path.join(MODELS_DIR, "pipeline_report.json")
if os.path.exists(rep):
    r = json.load(open(rep))
    print(f"run {r['run_id']} · GPU {r['gpu'].get('name')}\\n")
    for m, s in r["models"].items():
        rel = s.get("release") or {}
        print(f"{m:10s} {s['status']:17s}" + (f" v{rel.get('version')} status={rel.get('status')} production_ready={rel.get('production_ready')}" if rel else "")
              + (f"\\n{'':10s} {s.get('reason')}" if s.get('reason') and s['status'] != 'completed' else ""))
print("\\nReleases (models/<id>/versions/<version>/ + .tar.gz for the registry import):")
for p in sorted(glob.glob(os.path.join(MODELS_DIR, "*", "versions", "*", "manifest.json"))):
    m = json.load(open(p)); print(f"  {m['model_id']} {m['version']} · {m['status']} · production_ready={m['production_ready']} · {os.path.dirname(p)}")
""", title=True),
]

nb = {"nbformat": 4, "nbformat_minor": 5, "cells": cells,
      "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "A100"}, "kernelspec": {"name": "python3", "display_name": "Python 3"},
                   "language_info": {"name": "python"}}}
out = Path(__file__).resolve().parent / "approx_training_colab.ipynb"
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
print(f"wrote {out}")
