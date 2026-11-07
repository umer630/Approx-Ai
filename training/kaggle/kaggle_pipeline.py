"""Stage runner used by the Kaggle notebook. Each stage fails loudly (non-zero exit) so the notebook stops.

    python kaggle/kaggle_pipeline.py preflight   # GPU, CUDA, library versions, bitsandbytes 4-bit kernel test, disk, Hub access
    python kaggle/kaggle_pipeline.py data        # seed + approved sources → data/processed (+ manifest)
    python kaggle/kaggle_pipeline.py train       # QLoRA, checkpoints, auto-resume (also from /kaggle/input)
    python kaggle/kaggle_pipeline.py verify      # real generation tests → verification.json
    python kaggle/kaggle_pipeline.py package     # nick-4.8-adapter-1.0.0.tar.gz + verification.json + SHA256SUMS
    python kaggle/kaggle_pipeline.py status      # strict completion check (prints COMPLETE only with full evidence)

Outputs go to $APPROX_OUTPUT_DIR (default /kaggle/working/nick-4.8-output on Kaggle, else training/outputs/...).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
ON_KAGGLE = Path("/kaggle/working").exists()
CFG = json.loads((TRAINING / "configs/nick-4.8-qlora.json").read_text())
OUT = Path(os.environ.get("APPROX_OUTPUT_DIR") or ("/kaggle/working/nick-4.8-output" if ON_KAGGLE else TRAINING / CFG["output_dir"]))
ADAPTER = OUT / "adapter"
PY = sys.executable


def run(cmd: list[str], **kw) -> None:
    print("$", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=TRAINING, **kw)
    if r.returncode != 0:
        sys.exit(f"STAGE FAILED (exit {r.returncode}): {' '.join(cmd)}")


def preflight() -> None:
    import torch
    info = {"torch": torch.__version__, "cuda_available": torch.cuda.is_available(), "cuda": torch.version.cuda}
    if not torch.cuda.is_available():
        sys.exit("BLOCKED: no GPU. Kaggle: Settings → Accelerator → GPU T4 x1 (or T4 x2), then restart the session.")
    info["gpus"] = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
    info["gpu0_memory_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1)
    info["bf16_supported"] = torch.cuda.is_bf16_supported()
    import transformers, peft, accelerate, datasets, bitsandbytes as bnb
    info.update(transformers=transformers.__version__, peft=peft.__version__, accelerate=accelerate.__version__,
                datasets=datasets.__version__, bitsandbytes=bnb.__version__)
    # Exercise the 4-bit NF4 CUDA kernel before spending time downloading 6 GB.
    layer = bnb.nn.Linear4bit(64, 64, bias=False, compute_dtype=torch.float16, quant_type="nf4").cuda()
    y = layer(torch.randn(2, 64, dtype=torch.float16, device="cuda"))
    info["bnb_nf4_kernel"] = "ok" if torch.isfinite(y).all().item() else "non-finite output"
    if info["bnb_nf4_kernel"] != "ok":
        sys.exit(f"BLOCKED: bitsandbytes 4-bit kernel failed: {info}")
    if info["gpu0_memory_gb"] < 14:
        sys.exit(f"BLOCKED: GPU 0 has {info['gpu0_memory_gb']} GB; ≥15 GB (T4) recommended for this config.")
    free_gb = shutil.disk_usage(OUT.parent if OUT.parent.exists() else "/").free / 1e9
    info["disk_free_gb"] = round(free_gb, 1)
    if free_gb < 10:
        sys.exit(f"BLOCKED: only {free_gb:.1f} GB free disk (need ~10 GB for model cache + checkpoints).")
    try:
        from huggingface_hub import model_info
        mi = model_info(CFG["base_model"], revision=CFG.get("base_model_revision"))
        info["base_model"] = CFG["base_model"]
        info["base_model_revision"] = mi.sha
        info["base_model_files"] = sorted(s.rfilename for s in (mi.siblings or []) if s.rfilename.endswith((".safetensors", ".json")))[:20]
    except Exception as e:
        sys.exit(f"BLOCKED: base model {CFG['base_model']} not reachable ({type(e).__name__}: {e}). "
                 "Enable Settings → Internet. Not substituting another model.")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "preflight.json").write_text(json.dumps(info, indent=2))
    print(json.dumps(info, indent=2))
    print("PREFLIGHT OK")


def data() -> None:
    run([PY, "data/seed/make_seed.py"])
    run([PY, "-m", "approx_data.build", "--version", "nick-sft-0.1.0"])
    run([PY, "train_qlora.py", "--dry-run"])


def train() -> None:
    cmd = [PY, "train_qlora.py", "--output-dir", str(OUT)]
    if Path("/kaggle/input").exists():
        cmd += ["--resume-search", "/kaggle/input"]
    run(cmd, env={**os.environ, "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES", "0"),
                  "APPROX_GIT_COMMIT": os.environ.get("APPROX_GIT_COMMIT", "")})


def verify() -> None:
    if not (ADAPTER / "adapter_model.safetensors").exists():
        sys.exit("verify: no adapter_model.safetensors — training has not completed")
    r = subprocess.run([PY, "verify_adapter.py", "--adapter", str(ADAPTER)], cwd=TRAINING,
                       env={**os.environ, "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES", "0")})
    # verification failures are real results: keep going to packaging so they can be inspected, but report them
    print("VERIFICATION PASSED" if r.returncode == 0 else f"VERIFICATION FAILED (exit {r.returncode}) — see verification.json")


def package() -> None:
    run([PY, "package_adapter.py", "--adapter", str(ADAPTER)])


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def status() -> int:
    """Nick 4.8 is trained ONLY if every item below is true."""
    ev = {}
    meta = json.loads((OUT / "train_metadata.json").read_text()) if (OUT / "train_metadata.json").exists() else {}
    ev["gpu_training_completed"] = meta.get("status") == "completed" and bool(meta.get("gpu")) and not meta.get("smoke_test")
    w = ADAPTER / "adapter_model.safetensors"
    ev["adapter_model_safetensors_exists"] = w.exists() and w.stat().st_size > 0
    ver = json.loads((OUT / "verification.json").read_text(encoding="utf-8")) if (OUT / "verification.json").exists() else {}
    checks = ver.get("checks", {})
    ev["adapter_loaded"] = checks.get("adapter_loads") is True
    ev["real_inference_verified"] = checks.get("generation_works") is True and bool(ver.get("probes"))
    ev["verification_json_passed"] = ver.get("verification_passed") is True
    sums = OUT / "SHA256SUMS"
    ok_sums = sums.exists()
    if ok_sums:
        for line in sums.read_text().splitlines():
            h, name = line.split("  ", 1)
            p = OUT / name
            if not p.exists() or sha256_file(p) != h:
                ok_sums = False
                print(f"SHA256 MISMATCH: {name}")
    ev["sha256_verified"] = ok_sums
    tar = OUT / f"nick-4.8-adapter-{CFG['adapter_version']}.tar.gz"
    ev["package_exists"] = tar.exists()
    complete = all(ev.values())
    report = {"evidence": ev, "COMPLETE": complete, "output_dir": str(OUT),
              "adapter_sha256": sha256_file(w) if w.exists() else None, "tarball_sha256": sha256_file(tar) if tar.exists() else None,
              "base_model": meta.get("base_model"), "base_model_revision": meta.get("base_model_revision"),
              "gpu": (meta.get("gpu") or {}).get("name"), "dataset": (meta.get("dataset") or {}).get("fingerprint"),
              "failed_probes": ver.get("failed_probes")}
    (OUT / "completion_status.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print("\n" + ("✅ COMPLETE: Nick 4.8 adapter trained on GPU, loaded, inference-verified, SHA-256 verified." if complete
                  else "❌ NOT COMPLETE — see the false items above. Do not report Nick 4.8 as trained."))
    return 0 if complete else 1


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "status"
    fn = {"preflight": preflight, "data": data, "train": train, "verify": verify, "package": package, "status": status}.get(stage)
    if not fn:
        sys.exit(f"unknown stage {stage}")
    rc = fn()
    sys.exit(rc or 0)
