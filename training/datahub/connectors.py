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
                if conn.get("max_files"):
                    urls = urls[: conn["max_files"]]
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


def iter_parquet_rows(entries: list[dict], columns: list | None = None):
    """Stream rows batch by batch (bounded memory even for multi-GB sources)."""
    import pyarrow.parquet as pq
    for e in entries:
        f = pq.ParquetFile(CACHE / e["file"])
        cols = [c for c in columns if c in f.schema_arrow.names] if columns else None
        i = 0
        for batch in f.iter_batches(batch_size=2048, columns=cols):
            for row in batch.to_pylist():
                yield e, i, row
                i += 1


def fetch_hf_files(src: dict, offline: bool = False) -> list[dict]:
    """Download specific repo files pinned to the full revision SHA (for very large repos where only some shards are used)."""
    conn = src["connector"]
    rev = src.get("revision_full")
    if not rev:
        raise MissingSource(f"{src['id']}: hf_files connector needs revision_full (pinned commit)")
    d = CACHE / src["id"] / "files"
    meta_f = d / "_provenance.json"
    if meta_f.exists() and all((CACHE / e["file"]).exists() for e in json.loads(meta_f.read_text())):
        prov = json.loads(meta_f.read_text())
        if [e["path"] for e in prov] == conn["files"]:
            return prov
    if offline:
        raise MissingSource(f"{src['id']}: files not cached at {d} (offline mode)")
    entries = []
    for path in conn["files"]:
        f = d / path.replace("/", "__")
        u = f"{HF}/datasets/{src['hub_repo']}/resolve/{rev}/{path}"
        if not f.exists():
            try:
                _download(u, f)
            except Exception as e:  # noqa: BLE001
                raise MissingSource(f"{src['id']}: cannot download {path}: {e}") from e
        entries.append({"file": str(f.relative_to(CACHE)), "path": path, "url": u, "sha256": sha256_file(f), "bytes": f.stat().st_size,
                        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source_revision": rev})
    meta_f.write_text(json.dumps(entries, indent=1))
    return entries


def _keep(key: str, rate: float) -> bool:
    """Deterministic sampling: the same key is always kept or always dropped."""
    return rate >= 1.0 or int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF < rate


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


# ---- dataset-completion sources (2026-11) ------------------------------------------------------------------------
THINK = re.compile(r"(?s)^\s*<think>.*?</think>\s*")


def _strip_think(text: str) -> str | None:
    """Final answer of a reasoning-model response; None if the reasoning never closed (truncated output)."""
    if "<think>" in text:
        if "</think>" not in text:
            return None
        text = THINK.sub("", text, count=1)
    return text.strip() or None


def map_nemotron(rows, verify_mc: bool = False):
    """NVIDIA Nemotron post-training rows (math / stem). Responses by DeepSeek-R1-0528 (MIT) or Qwen3-235B-A22B (Apache-2.0).
    Reasoning traces are removed; only the first response per prompt is kept (multiple samples per prompt exist);
    with verify_mc the final answer must agree with the row's expected multiple-choice answer."""
    seen = set()
    allowed = {"DeepSeek-R1-0528", "Qwen3-235B-A22B"}
    for e, i, r in rows:
        if r.get("generator") not in allowed:
            continue
        msgs = r.get("messages") or []
        if len(msgs) != 2 or msgs[0]["role"] != "user" or msgs[1]["role"] != "assistant":
            continue
        user = (msgs[0]["content"] or "").strip()
        if user in ("", "-"):
            continue                       # withheld prompt
        key = hashlib.sha256(user.encode()).hexdigest()
        if key in seen:
            continue
        ans = _strip_think(msgs[1]["content"] or "")
        if not ans or len(ans) > 8000:
            continue
        if verify_mc and not _mc_consistent(user, ans, r.get("metadata")):
            continue
        seen.add(key)
        yield {"messages": _msgs(user, ans), "lang_declared": None, "domain_hint": r.get("category"),
               "source_record_id": r.get("uuid") or f"{e['file']}-{i}", "category": r.get("category"),
               "meta": {"generator": r.get("generator")}}


def _mc_consistent(user: str, ans: str, metadata) -> bool:
    try:
        exp = json.loads(metadata or "{}").get("expected_answer", "")
    except ValueError:
        return False
    m = re.fullmatch(r"\\?(?:text\{)?\s*([A-J])\s*\}?", str(exp).strip())
    if not m:
        return False
    L = m.group(1)
    opt = re.search(rf"(?m)^\s*\(?{L}[\):\.]\s*(.+)$", user)
    low = ans.lower()
    if opt and len(opt.group(1).strip()) >= 4 and opt.group(1).strip().lower()[:60] in low:
        return True
    return bool(re.search(rf"(\\boxed\{{\s*(\\text\{{)?\s*{L}\s*\}}|\b(answer|option|choice)\s*(is|:)?\s*\(?\**{L}\**\)?(?![A-Za-z])|\({L}\))", ans))


def map_opencodeinstruct(rows, min_score: float = 1.0):
    """nvidia/OpenCodeInstruct: keep only rows whose publisher-executed unit tests all pass (average_test_score == 1.0)."""
    for e, i, r in rows:
        try:
            score = float(r.get("average_test_score") or 0)
        except ValueError:
            continue
        if score < min_score:
            continue
        yield {"messages": _msgs(r["input"], r["output"]), "lang_declared": "en", "domain_hint": "coding",
               "source_record_id": r.get("id") or f"oci-{e['file']}-{i}", "category": r.get("generation_algorithm")}


def map_trendyol_sec(rows):
    for e, i, r in rows:
        if not (r.get("user") and r.get("assistant")):
            continue
        yield {"messages": _msgs(r["user"], r["assistant"]), "lang_declared": "en", "domain_hint": "cybersecurity",
               "source_record_id": f"trendyol-{e['split']}-{i}", "category": "defensive_security"}


def map_qasc(rows):
    """QASC (crowd-written science facts + questions). Answer = the two gold facts + the labelled choice."""
    for e, i, r in rows:
        ch = r.get("choices") or {}
        labels, texts = ch.get("label") or [], ch.get("text") or []
        if not r.get("answerKey") or r["answerKey"] not in labels:
            continue
        opts = "\n".join(f"{l}. {t}" for l, t in zip(labels, texts))
        k = labels.index(r["answerKey"])
        ans = f"{r['fact1'].strip()} {r['fact2'].strip()} Therefore the answer is {r['answerKey']}. {texts[k]}."
        yield {"messages": _msgs(f"{r['question']}\n\n{opts}", ans), "lang_declared": "en", "domain_hint": "science",
               "source_record_id": f"qasc-{r.get('id') or i}", "category": "science_multihop"}


TYDI_LANG = {"arabic": "ar", "bengali": "bn", "english": "en", "finnish": "fi", "indonesian": "id", "japanese": "ja", "korean": "ko",
             "russian": "ru", "swahili": "sw", "telugu": "te", "thai": "th"}
SENT_END = re.compile(r"(?<=[\.\!\?。！？])\s+|\n+")


def map_tydiqa(rows):
    """TyDi QA GoldP: native-speaker questions answered from a Wikipedia passage. Answer = span + the passage sentence that
    contains it (both human text; nothing generated)."""
    for e, i, r in rows:
        ans = r.get("answers") or {}
        spans, starts = ans.get("text") or [], ans.get("answer_start") or []
        if not spans:
            continue
        span, st, ctx = spans[0].strip(), starts[0], r["context"]
        if not span:
            continue
        a, b = ctx.rfind("\n", 0, st) + 1, ctx.find("\n", st)
        para = ctx[a: b if b != -1 else len(ctx)]
        sent = next((x.strip() for x in SENT_END.split(para) if span in x), para.strip())
        answer = span if sent == span else f"{span}\n\n{sent}"
        lang = TYDI_LANG.get(r["id"].split("-")[0])
        yield {"messages": _msgs(f"{ctx}\n\n{r['question']}", answer), "lang_declared": lang, "domain_hint": "research",
               "source_record_id": f"tydi-{r['id']}", "category": "reading_comprehension"}


def map_roman_urdu_parl(rows, rate: float = 1.0, min_words: int = 6):
    """Urdu ↔ Roman-Urdu transliteration pairs. The record's language is the OUTPUT script's language."""
    for e, i, r in rows:
        ur, rom = (r.get("Urdu text") or "").strip(), (r.get("Roman-Urdu text") or "").strip()
        if len(rom.split()) < min_words or not _keep(rom, rate):
            continue
        if int(hashlib.sha256(rom.encode()).hexdigest()[8:10], 16) % 2 == 0:
            msgs, lang = _msgs(f"Is jumle ko Roman Urdu mein likhein:\n{ur}", rom), "roman_ur"
        else:
            msgs, lang = _msgs(f"اس جملے کو اردو رسم الخط میں لکھیں:\n{rom}", ur), "ur"
        yield {"messages": msgs, "lang_declared": lang, "lang_from": "answer", "domain_hint": "writing",
               "source_record_id": f"rup-{e['split']}-{i}", "category": "transliteration"}


WIKI_PROMPT = {"ur": "{t} کے بارے میں ایک مختصر تعارف لکھیں۔", "hi": "{t} के बारे में एक संक्षिप्त परिचय लिखिए।",
               "ko": "{t}에 대해 간단히 소개해 주세요.", "id": "Jelaskan secara singkat tentang {t}.",
               "bn": "{t} সম্পর্কে একটি সংক্ষিপ্ত পরিচিতি লিখুন।", "fa": "دربارهٔ {t} یک معرفی کوتاه بنویسید."}


def map_wikipedia_intro(rows, lang: str, rate: float = 1.0, max_records: int = 0, min_chars: int = 350, max_chars: int = 1400):
    """Human-written Wikipedia lead sections (CC-BY-SA) under a fixed, honest prompt template. The prompt is a template,
    so these records count toward the synthetic cap (origin 'templated_human')."""
    n = 0
    for e, i, r in rows:
        title, text = (r.get("title") or "").strip(), (r.get("text") or "").strip()
        if not title or not text or re.search(r"\d{3,}|\(.*(ضد ابہام|disambiguation|동음이의|disambiguasi).*\)", title):
            continue
        if not _keep(f"{lang}:{title}", rate):
            continue
        paras = [p.strip() for p in text.split("\n") if len(p.strip()) > 40]
        lead = ""
        for p in paras:
            if len(lead) + len(p) > max_chars:
                break
            lead = f"{lead}\n\n{p}" if lead else p
        if len(lead) < min_chars:
            continue
        yield {"messages": _msgs(WIKI_PROMPT[lang].format(t=title), lead), "lang_declared": lang, "domain_hint": None,
               "source_record_id": f"wiki-{lang}-{r.get('id') or i}", "category": "encyclopedic_intro",
               "meta": {"title": title, "url": r.get("url")}}
        n += 1
        if max_records and n >= max_records:
            return


MAPPERS = {"oasst1": map_oasst1, "dolly": map_dolly, "gsm8k": map_gsm8k, "aya": map_aya, "arc": map_arc, "mbpp": map_mbpp,
           "scienceqa": map_scienceqa, "self_oss": map_self_oss, "humaneval": map_humaneval, "belebele": map_belebele,
           "nemotron": map_nemotron, "opencodeinstruct": map_opencodeinstruct, "trendyol_sec": map_trendyol_sec, "qasc": map_qasc,
           "tydiqa": map_tydiqa, "roman_urdu_parl": map_roman_urdu_parl, "wikipedia_intro": map_wikipedia_intro, "oasst2": map_oasst1}


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
    conn = src["connector"]
    kind = conn["type"]
    if kind in ("hf_parquet", "hf_files"):
        prov = fetch_hf(src, offline=offline) if kind == "hf_parquet" else fetch_hf_files(src, offline=offline)
        rows = iter_parquet_rows(prov, conn.get("columns"))
        mapper = MAPPERS[conn["mapper"]]
        opts = conn.get("options", {})
        recs = list(mapper(rows, execute=execute_code) if mapper is map_mbpp else (mapper(rows, **opts) if opts else mapper(rows)))
        if conn.get("max_records"):
            recs = recs[: conn["max_records"]]
        return prov, recs
    if kind == "local_jsonl":
        return load_local_jsonl(src)
    if kind == "curriculum":
        return load_curriculum(scale=curriculum_scale)
    raise MissingSource(f"{src['id']}: no connector for type {kind!r}")
