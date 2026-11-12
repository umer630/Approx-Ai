"""Assemble a per-model SFT dataset from the curriculum (authored + programmatically generated), run every quality
gate (engine/dataset_validator.py), hold out the unseen evaluation suite, and write train/eval/test splits plus a
manifest with full statistics, a reproducibility fingerprint and an explicit production-readiness verdict.

Deterministic: same seed + same scale ⇒ byte-identical outputs (checked by the engine tests).

A model's system prompt is applied as the first turn of every record, so each model gets its own identity. The
record authors never bake a system prompt in; the builder adds it from the model config (templating by model).
"""
from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ENGINE = Path(__file__).resolve().parent
TRAINING = ENGINE.parent
REPO_ROOT = TRAINING.parent
for _p in (str(TRAINING), str(REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from engine import dataset_validator as dv  # noqa: E402
from engine.curriculum import authored, generators, eval_suite  # noqa: E402
from approx_data.pii import scrub  # noqa: E402

BUILDER_VERSION = "2.0.0"
# Production thresholds. The current authored+generated corpus is intentionally below these, so a build is NOT
# production-ready until a much larger, human-reviewed corpus is supplied.
PRODUCTION_MIN_TOTAL = 20000
PRODUCTION_MIN_PER_CORE_DOMAIN = 300
CORE_DOMAINS = ["mathematics", "science", "physics", "chemistry", "coding", "english", "urdu", "education", "safety", "reasoning"]
PRODUCTION_MAX_SYNTHETIC_FRACTION = 0.6   # mostly-template data is not enough on its own
PRODUCTION_MIN_LANGUAGES = {"en", "ur", "roman_ur"}


def norm(text: str) -> str:
    return dv.norm_text(text)


def record_prompt_key(messages) -> str:
    user = " ".join(m["content"] for m in messages if m["role"] == "user")
    return hashlib.sha256(norm(user).encode()).hexdigest()


def build(out_dir: Path, model_cfg: dict, seed: int = 4848, scale: float = 1.0, extra_sources: list | None = None) -> dict:
    model_id = model_cfg["model_id"]
    system_prompt = " ".join(model_cfg["system_prompt"].split())
    domains_cfg = model_cfg["dataset"].get("domains", "all")
    allow_domains = None if domains_cfg == "all" else set(domains_cfg)
    ratios = model_cfg["dataset"].get("ratios", {"eval": 0.08, "test": 0.08})
    max_per_domain = model_cfg["dataset"].get("max_per_domain", 20000)

    raw = authored.generate() + generators.generate(seed=seed, scale=scale)
    for src in (extra_sources or []):
        raw += list(src)

    all_domains = {r.get("domain") for r in raw} | set(CORE_DOMAINS) | {"instruction_following", "structured_output", "media_planning", "cybersecurity",
                   "general_knowledge", "writing", "islamic_studies", "pakistan", "roman_urdu", "research", "summarization", "business",
                   "productivity", "daily_tasks", "reasoning", "structured_responses", "malformed_input", "hallucination_resistance"}

    rejected = Counter()
    rejected_samples: list = []
    stats = Counter()

    def reject(reason: str, r: dict):
        rejected[reason.split(":")[0]] += 1
        if len(rejected_samples) < 60:
            rejected_samples.append({"reason": reason, "domain": r.get("domain"), "prompt": dv.user_text(r)[:120] if isinstance(r.get("messages"), list) else None})

    held_out = eval_suite.held_out_prompt_keys(norm)
    exact_seen: set = set()
    near = dv.NearDupIndex(threshold=model_cfg.get("dataset", {}).get("near_dup_threshold", 0.85))
    kept: list = []

    for r in raw:
        stats["read"] += 1
        err = dv.check_schema(r, all_domains)
        if err:
            reject(err, r)
            continue
        if allow_domains is not None and r["domain"] not in allow_domains:
            reject("domain: not in this model's scope", r)
            continue
        # PII / secret scrub on every turn
        pii = 0
        for m in r["messages"]:
            m["content"], n = scrub(m["content"])
            pii += n
        if pii:
            stats["pii_redactions"] += pii
            stats["records_with_pii_redacted"] += 1
        err = dv.check_record(r, system_prompt)
        if err:
            reject(err, r)
            continue
        pk = record_prompt_key(r["messages"])
        if pk in held_out:
            reject("leakage: matches the held-out evaluation suite", r)
            continue
        if pk in exact_seen:
            reject("duplicate: exact", r)
            continue
        cid, sig = near.find(dv.user_text(r) + " || " + dv.answer_text(r))
        if cid is not None:
            reject("duplicate: near", r)
            continue
        exact_seen.add(pk)
        near.add(sig, pk)
        r["language"] = r.get("language") or dv.detect_language(dv.user_text(r) + " " + dv.answer_text(r))
        kept.append(r)

    # contradictions across the surviving corpus
    contra = dv.find_contradictions(kept)
    if contra:
        for i in sorted(contra):
            reject("contradiction: conflicting answers for the same question", kept[i])
        kept = [r for i, r in enumerate(kept) if i not in contra]

    # domain balancing (deterministic)
    import random
    rng = random.Random(seed)
    by_domain = defaultdict(list)
    for r in kept:
        by_domain[r["domain"]].append(r)
    balanced = []
    for d in sorted(by_domain):
        items = by_domain[d]
        rng.shuffle(items)
        balanced.extend(items[:max_per_domain])
    rng.shuffle(balanced)

    # deterministic train / eval / test split (TEST stays unseen by training AND by the eval checkpointing)
    n = len(balanced)
    n_test = int(n * ratios.get("test", 0.08))
    n_eval = int(n * ratios.get("eval", 0.08))
    test_set = balanced[:n_test]
    eval_set = balanced[n_test:n_test + n_eval]
    train_set = balanced[n_test + n_eval:]

    # cross-split leakage guard (defensive: prompts must not repeat across splits)
    seen_keys: set = set()
    leak = 0
    for split in (test_set, eval_set, train_set):
        for r in split:
            k = record_prompt_key(r["messages"])
            if k in seen_keys:
                leak += 1
            seen_keys.add(k)

    def with_system(r: dict) -> dict:
        msgs = [m for m in r["messages"] if m["role"] != "system"]
        return {"domain": r["domain"], "language": r["language"], "category": r.get("category"), "synthetic": r.get("synthetic", False),
                "messages": [{"role": "system", "content": system_prompt}] + msgs}

    out_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, rows in (("train.jsonl", train_set), ("eval.jsonl", eval_set), ("test.jsonl", test_set)):
        p = out_dir / name
        p.write_text("".join(json.dumps(with_system(x), ensure_ascii=False, sort_keys=True) + "\n" for x in rows), encoding="utf-8")
        files[name] = {"records": len(rows), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}

    domain_counts = dict(sorted(Counter(r["domain"] for r in balanced).items()))
    language_counts = dict(sorted(Counter(r["language"] for r in balanced).items()))
    category_counts = dict(sorted(Counter(r.get("category") for r in balanced).items()))
    synthetic = sum(1 for r in balanced if r.get("synthetic"))
    synthetic_fraction = round(synthetic / n, 4) if n else 0
    reviewed = sum(1 for r in balanced if r.get("synthetic") is False and r.get("human_reviewed"))

    reasons = []
    if n < PRODUCTION_MIN_TOTAL:
        reasons.append(f"only {n} records (production needs >= {PRODUCTION_MIN_TOTAL})")
    thin = [d for d in CORE_DOMAINS if domain_counts.get(d, 0) < PRODUCTION_MIN_PER_CORE_DOMAIN and (allow_domains is None or d in allow_domains)]
    if thin:
        reasons.append(f"core domains below {PRODUCTION_MIN_PER_CORE_DOMAIN}: {', '.join(thin)}")
    if synthetic_fraction > PRODUCTION_MAX_SYNTHETIC_FRACTION:
        reasons.append(f"{int(synthetic_fraction * 100)}% of records are template-generated (max {int(PRODUCTION_MAX_SYNTHETIC_FRACTION * 100)}%)")
    missing_langs = PRODUCTION_MIN_LANGUAGES - set(language_counts)
    if missing_langs:
        reasons.append(f"missing languages: {', '.join(sorted(missing_langs))}")
    authored_unreviewed = sum(1 for r in balanced if r.get("synthetic") is False and not r.get("human_reviewed"))
    if authored_unreviewed:
        reasons.append(f"{authored_unreviewed} authored records are not yet human-reviewed")
    if leak:
        reasons.append(f"cross-split prompt leakage: {leak}")

    manifest = {
        "dataset_version": f"{model_cfg['dataset'].get('version_prefix', model_id)}-{BUILDER_VERSION}",
        "builder_version": BUILDER_VERSION,
        "target_model": model_id,
        "system_prompt": system_prompt,
        "build_parameters": {"seed": seed, "scale": scale, "ratios": ratios, "max_per_domain": max_per_domain,
                             "near_dup_threshold": near.threshold},
        "quality_gates": ["schema", "empty", "unicode", "formatting", "foreign_identity", "prompt_leakage",
                          "prompt_injection_contamination", "harmful_target", "time_sensitive", "repetition", "nonsensical",
                          "exact_dedupe", "near_dedupe_minhash_lsh_number_aware", "contradiction", "eval_suite_holdout",
                          "domain_balance", "deterministic_train_eval_test_split", "cross_split_leakage_check"],
        "counts": {"read": stats["read"], "kept": n, "train": len(train_set), "eval": len(eval_set), "test": len(test_set),
                   "synthetic": synthetic, "authored": n - synthetic, "authored_human_reviewed": reviewed},
        "synthetic_fraction": synthetic_fraction,
        "stats": dict(stats),
        "rejected": dict(rejected),
        "rejected_total": sum(rejected.values()),
        "rejected_samples": rejected_samples,
        "domain_counts": domain_counts,
        "language_counts": language_counts,
        "category_counts": category_counts,
        "cross_split_leakage": leak,
        "held_out_eval_suite_items": len(held_out),
        "files": files,
        "production_ready": not reasons,
        "production_readiness_notes": reasons or ["meets configured thresholds"],
    }
    manifest["content_fingerprint_sha256"] = hashlib.sha256(json.dumps(
        {"files": files, "build_parameters": manifest["build_parameters"], "system_prompt": system_prompt, "builder": BUILDER_VERSION},
        sort_keys=True).encode()).hexdigest()
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _load_model_cfg(path: Path) -> dict:
    import yaml
    return yaml.safe_load(path.read_text())


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Build a per-model SFT dataset with quality gates and train/eval/test split.")
    ap.add_argument("--model-config", required=True, help="training/models/<model>.yaml")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=4848)
    ap.add_argument("--scale", type=float, default=1.0, help="multiply generator volume (smoke builds use a small value)")
    a = ap.parse_args(argv)
    m = build(Path(a.out), _load_model_cfg(Path(a.model_config)), seed=a.seed, scale=a.scale)
    print(json.dumps({k: m[k] for k in ("dataset_version", "counts", "rejected", "domain_counts", "language_counts",
                                        "synthetic_fraction", "cross_split_leakage", "production_ready", "production_readiness_notes",
                                        "content_fingerprint_sha256")}, ensure_ascii=False, indent=2))
    if not m["production_ready"]:
        print("NOTE: dataset is NOT production-ready: " + "; ".join(m["production_readiness_notes"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
