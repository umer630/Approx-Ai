"""Generates training/colab/nick_4_8_qlora_colab.ipynb. Run: python colab/build_notebook.py"""
import json
from pathlib import Path

REPO, BRANCH = "umer630/Approx-Ai", "ccr-b9e70091-57vl48"


def md(s):
    return {"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")}


def code(s):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n")}


HELPER = r'''
import os, subprocess, sys
REPO_DIR = "/content/Approx-Ai"
TRAINING = os.path.join(REPO_DIR, "training")
GPU_STAGES = {"deps", "model", "config", "gate", "train", "evaluate", "verify"}
def stage(*names):
    """Run colab_pipeline.py stages; stream output; stop the notebook on the first failure."""
    for name in names:
        if name in GPU_STAGES and globals().get("GPU_STATUS") != "GPU_READY":
            raise RuntimeError(f"'{name}' needs a GPU, but cell 2 reported GPU_STATUS={globals().get('GPU_STATUS', 'not run in this kernel')}. "
                               "Fix the runtime (T4 GPU) and re-run from cell 1. Nothing was installed.")
        p = subprocess.Popen([sys.executable, "-u", "colab/colab_pipeline.py", name], cwd=TRAINING, env=dict(os.environ),
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        try:
            for line in p.stdout:
                print(line, end="")
        except KeyboardInterrupt:
            p.terminate()   # stops only this stage's follower process
            if name == "train":
                print("\nCell interrupted: the training itself keeps running in the background (detached supervisor). "
                      "Re-run this cell to re-attach to its log.")
            raise
        if p.wait() != 0:
            raise RuntimeError(f"stage '{name}' failed — see the message above (and logs/ on Drive). Nothing after it will run.")
'''

cells = [
    md(f"""
# Nick 4.8 — QLoRA training on Google Colab (Approx AI)

**Base model (locked):** `Qwen/Qwen2.5-3B-Instruct` · **Method:** QLoRA — 4-bit NF4 + double quant, LoRA r=16/α=32 on all
attention + MLP projections, gradient checkpointing, gradient accumulation, fp16 (T4) / bf16 (Ampere+), checkpoints + resume.
**Code:** `{REPO}` branch `{BRANCH}` · **Artifacts:** Google Drive `MyDrive/ApproxAI/Nick_4_8/`

### Before you run
1. **Runtime → Change runtime type → Hardware accelerator: T4 GPU → Save.** (A GPU is not guaranteed by Colab; the notebook stops if none is attached.)
2. **Runtime → Run all.** Approve the Google Drive mount pop-up in cell 1.
3. Hugging Face token is **not** needed for this public model. Only if cell 6 reports 401/403: add `HF_TOKEN` under the 🔑 *Secrets* sidebar (never paste it into a cell).

### If the runtime disconnects
Checkpoints are on Drive (`checkpoints/`). Reconnect, **Run all** again — training resumes from the newest checkpoint
(refused if the dataset changed).

### Completion rule
Nick 4.8 counts as trained only if cell 14 prints `NICK 4.8 TRAINING STATUS: COMPLETE`.
Training starts only if cell 9 prints `TRAINING_READY: YES`.

> ⚠️ Dataset: the current approved data is the 45-record Approx seed set — *not production-quality*. A run on it validates
> the pipeline and teaches identity/format; it does not add broad capability.
"""),
    md("## CELL 1 — Environment / preflight (mount Google Drive, record runtime)"),
    code(r'''
import json, os, platform, shutil, subprocess, sys
try:
    from google.colab import drive
    drive.mount("/content/drive")
except ImportError:
    raise RuntimeError("This notebook must run in Google Colab (google.colab not found).")
DRIVE_ROOT = "/content/drive/MyDrive/ApproxAI/Nick_4_8"
for d in ("checkpoints", "adapter", "logs", "evaluation", "metadata"):
    os.makedirs(os.path.join(DRIVE_ROOT, d), exist_ok=True)
os.environ["APPROX_DRIVE_ROOT"] = DRIVE_ROOT
import torch
print("Python :", platform.python_version())
print("PyTorch:", torch.__version__, "| CUDA build:", torch.version.cuda, "| CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    pr = torch.cuda.get_device_properties(0)
    print(f"GPU    : {pr.name} | VRAM {pr.total_memory / 1e9:.1f} GB")
print(subprocess.run(["nvidia-smi"], capture_output=True, text=True).stdout if shutil.which("nvidia-smi") else "nvidia-smi: not found")
print("Artifacts →", DRIVE_ROOT)
'''),
    md("""## CELL 2 — Hardware preflight (stops here unless GPU_READY)
Classifies the runtime as `NO_GPU_ATTACHED`, `CUDA_UNAVAILABLE`, `GPU_ATTACHED_BUT_INCOMPATIBLE` or `GPU_READY`.
Nothing is installed or downloaded here. Cells 5, 6, 8, 9, 10, 11 and 12 refuse to run unless this cell said `GPU_READY`
in the current kernel (and the pipeline re-checks the hardware itself before each of them)."""),
    code(r'''
import glob, shutil, subprocess, torch
GPU_STATUS, reasons = None, []
smi = shutil.which("nvidia-smi")
smi_out = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True,
                         timeout=30).stdout.strip() if smi else ""
device_present = bool(glob.glob("/dev/nvidia[0-9]*")) or bool(smi_out)
cuda = torch.cuda.is_available()
name, vram, cap = None, 0.0, None
if not device_present and not cuda:
    GPU_STATUS = "NO_GPU_ATTACHED"; reasons.append("no NVIDIA device/driver in this runtime (CPU-only VM)")
elif not cuda:
    GPU_STATUS = "CUDA_UNAVAILABLE"
    reasons.append(f"PyTorch is a CPU-only build ({torch.__version__})" if torch.version.cuda is None
                   else f"PyTorch CUDA {torch.version.cuda} cannot use the attached driver")
else:
    pr = torch.cuda.get_device_properties(0)
    name, vram, cap = pr.name, round(pr.total_memory / 1e9, 2), torch.cuda.get_device_capability(0)
    try:
        a = torch.randn(1024, 1024, device="cuda"); ok = bool(torch.isfinite(a @ a).all())
    except Exception as e:
        ok = False; reasons.append(f"CUDA matmul failed: {e}")
    if not ok and not reasons: reasons.append("CUDA matmul produced non-finite values")
    if cap < (7, 0): reasons.append(f"compute capability {cap} < 7.0 (bitsandbytes 4-bit)")
    if vram < 10: reasons.append(f"{vram} GB VRAM < 10 GB")
    GPU_STATUS = "GPU_READY" if not reasons else "GPU_ATTACHED_BUT_INCOMPATIBLE"
print(f"torch version          : {torch.__version__}")
print(f"torch.version.cuda     : {torch.version.cuda}")
print(f"torch.cuda.is_available: {cuda}")
print(f"nvidia-smi             : {smi_out or ('not found' if not smi else 'no GPU listed')}")
print(f"GPU name               : {name or '—'}")
print(f"VRAM                   : {str(vram) + ' GB' if vram else '—'}")
print(f"CUDA capability        : {cap or '—'}")
print(f"GPU_STATUS             : {GPU_STATUS}")
print(f"GPU_READY              : {'YES' if GPU_STATUS == 'GPU_READY' else 'NO'}")
if GPU_STATUS != "GPU_READY":
    raise RuntimeError(f"{GPU_STATUS}: {'; '.join(reasons)}. Runtime → Change runtime type → T4 GPU → Save, then Runtime → "
                       "Run all. If Colab connects without a GPU, the GPU quota is exhausted. Training will NOT run on CPU — "
                       "do not run the later cells in this runtime.")
print("T4 ✓" if "T4" in name else f"(not a T4 — a VRAM-based profile will be used for {name})")
'''),
    md("## CELL 3 — Internet verification (DNS, GitHub, Hugging Face)"),
    code(rf'''
import socket, urllib.request
for host in ("github.com", "huggingface.co"):
    socket.getaddrinfo(host, 443)
for url in ("https://github.com/{REPO}", "https://huggingface.co/api/models/Qwen/Qwen2.5-3B-Instruct"):
    status = urllib.request.urlopen(url, timeout=20).status
    assert status == 200, f"{{url}} returned HTTP {{status}}"
    print("OK", status, url)
'''),
    md(f"## CELL 4 — GitHub checkout (`{REPO}` @ `{BRANCH}`) + verification"),
    code(HELPER + rf'''
BRANCH = "{BRANCH}"
EXPECTED_COMMIT = ""   # optional: pin an exact commit SHA for reproducibility (leave empty = branch head)
if not os.path.isdir(os.path.join(REPO_DIR, ".git")):
    subprocess.run(["git", "clone", "--branch", BRANCH, "https://github.com/{REPO}.git", REPO_DIR], check=True,
                   env={{**os.environ, "GIT_TERMINAL_PROMPT": "0"}})
else:
    subprocess.run(["git", "-C", REPO_DIR, "fetch", "origin", BRANCH], check=True)
    subprocess.run(["git", "-C", REPO_DIR, "checkout", "-B", BRANCH, f"origin/{{BRANCH}}"], check=True)
if EXPECTED_COMMIT:
    subprocess.run(["git", "-C", REPO_DIR, "checkout", EXPECTED_COMMIT], check=True)
    subprocess.run(["git", "-C", REPO_DIR, "checkout", "-B", BRANCH], check=True)
os.environ["APPROX_EXPECTED_BRANCH"] = BRANCH
os.environ["APPROX_EXPECTED_COMMIT"] = EXPECTED_COMMIT
stage("repo", "env")
'''),
    md("## CELL 5 — Install exact dependencies (only what is missing or mismatched; PyTorch is not touched)"),
    code('stage("deps")'),
    md("## CELL 6 — Hugging Face / base-model verification (config, tokenizer, chat template, revision SHA)"),
    code(r'''
try:
    stage("model")
except RuntimeError:
    # Only if anonymous access failed: use HF_TOKEN from Colab Secrets (never printed, never written to disk).
    try:
        from google.colab import userdata
        tok = userdata.get("HF_TOKEN")
    except Exception:
        tok = None
    if not tok:
        raise
    os.environ["HF_TOKEN"] = tok
    del tok
    stage("model")
'''),
    md("## CELL 7 — Dataset preparation / validation (provenance, licenses, malformed, duplicates, PII, quality, split, hash)"),
    code('stage("data")'),
    md("## CELL 8 — Training configuration (derived from the detected GPU's VRAM)"),
    code('stage("gpu", "config")'),
    md("## CELL 9 — Final preflight gate (re-checks GPU + Internet; training starts only if everything is READY)"),
    code('stage("gpu", "internet", "repo", "gate")'),
    md("""## CELL 10 — Actual training (QLoRA on GPU; checkpoints on Drive; re-run to resume)
Training runs in a **detached background supervisor** (log on local disk, mirrored to Drive every minute; model cache on local
`/content/hf_cache`). Interrupting this cell or a browser disconnect does **not** stop training — re-run the cell to re-attach.
A heartbeat line appears every 30 s while the ~6 GB base-model download / 4-bit load is silent.
On failure this cell prints an automatic read-only diagnosis (first real error, last phase reached, checkpoints, resume/fresh).
To inspect an earlier failed run **without training**, run cells 1 and 4, then in a new cell: `stage("diagnose")`."""),
    code('stage("train")'),
    md("## CELL 11 — Evaluation (real generation probes: identity, English, Urdu, Roman Urdu, maths, reasoning, coding, safety, malformed input, perplexity)"),
    code('stage("evaluate")'),
    md("## CELL 12 — Adapter verification (independent reload into the base model + real inference)"),
    code('stage("verify")'),
    md("## CELL 13 — SHA-256 / artifact manifest (`nick-4.8-adapter-1.0.0.tar.gz`, `SHA256SUMS`, `artifact_manifest.json`)"),
    code('stage("manifest")'),
    md("## CELL 14 — Final machine-readable training report (`metadata/completion_report.json`)"),
    code('stage("report")\nprint(open(os.path.join(os.environ["APPROX_DRIVE_ROOT"], "metadata", "completion_report.json")).read())'),
]

nb = {"cells": cells,
      "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
                   "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}},
      "nbformat": 4, "nbformat_minor": 5}
for i, c in enumerate(nb["cells"]):
    c["id"] = f"cell-{i:02d}"
out = Path(__file__).with_name("nick_4_8_qlora_colab.ipynb")
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {out}")
