"""Generate training/colab/approx_training_colab.ipynb — the production notebook (no phone uploads needed).

    python training/colab/build_platform_notebook.py

Workflow: Colab → Mount Drive → Restore/Download datasets → SHA-256 verify → Human review (CSV sheets on Drive)
→ Build check (no regeneration) → Readiness → Training. Datasets come from the GitHub repository (Git LFS
.jsonl.gz shards) and are mirrored to Drive, so later sessions restore from Drive. No secrets in the notebook.
"""
import json
from pathlib import Path

BRANCH = "ccr-b9e70091-57vl48"
REPO = "https://github.com/umer630/Approx-Ai.git"


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text):
    return {"cell_type": "code", "metadata": {"cellView": "form"}, "execution_count": None, "outputs": [],
            "source": text.strip("\n").splitlines(keepends=True)}


cells = [
    md("""
# Approx AI — dataset restore, review and training (Run all)

**Colab → Mount Drive → Restore datasets → SHA-256 verify → Human review → Build check → Readiness → Training**

Nothing has to be uploaded from your phone and no `.tar.gz` has to be opened:
* the approved datasets are downloaded **inside Colab** from the GitHub repository (Git LFS `.jsonl.gz` shards) and
  checked against `training/datasets/DATASETS.lock.json`; a verified copy is saved to
  `MyDrive/ApproxAI/datasets/<model>/` so the next session restores from Drive;
* review sheets are written to `MyDrive/ApproxAI/review-sheets/<model>/` as **individual CSV files** (open them in
  Google Sheets); completed sheets you save to `MyDrive/ApproxAI/review-completed/<model>/` are imported automatically.

| Dataset | Records | Minimum GPU |
|---|---|---|
| nick-4.8 | 30,000 | T4 |
| hike-6.5 | 50,000 | T4 |
| sona-9.0 | 70,000 | L4 / A100 |
| fab-100x | 100,000 (`fab-100x-90k`: the original 90,000 version, restore-only) | A100 |
| fab-500x | 500,000 | A100 / H100 |

**Use:** *Runtime → Change runtime type → T4 GPU* (Nick/Hike) or A100 (all) → *Runtime → Run all* → approve Drive.
Rerun with the same `RUN_ID` to resume after a disconnect.
"""),
    code("""
#@title 1 · Configuration
MODELS = "nick-4.8"  #@param {type:"string"}
#@markdown Start with `nick-4.8`. Later: `hike-6.5`, `sona-9.0`, `fab-100x`, `fab-500x` or `all` (space-separated).
RUN_ID = "approx-nick-r1"  #@param {type:"string"}
#@markdown Keep the same RUN_ID to resume; a new RUN_ID starts a fresh run.
TIME_BUDGET_MINUTES = 240  #@param {type:"integer"}
TRAIN = True  #@param {type:"boolean"}
#@markdown Untick to only restore, verify, export review sheets and check readiness.
BRANCH = "%s"  #@param {type:"string"}
SEL = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"] if MODELS.strip() == "all" else MODELS.split()
print("models:", SEL, "| run:", RUN_ID, "| train:", TRAIN)
""" % BRANCH),
    code("""
#@title 2 · Mount Google Drive + get the code
import os, subprocess, sys, shlex, glob, shutil, json
from google.colab import drive
drive.mount("/content/drive")
ROOT = "/content/drive/MyDrive/ApproxAI"
for d in ("datasets", "review-sheets", "review-completed", "pipeline", "models"):
    os.makedirs(f"{ROOT}/{d}", exist_ok=True)
REPO_DIR = "/content/Approx-Ai"
sh = lambda c: subprocess.run(c, shell=True, check=True)
sh("apt-get -qq install -y git-lfs >/dev/null 2>&1 || true; git lfs install --skip-repo >/dev/null")
if not os.path.isdir(REPO_DIR):   # pointers only; dataset shards are fetched in step 3 (only for the selected models)
    sh(f"GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch {shlex.quote(BRANCH)} %s {REPO_DIR}")
else:
    sh(f"cd {REPO_DIR} && GIT_LFS_SKIP_SMUDGE=1 git fetch --depth 1 origin {shlex.quote(BRANCH)} && git reset --hard FETCH_HEAD")
TRAINING = f"{REPO_DIR}/training"
print(subprocess.run(["git", "-C", REPO_DIR, "log", "--oneline", "-1"], capture_output=True, text=True).stdout)
""" % REPO),
    code("""
#@title 3 · Restore datasets + SHA-256 verify (Drive first, then GitHub LFS) — nothing is regenerated
rc = subprocess.run([sys.executable, "-m", "datahub.dist", "restore", "--models", *SEL, "--drive-dir", f"{ROOT}/datasets"], cwd=TRAINING).returncode
if rc != 0:
    raise RuntimeError("Dataset restore/verification failed — see the message above. Nothing was rebuilt.")
subprocess.run([sys.executable, "-m", "datahub.dist", "verify", "--models", *SEL], cwd=TRAINING, check=True)
for m in SEL:
    print(f"{m}: verified copy on Drive → {ROOT}/datasets/{m}/ :", sorted(os.listdir(f"{ROOT}/datasets/{m}")))
"""),
    code("""
#@title 4 · Human review — individual CSV sheets on Drive (open in Google Sheets on your phone)
# Sheets: MyDrive/ApproxAI/review-sheets/<model>/*.csv. Fill reviewer, verdict (accept/reject), issue_tags, notes;
# never edit prompt/answer. Save completed CSVs to MyDrive/ApproxAI/review-completed/<model>/ and run this cell again.
for m in SEL:
    src = f"{TRAINING}/datasets/reviews/sheets/{m}"
    dst = f"{ROOT}/review-sheets/{m}"
    os.makedirs(dst, exist_ok=True)
    sheets = sorted(glob.glob(f"{src}/*.csv"))
    for p in sheets:
        if not os.path.exists(os.path.join(dst, os.path.basename(p))):
            shutil.copy(p, dst)
    done = sorted(glob.glob(f"{ROOT}/review-completed/{m}/*.csv"))
    print(f"{m}: {len(sheets)} review sheet(s) → {dst} · {len(done)} completed sheet(s) found")
    if done:
        subprocess.run([sys.executable, "-m", "datahub", "review-import", "--model", m, "--csv", *done], cwd=TRAINING)
subprocess.run([sys.executable, "-m", "datahub", "review-progress", "--models", *SEL], cwd=TRAINING)
att = json.load(open(f"{TRAINING}/datasets/reviews/attestation.json"))
print("\\nOwner review attestation:", att["recorded_at"], "-", att["statement"])
"""),
    code("""
#@title 5 · Build check (no regeneration: validated datasets are reused when their SHA-256 match)
subprocess.run([sys.executable, "-m", "datahub", "approve", "--models", *SEL], cwd=TRAINING, check=True)
for m in SEL:
    man = json.load(open(f"{TRAINING}/datasets/{m}/build/manifest.json"))
    print(f"{m:9s} {man['counts']} version={man['dataset_version']} production_ready={man['production_ready']} review={man.get('review_basis')}")
"""),
    code("""
#@title 6 · Readiness (datasets + GPU)
import torch
if torch.cuda.is_available():
    sh(f"cd {TRAINING} && {sys.executable} -u colab/colab_pipeline.py deps")   # pinned deps + real 4-bit kernel check
else:
    print("NO GPU in this runtime: Runtime → Change runtime type → T4 GPU, then Run all again.")
rc = subprocess.run([sys.executable, "-u", "training/run_all.py", "--models", *SEL, "--run-id", RUN_ID, "--skip-restore", "--plan-only",
                     "--work-dir", f"{ROOT}/pipeline", "--models-dir", f"{ROOT}/models"], cwd=REPO_DIR).returncode
print("READY" if rc == 0 else "NOT READY — see the table above")
"""),
    code("""
#@title 7 · Training (checkpoints + releases on Drive; rerun with the same RUN_ID to resume)
if TRAIN:
    cmd = [sys.executable, "-u", "training/run_all.py", "--models", *SEL, "--run-id", RUN_ID, "--skip-restore",
           "--time-budget-minutes", str(TIME_BUDGET_MINUTES), "--work-dir", f"{ROOT}/pipeline", "--models-dir", f"{ROOT}/models"]
    print("$", " ".join(shlex.quote(c) for c in cmd), flush=True)
    rc = subprocess.run(cmd, cwd=REPO_DIR).returncode
    print({0: "COMPLETED", 3: "PAUSED — Run all again with the same RUN_ID to resume",
           1: "NOT ALL MODELS COMPLETED — see the table above"}.get(rc, f"exit {rc}"))
    rep = f"{ROOT}/models/pipeline_report.json"
    if os.path.exists(rep):
        print(json.dumps(json.load(open(rep))["models"], indent=1)[:4000])
else:
    print("TRAIN is off — restore, verification, review export and readiness are done.")
"""),
]

nb = {"nbformat": 4, "nbformat_minor": 5, "cells": cells,
      "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"}, "kernelspec": {"name": "python3", "display_name": "Python 3"},
                   "language_info": {"name": "python"}}}
out = Path(__file__).resolve().parent / "approx_training_colab.ipynb"
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
print(f"wrote {out}")
