"""Hardware planner. For a model config and a detected GPU, pick the first training profile whose estimated peak
VRAM fits, using the analytic QLoRA estimator (recalled from colab/colab_pipeline.py). The arch values in the YAML
are hints; at real training time the trainer loads the actual base-model config and the estimate is recomputed.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "colab"))
from colab_pipeline import estimate_qlora_peak_gb  # noqa: E402

SAFETY_HEADROOM = 0.90   # leave 10% of VRAM for fragmentation / driver


def plan(model_cfg: dict, gpu_vram_gb: float | None, gpu_compute_capability: float | None = None, arch: dict | None = None) -> dict:
    """Returns {feasible, chosen_profile, estimate, reason, profiles:[...]} for the detected GPU."""
    arch = arch or model_cfg["architecture_hint"]
    lora = model_cfg["lora"]
    results = []
    chosen = None
    for prof in model_cfg["profiles"]:
        est = estimate_qlora_peak_gb(arch, {"per_device_batch_size": prof["per_device_batch_size"], "max_seq_length": prof["max_seq_length"]},
                                     lora["r"], lora["target_modules"])
        fits_cfg = prof["min_vram_gb"]
        usable = gpu_vram_gb * SAFETY_HEADROOM if gpu_vram_gb else None
        fits = usable is not None and est["peak_gb"] <= usable
        row = {"profile": prof["name"], "per_device_batch_size": prof["per_device_batch_size"], "grad_accum": prof["gradient_accumulation_steps"],
               "max_seq_length": prof["max_seq_length"], "estimated_peak_gb": est["peak_gb"], "declared_min_vram_gb": fits_cfg, "fits_detected_gpu": fits}
        results.append(row)
        if chosen is None and fits:
            chosen = {**prof, "estimate": est}
    min_cc = model_cfg["hardware"].get("min_compute_capability", 7.0)
    cc_ok = gpu_compute_capability is None or gpu_compute_capability >= min_cc
    feasible = chosen is not None and cc_ok
    if gpu_vram_gb is None:
        reason = "no GPU detected: QLoRA training requires an NVIDIA GPU (the trainer refuses to run on CPU)"
    elif not cc_ok:
        reason = f"GPU compute capability {gpu_compute_capability} < required {min_cc} (bitsandbytes 4-bit needs newer hardware)"
    elif chosen is None:
        smallest = min(results, key=lambda r: r["estimated_peak_gb"])
        reason = (f"GPU_REQUIREMENT_NOT_MET: smallest profile needs ~{smallest['estimated_peak_gb']} GB but only "
                  f"{round(gpu_vram_gb * SAFETY_HEADROOM, 1)} GB is usable of {gpu_vram_gb} GB. {model_cfg['hardware'].get('recommended', '')}")
    else:
        reason = f"profile '{chosen['name']}' fits: est {chosen['estimate']['peak_gb']} GB <= {round(gpu_vram_gb * SAFETY_HEADROOM, 1)} GB usable"
    return {"feasible": feasible, "chosen_profile": {k: chosen[k] for k in ("name", "per_device_batch_size", "gradient_accumulation_steps", "max_seq_length")} if chosen else None,
            "estimate": chosen["estimate"] if chosen else None, "compute_capability_ok": cc_ok, "min_compute_capability": min_cc,
            "reason": reason, "recommended_hardware": model_cfg["hardware"].get("recommended"), "profiles": results}


def detect_gpu():
    """(vram_gb, compute_capability, name) or (None, None, None)."""
    try:
        import torch
        if not torch.cuda.is_available():
            return None, None, None
        p = torch.cuda.get_device_properties(0)
        cap = torch.cuda.get_device_capability(0)
        return round(p.total_memory / 1e9, 2), float(f"{cap[0]}.{cap[1]}"), p.name
    except Exception:
        return None, None, None
