"""Source connectors: fetch approved sources (with SHA-256 + timestamp provenance) and map rows to raw records.

A raw record: {"messages": [...], "lang_declared": str|None, "domain_hint": str|None, "source_record_id": str,
               "category": str|None, "meta": {...}}
Nothing here invents content: every record comes from the registered source's own rows (or, for the curriculum,
from its deterministic generators). Missing sources raise MissingSource with the exact path/URL.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get("APPROX_DATA_CACHE", TRAINING / "datasets" / ".cache"))
HF = "https://huggingface.co"


class MissingSource(Exception):
    """An approved source whose data cannot be found or fetched."""


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "approx-datahub/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "approx-datahub/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)


def fetch_hf(src: dict, offline: bool = False) -> list[dict]:
    """Download (or reuse cached) parquet files for an HF source. Returns provenance entries per file."""
    conn = src["connector"]
    configs = conn.get("configs") or [conn["config"]]
    out = []
    for cfg in configs:
        for split in conn["splits"]:
            d = CACHE / src["id"] / cfg / split
            cached = sorted(d.glob("*.parquet")) if d.exists() else []
            meta_f = d / "_provenance.json"
            if cached and meta_f.exists():
                out.extend(json.loads(meta_f.read_text()))
                continue
            if offline:
                raise MissingSource(f"{src['id']}: {cfg}/{split} not cached at {d} (offline mode)")
            try:
                urls = _get_json(f"{HF}/api/datasets/{src['hub_repo']}/parquet/{cfg}/{split}")
            except Exception as e:  # noqa: BLE001
                raise MissingSource(f"{src['id']}: cannot list parquet files for {cfg}/{split}: {e}") from e
            entries = []
            for i, u in enumerate(urls):
                f = d / f"{split}-{i:04d}.parquet"
                _download(u, f)
                entries.append({"file": str(f.relative_to(CACHE)), "url": u, "sha256": sha256_file(f), "bytes": f.stat().st_size,
                                "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "config": cfg, "split": split,
                                "source_revision": src.get("revision")})
            meta_f.write_text(json.dumps(entries, indent=1))
            out.extend(entries)
    return out


def iter_parquet_rows(entries: list[dict]):
    import pyarrow.parquet as pq
    for e in entries:
        t = pq.read_table(CACHE / e["file"])
        for i, row in enumerate(t.to_pylist()):
            yield e, i, row


# ---------------------------------------------------------------- mappers (rows → raw records)
ISO3 = {"eng": "en", "urd": "ur", "arb": "ar", "ara": "ar", "zho": "zh", "cmn": "zh", "spa": "es", "fra": "fr", "deu": "de", "por": "pt", "rus": "ru",
        "jpn": "ja", "kor": "ko", "hin": "hi", "ben": "bn", "tur": "tr", "ind": "id", "pes": "fa", "fas": "fa", "ita": "it", "nld": "nl", "pol": "pl",
        "vie": "vi", "swh": "sw", "swa": "sw", "tha": "th", "heb": "he", "ell": "el", "ukr": "uk", "tam": "ta", "tel": "te", "pan": "pa", "guj": "gu",
        "amh": "am", "mar": "mr", "npi": "ne", "zsm": "ms", "tgl": "tl", "fil": "tl"}


def _msgs(user: str, assistant: str) -> list:
    return [{"role": "user", "content": user.strip()}, {"role": "assistant", "content": assistant.strip()}]


def map_oasst1(rows):
    """Best-ranked assistant reply to each human prompt (crowd-ranked), human-reviewed by the OA community flow."""
    by_id, children = {}, {}
    for e, i, r in rows:
        if r.get("deleted") or r.get("review_result") is False or r.get("synthetic"):
            continue
        by_id[r["message_id"]] = r
        if r.get("parent_id"):
            children.setdefault(r["parent_id"], []).append(r)
    for mid, m in by_id.items():
        if m["role"] != "prompter":
            continue
        replies = [c for c in children.get(mid, []) if c["role"] == "assistant" and c.get("rank") is not None]
        if not replies:
            continue
        best = min(replies, key=lambda c: c["rank"])
        if best["rank"] != 0:
            continue
        hist = []
        p = by_id.get(m.get("parent_id")) if m.get("parent_id") else None
        while p and len(hist) < 4:
            hist.insert(0, {"role": "user" if p["role"] == "prompter" else "assistant", "content": p["text"].strip()})
            p = by_id.get(p.get("parent_id")) if p.get("parent_id") else None
        if hist and hist[0]["role"] != "user":
            hist = []
        yield {"messages": hist + _msgs(m["text"], best["text"]), "lang_declared": m.get("lang"), "domain_hint": None,
               "source_record_id": best["message_id"], "meta": {"oasst_tree": m.get("message_tree_id")}}


DOLLY_DOMAIN = {"open_qa": "general_knowledge", "general_qa": "general_knowledge", "closed_qa": "research", "information_extraction": "research",
                "summarization": "writing", "brainstorming": "writing", "creative_writing": "writing", "classification": "reasoning"}


def map_dolly(rows):
    for e, i, r in rows:
        user = r["instruction"] + (f"\n\nContext:\n{r['context']}" if (r.get("context") or "").strip() else "")
        yield {"messages": _msgs(user, r["response"]), "lang_declared": "en", "domain_hint": DOLLY_DOMAIN.get(r.get("category")),
               "source_record_id": f"dolly-{e['split']}-{i}", "category": r.get("category")}


def map_gsm8k(rows):
    for e, i, r in rows:
        body, _, final = r["answer"].rpartition("####")
        body = re.sub(r"<<[^>]*>>", "", body).strip()
        yield {"messages": _msgs(r["question"], f"{body}\n\nAnswer: {final.strip()}"), "lang_declared": "en", "domain_hint": "mathematics",
               "source_record_id": f"gsm8k-{e['split']}-{i}", "category": "word_problem"}


def map_aya(rows):
    for e, i, r in rows:
        code = (r.get("language_code") or "").lower()
        yield {"messages": _msgs(r["inputs"], r["targets"]), "lang_declared": ISO3.get(code, code or None), "domain_hint": None,
               "source_record_id": f"aya-{e['split']}-{i}", "meta": {"annotation_type": r.get("annotation_type"), "language": r.get("language")}}


def map_arc(rows):
    for e, i, r in rows:
        ch = r["choices"]
        opts = "\n".join(f"{l}. {t}" for l, t in zip(ch["label"], ch["text"]))
        try:
            ans = ch["text"][ch["label"].index(r["answerKey"])]
        except ValueError:
            continue
        yield {"messages": _msgs(f"{r['question']}\n\n{opts}", f"The correct answer is {r['answerKey']}: {ans}."), "lang_declared": "en",
               "domain_hint": "science", "source_record_id": f"arc-{e['config']}-{e['split']}-{r['id']}", "category": "multiple_choice"}


def run_python_tests(code: str, tests: list[str], setup: str = "", timeout: float = 10.0) -> bool:
    """Execute a solution against its asserts in a separate, time-limited Python process (no network use expected)."""
    prog = "\n".join([setup or "", code, *tests]) + "\n"
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "t.py"
        p.write_text(prog)
        try:
            r = subprocess.run([sys.executable, "-I", str(p)], cwd=d, capture_output=True, timeout=timeout,
                               env={"PATH": os.environ.get("PATH", ""), "PYTHONHASHSEED": "0"})
        except subprocess.TimeoutExpired:
            return False
        return r.returncode == 0


def map_mbpp(rows, execute: bool = True):
    for e, i, r in rows:
        tests = list(r.get("test_list") or [])
        verified = run_python_tests(r["code"], tests, r.get("test_setup_code") or "") if execute else None
        if execute and not verified:
            continue
        user = f"{r['text']}\n\nYour code should pass these tests:\n" + "\n".join(tests)
        yield {"messages": _msgs(user, f"```python\n{r['code'].strip()}\n```"), "lang_declared": "en", "domain_hint": "coding",
               "source_record_id": f"mbpp-{e['split']}-{r['task_id']}", "category": "python_function", "meta": {"tests_executed": bool(execute), "tests_passed": verified}}


def map_scienceqa(rows):
    for e, i, r in rows:
        if r.get("image") is not None:
            continue
        ch = r.get("choices") or []
        if not ch or r.get("answer") is None or r["answer"] >= len(ch):
            continue
        opts = "\n".join(f"{chr(65 + k)}. {c}" for k, c in enumerate(ch))
        ctx = f"Context: {r['hint']}\n\n" if (r.get("hint") or "").strip() else ""
        expl = " ".join(x.strip() for x in (r.get("lecture") or "", r.get("solution") or "") if x and x.strip())
        ans = f"The answer is {chr(65 + r['answer'])}: {ch[r['answer']]}." + (f"\n\nExplanation: {expl}" if expl else "")
        yield {"messages": _msgs(f"{ctx}{r['question']}\n\n{opts}", ans), "lang_declared": "en", "domain_hint": "science",
               "source_record_id": f"scienceqa-{e['split']}-{i}", "category": r.get("subject")}


def map_self_oss(rows):
    for e, i, r in rows:
        yield {"messages": _msgs(r["instruction"], r["response"]), "lang_declared": "en", "domain_hint": "coding",
               "source_record_id": f"self-oss-{r.get('id', i)}", "category": "code_instruction"}


def map_humaneval(rows):
    for e, i, r in rows:
        yield {"messages": _msgs(r["prompt"], r["canonical_solution"]), "lang_declared": "en", "domain_hint": "coding",
               "source_record_id": f"humaneval-{r['task_id']}"}


def map_belebele(rows):
    for e, i, r in rows:
        opts = "\n".join(f"{k}. {r[f'mc_answer{k}']}" for k in range(1, 5))
        ans = r[f"mc_answer{int(r['correct_answer_num'])}"]
        lang = ISO3.get(r["dialect"].split("_")[0], r["dialect"])
        if r["dialect"] == "urd_Latn":
            lang = "roman_ur"
        yield {"messages": _msgs(f"{r['flores_passage']}\n\n{r['question']}\n\n{opts}", f"{r['correct_answer_num']}. {ans}"), "lang_declared": lang,
               "domain_hint": "reasoning", "source_record_id": f"belebele-{r['dialect']}-{r['link']}-{r['question_number']}",
               "meta": {"parallel_id": f"{r['link']}#{r['question_number']}"}}


MAPPERS = {"oasst1": map_oasst1, "dolly": map_dolly, "gsm8k": map_gsm8k, "aya": map_aya, "arc": map_arc, "mbpp": map_mbpp,
           "scienceqa": map_scienceqa, "self_oss": map_self_oss, "humaneval": map_humaneval, "belebele": map_belebele}


def load_local_jsonl(src: dict):
    p = TRAINING / src["connector"]["path"]
    if not p.exists():
        raise MissingSource(f"{src['id']}: file not found: {p.relative_to(TRAINING)}")
    prov = [{"file": str(p.relative_to(TRAINING)), "sha256": sha256_file(p), "bytes": p.stat().st_size,
             "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(p.stat().st_mtime))}]
    recs = []
    for n, line in enumerate(p.read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except ValueError:
            recs.append({"_malformed": f"line {n + 1}: invalid JSON"})
            continue
        recs.append({"messages": r.get("messages"), "lang_declared": r.get("language"), "domain_hint": r.get("domain"),
                     "source_record_id": f"{src['id']}-{n}", "category": r.get("category")})
    return prov, recs


def load_curriculum(seed: int = 4848, scale: float = 1.0):
    sys.path.insert(0, str(TRAINING))
    from engine.curriculum import authored, generators
    raw = authored.generate() + generators.generate(seed=seed, scale=scale)
    recs = [{"messages": r["messages"], "lang_declared": r.get("language"), "domain_hint": r.get("domain"), "source_record_id": f"curriculum-{k}",
             "category": r.get("category")} for k, r in enumerate(raw)]
    return [{"file": "engine/curriculum (generated)", "sha256": hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest(),
             "params": {"seed": seed, "scale": scale}}], recs


def load_source(src: dict, *, offline: bool = False, execute_code: bool = True, curriculum_scale: float = 1.0):
    """(provenance, raw records) for one APPROVED source. Raises for anything not approved or missing."""
    if src.get("status") != "approved":
        raise PermissionError(f"{src['id']}: status {src.get('status')!r} — only approved sources are ingested")
    kind = src["connector"]["type"]
    if kind == "hf_parquet":
        prov = fetch_hf(src, offline=offline)
        rows = iter_parquet_rows(prov)
        mapper = MAPPERS[src["connector"]["mapper"]]
        recs = list(mapper(rows, execute=execute_code) if mapper is map_mbpp else mapper(rows))
        return prov, recs
    if kind == "local_jsonl":
        return load_local_jsonl(src)
    if kind == "curriculum":
        return load_curriculum(scale=curriculum_scale)
    raise MissingSource(f"{src['id']}: no connector for type {kind!r}")
