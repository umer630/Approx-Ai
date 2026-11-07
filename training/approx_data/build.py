"""Build the Nick 4.8 SFT dataset — reproducibly, with provenance.

Pipeline (spec §31–33):
  approved sources only (license + provenance required)
  → malformed-line detection (bad JSON / bad schema)          → rejected, counted, sampled
  → PII / secret scrubbing
  → quality filter (length, boilerplate, harmful targets, time-sensitive facts)
  → exact + near-duplicate filter (Jaccard over char 5-gram shingles > 0.85)
  → domain balancing → deterministic train/eval split (seeded)
  → manifest.json: per-source SHA-256 + license, build parameters, rejection reasons,
    domain/language coverage, output SHA-256s, and an explicit production-readiness verdict.

Same inputs + same parameters ⇒ byte-identical train.jsonl / eval.jsonl (verified by tests).

Usage:  python -m approx_data.build --out data/processed --version nick-sft-0.1.0
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from .pii import scrub

ROOT = Path(__file__).resolve().parents[1]
BUILDER_VERSION = "1.1.0"
DOMAINS = [
    "general_knowledge", "reasoning", "mathematics", "coding", "science", "education", "research", "writing",
    "summarization", "english", "urdu", "roman_urdu", "pakistan", "islamic_studies", "business", "cybersecurity",
    "productivity", "daily_tasks",
]
# Minimum examples per domain before a dataset is called production-ready. The seed set does not meet this.
PRODUCTION_MIN_PER_DOMAIN = 500
PRODUCTION_MIN_TOTAL = 20000

URDU_CHARS = re.compile(r"[؀-ۿ]")
ROMAN_URDU = re.compile(r"\b(kya|hai|hain|kaise|mujhe|aap|nahi|kyun|batao|karein|kar|ka|ki|ke|mein|se|ko)\b", re.I)
HARMFUL = re.compile(r"\b(ransomware|keylogger|credential stealer|make a bomb|nerve agent)\b", re.I)
# Changing-world facts belong in Approx Research (retrieval), not in weights.
TIME_SENSITIVE = re.compile(
    r"\b(as of (19|20)\d\d|currently|current (prime minister|president|ceo|price|rate|champion)|latest (version|news|price)|"
    r"this year|today'?s (price|rate|news)|stock price|exchange rate|breaking news)\b", re.I)


def detect_language(text: str) -> str:
    if URDU_CHARS.search(text):
        return "ur"
    if len(ROMAN_URDU.findall(text)) >= 2:
        return "roman-ur"
    return "en"


def validate_record(r) -> str | None:
    if not isinstance(r, dict):
        return "record is not an object"
    msgs = r.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        return "messages must be a list with >= 2 turns"
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str):
            return "bad message shape"
    if msgs[-1]["role"] != "assistant":
        return "last turn must be assistant"
    if not any(m["role"] == "user" for m in msgs):
        return "no user turn"
    if r.get("domain") not in DOMAINS:
        return f"unknown domain {r.get('domain')!r}"
    return None


def quality_ok(r: dict) -> str | None:
    user = " ".join(m["content"] for m in r["messages"] if m["role"] == "user")
    asst = r["messages"][-1]["content"]
    if len(user.strip()) < 4 or len(asst.strip()) < 8:
        return "too short"
    if len(asst) > 12000:
        return "too long"
    if HARMFUL.search(asst):
        return "harmful content in target"
    if asst.strip().lower().startswith(("as an ai language model", "i am chatgpt", "i'm claude")):
        return "foreign identity / boilerplate"
    if TIME_SENSITIVE.search(user) or TIME_SENSITIVE.search(asst):
        return "time-sensitive fact (use retrieval, not weights)"
    return None


def norm_key(r: dict) -> str:
    text = " ".join(m["content"] for m in r["messages"] if m["role"] == "user")
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"[^\w؀-ۿ]+", " ", text).strip()
    return hashlib.sha256(text.encode()).hexdigest()


def shingles(text: str, k: int = 5) -> set[str]:
    t = re.sub(r"\s+", " ", text.lower())
    return {t[i:i + k] for i in range(max(1, len(t) - k + 1))}


def load_sources(cfg_path: Path) -> list[dict]:
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    return data["sources"]


def source_path(src: dict) -> Path:
    p = Path(src["path"])
    return p if p.is_absolute() else ROOT / p


def iter_source(path: Path):
    """Yields (line_no, record_or_None, error). Malformed lines are reported, never crash the build."""
    for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            yield line_no, json.loads(line), None
        except json.JSONDecodeError as e:
            yield line_no, None, f"invalid JSON ({e.msg})"


def build(out_dir: Path, version: str, sources_cfg: Path, eval_ratio: float, seed: int, max_per_domain: int) -> dict:
    rng = random.Random(seed)
    sources = load_sources(sources_cfg)
    stats = Counter()
    rejected = Counter()
    rejected_samples: list[dict] = []
    records, seen, shingle_index = [], set(), []
    provenance = []

    def reject(reason: str, src_id: str, line_no: int):
        rejected[reason] += 1
        if len(rejected_samples) < 50:
            rejected_samples.append({"source": src_id, "line": line_no, "reason": reason})

    for src in sources:
        entry = {k: v for k, v in src.items()}
        path = source_path(src)
        if not src.get("approved"):
            provenance.append({**entry, "ingested": 0, "status": "skipped: not approved (license/quality review pending)"})
            continue
        if not src.get("license") or "UNKNOWN" in str(src.get("license")).upper():
            provenance.append({**entry, "ingested": 0, "status": "skipped: approved source without a verified license"})
            continue
        if not path.exists():
            provenance.append({**entry, "ingested": 0, "status": "skipped: file not present"})
            continue
        entry["file_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        n_in = 0
        for line_no, r, err in iter_source(path):
            stats["read"] += 1
            if err:
                reject(f"malformed: {err}", src["id"], line_no)
                continue
            err = validate_record(r)
            if err:
                reject(f"malformed: {err}", src["id"], line_no)
                continue
            pii_total = 0
            for m in r["messages"]:
                m["content"], n = scrub(m["content"])
                pii_total += n
            stats["pii_redactions"] += pii_total
            if pii_total:
                stats["records_with_pii_redacted"] += 1
            err = quality_ok(r)
            if err:
                reject(f"quality: {err}", src["id"], line_no)
                continue
            key = norm_key(r)
            if key in seen:
                reject("duplicate: exact", src["id"], line_no)
                continue
            sh = shingles(" ".join(m["content"] for m in r["messages"] if m["role"] == "user"))
            if any(len(sh & o) / max(1, len(sh | o)) > 0.85 for o in shingle_index):
                reject("duplicate: near", src["id"], line_no)
                continue
            seen.add(key)
            shingle_index.append(sh)
            r["language"] = r.get("language") or detect_language(" ".join(m["content"] for m in r["messages"]))
            r["source"] = src["id"]
            r["license"] = src["license"]
            records.append(r)
            n_in += 1
        provenance.append({**entry, "ingested": n_in, "status": "ingested"})

    # domain balancing (deterministic)
    by_domain = defaultdict(list)
    for r in records:
        by_domain[r["domain"]].append(r)
    balanced = []
    for d in DOMAINS:
        items = by_domain.get(d, [])
        rng.shuffle(items)
        balanced.extend(items[:max_per_domain])
    rng.shuffle(balanced)
    n_eval = max(1, int(len(balanced) * eval_ratio)) if len(balanced) > 10 else 0
    eval_set, train_set = balanced[:n_eval], balanced[n_eval:]

    out_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, rows in (("train.jsonl", train_set), ("eval.jsonl", eval_set)):
        p = out_dir / name
        p.write_text("".join(json.dumps(x, ensure_ascii=False, sort_keys=True) + "\n" for x in rows), encoding="utf-8")
        files[name] = {"records": len(rows), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}

    domain_counts = {d: sum(1 for r in balanced if r["domain"] == d) for d in DOMAINS}
    reasons = []
    if len(balanced) < PRODUCTION_MIN_TOTAL:
        reasons.append(f"only {len(balanced)} records (< {PRODUCTION_MIN_TOTAL})")
    thin = [d for d, c in domain_counts.items() if c < PRODUCTION_MIN_PER_DOMAIN]
    if thin:
        reasons.append(f"{len(thin)} domains below {PRODUCTION_MIN_PER_DOMAIN} examples")

    manifest = {
        "dataset_version": version,
        "builder_version": BUILDER_VERSION,
        "target_model": "nick-4.8",
        "base_model": "Qwen/Qwen2.5-3B-Instruct",
        "build_parameters": {"seed": seed, "eval_ratio": eval_ratio, "max_per_domain": max_per_domain, "near_dup_threshold": 0.85},
        "pipeline": ["approved_licensed_sources_only", "malformed_detection", "schema_validation", "pii_scrub", "quality_filter",
                     "time_sensitive_filter", "exact_dedupe", "near_dedupe(jaccard>0.85)", "domain_balance", "seeded_train_eval_split"],
        "stats": dict(stats),
        "rejected": dict(rejected),
        "rejected_samples": rejected_samples,
        "domain_counts": domain_counts,
        "missing_domains": [d for d in DOMAINS if not by_domain.get(d)],
        "language_counts": dict(sorted(Counter(r["language"] for r in balanced).items())),
        "files": files,
        "provenance": provenance,
        "user_history_included": any(p["id"] == "consented-history" and p.get("ingested") for p in provenance),
        "fab_data_included": False,
        "production_ready": not reasons,
        "production_readiness_notes": reasons or ["meets minimum size thresholds"],
    }
    # reproducibility fingerprint: output hashes + build parameters + input file hashes
    manifest["content_fingerprint_sha256"] = hashlib.sha256(
        json.dumps({"files": files, "build_parameters": manifest["build_parameters"], "sources": [(p["id"], p.get("file_sha256")) for p in provenance]},
                   sort_keys=True).encode()).hexdigest()
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data/processed"))
    ap.add_argument("--version", default="nick-sft-0.1.0")
    ap.add_argument("--sources", default=str(ROOT / "configs/dataset_sources.json"))
    ap.add_argument("--eval-ratio", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=4848)
    ap.add_argument("--max-per-domain", type=int, default=20000)
    a = ap.parse_args(argv)
    m = build(Path(a.out), a.version, Path(a.sources), a.eval_ratio, a.seed, a.max_per_domain)
    print(json.dumps({k: m[k] for k in ("dataset_version", "stats", "rejected", "files", "missing_domains", "language_counts",
                                        "production_ready", "production_readiness_notes", "content_fingerprint_sha256")}, ensure_ascii=False, indent=2))
    if not m["production_ready"]:
        print("NOTE: this dataset is NOT production-quality: " + "; ".join(m["production_readiness_notes"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
