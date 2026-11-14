"""Human review workflow: sheets → people fill them in → validated import → ledger → progress report.

Only this module writes the review ledger (datasets/reviews/<model>.jsonl), and the pipeline only marks a record
`human_reviewed` when the ledger holds an ACCEPT for that record's current content from a named human reviewer.
Automatic checks (unit tests, answer matching, community ranking) are separate review states and never count here.
"""
from __future__ import annotations

import csv
import hashlib
import json
import random
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

from . import pipeline

REVIEWS = pipeline.REVIEWS
SHEETS = REVIEWS / "sheets"                  # gitignored: sheets contain dataset text
COLUMNS = ["sheet_id", "row", "record_id", "content_hash", "model", "lang", "domain", "source", "origin", "prompt", "answer",
           "reviewer", "verdict", "issue_tags", "notes"]
VERDICTS = {"accept", "reject"}
ISSUE_TAGS = {"incorrect", "unsafe", "low_quality", "wrong_language", "pii", "formatting", "incomplete", "license", "other"}
REVIEWER_RX = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{1,39}$")
# Names that identify a program rather than a person: imports using them are refused.
NON_HUMAN = re.compile(r"(^|[._-])(auto|automatic|bot|claude|gpt|chatgpt|llm|ai|model|machine|system|script|pipeline|test|unknown|n/?a|none)($|[._-])", re.I)


def content_hash(messages: list) -> str:
    """Hash of the reviewed conversation (system prompts are model packaging, not reviewed content)."""
    turns = [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] != "system"]
    return hashlib.sha256(json.dumps(turns, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:32]


def _build_rows(model: str) -> list:
    d = pipeline.DATASETS / model / "build"
    rows = []
    for split in ("train", "eval", "test"):
        p = d / f"{split}.jsonl"
        if not p.exists():
            raise FileNotFoundError(f"{p} missing — run `python -m datahub build --models {model}` first")
        for line in p.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            r["split"] = split
            rows.append(r)
    return rows


def _turns(r: dict) -> tuple[str, str]:
    msgs = [m for m in r["messages"] if m["role"] != "system"]
    prompt = "\n\n".join(f"[{m['role']}] {m['content']}" for m in msgs[:-1])
    return prompt, msgs[-1]["content"]


def load_ledger(review_dir: Path | None = None) -> dict:
    """record_id → decision. A record with any human REJECT is rejected; otherwise accepted if a human accepted it."""
    d = Path(review_dir or REVIEWS)
    by_rec = defaultdict(list)
    if d.exists():
        for f in sorted(d.glob("*.jsonl")):
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                e = json.loads(line)
                if e.get("verdict") in VERDICTS and e.get("reviewer") and not NON_HUMAN.search(e["reviewer"]):
                    by_rec[e["record_id"]].append(e)
    out = {}
    for rid, es in by_rec.items():
        rej = [e for e in es if e["verdict"] == "reject"]
        pick = rej[0] if rej else es[0]
        out[rid] = {**pick, "reviewers": sorted({e["reviewer"] for e in es}), "decisions": len(es)}
    return out


def make_sheets(model: str, n: int | None = None, batch: int = 100, out_dir: Path | None = None, seed: str = "") -> list[Path]:
    """Stratified (language × domain) sample of the model's dataset that has no human decision yet, split into CSV batches.
    n defaults to the remaining requirement (+10 % for rejections)."""
    prof = pipeline.load_profile(model)
    ledger = load_ledger()
    rows = [r for r in _build_rows(model) if r["id"] not in ledger]
    done = sum(1 for r in _build_rows(model) if ledger.get(r["id"], {}).get("verdict") == "accept")
    need = max(0, prof.get("min_human_reviewed", 0) - done)
    n = n if n is not None else math_ceil(need * 1.1)
    if n <= 0:
        return []
    strata = defaultdict(list)
    for r in sorted(rows, key=lambda r: r["id"]):
        strata[(r["lang"], r["domain"])].append(r)
    rnd = random.Random(f"review:{model}:{seed}")
    for v in strata.values():
        rnd.shuffle(v)
    picked, keys = [], sorted(strata)
    while len(picked) < n and keys:                       # round-robin over strata → every language/domain gets coverage
        nxt = []
        for k in keys:
            if strata[k] and len(picked) < n:
                picked.append(strata[k].pop())
            if strata[k]:
                nxt.append(k)
        keys = nxt
    out_dir = Path(out_dir or SHEETS / model)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    paths = []
    for b in range(0, len(picked), batch):
        chunk = picked[b: b + batch]
        sid = f"{model}-{stamp}-{b // batch + 1:03d}"
        p = out_dir / f"{sid}.csv"
        with open(p, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=COLUMNS)
            w.writeheader()
            for k, r in enumerate(chunk, 1):
                prompt, answer = _turns(r)
                w.writerow({"sheet_id": sid, "row": k, "record_id": r["id"], "content_hash": content_hash(r["messages"]), "model": model,
                            "lang": r["lang"], "domain": r["domain"], "source": r["source"], "origin": r["origin"], "prompt": prompt,
                            "answer": answer, "reviewer": "", "verdict": "", "issue_tags": "", "notes": ""})
        meta = {"sheet_id": sid, "model": model, "created_at": stamp, "rows": len(chunk),
                "records": {r["id"]: content_hash(r["messages"]) for r in chunk}}
        (out_dir / f"{sid}.meta.json").write_text(json.dumps(meta, indent=1))
        paths.append(p)
    return paths


def math_ceil(x: float) -> int:
    return int(-(-x // 1))


def import_sheet(csv_path: Path, model: str, *, sheets_dir: Path | None = None, review_dir: Path | None = None) -> dict:
    """Validate a completed sheet and append its decisions to the ledger. Returns a report; raises on structural errors."""
    csv_path = Path(csv_path)
    raw = csv_path.read_bytes()
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        rd = csv.DictReader(fh)
        missing = [c for c in ("sheet_id", "record_id", "content_hash", "reviewer", "verdict") if c not in (rd.fieldnames or [])]
        if missing:
            raise ValueError(f"{csv_path.name}: missing columns {missing}")
        rows = list(rd)
    sids = {r["sheet_id"] for r in rows}
    if len(sids) != 1:
        raise ValueError(f"{csv_path.name}: expected exactly one sheet_id, found {sorted(sids)}")
    sid = sids.pop()
    meta_p = Path(sheets_dir or SHEETS / model) / f"{sid}.meta.json"
    if not meta_p.exists():
        raise ValueError(f"unknown sheet {sid}: {meta_p} not found (sheets must be issued by `datahub review-sheet`)")
    meta = json.loads(meta_p.read_text())
    if meta["model"] != model:
        raise ValueError(f"sheet {sid} belongs to {meta['model']}, not {model}")
    ledger_dir = Path(review_dir or REVIEWS)
    ledger_dir.mkdir(parents=True, exist_ok=True)
    ledger_p = ledger_dir / f"{model}.jsonl"
    existing = set()
    if ledger_p.exists():
        for line in ledger_p.read_text(encoding="utf-8").splitlines():
            if line.strip():
                e = json.loads(line)
                existing.add((e["record_id"], e["reviewer"]))
    rep, out = Counter(), []
    errors = []
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    csv_sha = hashlib.sha256(raw).hexdigest()
    for i, r in enumerate(rows, 2):
        reviewer, verdict = (r.get("reviewer") or "").strip(), (r.get("verdict") or "").strip().lower()
        tags = sorted({t.strip().lower() for t in (r.get("issue_tags") or "").replace(";", ",").split(",") if t.strip()})
        notes = (r.get("notes") or "").strip()
        if not reviewer and not verdict:
            rep["blank_row_skipped"] += 1
            continue
        def bad(why):
            rep[f"refused:{why}"] += 1
            errors.append(f"line {i}: {why}")
        if r["record_id"] not in meta["records"]:
            bad("record not in this sheet"); continue
        if r.get("content_hash") != meta["records"][r["record_id"]]:
            bad("content_hash changed (sheet edited) — do not edit prompt/answer; reject with notes instead"); continue
        if not REVIEWER_RX.match(reviewer):
            bad("reviewer id must be 2-40 chars, letters/digits/._- , starting with a letter"); continue
        if NON_HUMAN.search(reviewer):
            bad("reviewer id looks like a program, not a person"); continue
        if verdict not in VERDICTS:
            bad(f"verdict must be accept or reject, got {verdict!r}"); continue
        if verdict == "reject" and not (tags or notes):
            bad("reject needs issue_tags or notes"); continue
        if set(tags) - ISSUE_TAGS:
            bad(f"unknown issue tags {sorted(set(tags) - ISSUE_TAGS)}"); continue
        if (r["record_id"], reviewer) in existing:
            rep["duplicate_skipped"] += 1
            continue
        existing.add((r["record_id"], reviewer))
        out.append({"record_id": r["record_id"], "model": model, "sheet_id": sid, "reviewer": reviewer, "verdict": verdict,
                    "issue_tags": tags, "notes": notes, "content_hash": meta["records"][r["record_id"]], "imported_at": now,
                    "csv_sha256": csv_sha})
        rep[f"imported:{verdict}"] += 1
    with open(ledger_p, "a", encoding="utf-8") as f:
        for e in out:
            f.write(json.dumps(e, ensure_ascii=False, sort_keys=True) + "\n")
    return {"sheet_id": sid, "ledger": str(ledger_p), "counts": dict(rep), "errors": errors[:50]}


def progress(models: list[str]) -> dict:
    """Per-model review progress against the profile requirement, computed from the ledger and the current build."""
    ledger = load_ledger()
    out = {}
    for m in models:
        prof = pipeline.load_profile(m)
        req = prof.get("min_human_reviewed", 0)
        try:
            ids = {r["id"]: r for r in _build_rows(m)}
        except FileNotFoundError:
            ids = {}
        acc = [rid for rid in ids if ledger.get(rid, {}).get("verdict") == "accept"]
        rej = [rid for rid, e in ledger.items() if e["verdict"] == "reject" and e.get("model") == m]
        sheets = sorted((SHEETS / m).glob("*.meta.json")) if (SHEETS / m).exists() else []
        issued = sum(json.loads(p.read_text())["rows"] for p in sheets)
        decided_ids = {rid for p in sheets for rid in json.loads(p.read_text())["records"] if rid in ledger}
        by_lang = Counter(ids[r]["lang"] for r in acc)
        out[m] = {"required": req, "accepted_in_dataset": len(acc), "rejected": len(rej), "remaining": max(0, req - len(acc)),
                  "sheets_issued": len(sheets), "rows_issued": issued, "rows_decided": len(decided_ids),
                  "rows_pending": issued - len(decided_ids), "accepted_by_language": dict(by_lang),
                  "reviewers": sorted({rv for rid in acc for rv in ledger[rid]["reviewers"]}), "gate_passed": len(acc) >= req}
    return out


def write_progress_report(models: list[str], path: Path) -> dict:
    prog = progress(models)
    lines = ["# Human review progress", "", "Computed by `python -m datahub review-progress` from `datasets/reviews/*.jsonl` (the ledger) and the current builds.",
             "Only named human reviewers count. Automatic checks (unit tests, answer matching, OASST community ranking) are tracked separately and are **not** human review.", "",
             "| Model | Required | Accepted in dataset | Rejected | Remaining | Sheets issued | Rows issued | Rows decided | Rows pending | Gate |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for m, p in prog.items():
        lines.append(f"| {m} | {p['required']:,} | {p['accepted_in_dataset']:,} | {p['rejected']:,} | {p['remaining']:,} | {p['sheets_issued']} | "
                     f"{p['rows_issued']:,} | {p['rows_decided']:,} | {p['rows_pending']:,} | {'PASS' if p['gate_passed'] else 'FAIL'} |")
    path.write_text("\n".join(lines) + "\n")
    path.with_suffix(".json").write_text(json.dumps(prog, indent=1))
    return prog
