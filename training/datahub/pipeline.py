"""The single authoritative dataset pipeline for every Approx model.

registry (approved sources only) → connectors (provenance: URL, revision, file SHA-256, timestamp)
→ normalise schema → PII scrub → content gates (engine.dataset_validator.check_record) → language ID + declared-language
consistency → domain classification → quality score → review state (ledger-backed; never assumed)
→ pool-level: exact dedup, near-duplicate prompts (MinHash), contradictions, benchmark / unseen-suite leakage removal
→ per-model selection (profile quotas: domains, languages, synthetic cap, user-history exclusion)
→ deterministic prompt-hash splits (same prompt ⇒ same split for every model) → files + manifest + gates.

production_ready is COMPUTED from the gates; it can never be set by configuration.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAINING))
from approx_data.pii import scrub  # noqa: E402
from engine import dataset_validator as dv  # noqa: E402

from . import connectors, domains, langid  # noqa: E402

DATASETS = TRAINING / "datasets"
REGISTRY = DATASETS / "sources" / "registry" / "sources.json"
REVIEWS = DATASETS / "reviews"
PIPELINE_VERSION = "datahub-1.0"
SYNTHETIC_ORIGINS = {"synthetic", "programmatic", "machine_translated"}
SOURCE_QUALITY = {"oasst1": 0.9, "gsm8k": 0.9, "mbpp": 0.9, "dolly-15k": 0.8, "aya-dataset": 0.7, "scienceqa-text": 0.7, "self-oss-instruct": 0.7,
                  "arc": 0.55, "approx-curriculum": 0.6, "approx-seed-v0.1": 0.6, "consented-history": 0.6}
INJECTION_CONTAM = re.compile(r"(ignore (all |the )?(previous|above) (instructions|prompts)|you are now (dan|in developer mode)|<\|im_start\|>|\[INST\]|system prompt:)", re.I)


def load_registry(path: Path = REGISTRY) -> dict:
    reg = json.loads(path.read_text(encoding="utf-8"))
    ids = [s["id"] for s in reg["sources"]]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate source ids in registry")
    for s in reg["sources"]:
        for k in ("id", "license", "status", "origin", "use", "connector"):
            if k not in s:
                raise ValueError(f"registry entry {s.get('id')} lacks {k!r}")
        if s["status"] == "approved" and s.get("commercial_use") not in ("yes",):
            raise ValueError(f"{s['id']}: approved sources must be cleared for commercial use")
    return reg


def _norm(t: str) -> str:
    return dv.norm_text(t)


def _hash(*parts: str) -> str:
    return hashlib.sha256("\u0000".join(parts).encode("utf-8")).hexdigest()


def load_review_ledger(review_dir: Path | None = None) -> dict:
    """record_id → verdict from real human reviews (datasets/reviews/*.jsonl, written by `python -m datahub review-import`)."""
    out = {}
    d = Path(review_dir or REVIEWS)
    if d.exists():
        for f in sorted(d.glob("*.jsonl")):
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    if r.get("reviewer") and r.get("verdict") in ("accept", "reject"):
                        out[r["record_id"]] = r
    return out


def normalise(raw: dict, src: dict, stats: Counter, ledger: dict) -> dict | None:
    """One raw record → pipeline record, or None (counted in stats as a rejection reason)."""
    def rej(reason):
        stats[f"rejected:{reason}"] += 1
        return None
    if raw.get("_malformed"):
        return rej("malformed")
    msgs = raw.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        return rej("schema")
    clean = []
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str):
            return rej("schema")
        clean.append({"role": m["role"], "content": m["content"].strip()})
    if clean[-1]["role"] != "assistant" or not any(m["role"] == "user" for m in clean):
        return rej("schema")
    pii = 0
    for m in clean:
        m["content"], n = scrub(m["content"])
        pii += n
    rec = {"messages": clean, "domain": "general_knowledge"}
    reason = dv.check_record(rec)
    if reason:
        return rej(reason.split(":")[0])
    user, ans = dv.user_text(rec), dv.answer_text(rec)
    if INJECTION_CONTAM.search(user + "\n" + ans) and "safety" not in (raw.get("domain_hint") or ""):
        return rej("injection_contamination")
    lang, script, conf = langid.detect(user + "\n" + ans)
    declared = raw.get("lang_declared")
    if declared and lang not in ("und", declared) and conf >= 0.7 and not (declared == "ur" and lang == "roman_ur"):
        return rej("language_mismatch")
    lang = declared if (declared and lang == "und") else (lang if lang != "und" else (declared or "und"))
    dom = domains.classify(user, ans, raw.get("domain_hint"))
    rid = _hash(src["id"], str(raw["source_record_id"]))[:24]
    ans_len = len(ans)
    length_score = min(1.0, math.log10(max(10, ans_len)) / 3)          # ~1.0 at 1000 chars
    quality = round(0.5 * SOURCE_QUALITY.get(src["id"], 0.6) + 0.3 * length_score + 0.2 * max(conf, 0.3), 4)
    if src["origin"] in SYNTHETIC_ORIGINS:
        review = "auto_verified" if src["id"] == "approx-curriculum" else "unreviewed"
    elif src["id"] == "oasst1":
        review = "source_community_reviewed"
    elif src["id"] == "mbpp" and (raw.get("meta") or {}).get("tests_passed"):
        review = "auto_verified"
    else:
        review = "unreviewed"
    lv = ledger.get(rid)
    if lv:
        if lv["verdict"] == "reject":
            return rej("human_review_rejected")
        review = "human_reviewed"
    stats["pii_redactions"] += pii
    return {"id": rid, "messages": clean, "lang": lang, "script": script, "lang_confidence": conf, "lang_declared": declared,
            "domain": dom, "category": raw.get("category"), "source": src["id"], "license": src["license"], "origin": src["origin"],
            "synthetic": src["origin"] in SYNTHETIC_ORIGINS, "review_state": review, "quality": quality,
            "prompt_key": _hash(_norm(user))[:32], "content_hash": _hash(_norm(user), _norm(ans))[:32]}


def eval_prompts(reg: dict, offline: bool) -> list[str]:
    """User prompts of every evaluation-only source + the unseen suite (training must never contain them)."""
    out = []
    for s in reg["sources"]:
        if s["status"] == "approved" and s["use"] == "eval_only":
            _, recs = connectors.load_source(s, offline=offline, execute_code=False)
            out += [m["content"] for r in recs for m in r["messages"] if m["role"] == "user"]
    from engine.curriculum import eval_suite          # the held-out unseen suite used for BASE-vs-ADAPTER evaluation
    out += [it["prompt"] for it in eval_suite.ITEMS if it.get("prompt")]
    return out


def build_pool(reg: dict | None = None, *, offline: bool = False, curriculum_scale: float = 1.0, only: set | None = None, log=print,
               review_dir: Path | None = None) -> dict:
    """Ingest every approved TRAIN source once and apply all record- and pool-level gates."""
    reg = reg or load_registry()
    ledger = load_review_ledger(review_dir)
    stats, per_source, provenance, missing = Counter(), {}, {}, []
    recs = []
    for s in reg["sources"]:
        if s["use"] != "train" or (only and s["id"] not in only):
            continue
        if s["status"] != "approved":
            per_source[s["id"]] = {"status": s["status"], "ingested": 0, "reason": s.get("reason")}
            continue
        t = time.time()
        try:
            prov, raws = connectors.load_source(s, offline=offline, curriculum_scale=curriculum_scale)
        except connectors.MissingSource as e:
            missing.append({"source": s["id"], "error": str(e)})
            per_source[s["id"]] = {"status": "missing", "ingested": 0, "error": str(e)}
            log(f"  MISSING {s['id']}: {e}")
            continue
        provenance[s["id"]] = prov
        st = Counter()
        kept = [r for r in (normalise(x, s, st, ledger) for x in raws) if r]
        recs += kept
        stats.update(st)
        per_source[s["id"]] = {"status": "ingested", "raw": len(raws), "accepted_record_gates": len(kept),
                               "rejected": {k.split(":", 1)[1]: v for k, v in st.items() if k.startswith("rejected:")}, "seconds": round(time.time() - t, 1)}
        log(f"  {s['id']:20s} raw={len(raws):7d} kept={len(kept):7d} ({time.time() - t:.0f}s)")
    # pool-level gates (deterministic order: best quality first, then id)
    recs.sort(key=lambda r: (-r["quality"], r["id"]))
    seen, uniq = set(), []
    for r in recs:
        if r["content_hash"] in seen:
            stats["rejected:exact_duplicate"] += 1
            continue
        seen.add(r["content_hash"])
        uniq.append(r)
    # Contradictions first: the same question with conflicting final answers → drop ALL of them (keeping one would keep
    # a possibly wrong answer).
    bad = dv.find_contradictions(uniq)
    stats["rejected:contradiction"] += len(bad)
    uniq = [r for i, r in enumerate(uniq) if i not in bad]
    near, kept = dv.NearDupIndex(threshold=0.85), []
    for r in uniq:
        cid, sig = near.find(dv.user_text(r))
        if cid is not None:
            stats["rejected:near_duplicate"] += 1
            continue
        near.add(sig, r["id"])
        kept.append(r)
    ev = eval_prompts(reg, offline)
    ev_exact = {_norm(q) for q in ev}
    ev_idx = dv.NearDupIndex(threshold=0.7)
    for q in ev:
        _, sig = ev_idx.find(q)
        ev_idx.add(sig, "eval")
    clean = []
    for r in kept:
        u = dv.user_text(r)
        if _norm(u) in ev_exact or ev_idx.find(u)[0] is not None:
            stats["rejected:benchmark_leakage"] += 1
            continue
        clean.append(r)
    log(f"  pool: {len(clean)} records after dedup/contradiction/leakage gates")
    return {"records": clean, "stats": dict(stats), "per_source": per_source, "provenance": provenance, "missing": missing,
            "eval_prompt_count": len(ev), "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def split_of(prompt_key: str, ratios: dict) -> str:
    b = int(prompt_key[:8], 16) / 0xFFFFFFFF
    if b < ratios["test"]:
        return "test"
    if b < ratios["test"] + ratios["eval"]:
        return "eval"
    return "train"


def load_profile(model_id: str) -> dict:
    return json.loads((DATASETS / model_id / "profile.json").read_text(encoding="utf-8"))


def select(pool: list, profile: dict) -> tuple[list, dict]:
    """Deterministic, quota-respecting selection for one model. Never duplicates a record to reach a target."""
    excl = set(profile.get("exclude_sources", []))
    elig = [r for r in pool if r["source"] not in excl and r["quality"] >= profile.get("min_quality", 0.0)]
    cap = profile.get("max_records") or profile["min_records"]
    if len(elig) <= cap:
        chosen = list(elig)
    else:
        chosen, taken = [], set()
        by_dom, by_lang = defaultdict(list), defaultdict(list)
        for r in elig:
            by_dom[r["domain"]].append(r)
            by_lang[r["lang"]].append(r)
        for d, share in profile.get("domain_min_share", {}).items():          # 1) domain minimums
            for r in by_dom.get(d, [])[: math.ceil(share * cap)]:
                if r["id"] not in taken:
                    taken.add(r["id"]); chosen.append(r)
        for l, n in profile.get("language_min", {}).items():                   # 2) language minimums
            for r in [x for x in by_lang.get(l, []) if x["id"] not in taken][: max(0, n - sum(1 for c in chosen if c["lang"] == l))]:
                taken.add(r["id"]); chosen.append(r)
        dmax = {d: math.floor(s * cap) for d, s in profile.get("domain_max_share", {}).items()}
        dcount = Counter(r["domain"] for r in chosen)
        syn_cap = math.floor(profile.get("synthetic_max", 0.6) * cap)
        syn = sum(1 for r in chosen if r["synthetic"])
        for r in elig:                                                          # 3) fill by quality within caps
            if len(chosen) >= cap:
                break
            if r["id"] in taken or dcount[r["domain"]] >= dmax.get(r["domain"], cap) or (r["synthetic"] and syn >= syn_cap):
                continue
            taken.add(r["id"]); chosen.append(r); dcount[r["domain"]] += 1; syn += r["synthetic"]
    # enforce the synthetic cap on the final set too (drop lowest-quality synthetic records if needed)
    smax = profile.get("synthetic_max", 0.6)
    chosen.sort(key=lambda r: (-r["quality"], r["id"]))
    while chosen and sum(r["synthetic"] for r in chosen) > smax * len(chosen):
        idx = max(i for i, r in enumerate(chosen) if r["synthetic"])
        chosen.pop(idx)
    return sorted(chosen, key=lambda r: r["id"]), {"eligible": len(elig), "cap": cap}


def _dump(path: Path, rows: list):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")


def build_model(model_id: str, pool: dict, out_dir: Path | None = None, profile: dict | None = None, *, reg: dict | None = None,
                publish: bool = True) -> dict:
    profile = dict(profile or load_profile(model_id))
    profile.pop("production_ready", None)        # never configurable: computed from the gates below
    out_dir = Path(out_dir or DATASETS / model_id / "build")
    chosen, sel = select(pool["records"], profile)
    ratios = profile.get("split_ratios", {"eval": 0.03, "test": 0.03})
    splits = defaultdict(list)
    for r in chosen:
        splits[split_of(r["prompt_key"], ratios)].append(r)
    sysmsg = profile.get("system_prompt")
    def row(r):
        msgs = ([{"role": "system", "content": sysmsg}] if sysmsg else []) + r["messages"]
        return {"messages": msgs, "id": r["id"], "lang": r["lang"], "domain": r["domain"], "source": r["source"], "origin": r["origin"],
                "review_state": r["review_state"], "quality": r["quality"]}
    files = {}
    for name in ("train", "eval", "test"):
        p = out_dir / f"{name}.jsonl"
        _dump(p, [row(r) for r in splits[name]])
        files[f"{name}.jsonl"] = {"records": len(splits[name]), "sha256": connectors.sha256_file(p)}
    total = len(chosen)
    c = lambda key: dict(sorted(Counter(r[key] for r in chosen).items(), key=lambda kv: -kv[1]))  # noqa: E731
    syn = sum(r["synthetic"] for r in chosen)
    reviewed = sum(r["review_state"] == "human_reviewed" for r in chosen)
    langs, doms = c("lang"), c("domain")
    # leakage re-check on the written splits
    keys = {n: {r["prompt_key"] for r in splits[n]} for n in splits}
    leak = len(keys.get("train", set()) & (keys.get("eval", set()) | keys.get("test", set())))
    used_sources = {r["source"] for r in chosen}
    reg = {s["id"]: s for s in (reg or load_registry())["sources"]}
    gates = {
        "quantity": {"passed": total >= profile["min_records"], "detail": f"{total} accepted / target {profile['min_records']}"},
        "licenses": {"passed": all(reg[s]["status"] == "approved" and reg[s].get("commercial_use") == "yes" for s in used_sources),
                     "detail": sorted(used_sources)},
        "synthetic_ratio": {"passed": total > 0 and syn / total <= profile.get("synthetic_max", 0.6), "detail": f"{syn}/{total} = {syn / max(1, total):.3f} (max {profile.get('synthetic_max', 0.6)})"},
        "domain_minimums": {"passed": all(doms.get(d, 0) >= math.ceil(s * profile["min_records"]) for d, s in profile.get("domain_min_share", {}).items()),
                            "detail": {d: f"{doms.get(d, 0)}/{math.ceil(s * profile['min_records'])}" for d, s in profile.get("domain_min_share", {}).items()}},
        "domain_maximums": {"passed": all(doms.get(d, 0) <= s * max(1, total) + 1 for d, s in profile.get("domain_max_share", {}).items()),
                            "detail": {d: f"{doms.get(d, 0) / max(1, total):.3f} ≤ {s}" for d, s in profile.get("domain_max_share", {}).items()}},
        "language_minimums": {"passed": all(langs.get(l, 0) >= n for l, n in profile.get("language_min", {}).items()),
                              "detail": {l: f"{langs.get(l, 0)}/{n}" for l, n in profile.get("language_min", {}).items()}},
        "human_review": {"passed": reviewed >= profile.get("min_human_reviewed", 1), "detail": f"{reviewed} human-reviewed / required {profile.get('min_human_reviewed', 1)}"},
        "no_split_leakage": {"passed": leak == 0, "detail": f"{leak} prompts shared between train and eval/test"},
        "benchmark_leakage_removed": {"passed": pool["stats"].get("rejected:benchmark_leakage", 0) >= 0 and pool["eval_prompt_count"] > 0,
                                      "detail": f"{pool['eval_prompt_count']} evaluation prompts indexed; {pool['stats'].get('rejected:benchmark_leakage', 0)} training records removed"},
        "no_missing_sources": {"passed": not pool["missing"], "detail": pool["missing"] or "all approved sources present"},
        "user_history_policy": {"passed": not (profile.get("tier") == "fab" and "consented-history" in used_sources), "detail": "FAB never uses user history"},
    }
    ready = all(g["passed"] for g in gates.values())
    fp = hashlib.sha256("\n".join(f"{r['id']}:{r['content_hash']}" for r in chosen).encode()).hexdigest()
    manifest = {
        "schema": "approx.dataset/v1", "model_id": model_id, "dataset_version": f"{model_id}-{PIPELINE_VERSION}-{fp[:10]}", "pipeline_version": PIPELINE_VERSION,
        "profile": profile, "counts": {"total": total, **{n: len(splits[n]) for n in ("train", "eval", "test")}},
        "selection": sel, "by_language": langs, "by_domain": doms, "by_source": c("source"), "by_origin": c("origin"), "by_review_state": c("review_state"),
        "synthetic_ratio": round(syn / max(1, total), 4), "human_reviewed": reviewed,
        "content_fingerprint_sha256": fp, "files": files, "gates": gates, "production_ready": ready,
        "production_readiness_notes": [f"{k}: {v['detail']}" for k, v in gates.items() if not v["passed"]],
        "pool": {"built_at": pool["built_at"], "stats": pool["stats"], "per_source": pool["per_source"], "missing": pool["missing"]},
        "provenance": {s: pool["provenance"].get(s) for s in sorted(used_sources)},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    if not publish:
        return manifest
    # committed copy (no data, only counts/hashes/provenance)
    (DATASETS / model_id / "manifest.json").write_text(json.dumps({k: v for k, v in manifest.items() if k != "pool"} | {"pool_summary": {
        "built_at": pool["built_at"], "rejections": {k.split(":", 1)[1]: v for k, v in pool["stats"].items() if k.startswith("rejected:")},
        "pii_redactions": pool["stats"].get("pii_redactions", 0), "per_source": pool["per_source"], "missing": pool["missing"]}}, indent=1, ensure_ascii=False))
    return manifest


EVAL_SUITES = {  # suite → (eval-only source ids, what it measures)
    "multilingual": (["eval-belebele"], "reading comprehension in 17 languages; identical questions across languages → cross-language consistency"),
    "mathematics": (["eval-gsm8k-test"], "multi-step arithmetic word problems (exact final answer)"),
    "science-reasoning": (["eval-arc-test"], "grade-school science reasoning (ARC-Challenge, multiple choice)"),
    "coding": (["eval-mbpp-test", "eval-humaneval"], "Python functions graded by executing the reference tests"),
}


def build_eval_suites(reg: dict | None = None, offline: bool = False) -> dict:
    """Write evaluation suites (data → datasets/evaluation/<suite>/build, gitignored; manifest committed)."""
    reg = reg or load_registry()
    by = {s["id"]: s for s in reg["sources"]}
    out = {}
    for suite, (ids, purpose) in EVAL_SUITES.items():
        items = []
        for sid in ids:
            s = by[sid]
            assert s["use"] == "eval_only" and s["status"] == "approved", sid
            _, recs = connectors.load_source(s, offline=offline, execute_code=False)
            for r in recs:
                items.append({"id": _hash(sid, str(r["source_record_id"]))[:24], "source": sid, "lang": r.get("lang_declared") or "en",
                              "messages": r["messages"], "parallel_id": (r.get("meta") or {}).get("parallel_id")})
        items.sort(key=lambda x: x["id"])
        d = DATASETS / "evaluation" / suite
        _dump(d / "build" / "items.jsonl", items)
        langs = dict(sorted(Counter(i["lang"] for i in items).items()))
        parallel = Counter(i["parallel_id"] for i in items if i["parallel_id"])
        man = {"suite": suite, "purpose": purpose, "sources": {sid: {"license": by[sid]["license"], "revision": by[sid].get("revision"),
               "attribution": by[sid].get("attribution")} for sid in ids}, "items": len(items), "by_language": langs,
               "cross_language_groups": sum(1 for v in parallel.values() if v >= 2),
               "fingerprint_sha256": hashlib.sha256("\n".join(i["id"] for i in items).encode()).hexdigest(),
               "file_sha256": connectors.sha256_file(d / "build" / "items.jsonl"), "never_trained_on": True}
        (d / "manifest.json").write_text(json.dumps(man, indent=1, ensure_ascii=False))
        out[suite] = man
    from engine.curriculum import eval_suite
    unseen = {"suite": "unseen-approx-v1", "purpose": "held-out Approx suite with objective graders (engine/evaluator.py); used for BASE vs ADAPTER",
              "items": len(eval_suite.ITEMS), "by_language": dict(Counter(i.get("lang", "en") for i in eval_suite.ITEMS)),
              "by_category": dict(Counter(i["category"] for i in eval_suite.ITEMS)), "location": "training/engine/curriculum/eval_suite.py", "never_trained_on": True}
    (DATASETS / "evaluation" / "unseen-approx-v1").mkdir(parents=True, exist_ok=True)
    (DATASETS / "evaluation" / "unseen-approx-v1" / "manifest.json").write_text(json.dumps(unseen, indent=1, ensure_ascii=False))
    out["unseen-approx-v1"] = unseen
    return out
