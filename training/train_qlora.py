"""Nick 4.8 QLoRA fine-tuning on Qwen/Qwen2.5-3B-Instruct (PEFT + bitsandbytes 4-bit NF4).

    python train_qlora.py                                  # GPU training (auto-resume)
    python train_qlora.py --dry-run                        # validate config + dataset only (CPU OK)
    python train_qlora.py --resume-search /kaggle/input    # also resume from checkpoints attached as Kaggle input

Guarantees:
  * Refuses to train without an NVIDIA GPU (exit 2). No fake training.
  * If the base model cannot be downloaded/loaded it STOPS (exit 3). It never substitutes another model.
  * Checkpoints `checkpoints_per_epoch` times per epoch; resumes automatically from the newest checkpoint in
    the output dir or (with --resume-search) from a previous Kaggle run attached as input. A checkpoint made
    from a different dataset is refused.
  * Loss is computed on the final assistant turn only; records with no trainable tokens are dropped.
  * Writes adapter/ (adapter_model.safetensors, adapter_config.json, tokenizer, manifests) and
    train_metadata.json (versions, GPU, resolved base-model revision, dataset hashes, metrics, timings).

Training is NOT complete until verify_adapter.py reports verification_passed=true.

--smoke-base <dir> exists ONLY for CPU pipeline tests with a tiny locally generated random model; outputs are
labelled smoke_test=true and are rejected by package_adapter.py / the backend registry as a Nick adapter.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXIT_NO_GPU, EXIT_BASE_UNAVAILABLE, EXIT_BAD_DATA, EXIT_RESUME_MISMATCH, EXIT_UNHEALTHY = 2, 3, 4, 5, 6
EXIT_PAUSED = 7   # time budget reached or STOP file present: a checkpoint was saved; rerun the same command to resume
MIN_FREE_RAM_GB, MIN_FREE_DISK_GB = 4.0, 15.0   # 3B safetensors are loaded shard-by-shard; ~6.2 GB download + headroom


def _mem_available_gb() -> float | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return round(int(line.split()[1]) * 1024 / 1e9, 2)
    except OSError:
        pass
    return None


def _runtime_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return platform.node()


def training_start_probe(out: Path, model_id: str, smoke: bool) -> dict:
    """Cheap health snapshot taken immediately before the expensive model download/load. Never records secrets."""
    from importlib.metadata import PackageNotFoundError, version
    import torch

    def ver(pkg):
        try:
            return version(pkg)
        except PackageNotFoundError:
            return None
    cache = os.environ.get("HF_HOME") or str(Path.home() / ".cache/huggingface")
    Path(cache).mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(cache)
    cuda = torch.cuda.is_available()
    probe = {
        "runtime_id": _runtime_id(),
        "gpu_name": torch.cuda.get_device_name(0) if cuda else None,
        "gpu_memory_total_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2) if cuda else None,
        "gpu_memory_free_gb": round(torch.cuda.mem_get_info(0)[0] / 1e9, 2) if cuda else None,
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
        "transformers_version": ver("transformers"),
        "peft_version": ver("peft"),
        "bitsandbytes_version": ver("bitsandbytes"),
        "model_id": model_id,
        "cache_location": cache,
        "drive_mount_status": "mounted" if os.path.ismount("/content/drive") else ("not_mounted" if Path("/content").exists() else "not_colab"),
        "output_on_drive": str(out).startswith("/content/drive"),
        "free_system_ram_gb": _mem_available_gb(),
        "free_disk_space_gb": round(disk.free / 1e9, 2),
        "smoke_test": smoke,
    }
    problems = []
    if not smoke and not cuda:
        problems.append("no CUDA GPU")
    if probe["free_system_ram_gb"] is not None and probe["free_system_ram_gb"] < MIN_FREE_RAM_GB and not smoke:
        problems.append(f"only {probe['free_system_ram_gb']} GB free system RAM (< {MIN_FREE_RAM_GB})")
    if probe["free_disk_space_gb"] < MIN_FREE_DISK_GB and not smoke:
        problems.append(f"only {probe['free_disk_space_gb']} GB free disk at the model cache (< {MIN_FREE_DISK_GB})")
    if str(out).startswith("/content/drive") and probe["drive_mount_status"] != "mounted":
        problems.append("Google Drive is not mounted but the output dir is on Drive")
    probe["healthy"] = not problems
    probe["problems"] = problems
    (out / "training_start_probe.json").write_text(json.dumps(probe, indent=2))
    return probe
_OUT: Path | None = None  # set once the output dir is known; phases are then also appended to train_phases.jsonl


def phase(name: str, **info) -> None:
    """Machine-readable progress marker: printed (so it lands in the launcher log) and appended to train_phases.jsonl."""
    rec = {"phase": name, "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **info}
    print("APPROX_PHASE " + json.dumps(rec, default=str), flush=True)
    if _OUT is not None:
        with (_OUT / "train_phases.jsonl").open("a") as fh:
            fh.write(json.dumps(rec, default=str) + "\n")


def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dataset_dir(cfg: dict, override: str | None) -> Path:
    d = Path(override or cfg["dataset_dir"])
    return d if d.is_absolute() else HERE / d


def validate_dataset(ddir: Path) -> tuple[list[dict], list[dict], dict]:
    mpath = ddir / "manifest.json"
    if not mpath.exists():
        print(f"BAD DATA: {mpath} missing — run `python -m approx_data.build` first", file=sys.stderr)
        sys.exit(EXIT_BAD_DATA)
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    for name in ("train.jsonl", "eval.jsonl"):
        if sha256_file(ddir / name) != manifest["files"][name]["sha256"]:
            print(f"BAD DATA: {name} does not match manifest SHA-256 — rebuild the dataset", file=sys.stderr)
            sys.exit(EXIT_BAD_DATA)
    if manifest.get("fab_data_included"):
        print("BAD DATA: FAB data must never be used for Nick training", file=sys.stderr)
        sys.exit(EXIT_BAD_DATA)
    train, ev = load_jsonl(ddir / "train.jsonl"), load_jsonl(ddir / "eval.jsonl")
    if not train:
        print("BAD DATA: empty training set", file=sys.stderr)
        sys.exit(EXIT_BAD_DATA)
    for r in train + ev:
        if r["messages"][-1]["role"] != "assistant":
            print("BAD DATA: last turn must be assistant", file=sys.stderr)
            sys.exit(EXIT_BAD_DATA)
    if not manifest.get("production_ready"):
        print(f"WARNING: dataset is NOT production-quality ({'; '.join(manifest.get('production_readiness_notes', []))}). "
              f"This run validates the pipeline and teaches identity/format; it will not add real capability.", file=sys.stderr)
    return train, ev, manifest


def git_commit() -> str | None:
    if os.environ.get("APPROX_GIT_COMMIT"):
        return os.environ["APPROX_GIT_COMMIT"]
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


def schedule(n_train: int, T: dict) -> dict:
    per_step = T["per_device_batch_size"] * T["gradient_accumulation_steps"]
    # mirrors transformers.Trainer: len(dataloader) // gradient_accumulation_steps (min 1)
    steps_per_epoch = max(1, math.ceil(n_train / T["per_device_batch_size"]) // T["gradient_accumulation_steps"])
    total = steps_per_epoch * T["epochs"]
    save_steps = max(1, min(T["max_save_steps"], steps_per_epoch // max(1, T["checkpoints_per_epoch"]) or 1))
    return {"examples_per_step": per_step, "steps_per_epoch": steps_per_epoch, "total_steps": total, "save_steps": save_steps}


def find_checkpoint(out: Path, search_roots: list[str]) -> Path | None:
    """Newest checkpoint-* (with trainer_state.json) in the output dir, else in search roots (e.g. /kaggle/input)."""
    def ckpts(root: Path):
        if not root.exists():
            return []
        return [p for p in root.rglob("checkpoint-*") if p.is_dir() and (p / "trainer_state.json").exists()]
    def step(p: Path) -> int:
        try:
            return int(p.name.split("-")[-1])
        except ValueError:
            return -1
    local = sorted(ckpts(out), key=step)
    if local:
        return local[-1]
    found = []
    for r in search_roots:
        found += ckpts(Path(r))
    if not found:
        return None
    best = sorted(found, key=step)[-1]
    dest = out / best.name
    print(f"copying checkpoint {best} → {dest}")
    shutil.copytree(best, dest, dirs_exist_ok=True)
    return dest


def _main(argv=None):
    global _OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "configs/nick-4.8-qlora.json"))
    ap.add_argument("--dataset-dir", default=None)
    ap.add_argument("--output-dir", default=os.environ.get("APPROX_OUTPUT_DIR"))
    ap.add_argument("--resume-search", action="append", default=[], help="extra roots to search for checkpoints (repeatable)")
    ap.add_argument("--no-resume", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-steps", type=int, default=0, help="hard cap on optimizer steps (0 = run the configured epochs)")
    ap.add_argument("--time-budget-minutes", type=float, default=0,
                    help="save a checkpoint and exit with code 7 once this much wall time has been used (0 = no limit); rerun to resume")
    ap.add_argument("--min-disk-gb", type=float, default=None, help="free disk required at start (default 15; larger base models need more)")
    ap.add_argument("--smoke-base", default=None, help=argparse.SUPPRESS)
    ap.add_argument("--smoke-max-steps", type=int, default=0, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    global MIN_FREE_DISK_GB
    if a.min_disk_gb is not None:
        MIN_FREE_DISK_GB = a.min_disk_gb
    cfg = json.loads(Path(a.config).read_text())
    ddir = dataset_dir(cfg, a.dataset_dir)
    train_rows, eval_rows, ds_manifest = validate_dataset(ddir)
    T = cfg["train"]
    plan = schedule(len(train_rows), T)
    print(f"dataset OK: {len(train_rows)} train / {len(eval_rows)} eval · plan: {plan}")
    if a.dry_run:
        print("dry run: config + dataset validated; no model loaded")
        return 0

    smoke = a.smoke_base is not None
    import torch
    if not smoke and not torch.cuda.is_available():
        print("BLOCKED: QLoRA training requires an NVIDIA GPU (Colab: Runtime → Change runtime type → T4 GPU).", file=sys.stderr)
        return EXIT_NO_GPU

    import transformers
    import peft
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, DataCollatorForSeq2Seq, Trainer,
                              TrainerCallback, TrainingArguments, set_seed)

    set_seed(T["seed"])
    base_id = a.smoke_base or cfg["base_model"]
    revision = None if smoke else cfg.get("base_model_revision")
    out = Path(a.output_dir) if a.output_dir else HERE / cfg["output_dir"]
    if smoke:
        out = out.with_name(out.name + "-SMOKE")
    out.mkdir(parents=True, exist_ok=True)
    _OUT = out
    phase("entered", output_dir=str(out), smoke=smoke, cuda=torch.cuda.is_available(), pid=os.getpid())

    probe = training_start_probe(out, base_id, smoke)
    phase("training_start_probe", **probe)
    if not probe["healthy"]:
        print("BLOCKED: runtime is not healthy enough to start: " + "; ".join(probe["problems"]), file=sys.stderr)
        return EXIT_UNHEALTHY

    # ---- resolve + load base model (STOP if unavailable; never substitute) ----
    resolved_revision = "local-smoke-model" if smoke else None
    if not smoke:
        try:
            from huggingface_hub import model_info
            resolved_revision = model_info(base_id, revision=revision).sha
        except Exception as e:
            print(f"BLOCKED: base model {base_id} is not available from the Hugging Face Hub ({type(e).__name__}: {e}). "
                  "Not substituting another model. Check that the runtime has Internet access.", file=sys.stderr)
            return EXIT_BASE_UNAVAILABLE
        revision = revision or resolved_revision

    use_cuda = torch.cuda.is_available() and not smoke
    if use_cuda:
        q = cfg["quantization"]
        compute_dtype = getattr(torch, q["bnb_4bit_compute_dtype"])
        if compute_dtype == torch.bfloat16 and not torch.cuda.is_bf16_supported():
            compute_dtype = torch.float16  # T4 / P100
    else:
        compute_dtype = torch.float32
    try:
        load_path = base_id
        if not smoke:
            # Explicit download step (separate markers, resumable by huggingface_hub if interrupted).
            from huggingface_hub import snapshot_download
            phase("base_model_download_start", model_id=base_id, revision=revision, cache=os.environ.get("HF_HOME"))
            t0 = time.time()
            load_path = snapshot_download(base_id, revision=revision,
                                          allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "tokenizer*", "merges.txt", "vocab.json"])
            size = sum(f.stat().st_size for f in Path(load_path).rglob("*") if f.is_file())
            phase("base_model_download_done", path=load_path, bytes=size, seconds=round(time.time() - t0, 1))
        phase("tokenizer_load_start")
        tok = AutoTokenizer.from_pretrained(load_path, use_fast=True)
        phase("tokenizer_loaded", tokenizer=type(tok).__name__)
        phase("base_model_load_start", quantization="4-bit NF4" if use_cuda else "none (smoke)", ram_free_gb=_mem_available_gb())
        if use_cuda:
            model = AutoModelForCausalLM.from_pretrained(
                load_path, torch_dtype=compute_dtype, device_map={"": 0}, low_cpu_mem_usage=True,
                quantization_config=BitsAndBytesConfig(load_in_4bit=q["load_in_4bit"], bnb_4bit_quant_type=q["bnb_4bit_quant_type"],
                                                       bnb_4bit_use_double_quant=q["bnb_4bit_use_double_quant"],
                                                       bnb_4bit_compute_dtype=compute_dtype))
        else:
            model = AutoModelForCausalLM.from_pretrained(load_path, torch_dtype=torch.float32)
    except OSError as e:
        print(f"BLOCKED: could not download/load base model {base_id}@{revision}: {e}. Not substituting another model.", file=sys.stderr)
        return EXIT_BASE_UNAVAILABLE
    phase("base_model_loaded", base=base_id, revision=resolved_revision, quantized_4bit=use_cuda,
          compute_dtype=str(compute_dtype), gpu_mem_allocated_gb=round(torch.cuda.memory_allocated(0) / 1e9, 2) if use_cuda else None)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    if tok.chat_template is None:
        print("BLOCKED: tokenizer has no chat template", file=sys.stderr)
        return EXIT_BASE_UNAVAILABLE

    if use_cuda:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=T["gradient_checkpointing"],
                                                gradient_checkpointing_kwargs={"use_reentrant": False})
    L = cfg["lora"]
    phase("lora_init_start", r=L["r"], alpha=L["alpha"])
    targets = [t for t in L["target_modules"] if any(n.endswith(t) for n, _ in model.named_modules())]
    model = get_peft_model(model, LoraConfig(r=L["r"], lora_alpha=L["alpha"], lora_dropout=L["dropout"], target_modules=targets,
                                             bias="none", task_type="CAUSAL_LM"))
    trainable, total_params = model.get_nb_trainable_parameters()
    print(f"trainable params: {trainable:,} / {total_params:,} ({100 * trainable / total_params:.3f}%)")
    phase("qlora_initialized", trainable_params=trainable, total_params=total_params, target_modules=targets)

    # ---- tokenize with assistant-only loss ----
    max_len = cfg["max_seq_length"]
    prefix_mismatch = 0

    def encode(row):
        nonlocal prefix_mismatch
        msgs = row["messages"]
        prompt_ids = list(tok.apply_chat_template(msgs[:-1], tokenize=True, add_generation_prompt=True))
        full_ids = list(tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=False))
        if full_ids[:len(prompt_ids)] != prompt_ids:
            prefix_mismatch += 1
        full_ids = full_ids[:max_len]
        labels = ([-100] * min(len(prompt_ids), len(full_ids)) + full_ids[len(prompt_ids):])[:len(full_ids)]
        return {"input_ids": full_ids, "attention_mask": [1] * len(full_ids), "labels": labels}

    def to_ds(rows):
        enc = [encode({"messages": r["messages"]}) for r in rows]
        kept = [e for e in enc if any(l != -100 for l in e["labels"])]
        return Dataset.from_list(kept) if kept else None, len(enc) - len(kept)

    train_ds, dropped_train = to_ds(train_rows)
    eval_ds, dropped_eval = to_ds(eval_rows) if eval_rows else (None, 0)
    if prefix_mismatch:
        print(f"WARNING: chat-template prefix mismatch in {prefix_mismatch} records (masking may be off)", file=sys.stderr)
    if train_ds is None:
        print("BAD DATA: no record has trainable tokens after truncation", file=sys.stderr)
        return EXIT_BAD_DATA
    plan = schedule(len(train_ds), T)
    phase("dataset_tokenized", train=len(train_ds), eval=len(eval_ds) if eval_ds else 0, dropped=dropped_train + dropped_eval,
          prefix_mismatch=prefix_mismatch, plan=plan)
    print(f"tokenized: {len(train_ds)} train (dropped {dropped_train}), {len(eval_ds) if eval_ds else 0} eval (dropped {dropped_eval}); plan {plan}")

    run_info = {"run_name": cfg["run_name"], "dataset_fingerprint": ds_manifest.get("content_fingerprint_sha256"),
                "train_sha256": ds_manifest["files"]["train.jsonl"]["sha256"], "base_model": cfg["base_model"] if not smoke else base_id,
                "base_model_revision": resolved_revision, "smoke_test": smoke}

    class RunInfoCallback(TrainerCallback):
        """Stamps every checkpoint with the run identity so a resume can be validated."""
        def on_save(self, args, state, control, **kw):
            ck = Path(args.output_dir) / f"checkpoint-{state.global_step}"
            if ck.exists():
                (ck / "approx_run.json").write_text(json.dumps(run_info, indent=2))
            phase("checkpoint_saved", step=state.global_step, path=str(ck), exists=ck.exists())

        def on_train_begin(self, args, state, control, **kw):
            phase("trainer_started", max_steps=state.max_steps, resumed_at_step=state.global_step)

        def on_step_begin(self, args, state, control, **kw):
            if not getattr(self, "_first", False):
                self._first = True
                phase("first_training_step_start", step=state.global_step + 1)

        def on_step_end(self, args, state, control, **kw):
            mem = round(torch.cuda.max_memory_allocated(0) / 1e9, 2) if torch.cuda.is_available() else None
            phase("step_completed", step=state.global_step, max_steps=state.max_steps, peak_gpu_mem_gb=mem)

        def on_log(self, args, state, control, logs=None, **kw):
            if logs:
                phase("log", step=state.global_step, **{k: v for k, v in logs.items() if isinstance(v, (int, float))})

    paused = {"reason": None}
    started = time.time()

    class PauseCallback(TrainerCallback):
        """Graceful pause: on time budget or a STOP file, save a checkpoint at this step and stop. Rerun resumes."""
        def on_step_end(self, args, state, control, **kw):
            why = None
            if (out / "STOP").exists():
                why = "stop requested (STOP file)"
            elif a.time_budget_minutes and time.time() - started > a.time_budget_minutes * 60:
                why = f"time budget of {a.time_budget_minutes} min reached"
            if why and state.global_step < state.max_steps:
                paused["reason"] = why
                control.should_save = True
                control.should_training_stop = True
            return control

    max_steps = a.max_steps or (a.smoke_max_steps if smoke and a.smoke_max_steps else -1)
    args = TrainingArguments(
        output_dir=str(out), num_train_epochs=T["epochs"], max_steps=max_steps,
        per_device_train_batch_size=T["per_device_batch_size"], per_device_eval_batch_size=T["per_device_batch_size"],
        gradient_accumulation_steps=T["gradient_accumulation_steps"], learning_rate=T["learning_rate"],
        lr_scheduler_type=T["lr_scheduler"], warmup_ratio=T["warmup_ratio"], weight_decay=T["weight_decay"],
        max_grad_norm=T["max_grad_norm"], logging_steps=T["logging_steps"], save_strategy="steps", save_steps=plan["save_steps"],
        save_total_limit=T["save_total_limit"], eval_strategy="steps" if eval_ds is not None else "no", eval_steps=plan["save_steps"],
        bf16=use_cuda and compute_dtype == torch.bfloat16, fp16=use_cuda and compute_dtype == torch.float16,
        gradient_checkpointing=T["gradient_checkpointing"] and use_cuda, gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="paged_adamw_8bit" if use_cuda else "adamw_torch", report_to="none", seed=T["seed"], data_seed=T["seed"],
        run_name=cfg["run_name"], use_cpu=not use_cuda, disable_tqdm=True, dataloader_num_workers=0, save_safetensors=True)
    phase("trainer_init_start")
    trainer = Trainer(model=model, args=args, train_dataset=train_ds, eval_dataset=eval_ds,
                      data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100), callbacks=[RunInfoCallback(), PauseCallback()])

    phase("trainer_init_done")
    resume = None if a.no_resume else find_checkpoint(out, a.resume_search)
    if resume:
        stamp = resume / "approx_run.json"
        if stamp.exists():
            prev = json.loads(stamp.read_text())
            if prev.get("train_sha256") != run_info["train_sha256"] or prev.get("base_model") != run_info["base_model"]:
                print(f"RESUME REFUSED: {resume} was trained on a different dataset/base model. Use --no-resume or a fresh output dir.", file=sys.stderr)
                return EXIT_RESUME_MISMATCH
        print(f"resuming from {resume}")
    phase("resume_decision", mode="resume" if resume else "fresh", checkpoint=str(resume) if resume else None)

    (out / "train_status.json").write_text(json.dumps({"status": "running", "started_at": time.time(), "resume_from": str(resume) if resume else None}))
    t0 = time.time()
    result = trainer.train(resume_from_checkpoint=str(resume) if resume else None)
    if paused["reason"]:
        (out / "train_status.json").write_text(json.dumps({"status": "paused", "reason": paused["reason"], "global_step": trainer.state.global_step,
                                                          "max_steps": trainer.state.max_steps}))
        phase("training_paused", reason=paused["reason"], global_step=trainer.state.global_step, max_steps=trainer.state.max_steps)
        print(f"PAUSED at step {trainer.state.global_step}/{trainer.state.max_steps}: {paused['reason']}. A checkpoint was saved; "
              "run the same command again to resume.")
        return EXIT_PAUSED
    phase("training_finished", global_step=trainer.state.global_step)
    metrics = {"train": result.metrics, "train_seconds": round(time.time() - t0, 1), "global_step": trainer.state.global_step}
    if eval_ds is not None:
        metrics["eval"] = trainer.evaluate()
    losses = [h["loss"] for h in trainer.state.log_history if "loss" in h]
    metrics["loss_first"], metrics["loss_last"] = (losses[0], losses[-1]) if losses else (None, None)
    if any(map(lambda x: x is not None and (math.isnan(x) or math.isinf(x)), [metrics["loss_last"], metrics["train"].get("train_loss")])):
        (out / "train_status.json").write_text(json.dumps({"status": "failed", "reason": "non-finite loss", "metrics": metrics}, default=str))
        print("FAILED: non-finite loss", file=sys.stderr)
        return 1

    adapter_dir = out / "adapter"
    model.save_pretrained(str(adapter_dir), safe_serialization=True)
    tok.save_pretrained(str(adapter_dir))
    weights = adapter_dir / "adapter_model.safetensors"
    phase("adapter_saved", path=str(weights), exists=weights.exists(), bytes=weights.stat().st_size if weights.exists() else 0)
    if not weights.exists() or weights.stat().st_size == 0:
        print("FAILED: adapter_model.safetensors was not written", file=sys.stderr)
        return 1
    shutil.copy(ddir / "manifest.json", adapter_dir / "dataset_manifest.json")
    (adapter_dir / "training_config.json").write_text(json.dumps(cfg, indent=2))

    gpu = {"name": torch.cuda.get_device_name(0), "capability": list(torch.cuda.get_device_capability(0)),
           "total_memory_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1),
           "peak_memory_gb": round(torch.cuda.max_memory_allocated(0) / 1e9, 2), "cuda": torch.version.cuda} if use_cuda else None
    versions = {"python": platform.python_version(), "torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__}
    try:
        import bitsandbytes, accelerate, datasets
        versions.update(bitsandbytes=bitsandbytes.__version__, accelerate=accelerate.__version__, datasets=datasets.__version__)
    except Exception:
        pass
    meta = {
        "status": "completed", "smoke_test": smoke,
        "model_id": cfg["model_id"] if not smoke else "SMOKE-TEST-NOT-NICK", "adapter_version": cfg["adapter_version"] if not smoke else "smoke",
        "base_model": run_info["base_model"], "base_model_revision": resolved_revision,
        "method": "QLoRA (4-bit NF4, double quant) + LoRA" if use_cuda else "LoRA fp32 on CPU (smoke test only)",
        "compute_dtype": str(compute_dtype).replace("torch.", ""), "lora_target_modules": targets,
        "trainable_parameters": trainable, "total_parameters": total_params,
        "dataset": {"version": ds_manifest["dataset_version"], "fingerprint": ds_manifest.get("content_fingerprint_sha256"),
                    "files": ds_manifest["files"], "production_ready": ds_manifest.get("production_ready"),
                    "tokenized_train": len(train_ds), "dropped_no_label_tokens": dropped_train + dropped_eval, "prefix_mismatch": prefix_mismatch},
        "schedule": plan, "resumed_from": str(resume) if resume else None, "metrics": metrics, "gpu": gpu, "versions": versions,
        "git_commit": git_commit(), "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out / "train_metadata.json").write_text(json.dumps(meta, indent=2, default=str))
    (adapter_dir / "train_metadata.json").write_text(json.dumps(meta, indent=2, default=str))
    manifest = {
        "model_id": meta["model_id"], "adapter_version": meta["adapter_version"], "base_model": meta["base_model"],
        "base_model_revision": resolved_revision, "smoke_test": smoke,
        "files_sha256": {p.name: sha256_file(p) for p in sorted(adapter_dir.iterdir()) if p.is_file() and p.name != "approx_adapter_manifest.json"},
        "verification_passed": None, "safety_passed": None,
    }
    (adapter_dir / "approx_adapter_manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / "train_status.json").write_text(json.dumps({"status": "completed", "finished_at": meta["finished_at"]}))
    print(json.dumps({"status": "completed", "adapter_dir": str(adapter_dir), "adapter_model.safetensors_bytes": weights.stat().st_size,
                      "adapter_model.safetensors_sha256": manifest["files_sha256"]["adapter_model.safetensors"], "metrics": metrics}, indent=2, default=str))
    print(f"NEXT: python verify_adapter.py --adapter {adapter_dir}")
    return 0


def _on_sigterm(signum, frame):
    raise SystemExit(128 + signum)  # turns SIGTERM/SIGHUP into a recorded, non-zero exit (SIGKILL cannot be caught)


def main(argv=None) -> int:
    """Runs training; on ANY exception prints the full traceback, records it in train_status.json, and exits non-zero."""
    import traceback
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _on_sigterm)
    try:
        rc = _main(argv)
    except BaseException as e:  # noqa: BLE001 — record everything, including KeyboardInterrupt / SystemExit with code
        if isinstance(e, SystemExit) and e.code in (0, None):
            raise
        tb = traceback.format_exc()
        if isinstance(e, SystemExit) and isinstance(e.code, int) and e.code >= 128:
            kind = f"terminated_by_signal_{e.code - 128}"
        else:
            kind = "cuda_out_of_memory" if "out of memory" in tb.lower() else ("cuda_error" if "cuda error" in tb.lower() else type(e).__name__)
        print("APPROX_TRAIN_EXCEPTION " + json.dumps({"type": type(e).__name__, "kind": kind, "message": str(e)[:2000]}), flush=True)
        print(tb, file=sys.stderr, flush=True)
        try:
            phase("failed", type=type(e).__name__, kind=kind, message=str(e)[:500])
            if _OUT is not None:
                (_OUT / "train_status.json").write_text(json.dumps({"status": "failed", "type": type(e).__name__, "kind": kind,
                                                                   "message": str(e)[:2000], "traceback": tb[-20000:]}, indent=2))
        except Exception:
            pass
        raise
    if rc and _OUT is not None:
        phase("exited", code=rc)
    return rc


if __name__ == "__main__":
    sys.exit(main())
