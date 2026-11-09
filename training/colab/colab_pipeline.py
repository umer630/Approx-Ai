"""Nick 4.8 QLoRA training on Google Colab — self-contained stage runner (no other notebook-platform APIs).

Every stage either succeeds or exits non-zero with a clear message; the notebook stops on failure.
Persistent artifacts live on Google Drive (Colab's local disk is wiped when the runtime ends):

  $APPROX_DRIVE_ROOT  (default /content/drive/MyDrive/ApproxAI/Nick_4_8)
    checkpoints/   Trainer checkpoints (checkpoint-N) — training resumes from here automatically
    adapter/       final LoRA adapter + tokenizer + manifests
    logs/          full stdout/stderr of every stage
    evaluation/    verification.json, inference_check.json
    metadata/      env/gpu/internet/repo/deps/model/dataset/config/preflight JSON, train_metadata.json, reports

Stages (python colab/colab_pipeline.py <stage>):
  env        record Python/PyTorch/CUDA/GPU/VRAM + nvidia-smi (never fails)
  gpu        REQUIRE a CUDA GPU: real matmul, compute capability ≥ 7.0 (bitsandbytes 4-bit), VRAM profile
  internet   REQUIRE DNS + GitHub + Hugging Face API reachability
  repo       verify the checkout: branch, commit SHA, required files
  deps       install ONLY missing/mismatched pinned packages; run a real 4-bit NF4 kernel on the GPU
  model      verify Qwen/Qwen2.5-3B-Instruct config + tokenizer + chat template; record Hub revision SHA
  data       build + validate the dataset (provenance, licenses, malformed/dupes/PII/quality, split, hash)
  config     derive the training config from detected VRAM (conservative T4 defaults)
  gate       final preflight report; exits non-zero unless every *_READY is true
  train      real QLoRA training (refuses to run unless the gate passed); checkpoints on Drive; resume
  evaluate   verify_adapter.py: real generation probes + safety + malformed input + perplexity
  verify     independent reload: files exist, tokenizer + base model + adapter load, non-empty generation
  manifest   nick-4.8-adapter-<v>.tar.gz + SHA256SUMS + artifact_manifest.json (all hashes)
  report     final machine-readable completion_report.json (COMPLETE only with full evidence)

Secrets: a Hugging Face token is used only if anonymous access fails, is read from Colab Secrets by the notebook
and passed via the HF_TOKEN environment variable; it is never printed, logged or written to disk by this code.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
REPO_ROOT = TRAINING.parent
BASE_CFG = json.loads((TRAINING / "configs/nick-4.8-qlora.json").read_text())
BASE_MODEL = "Qwen/Qwen2.5-3B-Instruct"  # locked Nick 4.8 base — never substituted
EXPECTED_BRANCH = os.environ.get("APPROX_EXPECTED_BRANCH", "ccr-b9e70091-57vl48")
DRIVE = Path(os.environ.get("APPROX_DRIVE_ROOT", "/content/drive/MyDrive/ApproxAI/Nick_4_8"))
D = {k: DRIVE / k for k in ("checkpoints", "adapter", "logs", "evaluation", "metadata")}
PY = sys.executable
REQUIRED_FILES = ["training/train_qlora.py", "training/verify_adapter.py", "training/package_adapter.py",
                  "training/approx_data/build.py", "training/approx_data/pii.py", "training/data/seed/make_seed.py",
                  "training/configs/nick-4.8-qlora.json", "training/configs/dataset_sources.json",
                  "training/colab/requirements-colab.txt", "training/colab/colab_pipeline.py"]


# ---------------------------------------------------------------- helpers
def fail(msg: str) -> None:
    print(f"\n❌ STOP: {msg}", flush=True)
    sys.exit(1)


def ensure_dirs() -> None:
    if not DRIVE.parent.parent.exists() and str(DRIVE).startswith("/content/drive"):
        fail("Google Drive is not mounted. Run the Drive mount cell first (artifacts would be lost otherwise).")
    for p in D.values():
        p.mkdir(parents=True, exist_ok=True)


def runtime_id() -> str:
    """Identifies the current VM. Colab gives every new runtime a new boot id; Drive files outlive runtimes."""
    for p in ("/proc/sys/kernel/random/boot_id",):
        try:
            return Path(p).read_text().strip()
        except OSError:
            pass
    return platform.node()


def save(name: str, data: dict) -> dict:
    data = {**data, "_runtime_id": runtime_id(), "_written_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (D["metadata"] / name).write_text(json.dumps(data, indent=2, default=str))
    print(json.dumps(data, indent=2, default=str), flush=True)
    return data


def load(name: str, current_runtime_only: bool = False) -> dict:
    p = D["metadata"] / name
    if not p.exists():
        return {}
    data = json.loads(p.read_text())
    if current_runtime_only and data.get("_runtime_id") != runtime_id():
        return {"_stale": True, "_written_at": data.get("_written_at")}
    return data


def run(cmd: list[str], log: str, env: dict | None = None) -> int:
    """Stream a subprocess to the notebook AND to logs/<log>.log on Drive."""
    print("$", " ".join(cmd), flush=True)
    with open(D["logs"] / f"{log}.log", "a", encoding="utf-8") as fh:
        fh.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} $ {' '.join(cmd)}\n")
        p = subprocess.Popen(cmd, cwd=TRAINING, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                             env={**os.environ, **(env or {}), "PYTHONUNBUFFERED": "1"})
        for line in p.stdout:
            print(line, end="", flush=True)
            fh.write(line)
        rc = p.wait()
        note = f" (killed by signal {-rc}: no Python traceback possible — usually host-RAM OOM or a runtime disconnect)" if rc < 0 else ""
        fh.write(f"=== exit code {rc}{note}\n")
        return rc


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def vram_profile(vram_gb: float) -> dict:
    """Conservative QLoRA settings for Qwen2.5-3B by VRAM. Effective batch (bs × accum) stays 16."""
    if vram_gb >= 30:
        return {"name": "large (A100/L4-class)", "per_device_batch_size": 4, "gradient_accumulation_steps": 4, "max_seq_length": 2048}
    if vram_gb >= 14:
        return {"name": "T4 16GB", "per_device_batch_size": 2, "gradient_accumulation_steps": 8, "max_seq_length": 2048}
    if vram_gb >= 10:
        return {"name": "reduced (10–14 GB)", "per_device_batch_size": 1, "gradient_accumulation_steps": 16, "max_seq_length": 1536}
    return {}


def estimate_qlora_peak_gb(arch: dict, prof: dict, lora_r: int, lora_targets: list[str]) -> dict:
    """Analytic worst-case peak VRAM (GB, 1e9 bytes) for QLoRA training of a decoder-only model with the ACTUAL setup:
    4-bit NF4 + double-quant base weights, non-quantised embeddings upcast to fp32 by prepare_model_for_kbit_training,
    LoRA (fp32 weights + fp32 grads + paged 8-bit AdamW), gradient checkpointing, fp16/bf16 activations, every sequence
    padded to max_seq_length (true worst case — real batches are padded only to the longest example), and the loss path
    of transformers 4.46 (fp16 logits → fp32 upcast → log-softmax → fp32 grad), which dominates for a 152k vocabulary."""
    H, I, L = arch["hidden_size"], arch["intermediate_size"], arch["num_hidden_layers"]
    nh, nkv, V = arch["num_attention_heads"], arch["num_key_value_heads"], arch["vocab_size"]
    kvd = (H // nh) * nkv
    T = prof["per_device_batch_size"] * prof["max_seq_length"]
    shapes = {"q_proj": (H, H), "k_proj": (H, kvd), "v_proj": (H, kvd), "o_proj": (H, H),
              "gate_proj": (H, I), "up_proj": (H, I), "down_proj": (I, H)}
    linear_params = L * sum(a * b for a, b in shapes.values())
    nf4_bytes_per_param = 0.5 * (4.127 / 4)                     # 4-bit + double-quantised absmax ≈ 0.127 bit/param
    emb_params = V * H * (1 if arch.get("tie_word_embeddings", True) else 2)
    lora_params = L * sum(lora_r * (a + b) for k, (a, b) in shapes.items() if k in lora_targets)
    gb = 1e9
    parts = {
        "base_weights_nf4": linear_params * nf4_bytes_per_param / gb,
        "embeddings_fp32": emb_params * 4 / gb,
        "lora_weights_grads_optimizer": lora_params * (4 + 4 + 2) / gb,
        "checkpointed_activations": L * T * H * 2 / gb,
        "recomputed_layer_workspace": (T * (6 * H + 4 * I) * 2 + H * I * 2) / gb,
        "logits_and_loss": T * V * (2 + 4 + 4) / gb,
        "cuda_context_and_allocator": 0.6,
    }
    total = sum(parts.values())
    return {"breakdown_gb": {k: round(v, 3) for k, v in parts.items()}, "peak_gb": round(total, 2),
            "tokens_per_micro_batch": T, "lora_trainable_params": lora_params, "quantised_linear_params": linear_params}


# ---------------------------------------------------------------- stages
def env() -> None:
    info = {"python": platform.python_version(), "platform": platform.platform()}
    try:
        import torch
        info.update(torch=torch.__version__, torch_cuda_build=torch.version.cuda, cuda_available=torch.cuda.is_available())
        if torch.cuda.is_available():
            pr = torch.cuda.get_device_properties(0)
            info.update(gpu_name=pr.name, gpu_vram_gb=round(pr.total_memory / 1e9, 2), gpu_count=torch.cuda.device_count())
    except ImportError:
        info["torch"] = None
    smi = shutil.which("nvidia-smi")
    info["nvidia_smi"] = subprocess.run([smi], capture_output=True, text=True, timeout=60).stdout if smi else "nvidia-smi not found (no GPU driver attached)"
    print(info.pop("nvidia_smi"))
    save("env.json", info)


GPU_STATES = ("NO_GPU_ATTACHED", "CUDA_UNAVAILABLE", "GPU_ATTACHED_BUT_INCOMPATIBLE", "GPU_READY")
COLAB_GPU_HELP = ("Colab: Runtime → Change runtime type → Hardware accelerator: T4 GPU → Save, then Runtime → Run all. "
                  "If Colab connects without a GPU (it says so in a pop-up), your GPU quota is exhausted — wait or use another "
                  "account. Training will NOT run on CPU.")


def gpu_status() -> dict:
    """Classify the hardware. No package installs, no model downloads.
       NO_GPU_ATTACHED               no NVIDIA device/driver is visible in this VM (CPU-only runtime)
       CUDA_UNAVAILABLE              an NVIDIA device is visible but PyTorch cannot use CUDA (CPU-only torch build / driver mismatch)
       GPU_ATTACHED_BUT_INCOMPATIBLE CUDA works but the GPU is unsuitable (capability < 7.0, < 10 GB VRAM, or broken matmul)
       GPU_READY                     usable for 4-bit NF4 QLoRA of Qwen2.5-3B"""
    import glob
    info = {"torch": None, "torch_cuda_build": None, "cuda_available": False, "gpu_name": None, "vram_gb": 0.0,
            "compute_capability": None, "bf16_supported": False, "cuda_matmul_ok": False, "profile": {}, "is_t4": False}
    smi = shutil.which("nvidia-smi")
    smi_out = ""
    if smi:
        try:
            smi_out = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True,
                                     text=True, timeout=30).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            smi_out = ""
    info["nvidia_smi"] = smi_out or ("not found" if not smi else "no GPU listed")
    info["nvidia_device_nodes"] = sorted(glob.glob("/dev/nvidia[0-9]*"))
    device_present = bool(info["nvidia_device_nodes"]) or bool(smi_out)
    try:
        import torch
        info.update(torch=torch.__version__, torch_cuda_build=torch.version.cuda, cuda_available=torch.cuda.is_available())
    except ImportError:
        torch = None
    reasons = []
    if not device_present and not info["cuda_available"]:
        state = "NO_GPU_ATTACHED"
        reasons.append("no NVIDIA device or driver visible in this runtime (CPU-only VM)")
    elif not info["cuda_available"]:
        state = "CUDA_UNAVAILABLE"
        reasons.append("PyTorch is a CPU-only build (" + str(info["torch"]) + ")" if info["torch_cuda_build"] is None
                       else f"PyTorch CUDA {info['torch_cuda_build']} cannot use the attached driver")
    else:
        pr = torch.cuda.get_device_properties(0)
        info["gpu_name"], info["vram_gb"] = pr.name, round(pr.total_memory / 1e9, 2)
        info["compute_capability"] = list(torch.cuda.get_device_capability(0))
        info["bf16_supported"] = torch.cuda.is_bf16_supported()
        info["is_t4"] = "T4" in pr.name
        try:
            a = torch.randn(1024, 1024, device="cuda")
            info["cuda_matmul_ok"] = bool(torch.isfinite(a @ a).all().item())
        except Exception as e:  # broken CUDA context
            reasons.append(f"CUDA matmul failed: {type(e).__name__}: {e}"[:200])
        info["profile"] = vram_profile(info["vram_gb"])
        if not info["cuda_matmul_ok"] and not reasons:
            reasons.append("CUDA matmul produced non-finite values")
        if info["compute_capability"] < [7, 0]:
            reasons.append(f"compute capability {info['compute_capability']} < 7.0 (bitsandbytes 4-bit needs ≥ 7.0)")
        if not info["profile"]:
            reasons.append(f"{info['vram_gb']} GB VRAM < 10 GB minimum for Qwen2.5-3B QLoRA")
        state = "GPU_READY" if not reasons else "GPU_ATTACHED_BUT_INCOMPATIBLE"
    info["GPU_STATUS"] = state
    info["reasons"] = reasons
    info["CUDA_READY"] = bool(info["cuda_available"] and info["cuda_matmul_ok"])
    info["GPU_READY"] = state == "GPU_READY"
    return info


def _print_gpu(info: dict) -> None:
    print(f"torch version          : {info['torch']}")
    print(f"torch.version.cuda     : {info['torch_cuda_build']}")
    print(f"torch.cuda.is_available: {info['cuda_available']}")
    print(f"nvidia-smi             : {info['nvidia_smi']}")
    print(f"GPU name               : {info['gpu_name'] or '—'}")
    print(f"VRAM                   : {str(info['vram_gb']) + ' GB' if info['vram_gb'] else '—'}")
    print(f"CUDA capability        : {info['compute_capability'] or '—'}")
    print(f"GPU_STATUS             : {info['GPU_STATUS']}")
    print(f"GPU_READY              : {'YES' if info['GPU_READY'] else 'NO'}")


def require_gpu_ready(stage_name: str) -> dict:
    """Hard stop for every GPU-dependent stage — runs BEFORE any package install, download or model work."""
    info = gpu_status()
    save("gpu.json", info)
    if not info["GPU_READY"]:
        _print_gpu(info)
        fail(f"'{stage_name}' requires GPU_READY; this runtime is {info['GPU_STATUS']} ({'; '.join(info['reasons'])}). "
             f"Nothing was installed or downloaded. {COLAB_GPU_HELP}")
    return info


def gpu() -> None:
    info = gpu_status()
    save("gpu.json", info)
    _print_gpu(info)
    if not info["GPU_READY"]:
        fail(f"{info['GPU_STATUS']}: {'; '.join(info['reasons'])}. {COLAB_GPU_HELP}")
    if not info["is_t4"]:
        print(f"NOTE: assigned GPU is {info['gpu_name']} (not a T4); using profile '{info['profile']['name']}'.")
    print("GPU READY ✅")


def internet() -> None:
    res = {}
    for host in ("github.com", "huggingface.co"):
        try:
            socket.getaddrinfo(host, 443)
            res[f"dns_{host}"] = True
        except OSError as e:
            res[f"dns_{host}"] = f"{type(e).__name__}: {e}"
    for name, url in (("github_repo", "https://github.com/umer630/Approx-Ai"),
                      ("hf_model_api", f"https://huggingface.co/api/models/{BASE_MODEL}")):
        try:
            res[name] = urllib.request.urlopen(url, timeout=20).status
        except Exception as e:
            res[name] = f"{type(e).__name__}: {e}"[:200]
    res["INTERNET_READY"] = all(v is True for k, v in res.items() if k.startswith("dns_")) and res["github_repo"] == 200 and res["hf_model_api"] == 200
    save("internet.json", res)
    if not res["INTERNET_READY"]:
        fail("Internet/DNS, GitHub or Hugging Face is not reachable from this runtime. Do not train in a broken runtime.")
    print("INTERNET READY ✅")


def repo() -> None:
    git = lambda *a: subprocess.run(["git", "-C", str(REPO_ROOT), *a], capture_output=True, text=True).stdout.strip()
    data = {"remote": git("remote", "get-url", "origin"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))}
    data["missing_files"] = [f for f in REQUIRED_FILES if not (REPO_ROOT / f).exists()]
    expected_commit = os.environ.get("APPROX_EXPECTED_COMMIT", "").strip()
    data["expected_branch"], data["expected_commit"] = EXPECTED_BRANCH, expected_commit or None
    problems = []
    if "umer630/Approx-Ai" not in data["remote"]:
        problems.append(f"unexpected remote {data['remote']}")
    if data["branch"] != EXPECTED_BRANCH:
        problems.append(f"branch is {data['branch']}, expected {EXPECTED_BRANCH}")
    if expected_commit and not data["commit"].startswith(expected_commit):
        problems.append(f"commit {data['commit']} != pinned {expected_commit}")
    if data["missing_files"]:
        problems.append(f"missing files {data['missing_files']}")
    data["REPO_READY"] = not problems
    save("repo.json", data)
    if problems:
        fail("; ".join(problems))
    print(f"REPO READY ✅ commit {data['commit']}")


def _parse_requirements() -> list[tuple[str, str, str]]:
    out = []
    for line in (TRAINING / "colab/requirements-colab.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        for op in ("==", ">="):
            if op in line:
                name, ver = line.split(op, 1)
                out.append((name.strip(), op, ver.strip()))
                break
    return out


def deps() -> None:
    require_gpu_ready("deps")
    from importlib.metadata import PackageNotFoundError, version
    from packaging.version import Version
    plan, report = [], {}
    for name, op, want in _parse_requirements():
        try:
            have = version(name)
        except PackageNotFoundError:
            have = None
        ok = have is not None and (Version(have) == Version(want) if op == "==" else Version(have) >= Version(want))
        report[name] = {"installed": have, "required": f"{op}{want}", "action": "keep" if ok else "install"}
        if not ok:
            plan.append(f"{name}{op}{want}")
    print(json.dumps(report, indent=1))
    if plan:
        rc = run([PY, "-m", "pip", "install", "-q", *plan], "deps")
        if rc:
            fail(f"pip install failed for {plan}")
    final = {}
    for name, _, _ in _parse_requirements():
        final[name] = version(name)
    import torch
    final["torch (Colab runtime, untouched)"] = torch.__version__
    # real 4-bit NF4 kernel on the GPU, in a fresh interpreter so freshly installed packages are used
    code = ("import torch, bitsandbytes as bnb\n"
            "l = bnb.nn.Linear4bit(64, 64, bias=False, compute_dtype=torch.float16, quant_type='nf4').cuda()\n"
            "y = l(torch.randn(2, 64, dtype=torch.float16, device='cuda'))\n"
            "assert torch.isfinite(y).all(); print('NF4 kernel OK')")
    nf4 = run([PY, "-c", code], "deps") == 0
    save("deps.json", {"plan_installed": plan, "versions": final, "nf4_kernel_ok": nf4, "DEPS_READY": nf4})
    if not nf4:
        fail("bitsandbytes 4-bit NF4 kernel failed on this GPU/CUDA combination.")
    print("DEPS READY ✅")


def model() -> None:
    require_gpu_ready("model")
    code = r"""
import json, os
from huggingface_hub import model_info
from transformers import AutoConfig, AutoTokenizer
base = "Qwen/Qwen2.5-3B-Instruct"
mi = model_info(base)
cfg = AutoConfig.from_pretrained(base, revision=mi.sha)
tok = AutoTokenizer.from_pretrained(base, revision=mi.sha)
msgs = [{"role": "system", "content": "x"}, {"role": "user", "content": "Salam"}]
ids = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True)
files = sorted(s.rfilename for s in (mi.siblings or []))
out = {"base_model": base, "revision": mi.sha, "gated": bool(getattr(mi, "gated", False)), "model_type": cfg.model_type,
       "architectures": cfg.architectures, "hidden_size": cfg.hidden_size, "num_hidden_layers": cfg.num_hidden_layers,
       "vocab_size": cfg.vocab_size, "tokenizer_class": type(tok).__name__, "has_chat_template": tok.chat_template is not None,
       "chat_template_tokens": len(ids), "weight_files": [f for f in files if f.endswith(".safetensors")],
       "arch": {k: getattr(cfg, k) for k in ("hidden_size", "intermediate_size", "num_hidden_layers", "num_attention_heads",
                                               "num_key_value_heads", "vocab_size", "tie_word_embeddings")}}
try:
    import torch
    out["vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2) if torch.cuda.is_available() else 0.0
    out["gpu_name"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
except Exception:
    out["vram_gb"], out["gpu_name"] = 0.0, None
print("MODEL_JSON " + json.dumps(out))
"""
    p = subprocess.run([PY, "-c", code], capture_output=True, text=True, cwd=TRAINING, env=os.environ.copy())
    (D["logs"] / "model.log").write_text(p.stdout[-20000:] + p.stderr[-20000:])
    line = next((l for l in p.stdout.splitlines() if l.startswith("MODEL_JSON ")), None)
    if p.returncode or not line:
        save("model.json", {"MODEL_READY": False, "error": p.stderr.strip().splitlines()[-1:] if p.stderr else "unknown"})
        fail("Could not verify Qwen/Qwen2.5-3B-Instruct (config/tokenizer). If it reports 401/403, add an HF_TOKEN in "
             "Colab Secrets and re-run. Not substituting another model.")
    m = json.loads(line[len("MODEL_JSON "):])
    # VRAM is measured in this stage (not read from another stage's file) and the training profile is the one the
    # config stage will use, so the fit check describes the run that will actually happen.
    prof = vram_profile(m["vram_gb"])
    m["training_profile"] = prof
    if prof:
        est = estimate_qlora_peak_gb(m["arch"], prof, BASE_CFG["lora"]["r"], BASE_CFG["lora"]["target_modules"])
        usable = round(m["vram_gb"] * 0.90, 2)          # 10% headroom for fragmentation / driver variance
        m["memory_estimate"] = {**est, "usable_vram_gb": usable, "headroom_gb": round(usable - est["peak_gb"], 2)}
        m["estimated_peak_vram_gb"] = est["peak_gb"]
        m["fits_vram"] = est["peak_gb"] <= usable
    else:
        m["memory_estimate"] = None
        m["estimated_peak_vram_gb"] = None
        m["fits_vram"] = False
    m["MODEL_READY"] = m["model_type"] == "qwen2" and m["has_chat_template"] and bool(m["weight_files"]) and m["fits_vram"]
    save("model.json", m)
    if not m["MODEL_READY"]:
        why = []
        if m["model_type"] != "qwen2": why.append(f"model_type={m['model_type']}")
        if not m["has_chat_template"]: why.append("no chat template")
        if not m["weight_files"]: why.append("no safetensors weights")
        if not m["fits_vram"]:
            why.append(f"estimated peak {m['estimated_peak_vram_gb']} GB > usable {m.get('memory_estimate', {}) and m['memory_estimate']['usable_vram_gb']} GB"
                       if prof else f"GPU VRAM {m['vram_gb']} GB is below the 10 GB minimum (or no GPU visible to this stage)")
        fail("Base model verification failed: " + "; ".join(why))
    print(f"MODEL READY ✅ {BASE_MODEL}@{m['revision']}")


def data() -> None:
    for cmd in ([PY, "data/seed/make_seed.py"], [PY, "-m", "approx_data.build", "--version", "nick-sft-0.1.0"],
                [PY, "train_qlora.py", "--dry-run"]):
        if run(cmd, "data"):
            fail(f"dataset stage failed: {' '.join(cmd)}")
    man = json.loads((TRAINING / "data/processed/manifest.json").read_text())
    shutil.copy(TRAINING / "data/processed/manifest.json", D["metadata"] / "dataset_manifest.json")
    rejected = sum(man["rejected"].values())
    accepted = man["files"]["train.jsonl"]["records"] + man["files"]["eval.jsonl"]["records"]
    summary = {"dataset_version": man["dataset_version"], "records_read": man["stats"].get("read", 0), "accepted": accepted,
               "rejected_total": rejected, "rejected_by_reason": man["rejected"], "train": man["files"]["train.jsonl"],
               "eval": man["files"]["eval.jsonl"], "missing_domains": man["missing_domains"], "languages": man["language_counts"],
               "fingerprint": man["content_fingerprint_sha256"], "production_ready": man["production_ready"],
               "production_readiness_notes": man["production_readiness_notes"],
               "sources": [{k: p.get(k) for k in ("id", "license", "approved", "ingested", "status", "file_sha256")} for p in man["provenance"]],
               "DATASET_READY": accepted > 0 and man["files"]["train.jsonl"]["records"] > 0 and not man["fab_data_included"]}
    save("dataset.json", summary)
    print(f"\nACCEPTED: {accepted}   REJECTED: {rejected}   (read {summary['records_read']})")
    if not summary["production_ready"]:
        print("⚠️  Dataset is NOT production-quality: " + "; ".join(summary["production_readiness_notes"]))
    if not summary["DATASET_READY"]:
        fail("dataset is empty or invalid")
    print("DATASET READY ✅")


def config() -> None:
    require_gpu_ready("config")
    g = load("gpu.json", current_runtime_only=True)
    prof = g.get("profile") or {}
    if not prof:
        fail("no GPU profile — run the gpu stage first")
    cfg = json.loads(json.dumps(BASE_CFG))
    cfg["base_model"] = BASE_MODEL
    cfg["train"]["per_device_batch_size"] = prof["per_device_batch_size"]
    cfg["train"]["gradient_accumulation_steps"] = prof["gradient_accumulation_steps"]
    cfg["max_seq_length"] = prof["max_seq_length"]
    cfg["quantization"]["bnb_4bit_compute_dtype"] = "bfloat16" if g.get("bf16_supported") else "float16"
    cfg["platform"] = {"runtime": "google-colab", "gpu": g.get("gpu_name"), "vram_gb": g.get("vram_gb"), "profile": prof["name"]}
    path = D["metadata"] / "training_config.resolved.json"
    path.write_text(json.dumps(cfg, indent=2))
    m = load("model.json", current_runtime_only=True)
    agrees = m.get("training_profile") == prof and m.get("fits_vram") is True
    save("config.json", {"profile": prof, "compute_dtype": cfg["quantization"]["bnb_4bit_compute_dtype"], "lora": cfg["lora"],
                         "epochs": cfg["train"]["epochs"], "lr": cfg["train"]["learning_rate"], "config_path": str(path),
                         "model_fit_checked_for_this_profile": agrees, "CONFIG_READY": agrees})
    if not agrees:
        fail("training profile was not fit-checked by the model stage in this runtime — run the model cell first.")


def gate() -> None:
    names = ("gpu.json", "internet.json", "repo.json", "deps.json", "model.json", "dataset.json", "config.json")
    loaded = {n: load(n, current_runtime_only=True) for n in names}
    stale = [n for n, v in loaded.items() if v.get("_stale")]
    missing = [n for n, v in loaded.items() if not v]
    g, i, r, dp, m, ds, cf = (loaded[n] for n in names)
    rep = {"GPU_READY": g.get("GPU_READY") is True, "CUDA_READY": g.get("CUDA_READY") is True,
           "INTERNET_READY": i.get("INTERNET_READY") is True, "REPO_READY": r.get("REPO_READY") is True,
           "DEPS_READY": dp.get("DEPS_READY") is True, "MODEL_READY": m.get("MODEL_READY") is True,
           "DATASET_READY": ds.get("DATASET_READY") is True,
           "CONFIG_READY": cf.get("CONFIG_READY") is True and (D["metadata"] / "training_config.resolved.json").exists()}
    rep["TRAINING_READY"] = all(rep.values())
    rep["stale_from_previous_runtime"] = stale
    rep["not_run_in_this_runtime"] = missing
    rep["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rep["repo_commit"] = r.get("commit")
    rep["dataset_fingerprint"] = ds.get("fingerprint")
    save("preflight.json", rep)
    for k in ("GPU_READY", "CUDA_READY", "INTERNET_READY", "MODEL_READY", "DATASET_READY", "TRAINING_READY"):
        print(f"{k}: {'YES' if rep[k] else 'NO'}")
    if not rep["TRAINING_READY"]:
        msg = "preflight gate failed — training will not start: " + ", ".join(k for k, v in rep.items() if v is False)
        if missing:
            msg += f". Not run in this runtime: {', '.join(missing)} (run cells 4–8 first)"
        if stale:
            msg += f". Stale results from a previous runtime ignored: {', '.join(stale)}"
        fail(msg)



def _last_attempt(log_text: str) -> tuple[str, int | None]:
    """Text and exit code of the most recent `train_qlora.py` invocation in logs/train.log."""
    import re
    starts = [m.start() for m in re.finditer(r"^=== .*\$ .*train_qlora\.py", log_text, re.M)]
    if not starts:
        return "", None
    chunk = log_text[starts[-1]:]
    m = re.search(r"^=== exit code (-?\d+)", chunk, re.M)
    return chunk, int(m.group(1)) if m else None


def _first_error(text: str) -> str | None:
    import re
    lines = text.splitlines()
    for i, l in enumerate(lines):
        if l.startswith("APPROX_TRAIN_EXCEPTION "):
            return l[len("APPROX_TRAIN_EXCEPTION "):]
    for i, l in enumerate(lines):
        if l.startswith("Traceback (most recent call last)"):
            for j in range(i + 1, min(i + 400, len(lines))):
                if re.match(r"^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b.*", lines[j]):
                    return lines[j].strip()[:1500]
            return "traceback without a final exception line: " + " | ".join(lines[i:i + 5])[:800]
    for pat in ("BLOCKED:", "BAD DATA:", "RESUME REFUSED:", "FAILED:", "CUDA out of memory", "CUDA error", "Killed"):
        for l in lines:
            if pat in l:
                return l.strip()[:1500]
    return None


def diagnose() -> dict:
    """READ-ONLY inspection of checkpoints/, adapter/ and logs/ for the latest training attempt. Deletes nothing."""
    import re
    log_path = D["logs"] / "train.log"
    log_text = log_path.read_text(errors="replace") if log_path.exists() else ""
    attempt, rc = _last_attempt(log_text)
    phases = []
    for l in attempt.splitlines():
        if l.startswith("APPROX_PHASE "):
            try:
                phases.append(json.loads(l[len("APPROX_PHASE "):]))
            except json.JSONDecodeError:
                pass
    seen = {p["phase"] for p in phases}
    # fall back to the plain-text markers older trainer versions print
    loaded = "base_model_loaded" in seen or "trainable params:" in attempt
    qlora = "qlora_initialized" in seen or "trainable params:" in attempt
    tokenized = "dataset_tokenized" in seen or bool(re.search(r"^tokenized: ", attempt, re.M))
    step_nums = [p.get("step", 0) for p in phases if p["phase"] == "step_completed"]
    tqdm_steps = [int(a) for a, b in re.findall(r"\b(\d+)/(\d+) \[", attempt) if int(b) > 0]
    steps_done = max(step_nums or [0]) or (max(tqdm_steps) if tqdm_steps else 0)
    ckpts = sorted((p for p in D["checkpoints"].glob("checkpoint-*") if (p / "trainer_state.json").exists()),
                   key=lambda p: int(p.name.split("-")[-1]) if p.name.split("-")[-1].isdigit() else -1)
    adapter_files = [p for p in (D["adapter"] / "adapter_model.safetensors", D["checkpoints"] / "adapter" / "adapter_model.safetensors")
                     if p.exists() and p.stat().st_size > 0]
    status = {}
    if (D["checkpoints"] / "train_status.json").exists():
        try:
            status = json.loads((D["checkpoints"] / "train_status.json").read_text())
        except json.JSONDecodeError:
            pass
    sup = {}
    for sp in (D["checkpoints"] / "supervisor_status.json", LOCAL_RUN / "supervisor_status.json"):
        if sp.exists():
            try:
                sup = json.loads(sp.read_text())
            except json.JSONDecodeError:
                pass
    if rc is None and sup.get("state") == "finished":
        rc = sup.get("exit_code")
    still_running = sup.get("state") == "running" and _pid_alive(sup.get("supervisor_pid"))
    probe = {}
    if (D["checkpoints"] / "training_start_probe.json").exists():
        probe = json.loads((D["checkpoints"] / "training_start_probe.json").read_text())
    first_error = _first_error(attempt) or (status.get("message") if status.get("status") == "failed" else None)
    if rc is not None and rc < 0 and not first_error:
        first_error = f"process killed by signal {-rc} (no Python exception) — typically Colab host-RAM OOM or runtime disconnect"
    kind = status.get("kind") or ("cuda_out_of_memory" if first_error and "out of memory" in first_error.lower() else None)

    resumable = False
    if ckpts:
        stamp = ckpts[-1] / "approx_run.json"
        man = TRAINING / "data/processed/manifest.json"
        if stamp.exists() and man.exists():
            resumable = json.loads(stamp.read_text()).get("train_sha256") == json.loads(man.read_text())["files"]["train.jsonl"]["sha256"]

    last_phase = next((p["phase"] for p in reversed(phases) if p["phase"] not in ("log",)), None)
    if still_running:
        root, fix = "Training is still running (supervisor alive) — not a failure.", "Re-run cell 10 to re-attach to its log."
    elif not log_text or not attempt:
        root, fix = "Cell 10 never launched train_qlora.py in any runtime that wrote to this Drive folder.", \
            "Run cell 9 (gate) and then cell 10 in the same runtime; check that cell 10 printed '$ … train_qlora.py'."
    elif kind == "cuda_out_of_memory":
        root, fix = "CUDA out of memory during training.", \
            "Lower max_seq_length (e.g. 1024) or per_device_batch_size to 1 in the VRAM profile, keep effective batch 16 via accumulation, then resume."
    elif rc is not None and rc < 0:
        root, fix = first_error, "Re-run cell 10; it resumes from the newest checkpoint. If it recurs, use a High-RAM runtime."
    elif first_error:
        root, fix = first_error, "Fix the error shown in FIRST_REAL_ERROR (full traceback in logs/train.log and checkpoints/train_status.json), then re-run cell 10."
    elif rc == 0 and not adapter_files:
        root, fix = "Trainer exited 0 but no adapter file exists.", "Inspect logs/train.log for the adapter_saved phase."
    else:
        root = ("No error and no exit code recorded: the process tree was stopped from outside before finishing "
                f"(last phase reached: {last_phase or 'none — the run predates phase markers or died immediately'}). "
                "With the pre-supervisor launcher this happens when the notebook cell is interrupted/stopped or the "
                "runtime disconnects, because training output was piped through the cell.")
        fix = ("Use the detached supervisor launcher (cell 10 now); re-run cell 10 in a fresh runtime. "
               + ("It will resume from the checkpoint." if ckpts else "No checkpoint exists, so it will start fresh."))

    yn = lambda b: "YES" if b else "NO"
    rep = {
        "TRAINING_STAGE_ENTERED": yn(bool(attempt)),
        "BASE_MODEL_LOADED": yn(loaded),
        "QLORA_INITIALIZED": yn(qlora),
        "DATASET_READY": yn(tokenized),
        "TRAINING_STEP_STARTED": yn("trainer_started" in seen or steps_done > 0),
        "TRAINING_STEPS_COMPLETED": steps_done,
        "FIRST_REAL_ERROR": first_error or "none recorded",
        "CHECKPOINT_FOUND": yn(bool(ckpts)),
        "CHECKPOINT_PATH": str(ckpts[-1]) if ckpts else None,
        "ADAPTER_FOUND": yn(bool(adapter_files)),
        "ROOT_CAUSE": root,
        "FIX": fix,
        "RESUME_OR_FRESH": "RESUME" if resumable else ("FRESH (checkpoint does not match the current dataset)" if ckpts else "FRESH"),
        "LAST_PHASE": last_phase,
        "STILL_RUNNING": yn(still_running),
        "training_start_probe": {k: probe.get(k) for k in ("healthy", "problems", "gpu_name", "free_system_ram_gb", "free_disk_space_gb",
                                                            "cache_location", "drive_mount_status")} if probe else None,
        "exit_code": rc,
        "phases_seen": [p["phase"] for p in phases if p["phase"] not in ("log", "step_completed")],
        "log_file": str(log_path) if log_path.exists() else None,
        "log_attempts_found": log_text.count("train_qlora.py") if log_text else 0,
    }
    save("training_diagnosis.json", rep)
    return rep

LOCAL_RUN = Path(os.environ.get("APPROX_LOCAL_RUN_DIR", "/content/approx_run"))   # fast local disk (per runtime)
HF_CACHE = os.environ.get("APPROX_HF_CACHE", "/content/hf_cache")                   # model cache: local, NOT Drive
HEARTBEAT_SECONDS, MIRROR_SECONDS = 30, 60


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _dir_size_gb(path: str) -> float:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return round(total / 1e9, 2)


def _mem_available_gb():
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return round(int(line.split()[1]) * 1024 / 1e9, 2)
    except OSError:
        return None


def _mirror(local_log: Path, local_status: Path) -> None:
    """Copy the local log/status to Drive (whole-file copies at a low rate: cheap on Drive's FUSE mount)."""
    try:
        shutil.copyfile(local_log, D["logs"] / "train.log")
        if local_status.exists():
            shutil.copyfile(local_status, D["checkpoints"] / "supervisor_status.json")
    except OSError as e:
        print(f"(warning: could not mirror log to Drive: {e})", flush=True)


def _follow(local_log: Path, local_status: Path, offset: int = 0) -> int | None:
    """Print new log output; heartbeat while quiet; mirror to Drive; return the trainer exit code when finished."""
    last_out = last_mirror = time.time()
    last_phase = "starting"
    started = time.time()
    while True:
        with local_log.open("r", errors="replace") as fh:
            fh.seek(offset)
            chunk = fh.read()
            offset = fh.tell()
        if chunk:
            last_out = time.time()
            for line in chunk.splitlines():
                print(line, flush=True)
                if line.startswith("APPROX_PHASE "):
                    try:
                        last_phase = json.loads(line[13:])["phase"]
                    except (ValueError, KeyError):
                        pass
        st = json.loads(local_status.read_text()) if local_status.exists() else {}
        if time.time() - last_mirror >= MIRROR_SECONDS:
            _mirror(local_log, local_status)
            last_mirror = time.time()
        if st.get("state") == "finished":
            _mirror(local_log, local_status)
            return st.get("exit_code")
        if st.get("state") == "running" and not _pid_alive(st.get("supervisor_pid")):
            _mirror(local_log, local_status)
            print("❌ supervisor process disappeared without recording an exit status (runtime-level kill).", flush=True)
            return None
        if time.time() - last_out >= HEARTBEAT_SECONDS:
            print(f"… still running | last phase: {last_phase} | elapsed {int(time.time() - started)}s | "
                  f"model cache {_dir_size_gb(HF_CACHE)} GB | free RAM {_mem_available_gb()} GB", flush=True)
            last_out = time.time()
        time.sleep(2)


def train() -> None:
    require_gpu_ready("train")
    pf = load("preflight.json", current_runtime_only=True)
    if pf.get("TRAINING_READY") is not True:
        fail("preflight gate has not passed in this runtime — run the gate cell first.")
    LOCAL_RUN.mkdir(parents=True, exist_ok=True)
    local_log, local_status = LOCAL_RUN / "train.log", LOCAL_RUN / "supervisor_status.json"

    # Re-attach instead of starting a second run if a supervisor from this runtime is still alive.
    st = json.loads(local_status.read_text()) if local_status.exists() else {}
    if st.get("state") == "running" and _pid_alive(st.get("supervisor_pid")):
        print(f"Re-attaching to the training run already in progress (supervisor pid {st['supervisor_pid']}).", flush=True)
        rc = _follow(local_log, local_status, offset=max(0, local_log.stat().st_size - 4000))
    else:
        ckpts = sorted(p.name for p in D["checkpoints"].glob("checkpoint-*") if (p / "trainer_state.json").exists())
        print("Checkpoint on Drive: " + (f"{ckpts[-1]} — the trainer will RESUME from it if it matches the current dataset"
                                         if ckpts else "none — this is a FRESH run (no resume possible yet)"), flush=True)
        if not local_log.exists() and (D["logs"] / "train.log").exists():
            shutil.copyfile(D["logs"] / "train.log", local_log)   # keep earlier attempts' history in the mirrored log
        if local_status.exists():
            local_status.unlink()
        Path(HF_CACHE).mkdir(parents=True, exist_ok=True)
        trainer_cmd = [PY, "-u", "train_qlora.py", "--config", str(D["metadata"] / "training_config.resolved.json"),
                       "--output-dir", str(D["checkpoints"])]
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "HF_HOME": HF_CACHE, "HF_HUB_DISABLE_PROGRESS_BARS": "1",
               "TOKENIZERS_PARALLELISM": "false", "APPROX_GIT_COMMIT": pf.get("repo_commit") or "",
               "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES", "0")}
        with local_log.open("a") as fh:
            fh.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} $ {' '.join(trainer_cmd)}\n")
        offset = local_log.stat().st_size
        logfh = local_log.open("a")
        sup = subprocess.Popen([PY, "-u", "colab/train_supervisor.py", "--status-file", str(local_status), "--", *trainer_cmd],
                               cwd=TRAINING, env=env, stdin=subprocess.DEVNULL, stdout=logfh, stderr=subprocess.STDOUT,
                               start_new_session=True)      # detached: survives cell interrupts and launcher death
        logfh.close()
        print(f"Training launched in the background (supervisor pid {sup.pid}). Log: {local_log} (mirrored to Drive logs/train.log).\n"
              "Interrupting this cell does NOT stop training; re-run cell 10 to re-attach.", flush=True)
        rc = _follow(local_log, local_status, offset)
    if rc != 0:
        print("\n--- automatic diagnosis of the failed training run (read-only) ---")
        diagnose()
        fail(f"training did not finish successfully (exit status {rc}) — first real error/last phase shown above "
             "and in metadata/training_diagnosis.json.")
    src = D["checkpoints"] / "adapter"
    if not (src / "adapter_model.safetensors").exists():
        fail("training finished without adapter_model.safetensors")
    if D["adapter"].exists():
        shutil.rmtree(D["adapter"])
    shutil.copytree(src, D["adapter"])
    shutil.copy(D["checkpoints"] / "train_metadata.json", D["metadata"] / "train_metadata.json")
    if (D["checkpoints"] / "training_start_probe.json").exists():
        shutil.copy(D["checkpoints"] / "training_start_probe.json", D["metadata"] / "training_start_probe.json")
    ckpts = sorted(p.name for p in D["checkpoints"].glob("checkpoint-*"))
    save("checkpoints.json", {"checkpoint_dir": str(D["checkpoints"]), "checkpoints": ckpts})
    print("TRAINING FINISHED — adapter copied to", D["adapter"])


def evaluate() -> None:
    require_gpu_ready("evaluate")
    if not (D["adapter"] / "adapter_model.safetensors").exists():
        fail("no adapter — training has not completed")
    rc = run([PY, "verify_adapter.py", "--adapter", str(D["adapter"])], "evaluate")
    v = D["adapter"] / "verification.json"
    if v.exists():
        shutil.copy(v, D["evaluation"] / "verification.json")
    print("EVALUATION:", "PASSED" if rc == 0 else f"FAILED (exit {rc}) — real results are in evaluation/verification.json")


def verify() -> None:
    require_gpu_ready("verify")
    code = r"""
import json, sys, torch
from pathlib import Path
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
a = Path(sys.argv[1]); out = {"checks": {}}
need = ["adapter_model.safetensors", "adapter_config.json", "tokenizer_config.json", "approx_adapter_manifest.json"]
out["checks"]["adapter_files_exist"] = all((a / f).exists() and (a / f).stat().st_size > 0 for f in need)
man = json.loads((a / "approx_adapter_manifest.json").read_text())
out["base_model"], out["revision"], out["smoke_test"] = man["base_model"], man.get("base_model_revision"), man.get("smoke_test")
out["checks"]["not_smoke"] = man.get("smoke_test") is False and man["base_model"] == "Qwen/Qwen2.5-3B-Instruct"
try:
    tok = AutoTokenizer.from_pretrained(str(a)); out["checks"]["tokenizer_loads"] = True
    dt = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    base = AutoModelForCausalLM.from_pretrained(man["base_model"], revision=man.get("base_model_revision"), torch_dtype=dt, device_map={"": 0})
    out["checks"]["model_loads"] = True
    model = PeftModel.from_pretrained(base, str(a)).eval(); out["checks"]["adapter_loads"] = True
    enc = tok.apply_chat_template([{"role": "user", "content": "Who are you? Answer in one sentence."}], add_generation_prompt=True,
                                  return_tensors="pt", return_dict=True).to(model.device)
    with torch.no_grad():
        g = model.generate(**enc, max_new_tokens=60, do_sample=False)
    text = tok.decode(g[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()
    out["generation"] = text; out["checks"]["generation_succeeds"] = True; out["checks"]["output_non_empty"] = bool(text)
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"[:500]
for k in ("tokenizer_loads", "model_loads", "adapter_loads", "generation_succeeds", "output_non_empty"):
    out["checks"].setdefault(k, False)
out["PASSED"] = all(out["checks"].values())
print("INFER_JSON " + json.dumps(out))
"""
    p = subprocess.run([PY, "-c", code, str(D["adapter"])], capture_output=True, text=True, cwd=TRAINING)
    (D["logs"] / "verify.log").write_text(p.stdout[-20000:] + p.stderr[-20000:])
    line = next((l for l in p.stdout.splitlines() if l.startswith("INFER_JSON ")), None)
    res = json.loads(line[len("INFER_JSON "):]) if line else {"PASSED": False, "error": (p.stderr or "no output")[-500:]}
    (D["evaluation"] / "inference_check.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps(res, indent=2, ensure_ascii=False))
    if not res.get("PASSED"):
        fail("adapter reload/inference verification FAILED — run marked FAILED")
    print("ADAPTER VERIFIED ✅ (reload + real generation)")


def manifest() -> None:
    if run([PY, "package_adapter.py", "--adapter", str(D["adapter"])], "manifest"):
        fail("packaging failed")
    files = {}
    for sub in ("adapter", "metadata", "evaluation"):
        for p in sorted(D[sub].rglob("*")):
            if p.is_file():
                files[f"{sub}/{p.relative_to(D[sub]).as_posix()}"] = {"sha256": sha256_file(p), "bytes": p.stat().st_size}
    for p in sorted(DRIVE.glob("*.tar.gz")) + [DRIVE / "SHA256SUMS"]:
        if p.exists():
            files[p.name] = {"sha256": sha256_file(p), "bytes": p.stat().st_size}
    ok = True
    for line in (DRIVE / "SHA256SUMS").read_text().splitlines():
        h, name = line.split("  ", 1)
        if not (DRIVE / name).exists() or sha256_file(DRIVE / name) != h:
            ok = False
            print("SHA256 MISMATCH:", name)
    save("artifact_manifest.json", {"root": str(DRIVE), "files": files, "sha256sums_verified": ok})
    if not ok:
        fail("SHA256SUMS verification failed")


def report() -> None:
    meta = load("train_metadata.json")
    ver = json.loads((D["evaluation"] / "verification.json").read_text()) if (D["evaluation"] / "verification.json").exists() else {}
    inf = json.loads((D["evaluation"] / "inference_check.json").read_text()) if (D["evaluation"] / "inference_check.json").exists() else {}
    art = load("artifact_manifest.json")
    w = D["adapter"] / "adapter_model.safetensors"
    ev = {
        "preflight_passed": load("preflight.json").get("TRAINING_READY") is True,
        "gpu_training_completed": meta.get("status") == "completed" and bool(meta.get("gpu")) and meta.get("smoke_test") is False,
        "adapter_weights_exist": w.exists() and w.stat().st_size > 0,
        "adapter_reload_and_inference": inf.get("PASSED") is True,
        "verification_passed": ver.get("verification_passed") is True,
        "sha256_verified": art.get("sha256sums_verified") is True,
        "metadata_written": bool(meta) and (D["metadata"] / "dataset_manifest.json").exists(),
    }
    status = "COMPLETE" if all(ev.values()) else ("FAILED" if ev["preflight_passed"] else "BLOCKED")
    rep = {"status": status, "evidence": ev, "model_id": "nick-4.8", "base_model": meta.get("base_model"),
           "base_model_revision": meta.get("base_model_revision"), "adapter_version": meta.get("adapter_version"),
           "adapter_sha256": sha256_file(w) if w.exists() else None, "repo_commit": meta.get("git_commit"),
           "dataset": meta.get("dataset"), "gpu": meta.get("gpu"), "metrics": meta.get("metrics"),
           "verification": {k: ver.get(k) for k in ("checks", "category_results", "capability_pass_rate", "safety_passed", "failed_probes", "eval_perplexity")},
           "inference_check": inf.get("checks"), "artifacts_root": str(DRIVE),
           "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    save("completion_report.json", rep)
    print(f"\nNICK 4.8 TRAINING STATUS: {status}")
    if status != "COMPLETE":
        sys.exit(1)


STAGES = {"env": env, "gpu": gpu, "internet": internet, "repo": repo, "deps": deps, "model": model, "data": data,
          "config": config, "gate": gate, "train": train, "diagnose": diagnose, "evaluate": evaluate, "verify": verify, "manifest": manifest, "report": report}

if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else ""
    if stage not in STAGES:
        sys.exit(f"usage: colab_pipeline.py {{{'|'.join(STAGES)}}}")
    ensure_dirs()
    STAGES[stage]()
