"""Nick 4.8 QLoRA fine-tuning on Qwen/Qwen2.5-3B-Instruct (PEFT + bitsandbytes).

Runs on a single NVIDIA GPU (Kaggle / Colab). Features: dataset validation, tokenizer chat
template, assistant-only loss masking, 4-bit NF4 quantization, LoRA, checkpointing + automatic
resume, periodic evaluation, adapter export with SHA-256 manifest.

    python train_qlora.py --config configs/nick-4.8-qlora.json            # train (auto-resumes)
    python train_qlora.py --config configs/nick-4.8-qlora.json --dry-run  # validate config+data only (CPU OK)

Training is only COMPLETE after verify_adapter.py reports verification_passed=true.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def validate(cfg: dict) -> tuple[list[dict], list[dict]]:
    ddir = HERE / cfg["dataset_dir"]
    manifest = json.loads((ddir / "manifest.json").read_text(encoding="utf-8"))
    for name in ("train.jsonl", "eval.jsonl"):
        digest = hashlib.sha256((ddir / name).read_bytes()).hexdigest()
        if digest != manifest["files"][name]["sha256"]:
            raise SystemExit(f"{name} does not match manifest SHA-256 — rebuild the dataset")
    if manifest.get("fab_data_included"):
        raise SystemExit("FAB data must never be used for Nick training")
    train, ev = load_jsonl(ddir / "train.jsonl"), load_jsonl(ddir / "eval.jsonl")
    for r in train + ev:
        assert r["messages"][-1]["role"] == "assistant", "last turn must be assistant"
    if len(train) < 1000:
        print(f"WARNING: only {len(train)} training records. This is a pipeline smoke set, not enough for a meaningful fine-tune.", file=sys.stderr)
    return train, ev


def sha256_dir(d: Path) -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.iterdir()) if p.is_file()}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "configs/nick-4.8-qlora.json"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    cfg = json.loads(Path(a.config).read_text())
    train_rows, eval_rows = validate(cfg)
    print(f"dataset OK: {len(train_rows)} train / {len(eval_rows)} eval")
    if a.dry_run:
        print("dry run: config + dataset validated; no model loaded")
        return 0

    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, DataCollatorForSeq2Seq, Trainer, TrainingArguments)
    from transformers.trainer_utils import get_last_checkpoint

    if not torch.cuda.is_available():
        raise SystemExit("BLOCKED: QLoRA training requires an NVIDIA GPU (run on Kaggle or Colab with a GPU accelerator).")

    q = cfg["quantization"]
    compute_dtype = getattr(torch, q["bnb_4bit_compute_dtype"])
    if compute_dtype == torch.bfloat16 and not torch.cuda.is_bf16_supported():
        compute_dtype = torch.float16  # T4 / P100
    tok = AutoTokenizer.from_pretrained(cfg["base_model"], use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        cfg["base_model"],
        quantization_config=BitsAndBytesConfig(load_in_4bit=q["load_in_4bit"], bnb_4bit_quant_type=q["bnb_4bit_quant_type"],
                                               bnb_4bit_use_double_quant=q["bnb_4bit_use_double_quant"], bnb_4bit_compute_dtype=compute_dtype),
        torch_dtype=compute_dtype, device_map="auto")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=cfg["train"]["gradient_checkpointing"])
    L = cfg["lora"]
    model = get_peft_model(model, LoraConfig(r=L["r"], lora_alpha=L["alpha"], lora_dropout=L["dropout"], target_modules=L["target_modules"], bias="none", task_type="CAUSAL_LM"))
    model.print_trainable_parameters()

    max_len = cfg["max_seq_length"]

    def encode(row):
        # Loss only on the final assistant turn (prompt tokens masked with -100).
        msgs = row["messages"]
        prompt_ids = tok.apply_chat_template(msgs[:-1], tokenize=True, add_generation_prompt=True)
        full_ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=False)
        full_ids = full_ids[:max_len]
        labels = [-100] * min(len(prompt_ids), len(full_ids)) + full_ids[len(prompt_ids):]
        return {"input_ids": full_ids, "attention_mask": [1] * len(full_ids), "labels": labels[:len(full_ids)]}

    train_ds = Dataset.from_list(train_rows).map(encode, remove_columns=list(train_rows[0].keys()))
    eval_ds = Dataset.from_list(eval_rows).map(encode, remove_columns=list(eval_rows[0].keys())) if eval_rows else None

    out = HERE / cfg["output_dir"]
    out.mkdir(parents=True, exist_ok=True)
    T = cfg["train"]
    args = TrainingArguments(
        output_dir=str(out), num_train_epochs=T["epochs"], per_device_train_batch_size=T["per_device_batch_size"],
        per_device_eval_batch_size=T["per_device_batch_size"], gradient_accumulation_steps=T["gradient_accumulation_steps"],
        learning_rate=T["learning_rate"], lr_scheduler_type=T["lr_scheduler"], warmup_ratio=T["warmup_ratio"], weight_decay=T["weight_decay"],
        max_grad_norm=T["max_grad_norm"], logging_steps=T["logging_steps"], save_steps=T["save_steps"], save_total_limit=T["save_total_limit"],
        eval_strategy="steps" if eval_ds is not None else "no", eval_steps=T["eval_steps"], bf16=compute_dtype == torch.bfloat16,
        fp16=compute_dtype == torch.float16, gradient_checkpointing=T["gradient_checkpointing"], optim="paged_adamw_8bit",
        report_to="none", seed=T["seed"], run_name=cfg["run_name"])
    trainer = Trainer(model=model, args=args, train_dataset=train_ds, eval_dataset=eval_ds,
                      data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100))
    last = get_last_checkpoint(str(out)) if out.exists() else None
    if last:
        print(f"resuming from {last}")
    t0 = time.time()
    result = trainer.train(resume_from_checkpoint=last)
    metrics = {"train": result.metrics, "train_seconds": round(time.time() - t0, 1)}
    if eval_ds is not None:
        metrics["eval"] = trainer.evaluate()

    adapter_dir = out / "adapter"
    model.save_pretrained(str(adapter_dir))
    tok.save_pretrained(str(adapter_dir))
    manifest = {
        "model_id": cfg["model_id"], "adapter_version": cfg["adapter_version"], "base_model": cfg["base_model"],
        "dataset_manifest": json.loads((HERE / cfg["dataset_dir"] / "manifest.json").read_text())["files"],
        "config": cfg, "metrics": metrics, "files_sha256": sha256_dir(adapter_dir),
        "gpu": torch.cuda.get_device_name(0), "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verification_passed": None,
    }
    (adapter_dir / "approx_adapter_manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    print(json.dumps(metrics, indent=2, default=str))
    print(f"adapter saved to {adapter_dir}. Next: python verify_adapter.py --adapter {adapter_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
