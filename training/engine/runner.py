"""The unified training engine: one code path, one per-model YAML config. For a single model it runs
dataset build → GPU/hardware plan → QLoRA training → independent verification → unseen evaluation (BASE vs
ADAPTER) → safety gate → regression → release packaging, and returns a machine-readable result. Every stage is
blocking: a failure stops that model with an explicit reason, and no failed model is ever marked production-ready.

GPU work is delegated to the already-validated training/train_qlora.py and training/verify_adapter.py (unchanged
contracts). This module renders their JSON config from the YAML and runs the evaluation graders.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENGINE = Path(__file__).resolve().parent
TRAINING = ENGINE.parent
REPO_ROOT = TRAINING.parent
for _p in (str(TRAINING), str(REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from engine import dataset_builder, evaluator, hardware         # noqa: E402
from engine import safety_evaluator, release_manager            # noqa: E402
from engine.curriculum import eval_suite                        # noqa: E402

PY = sys.executable


def load_model_cfg(path) -> dict:
    import yaml
    return yaml.safe_load(Path(path).read_text())


def render_trainer_config(model_cfg: dict, profile: dict, dataset_dir: Path, output_dir: Path, base_override: str | None = None) -> dict:
    T = model_cfg["train"]
    return {
        "run_name": f"{model_cfg['model_id']}-qlora", "model_id": model_cfg["model_id"],
        "adapter_version": model_cfg.get("version_series", "1.0") + ".0",
        "base_model": base_override or model_cfg["base_model"], "base_model_revision": model_cfg.get("base_model_revision"),
        "dataset_dir": str(dataset_dir), "output_dir": str(output_dir), "max_seq_length": profile["max_seq_length"],
        "quantization": {"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_use_double_quant": True, "bnb_4bit_compute_dtype": "bfloat16"},
        "lora": model_cfg["lora"],
        "train": {"epochs": T["epochs"], "per_device_batch_size": profile["per_device_batch_size"],
                  "gradient_accumulation_steps": profile["gradient_accumulation_steps"], "learning_rate": T["learning_rate"],
                  "lr_scheduler": T["lr_scheduler"], "warmup_ratio": T["warmup_ratio"], "weight_decay": T["weight_decay"],
                  "max_grad_norm": T["max_grad_norm"], "gradient_checkpointing": T["gradient_checkpointing"],
                  "max_save_steps": T.get("max_save_steps", 200), "checkpoints_per_epoch": T.get("checkpoints_per_epoch", 2),
                  "save_total_limit": T.get("save_total_limit", 3), "logging_steps": T.get("logging_steps", 1), "seed": T["seed"]},
    }


def _run(cmd: list, log: Path, env: dict | None = None) -> int:
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} $ {' '.join(cmd)}\n")
        p = subprocess.Popen(cmd, cwd=TRAINING, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                             env={**os.environ, **(env or {}), "PYTHONUNBUFFERED": "1"})
        for line in p.stdout:
            print(line, end="", flush=True)
            fh.write(line)
        return p.wait()


def generate_eval_answers(adapter_dir: Path | None, base_model: str, items: list, max_new_tokens: int, smoke_base: str | None = None,
                          progress=lambda *_: None) -> dict:
    """Run the unseen suite prompts through a model (base alone if adapter_dir is None). Returns {id: text}.
    Requires torch + the model; raises if neither GPU nor a smoke base is available."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    smoke = smoke_base is not None
    load = smoke_base or base_model
    tok = AutoTokenizer.from_pretrained(load)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    if smoke:
        model = AutoModelForCausalLM.from_pretrained(load, torch_dtype=torch.float32)
    else:
        if not torch.cuda.is_available():
            raise RuntimeError("GPU_REQUIRED: evaluation needs the model on a CUDA device")
        from transformers import BitsAndBytesConfig
        bf16 = torch.cuda.is_bf16_supported()
        model = AutoModelForCausalLM.from_pretrained(load, device_map={"": 0}, quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16 if bf16 else torch.float16))
    if adapter_dir is not None:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(adapter_dir))
    model.eval()
    device = next(model.parameters()).device
    answers = {}
    system = None
    for i, it in enumerate(items):
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": it["prompt"]}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(device)
        with torch.inference_mode():
            out = model.generate(ids, max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=tok.pad_token_id)
        answers[it["id"]] = tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True).strip()
        progress(i + 1, len(items))
    return answers


def train_one(model_cfg_path, models_dir: Path, work_dir: Path, *, smoke: bool = False, smoke_base: str | None = None,
              smoke_scale: float = 0.05, smoke_max_steps: int = 2, time_budget_minutes: float = 0, signing_key: str = "",
              report=lambda **_: None) -> dict:
    """Full pipeline for one model. Returns a result dict; never raises for an expected blocker (records it instead)."""
    cfg = load_model_cfg(model_cfg_path)
    model_id = cfg["model_id"]
    work = Path(work_dir) / model_id
    logs = work / "logs"
    result = {"model_id": model_id, "display_name": cfg.get("display_name"), "smoke": smoke, "stages": {}, "status": "pending", "blockers": []}

    def stage(name, **info):
        result["stages"][name] = {**info, "at": time.strftime("%H:%M:%SZ", time.gmtime())}
        report(model_id=model_id, stage=name, **info)

    def stop(reason, code):
        result["status"] = "blocked"
        result["blockers"].append(reason)
        result["blocker_code"] = code
        stage("stopped", reason=reason, code=code)
        return result

    # 1. dataset
    ds_dir = work / "dataset"
    manifest = dataset_builder.build(ds_dir, cfg, seed=cfg["dataset"].get("seed", 4848), scale=smoke_scale if smoke else 1.0)
    stage("dataset", version=manifest["dataset_version"], train=manifest["counts"]["train"], test=manifest["counts"]["test"],
          production_ready=manifest["production_ready"], notes=manifest["production_readiness_notes"])

    # 2. hardware plan
    vram, cc, gpu_name = hardware.detect_gpu()
    plan = hardware.plan(cfg, vram, cc)
    stage("hardware_plan", gpu=gpu_name, vram_gb=vram, feasible=plan["feasible"], chosen=plan["chosen_profile"], reason=plan["reason"])
    if not smoke and not plan["feasible"]:
        return stop(plan["reason"], "GPU_REQUIRED" if vram is None else "GPU_REQUIREMENT_NOT_MET")
    profile = plan["chosen_profile"] or {"name": "smoke-cpu", "per_device_batch_size": 1, "gradient_accumulation_steps": 1, "max_seq_length": 256}

    # 3. train (delegated to the validated trainer)
    out_dir = work / "train_output"
    trainer_cfg = render_trainer_config(cfg, profile, ds_dir, out_dir, base_override=smoke_base if smoke else None)
    cfg_path = work / "trainer_config.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(trainer_cfg, indent=2))
    (out_dir / "STOP").unlink(missing_ok=True) if (out_dir / "STOP").exists() else None
    cmd = [PY, str(TRAINING / "train_qlora.py"), "--config", str(cfg_path), "--dataset-dir", str(ds_dir), "--output-dir", str(out_dir),
           "--min-disk-gb", str(cfg["hardware"].get("min_disk_gb", 15))]
    if time_budget_minutes:
        cmd += ["--time-budget-minutes", str(time_budget_minutes)]
    if smoke:
        cmd += ["--smoke-base", smoke_base, "--smoke-max-steps", str(smoke_max_steps)]
    stage("training_start", profile=profile["name"], command="train_qlora.py")
    rc = _run(cmd, logs / "train.log")
    adapter_dir = (out_dir.with_name(out_dir.name + "-SMOKE") if smoke else out_dir) / "adapter"
    if rc == 7:
        result["status"] = "paused"
        stage("training_paused", note="time budget reached; rerun to resume")
        return result
    if rc != 0 or not (adapter_dir / "adapter_model.safetensors").exists():
        codes = {2: "GPU_REQUIRED", 3: "BASE_MODEL_UNAVAILABLE", 4: "BAD_DATA", 5: "RESUME_MISMATCH", 6: "UNHEALTHY_RUNTIME"}
        return stop(f"training did not produce an adapter (exit {rc})", codes.get(rc, "TRAINING_FAILED"))
    train_meta = json.loads((adapter_dir / "train_metadata.json").read_text())
    train_meta.setdefault("dataset", {}).update({"version": manifest["dataset_version"], "fingerprint": manifest["content_fingerprint_sha256"],
                                                 "production_ready": manifest["production_ready"]})
    stage("training_done", steps=train_meta.get("metrics", {}).get("global_step"), loss_last=train_meta.get("metrics", {}).get("loss_last"))

    # 4. independent verification (reload + generation + safety probes) via the existing verifier
    rc = _run([PY, str(TRAINING / "verify_adapter.py"), "--adapter", str(adapter_dir)], logs / "verify.log")
    verify_report = {}
    vpath = adapter_dir / "verification.json"
    if vpath.exists():
        verify_report = json.loads(vpath.read_text())
    train_meta["verification_passed"] = (rc == 0)
    stage("verification", passed=(rc == 0), summary=verify_report.get("summary"))

    # 5. unseen evaluation: BASE vs ADAPTER on the held-out suite
    items = eval_suite.ITEMS
    max_new = cfg["evaluation"].get("max_new_tokens", 320)
    try:
        base_ans = generate_eval_answers(None, cfg["base_model"], items, max_new, smoke_base=smoke_base if smoke else None)
        adapter_ans = generate_eval_answers(adapter_dir, cfg["base_model"], items, max_new, smoke_base=smoke_base if smoke else None)
    except Exception as e:
        return stop(f"evaluation could not run: {type(e).__name__}: {e}", "EVALUATION_FAILED")
    base_score = evaluator.score(items, base_ans)
    adapter_score = evaluator.score(items, adapter_ans)
    saf = safety_evaluator.evaluate(items, adapter_ans, required_pass_rate=cfg["evaluation"].get("safety_required_pass_rate", 1.0))
    gate = evaluator.gate(adapter_score, base_score, cfg["evaluation"].get("required_score", 100),
                          cfg["evaluation"].get("safety_required_pass_rate", 1.0), cfg["evaluation"].get("regression_tolerance", 0.0))
    regression = {"passed": not any(f["category"] == "regression" for f in gate["failures"]),
                  "base_score": base_score["overall_score"], "adapter_score": adapter_score["overall_score"]}
    stage("evaluation", adapter_score=adapter_score["overall_score"], base_score=base_score["overall_score"],
          gate_passed=gate["passed"], safety_passed=saf["passed"], failures=[f["category"] for f in gate["failures"]])

    # 6. release packaging (status/production_ready are derived honestly from the gates)
    rel = release_manager.build_release(models_dir, cfg, train_meta, {"base": base_score, "adapter": adapter_score}, gate, saf, regression,
                                        adapter_dir, signing_key=signing_key, smoke=smoke)
    result["release"] = {k: rel[k] for k in ("version", "status", "production_ready", "blockers", "adapter_sha256", "dir")}
    result["release"]["archive_sha256"] = rel["archive"]["sha256"]
    result["evaluation"] = {"adapter_score": adapter_score["overall_score"], "base_score": base_score["overall_score"],
                            "categories": {c: adapter_score["categories"][c]["score"] for c in adapter_score["categories"]},
                            "gate_passed": gate["passed"], "failures": gate["failures"]}
    result["status"] = "completed"
    stage("release", version=rel["version"], status=rel["status"], production_ready=rel["production_ready"], blockers=rel["blockers"])
    return result
