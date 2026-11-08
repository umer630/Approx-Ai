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
        return p.wait()


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


def gpu() -> None:
    import torch
    if not torch.cuda.is_available():
        save("gpu.json", {"GPU_READY": False, "CUDA_READY": False, "reason": "torch.cuda.is_available() is False"})
        fail("No CUDA GPU attached. Colab: Runtime → Change runtime type → Hardware accelerator: T4 GPU → Save, then "
             "Runtime → Restart and run all. If no GPU is offered, your Colab GPU quota may be exhausted — do NOT train on CPU.")
    pr = torch.cuda.get_device_properties(0)
    vram = round(pr.total_memory / 1e9, 2)
    a = torch.randn(1024, 1024, device="cuda")
    ok = bool(torch.isfinite(a @ a).all().item())
    cap = list(torch.cuda.get_device_capability(0))
    prof = vram_profile(vram)
    data = {"gpu_name": pr.name, "vram_gb": vram, "compute_capability": cap, "bf16_supported": torch.cuda.is_bf16_supported(),
            "is_t4": "T4" in pr.name, "cuda_matmul_ok": ok, "profile": prof,
            "CUDA_READY": ok, "GPU_READY": ok and cap >= [7, 0] and bool(prof)}
    save("gpu.json", data)
    if not ok:
        fail("CUDA matmul produced non-finite values — the GPU runtime is broken. Restart the runtime.")
    if cap < [7, 0]:
        fail(f"GPU compute capability {cap} < 7.0 is not supported by bitsandbytes 4-bit. Request a T4 or newer.")
    if not prof:
        fail(f"{pr.name} has {vram} GB VRAM; Nick 4.8 QLoRA needs ≥ 10 GB. Request a T4 (16 GB).")
    if not data["is_t4"]:
        print(f"NOTE: assigned GPU is {pr.name} (not a T4); using profile '{prof['name']}'.")
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


def train() -> None:
    pf = load("preflight.json", current_runtime_only=True)
    if pf.get("TRAINING_READY") is not True:
        fail("preflight gate has not passed in this runtime — run the gate cell first.")
    env_extra = {"APPROX_GIT_COMMIT": pf.get("repo_commit") or "", "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES", "0")}
    rc = run([PY, "train_qlora.py", "--config", str(D["metadata"] / "training_config.resolved.json"),
              "--output-dir", str(D["checkpoints"])], "train", env_extra)
    if rc:
        fail(f"training exited with code {rc} — see logs/train.log. Re-running this cell resumes from the last checkpoint.")
    src = D["checkpoints"] / "adapter"
    if not (src / "adapter_model.safetensors").exists():
        fail("training finished without adapter_model.safetensors")
    if D["adapter"].exists():
        shutil.rmtree(D["adapter"])
    shutil.copytree(src, D["adapter"])
    shutil.copy(D["checkpoints"] / "train_metadata.json", D["metadata"] / "train_metadata.json")
    ckpts = sorted(p.name for p in D["checkpoints"].glob("checkpoint-*"))
    save("checkpoints.json", {"checkpoint_dir": str(D["checkpoints"]), "checkpoints": ckpts})
    print("TRAINING FINISHED — adapter copied to", D["adapter"])


def evaluate() -> None:
    if not (D["adapter"] / "adapter_model.safetensors").exists():
        fail("no adapter — training has not completed")
    rc = run([PY, "verify_adapter.py", "--adapter", str(D["adapter"])], "evaluate")
    v = D["adapter"] / "verification.json"
    if v.exists():
        shutil.copy(v, D["evaluation"] / "verification.json")
    print("EVALUATION:", "PASSED" if rc == 0 else f"FAILED (exit {rc}) — real results are in evaluation/verification.json")


def verify() -> None:
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
          "config": config, "gate": gate, "train": train, "evaluate": evaluate, "verify": verify, "manifest": manifest, "report": report}

if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else ""
    if stage not in STAGES:
        sys.exit(f"usage: colab_pipeline.py {{{'|'.join(STAGES)}}}")
    ensure_dirs()
    STAGES[stage]()
