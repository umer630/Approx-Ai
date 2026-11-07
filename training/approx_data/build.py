"""Build the Nick 4.8 SFT dataset.

Pipeline (spec §31–33):
  sources (seed JSONL + approved Kaggle/HF datasets listed in configs/dataset_sources.yaml)
  → schema validation → language/domain tagging → PII scrubbing → quality filter
  → exact + near-duplicate filter → domain balancing → train/eval split
  → provenance manifest with per-source license + SHA-256 of every output file.

Only sources whose `approved: true` (license reviewed, quality inspected) are ingested.
Usage:
  python -m approx_data.build --out data/processed --version nick-sft-0.1.0
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
from datetime import datetime, timezone
from pathlib import Path

from .pii import scrub

ROOT = Path(__file__).resolve().parents[1]
DOMAINS = [
    "general_knowledge", "reasoning", "mathematics", "coding", "science", "education", "research", "writing",
    "summarization", "english", "urdu", "roman_urdu", "pakistan", "islamic_studies", "business", "cybersecurity",
    "productivity", "daily_tasks",
]
URDU_CHARS = re.compile(r"[؀-ۿ]")
ROMAN_URDU = re.compile(r"\b(kya|hai|hain|kaise|mujhe|aap|nahi|kyun|batao|karein|kar|ka|ki|ke|mein|se|ko)\b", re.I)
HARMFUL = re.compile(r"\b(ransomware|keylogger|credential stealer|make a bomb|nerve agent)\b", re.I)


def detect_language(text: str) -> str:
    if URDU_CHARS.search(text):
        return "ur"
    if len(ROMAN_URDU.findall(text)) >= 2:
        return "roman-ur"
    return "en"


def validate_record(r: dict) -> str | None:
    msgs = r.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        return "messages must be a list with >= 2 turns"
    for m in msgs:
        if m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str):
            return "bad message shape"
    if msgs[-1]["role"] != "assistant":
        return "last turn must be assistant"
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
    """Reads the YAML-lite source registry (JSON subset of YAML to avoid a PyYAML dependency)."""
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    return data["sources"]


def iter_source(src: dict):
    path = ROOT / src["path"]
    if not path.exists():
        return
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            yield line_no, json.loads(line)


def build(out_dir: Path, version: str, sources_cfg: Path, eval_ratio: float, seed: int, max_per_domain: int) -> dict:
    random.seed(seed)
    sources = load_sources(sources_cfg)
    stats = Counter()
    rejected = Counter()
    records, seen, shingle_index = [], set(), []
    provenance = []
    for src in sources:
        if not src.get("approved"):
            provenance.append({**src, "ingested": 0, "note": "skipped: not approved (license/quality review pending)"})
            continue
        n_in = 0
        for line_no, r in iter_source(src):
            stats["read"] += 1
            err = validate_record(r)
            if err:
                rejected[f"schema: {err}"] += 1
                continue
            pii_total = 0
            for m in r["messages"]:
                m["content"], n = scrub(m["content"])
                pii_total += n
            stats["pii_redactions"] += pii_total
            err = quality_ok(r)
            if err:
                rejected[f"quality: {err}"] += 1
                continue
            key = norm_key(r)
            if key in seen:
                rejected["duplicate: exact"] += 1
                continue
            sh = shingles(" ".join(m["content"] for m in r["messages"] if m["role"] == "user"))
            if any(len(sh & o) / max(1, len(sh | o)) > 0.85 for o in shingle_index):
                rejected["duplicate: near"] += 1
                continue
            seen.add(key)
            shingle_index.append(sh)
            r["language"] = r.get("language") or detect_language(" ".join(m["content"] for m in r["messages"]))
            r["source"] = src["id"]
            r["license"] = src["license"]
            records.append(r)
            n_in += 1
        provenance.append({**src, "ingested": n_in})

    # domain balancing
    by_domain = defaultdict(list)
    for r in records:
        by_domain[r["domain"]].append(r)
    balanced = []
    for d in DOMAINS:
        items = by_domain.get(d, [])
        random.shuffle(items)
        balanced.extend(items[:max_per_domain])
    random.shuffle(balanced)
    n_eval = max(1, int(len(balanced) * eval_ratio)) if len(balanced) > 10 else 0
    eval_set, train_set = balanced[:n_eval], balanced[n_eval:]

    out_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, rows in (("train.jsonl", train_set), ("eval.jsonl", eval_set)):
        p = out_dir / name
        p.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows), encoding="utf-8")
        files[name] = {"records": len(rows), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}

    manifest = {
        "dataset_version": version,
        "target_model": "nick-4.8",
        "base_model": "Qwen/Qwen2.5-3B-Instruct",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "pipeline": ["approved_sources_only", "schema_validation", "pii_scrub", "quality_filter", "exact_dedupe", "near_dedupe(jaccard>0.85)", "domain_balance", "train_eval_split"],
        "stats": dict(stats),
        "rejected": dict(rejected),
        "domain_counts": {d: sum(1 for r in balanced if r["domain"] == d) for d in DOMAINS},
        "missing_domains": [d for d in DOMAINS if not by_domain.get(d)],
        "language_counts": dict(Counter(r["language"] for r in balanced)),
        "files": files,
        "provenance": provenance,
        "user_history_included": False,
        "fab_data_included": False,
    }
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
    print(json.dumps({k: m[k] for k in ("dataset_version", "stats", "rejected", "files", "missing_domains", "language_counts")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
