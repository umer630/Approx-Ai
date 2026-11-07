"""Generates nick_4_8_qlora.ipynb (keeps the notebook reviewable as code). Run: python kaggle/build_notebook.py"""
import json
from pathlib import Path

REPO, BRANCH = "umer630/Approx-Ai", "ccr-b9e70091-57vl48"


def md(s):
    return {"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")}


def code(s):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n")}


cells = [
    md(f"""
# Nick 4.8 — QLoRA training on Kaggle GPU (Approx AI)

**Base model:** `Qwen/Qwen2.5-3B-Instruct` (never substituted — the run STOPS if it is unavailable)
**Method:** QLoRA — 4-bit NF4 + double quantization, LoRA r=16 / α=32 on all attention + MLP projections
**Output:** `nick-4.8-adapter-1.0.0.tar.gz`, `verification.json`, `SHA256SUMS` in `/kaggle/working/nick-4.8-output/`

### One-time setup (no code edits needed)
1. Settings → **Accelerator → GPU T4** (T4 x1 or x2; only GPU 0 is used).
2. Settings → **Internet → On** (needs a phone-verified Kaggle account). Required to clone `{REPO}` and download the base model.
3. Repository is public — no token needed. *If you make it private:* Add-ons → Secrets → add `GITHUB_TOKEN` (read-only fine-grained token).
4. Recommended: **Save Version → Save & Run All (Commit)**. It runs in the background (up to 12 h) and keeps everything in `/kaggle/working` as the version's output.

### Resume after a disconnect / timeout
Checkpoints are written to `/kaggle/working/nick-4.8-output/checkpoint-*` twice per epoch.
- Same session: just run all cells again — training resumes automatically.
- New session: **Add Input → Notebooks → this notebook → the interrupted version**, then Run All. The newest checkpoint under `/kaggle/input` is copied and resumed (refused if the dataset changed).

### Completion rule
Nick 4.8 counts as trained **only** when the last cell prints `✅ COMPLETE`. That requires: GPU training completed,
`adapter_model.safetensors` exists, adapter loaded, real inference verified, `verification_passed: true`, SHA-256 verified.

> ⚠️ The current dataset is the 45-record Approx seed set — a pipeline/identity run, **not production-quality training data**.
> Add license-checked datasets via `training/configs/dataset_sources.json` (approved sources only) for a real capability run.
"""),
    md("## 1 · Clone the repository (branch `" + BRANCH + "`)"),
    code(f"""
import os, subprocess, sys

REPO, BRANCH = "{REPO}", "{BRANCH}"
WORK = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.getcwd()
CLONE = os.path.join(WORK, "Approx-Ai")
TRAINING = os.path.join(CLONE, "training")

def sh(cmd, cwd=None, env=None, check=True):
    \"\"\"Run a command, stream its output into the notebook, stop the notebook on failure.\"\"\"
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in p.stdout:
        print(line, end="")
    p.wait()
    if check and p.returncode != 0:
        raise RuntimeError(f"command failed (exit {{p.returncode}}): {{' '.join(cmd)}}")
    return p.returncode

token = None
try:
    from kaggle_secrets import UserSecretsClient
    token = UserSecretsClient().get_secret("GITHUB_TOKEN")
except Exception:
    pass  # public repository: no token required
url = f"https://x-access-token:{{token}}@github.com/{{REPO}}.git" if token else f"https://github.com/{{REPO}}.git"
genv = {{**os.environ, "GIT_TERMINAL_PROMPT": "0"}}
if not os.path.isdir(os.path.join(CLONE, ".git")):
    sh(["git", "clone", "--depth", "1", "--branch", BRANCH, url, CLONE], env=genv)
else:
    sh(["git", "-C", CLONE, "remote", "set-url", "origin", url], env=genv)
    sh(["git", "-C", CLONE, "fetch", "--depth", "1", "origin", BRANCH], env=genv)
    sh(["git", "-C", CLONE, "checkout", "-B", BRANCH, "FETCH_HEAD"], env=genv)
sh(["git", "-C", CLONE, "remote", "set-url", "origin", f"https://github.com/{{REPO}}.git"])  # never keep a token on disk
COMMIT = subprocess.run(["git", "-C", CLONE, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

os.environ["APPROX_GIT_COMMIT"] = COMMIT
os.environ["APPROX_OUTPUT_DIR"] = os.path.join(WORK, "nick-4.8-output")
os.environ["CUDA_VISIBLE_DEVICES"] = "0"          # single GPU even on 2xT4 (deterministic placement)
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["PYTHONUNBUFFERED"] = "1"
for f in ["kaggle/kaggle_pipeline.py", "train_qlora.py", "verify_adapter.py", "package_adapter.py", "approx_data/build.py"]:
    assert os.path.exists(os.path.join(TRAINING, f)), f"missing {{f}} — wrong branch?"
print("commit:", COMMIT, "| output:", os.environ["APPROX_OUTPUT_DIR"])
"""),
    md("## 2 · Install pinned libraries (PyTorch/CUDA come from the Kaggle image)"),
    code("""
sh([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(TRAINING, "requirements-kaggle.txt")])
def stage(name):
    sh([sys.executable, "kaggle/kaggle_pipeline.py", name], cwd=TRAINING, env=dict(os.environ))
"""),
    md("## 3 · Preflight — GPU, CUDA, versions, real 4-bit NF4 kernel test, disk, base-model availability\nStops here (no download) if anything is missing."),
    code('stage("preflight")'),
    md("## 4 · Dataset — build, validate, provenance manifest\nReproducible: same sources + parameters ⇒ identical files and fingerprint (required for safe resume)."),
    code('stage("data")\nimport json\nm = json.load(open(os.path.join(TRAINING, "data/processed/manifest.json")))\nprint({k: m[k] for k in ["dataset_version", "files", "production_ready", "production_readiness_notes", "content_fingerprint_sha256"]})'),
    md("## 5 · Train (QLoRA) — checkpoints + automatic resume\nWith the seed set this takes minutes on a T4 (≈6 optimizer steps); with a full dataset, hours."),
    code('stage("train")'),
    md("## 6 · Verify — real generation on the GPU, results recorded in `verification.json`\nAdapter load · LoRA weights changed · identity · English · Urdu · Roman Urdu · maths · reasoning · coding (executed) · safety (refuse harmful, don't over-refuse) · malformed input · base-vs-adapter perplexity. Failures are reported, not hidden."),
    code('stage("verify")'),
    md("## 7 · Package — `nick-4.8-adapter-1.0.0.tar.gz` + `verification.json` + `SHA256SUMS`"),
    code('stage("package")\nsh(["ls", "-la", os.environ["APPROX_OUTPUT_DIR"]])\nprint(open(os.path.join(os.environ["APPROX_OUTPUT_DIR"], "SHA256SUMS")).read())'),
    md("## 8 · Strict completion check"),
    code('sh([sys.executable, "kaggle/kaggle_pipeline.py", "status"], cwd=TRAINING, env=dict(os.environ), check=False)'),
    md("""
## 9 · Hand-off
Download from the notebook's **Output** tab (or `/kaggle/working/nick-4.8-output/`):
`nick-4.8-adapter-1.0.0.tar.gz`, `verification.json`, `SHA256SUMS`, `train_metadata.json`, `completion_status.json`.
Give these to the Approx AI maintainer/Claude session to register the adapter (`POST /api/admin/training/adapters`) and update release metadata.

Serving (GPU host): `vllm serve Qwen/Qwen2.5-3B-Instruct --enable-lora --lora-modules nick-4.8=<extracted>/adapter`
then set `APPROX_MODEL_NICK_URL=http://<host>:8000/v1` and `APPROX_MODEL_NICK_NAME=nick-4.8` on the backend.
"""),
]

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                                   "language_info": {"name": "python"}, "kaggle": {"accelerator": "gpu", "isInternetEnabled": True}},
      "nbformat": 4, "nbformat_minor": 5}
for i, c in enumerate(nb["cells"]):
    c["id"] = f"cell-{i:02d}"
out = Path(__file__).with_name("nick_4_8_qlora.ipynb")
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {out}")
