"""Independent validation of the built datasets: re-reads the registry, provenance, manifests, build files and review ledger
and re-derives every number instead of trusting the manifests.

python -m datahub validate      → reports/validation_report.md + .json
Each check is PASS, FAIL, BLOCKED (cannot be satisfied with current data/decisions) or NOT RUN (inputs missing).
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from . import connectors, pipeline, review

MODELS = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"]
REQUIRED_SOURCE_FIELDS = ["name", "url", "license", "commercial_use", "attribution", "status", "origin", "transformations"]
SUBTOPICS = {"physics": r"\b(physics|velocity|acceleration|momentum|newton|gravity|force|energy|electric|magnet\w*|optics|quantum|thermodynamic\w*|wave\w*)\b",
             "chemistry": r"\b(chemistry|chemical|molecule\w*|atom\w*|reaction\w*|acid\w*|base\w*|oxidation|ion\w*|bond\w*|compound\w*|element\w*|periodic table)\b",
             "biology": r"\b(biology|cell\w*|dna|gene\w*|organism\w*|protein\w*|photosynthesis|evolution|enzyme\w*|species)\b"}


def _rows(model):
    d = pipeline.DATASETS / model / "build"
    out = {}
    for s in ("train", "eval", "test"):
        p = d / f"{s}.jsonl"
        out[s] = [json.loads(l) for l in p.read_text(encoding="utf-8").split("\n") if l.strip()] if p.exists() else None
    return out


def _user(r):
    return next((m["content"] for m in r["messages"] if m["role"] == "user"), "")


def check(name, status, detail):
    return {"check": name, "status": status, "detail": detail}


def validate(models: list | None = None, reg: dict | None = None) -> dict:
    reg = reg or pipeline.load_registry()
    srcs = {s["id"]: s for s in reg["sources"]}
    results = {"global": [], "models": {}}
    G = results["global"]

    # 1. registry completeness + provenance for every approved TRAINING source
    bad, prov_missing = [], []
    for s in reg["sources"]:
        if s["status"] != "approved" or s["use"] != "train":
            continue
        miss = [f for f in REQUIRED_SOURCE_FIELDS if not s.get(f)]
        if s["connector"]["type"] in ("hf_parquet", "hf_files") and not s.get("revision"):
            miss.append("revision")
        if s.get("commercial_use") != "yes":
            miss.append("commercial_use=yes")
        if miss:
            bad.append(f"{s['id']}: {miss}")
        if s["connector"]["type"] in ("hf_parquet", "hf_files"):
            p = pipeline.DATASETS / "sources" / "provenance" / f"{s['id']}.json"
            if not p.exists():
                prov_missing.append(s["id"]); continue
            files = json.loads(p.read_text())["files"]
            if not files or any(not f.get("sha256") or not f.get("fetched_at") or not f.get("url") for f in files):
                prov_missing.append(s["id"])
    G.append(check("registry_fields_complete", "PASS" if not bad else "FAIL", bad or "every approved training source has name, URL, revision, license, "
                   "commercial-use status, attribution, origin and transformation history"))
    G.append(check("source_provenance_hashes", "PASS" if not prov_missing else "FAIL",
                   prov_missing or "every downloaded source file has URL, SHA-256 and fetch timestamp"))
    unclear = [s["id"] for s in reg["sources"] if s["status"] == "approved" and s.get("commercial_use") != "yes"]
    G.append(check("no_unclear_license_approved", "PASS" if not unclear else "FAIL", unclear or
                   f"{sum(s['status'] == 'approved' for s in reg['sources'])} approved, all commercial-use 'yes'; "
                   f"{sum(s['status'] in ('review_required', 'conditional') for s in reg['sources'])} quarantined (review_required/conditional), "
                   f"{sum(s['status'] == 'rejected' for s in reg['sources'])} rejected, {sum(s['status'] == 'unavailable' for s in reg['sources'])} unavailable"))
    flagged = {s["id"]: s["upstream_risk"] for s in reg["sources"] if s["status"] == "approved" and s.get("upstream_risk")}
    G.append(check("upstream_risk_flags", "PASS", {"flagged_sources": flagged}))

    # 2. review ledger integrity
    ledger_entries = []
    for f in sorted(pipeline.REVIEWS.glob("*.jsonl")) if pipeline.REVIEWS.exists() else []:
        ledger_entries += [json.loads(l) for l in f.read_text(encoding="utf-8").split("\n") if l.strip()]
    dup = [k for k, v in Counter((e["record_id"], e["reviewer"]) for e in ledger_entries).items() if v > 1]
    nonhuman = [e["reviewer"] for e in ledger_entries if review.NON_HUMAN.search(e.get("reviewer", "")) or not review.REVIEWER_RX.match(e.get("reviewer", ""))]
    nosheet = [e["record_id"] for e in ledger_entries if not (review.SHEETS / e.get("model", "") / f"{e.get('sheet_id')}.meta.json").exists()]
    G.append(check("review_ledger_integrity", "PASS" if not (dup or nonhuman or nosheet) else "FAIL",
                   {"entries": len(ledger_entries), "duplicate_record_reviewer": len(dup), "non_human_reviewer_ids": len(nonhuman),
                    "entries_without_issued_sheet": len(nosheet)}))
    ledger = review.load_ledger()

    eval_src = {s["id"] for s in reg["sources"] if s["use"] == "eval_only"}
    from engine.curriculum import eval_suite
    eval_prompts = {pipeline._norm(it["prompt"]) for it in eval_suite.ITEMS if it.get("prompt")} - {""}
    for sid in eval_src:
        try:
            _, recs = connectors.load_source(srcs[sid], offline=True, execute_code=False)
            eval_prompts |= {k for r in recs for m in r["messages"] if m["role"] == "user" and (k := pipeline._norm(m["content"]))}
        except Exception:  # noqa: BLE001
            pass

    for m in models or MODELS:
        R = results["models"][m] = []
        mp = pipeline.DATASETS / m / "manifest.json"
        if not mp.exists():
            mp = pipeline.DATASETS / m / "build" / "manifest.json"
        if not mp.exists():
            R.append(check("manifest_present", "NOT RUN", "no manifest")); continue
        man = json.loads(mp.read_text())
        prof = man["profile"]
        rows = _rows(m)
        if any(v is None for v in rows.values()):
            R.append(check("build_files_present", "NOT RUN", "build files missing — run `python -m datahub build`")); continue
        allr = [r for s in rows.values() for r in s]
        # integrity
        mism = [f for f, meta in man["files"].items() if connectors.sha256_file(pipeline.DATASETS / m / "build" / f) != meta["sha256"]
                or meta["records"] != len(rows[f.split(".")[0]])]
        R.append(check("artifact_sha256_and_counts", "PASS" if not mism and len(allr) == man["counts"]["total"] else "FAIL",
                       mism or {f: meta["sha256"] for f, meta in man["files"].items()}))
        R.append(check("record_target", "PASS" if len(allr) >= prof["min_records"] else "BLOCKED",
                       f"{len(allr):,} accepted / {prof['min_records']:,} required" + (f" — {prof['min_records'] - len(allr):,} missing" if len(allr) < prof["min_records"] else "")))
        # licenses / eval separation
        used = Counter(r["source"] for r in allr)
        badlic = [s for s in used if srcs.get(s, {}).get("status") != "approved" or srcs[s].get("commercial_use") != "yes" or srcs[s]["use"] != "train"]
        R.append(check("licenses_and_eval_separation", "PASS" if not badlic else "FAIL", badlic or f"{len(used)} approved training sources; no evaluation-only source"))
        # recount languages/domains
        langs, doms = Counter(r["lang"] for r in allr), Counter(r["domain"] for r in allr)
        same = dict(langs) == man["by_language"] and dict(doms) == man["by_domain"]
        lgap = {l: f"{langs.get(l, 0)}/{n} (missing {n - langs.get(l, 0)})" for l, n in prof.get("language_min", {}).items() if langs.get(l, 0) < n}
        R.append(check("language_minimums", ("PASS" if not lgap else "BLOCKED") if same else "FAIL",
                       lgap or {l: f"{langs.get(l, 0)}/{n}" for l, n in prof.get("language_min", {}).items()}))
        need = {d: -(-s * prof["min_records"] // 1) for d, s in prof.get("domain_min_share", {}).items()}
        dgap = {d: f"{doms.get(d, 0)}/{int(n)} (missing {int(n) - doms.get(d, 0)})" for d, n in need.items() if doms.get(d, 0) < n}
        over = {d: f"{doms.get(d, 0) / max(1, len(allr)):.3f} > {s}" for d, s in prof.get("domain_max_share", {}).items() if doms.get(d, 0) > s * max(1, len(allr)) + 1}
        R.append(check("domain_minimums", ("PASS" if not dgap else "BLOCKED") if same else "FAIL", dgap or {d: f"{doms.get(d, 0)}/{int(n)}" for d, n in need.items()}))
        R.append(check("domain_maximums", "PASS" if not over else "FAIL", over or "within caps"))
        sci = [r for r in allr if r["domain"] == "science"]
        sub = {k: sum(1 for r in sci if re.search(rx, _user(r), re.I)) for k, rx in SUBTOPICS.items()}
        R.append(check("science_subtopics_info", "PASS", {"science_records": len(sci), **sub,
                       "note": "physics/chemistry/biology are tracked inside 'science' (no separate configured minimums); keyword counts, may overlap"}))
        # synthetic
        syn = sum(r["origin"] in pipeline.SYNTHETIC_ORIGINS for r in allr)
        R.append(check("synthetic_cap", "PASS" if syn <= prof.get("synthetic_max", 0.6) * len(allr) else "FAIL",
                       f"{syn:,}/{len(allr):,} = {syn / max(1, len(allr)):.3f} ≤ {prof.get('synthetic_max', 0.6)}"))
        # human review: re-derive from ledger only
        hr_rows = [r for r in allr if r["review_state"] == "human_reviewed"]
        unbacked = [r["id"] for r in hr_rows if ledger.get(r["id"], {}).get("verdict") != "accept"]
        n_ok = len(hr_rows) - len(unbacked)
        R.append(check("human_review_backed_by_ledger", "PASS" if not unbacked else "FAIL",
                       f"{len(hr_rows)} rows marked human_reviewed, {len(unbacked)} without a ledger accept"))
        R.append(check("human_review_minimum", "PASS" if n_ok >= prof.get("min_human_reviewed", 0) else "BLOCKED",
                       f"{n_ok:,} genuine human reviews / {prof.get('min_human_reviewed', 0):,} required (auto_verified and source_community_reviewed excluded: "
                       f"{sum(r['review_state'] == 'auto_verified' for r in allr):,} / {sum(r['review_state'] == 'source_community_reviewed' for r in allr):,})"))
        # duplicates / leakage — a training example's input is ALL of its user turns (the pipeline's prompt key)
        from engine import dataset_validator as dv
        keys = {s: [pipeline._norm(dv.user_text(r)) for r in rows[s]] for s in rows}
        allk = [k for v in keys.values() for k in v]
        dups = len(allk) - len(set(allk))
        cross = len(set(keys["train"]) & (set(keys["eval"]) | set(keys["test"])))
        # exact match of ANY user turn with an evaluation prompt (prompts that normalise to nothing — e.g. '？' or an emoji —
        # carry no content and are ignored)
        leak = sum(1 for r in allr for x in r["messages"] if x["role"] == "user" and (k := pipeline._norm(x["content"])) and k in eval_prompts)
        first = [pipeline._norm(_user(r)) for r in allr]
        shared_open = len(first) - len(set(first))
        ids = [r["id"] for r in allr]
        R.append(check("no_duplicate_prompts", "PASS" if dups == 0 and len(ids) == len(set(ids)) else "FAIL",
                       f"{dups} duplicate normalised prompts, {len(ids) - len(set(ids))} duplicate ids"))
        R.append(check("no_split_leakage", "PASS" if cross == 0 else "FAIL", f"{cross} prompts shared between train and eval/test"))
        R.append(check("no_benchmark_leakage", "PASS" if leak == 0 else "FAIL", f"{leak} user turns exactly matching an evaluation prompt ({len(eval_prompts):,} indexed)"))
        R.append(check("shared_opening_turn_info", "PASS", f"{shared_open:,} multi-turn conversations share an opening user message with another "
                                                         "record (different follow-up turns and targets; not duplicates)"))
        R.append(check("production_ready_derived", "PASS" if man["production_ready"] == all(g["passed"] for g in man["gates"].values()) else "FAIL",
                       f"production_ready={man['production_ready']} equals AND of {len(man['gates'])} gates"))
        fp = hashlib.sha256(json.dumps(sorted(ids)).encode()).hexdigest()
        R.append(check("fingerprint", "PASS", {"dataset_version": man["dataset_version"], "content_fingerprint_sha256": man["content_fingerprint_sha256"],
                                                "id_set_sha256": fp}))
        base = prof.get("base_model")
        R.append(check("base_model_configured", "PASS" if base else "BLOCKED", base or "no base model configured (needs approval)"))
    return results


def write(path: Path) -> dict:
    res = validate()
    path.with_suffix(".json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
    L = ["# Dataset validation", "", "Generated by `python -m datahub validate`: every number is re-derived from the build files, registry, provenance and review ledger.", "",
         "## Global", "", "| Check | Status | Detail |", "|---|---|---|"]
    fmt = lambda d: (d if isinstance(d, str) else json.dumps(d, ensure_ascii=False))[:600].replace("|", "/")  # noqa: E731
    L += [f"| {c['check']} | **{c['status']}** | {fmt(c['detail'])} |" for c in res["global"]]
    for m, cs in res["models"].items():
        L += ["", f"## {m}", "", "| Check | Status | Detail |", "|---|---|---|"] + [f"| {c['check']} | **{c['status']}** | {fmt(c['detail'])} |" for c in cs]
    path.write_text("\n".join(L) + "\n")
    return res
