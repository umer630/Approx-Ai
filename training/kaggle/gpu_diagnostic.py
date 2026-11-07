"""2-minute Kaggle readiness diagnostic (no training). Pushes a tiny private notebook with GPU T4 + Internet,
waits for it, downloads its single JSON result, evaluates it, then deletes the notebook.

The notebook records ONLY a fixed allow-list of facts (device names, booleans, HTTP status codes, a hash).
It never reads or prints environment variables, tokens or secrets.

    KAGGLE_API_TOKEN=<token or proxy placeholder> python gpu_diagnostic.py --user developerumwr
Exit 0 only if every check passes (GPU READY / INTERNET READY / TRAINING READY).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

NOTEBOOK_SOURCE = r'''
import json, shutil, subprocess, socket, urllib.request, hashlib
r = {}
def check(name, fn):
    try:
        r[name] = fn()
    except Exception as e:
        r[name] = {"error": type(e).__name__ + ": " + str(e)[:160]}

check("nvidia_smi", lambda: subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                                           capture_output=True, text=True, timeout=30).stdout.strip() if shutil.which("nvidia-smi") else None)
def torch_info():
    import torch
    return {"version": torch.__version__, "cuda_build": torch.version.cuda, "cuda_available": torch.cuda.is_available(),
            "device_count": torch.cuda.device_count(),
            "devices": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],
            "matmul_ok": bool(torch.cuda.is_available() and torch.isfinite((torch.randn(256, 256, device="cuda") @ torch.randn(256, 256, device="cuda")).sum()).item())}
check("torch", torch_info)
check("dns_huggingface", lambda: bool(socket.getaddrinfo("huggingface.co", 443)))
check("dns_github", lambda: bool(socket.getaddrinfo("github.com", 443)))
check("http_github_repo", lambda: urllib.request.urlopen("https://github.com/umer630/Approx-Ai", timeout=20).status)
check("http_hf_model_api", lambda: urllib.request.urlopen("https://huggingface.co/api/models/Qwen/Qwen2.5-3B-Instruct", timeout=20).status)
def hf_download():
    url = "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/resolve/main/config.json"
    body = urllib.request.urlopen(url, timeout=30).read()
    cfg = json.loads(body)
    return {"bytes": len(body), "model_type": cfg.get("model_type"), "architectures": cfg.get("architectures")}
check("hf_config_download", hf_download)
payload = b"approx-gpu-diagnostic"
open("/kaggle/working/diag_payload.bin", "wb").write(payload)
r["payload_sha256"] = hashlib.sha256(payload).hexdigest()
open("/kaggle/working/diagnostic.json", "w").write(json.dumps(r, indent=1))
print(json.dumps(r, indent=1))
'''


def build_notebook(path: Path) -> None:
    nb = {"cells": [{"id": "diag", "cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": NOTEBOOK_SOURCE.strip()}],
          "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}},
          "nbformat": 4, "nbformat_minor": 5}
    path.write_text(json.dumps(nb))


def evaluate(d: dict, payload_ok: bool) -> dict:
    t = d.get("torch") if isinstance(d.get("torch"), dict) else {}
    devices = t.get("devices") or []
    hf = d.get("hf_config_download") if isinstance(d.get("hf_config_download"), dict) else {}
    checks = {
        "gpu_attached": bool(d.get("nvidia_smi")) and "error" not in str(d.get("nvidia_smi")),
        "cuda_available": t.get("cuda_available") is True,
        "pytorch_detects_gpu": (t.get("device_count") or 0) >= 1 and t.get("matmul_ok") is True,
        "t4_visible": any("T4" in x for x in devices) or "T4" in str(d.get("nvidia_smi")),
        "internet_dns": d.get("dns_huggingface") is True and d.get("dns_github") is True,
        "github_repo_reachable": d.get("http_github_repo") == 200,
        "huggingface_model_reachable": d.get("http_hf_model_api") == 200 and hf.get("model_type") == "qwen2",
        "kaggle_output_download": payload_ok,
    }
    gpu = all(checks[k] for k in ("gpu_attached", "cuda_available", "pytorch_detects_gpu", "t4_visible"))
    net = all(checks[k] for k in ("internet_dns", "github_repo_reachable", "huggingface_model_reachable"))
    return {"checks": checks, "GPU_READY": gpu, "INTERNET_READY": net, "TRAINING_READY": gpu and net and payload_ok}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--slug", default="approx-gpu-diagnostic")
    ap.add_argument("--keep", action="store_true", help="do not delete the diagnostic notebook afterwards")
    a = ap.parse_args()
    runner = [sys.executable, str(HERE / "kaggle_runner.py")]
    slug = f"{a.user}/{a.slug}"
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        build_notebook(td / "diag.ipynb")
        subprocess.run(runner + ["push", "--notebook", str(td / "diag.ipynb"), "--slug", slug, "--title", a.slug, "--gpu", "--internet",
                                 "--timeout", "900"], check=True)
        w = subprocess.run(runner + ["wait", "--slug", slug, "--poll", "20", "--max-hours", "0.4"])
        out = td / "out"
        dl = subprocess.run(runner + ["output", "--slug", slug, "--dest", str(out), "--pattern", r"^(diagnostic\.json|diag_payload\.bin)$"],
                            capture_output=True, text=True)
        diag = json.loads((out / "diagnostic.json").read_text()) if (out / "diagnostic.json").exists() else {}
        payload_ok = (out / "diag_payload.bin").exists() and \
            hashlib.sha256((out / "diag_payload.bin").read_bytes()).hexdigest() == diag.get("payload_sha256")
        result = {"kaggle_run_exit": w.returncode, "download_ok": dl.returncode == 0, "diagnostic": diag, **evaluate(diag, payload_ok)}
        if not a.keep:
            subprocess.run([sys.executable, "-c", f"""
from kagglesdk import KaggleClient, KaggleEnv
from kagglesdk.kernels.types.kernels_api_service import ApiDeleteKernelRequest
import os
with KaggleClient(env=KaggleEnv.PROD, api_token=os.environ["KAGGLE_API_TOKEN"]) as k:
    r = ApiDeleteKernelRequest(); r.user_name = {a.user!r}; r.kernel_slug = {a.slug!r}
    k.kernels.kernels_api_client.delete_kernel(r)
"""], check=False)
            result["diagnostic_notebook_deleted"] = True
    print(json.dumps(result, indent=1))
    for k in ("GPU_READY", "INTERNET_READY", "TRAINING_READY"):
        print(f"{k.replace('_', ' ')}: {'YES' if result[k] else 'NO'}")
    sys.exit(0 if result["TRAINING_READY"] else 1)


if __name__ == "__main__":
    main()
