"""reports/dataset_status.md + reports/domain_requirements.json from the committed manifests (no estimates).

python -m datahub.report
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"]

BLOCKERS = [
    ("Human review (all models)", "No person has reviewed any record yet: 0 / 500 (Nick 4.8), 0 / 800 (Hike 6.5), 0 / 1,200 (Sona 9.0), "
     "0 / 1,500 (FAB 100X), 0 / 5,000 (FAB 500X). Review sheets are issued (datasets/reviews/sheets/, not committed); reviewers follow "
     "documentation/HUMAN_REVIEW.md and the operator imports them with `python -m datahub review-import`. Automatic checks never count."),
    ("FAB 100X base model", "No base model configured — hard blocker. Licensed options for approval: reports/base_model_options.md."),
    ("Nick 4.8 base-model license", "Qwen/Qwen2.5-3B-Instruct is under the Qwen Research License (non-commercial). The configuration is "
     "unchanged; commercial alternatives (Phi-4-mini-instruct, MIT; Qwen3-4B-Instruct-2507, Apache-2.0) await approval."),
    ("Unpinned base revisions", "Hike 6.5, Sona 9.0 and FAB 500X bases are Apache-2.0 but their revisions are unpinned (resolved and recorded at "
     "training time)."),
    ("Sources with upstream risk", "OpenCodeInstruct and Trendyol-Cybersecurity do not name their generator models; Roman-Urdu-Parl does not document "
     "how its Roman-Urdu side was produced; CommitPackFT code keeps per-repository permissive licenses. Approved under declared licenses and flagged "
     "(`upstream_risk`); set `status` to `rejected` and rebuild to drop any of them."),
    ("Unavailable / quarantined sources", "Hendrycks MATH (taken down), Nemotron code (prompts withheld), Tatoeba (needs another host or an HF token); "
     "13 sources are quarantined as review_required and 9 rejected (see datasets/sources/licenses/README.md)."),
    ("Consented history", "Optional source: no users have opted in; reported as absent, never fabricated."),
    ("Not verified here", "GPU training, `tests/test_recovery.py` and the torch-dependent tests in `test_colab_pipeline` need torch/GPU."),
]


def load(m):
    p = ROOT / "datasets" / m / "manifest.json"
    return json.loads(p.read_text()) if p.exists() else None


def requirements(man):
    prof, sel = man["profile"], man.get("selection", {})
    target = prof["min_records"]
    elig_d, elig_l = sel.get("eligible_by_domain", {}), sel.get("eligible_by_language", {})
    dom = {}
    for d, s in prof.get("domain_min_share", {}).items():
        need, have = math.ceil(s * target), man["by_domain"].get(d, 0)
        dom[d] = {"required": need, "selected": have, "remaining": max(0, need - have), "eligible_in_pool": elig_d.get(d, 0),
                  "needs_new_data": elig_d.get(d, 0) < need}
    dmax = {d: {"max_share": s, "share": round(man["by_domain"].get(d, 0) / max(1, man["counts"]["total"]), 3)}
            for d, s in prof.get("domain_max_share", {}).items()}
    lang = {}
    for l, n in prof.get("language_min", {}).items():
        have = man["by_language"].get(l, 0)
        lang[l] = {"required": n, "selected": have, "remaining": max(0, n - have), "eligible_in_pool": elig_l.get(l, 0), "needs_new_data": elig_l.get(l, 0) < n}
    return {"target_records": target, "accepted": man["counts"]["total"], "remaining_records": max(0, target - man["counts"]["total"]),
            "domains": dom, "domain_max": dmax, "languages": lang,
            "human_review": {"required": prof.get("min_human_reviewed", 0), "accepted": man["human_reviewed"],
                             "remaining": max(0, prof.get("min_human_reviewed", 0) - man["human_reviewed"])},
            "failed_gates": [k for k, g in man["gates"].items() if not g["passed"]]}


def write_source_reports() -> int:
    """datasets/sources/provenance/<id>.json (per-file URL, SHA-256, fetch time) and datasets/sources/licenses/README.md."""
    import sys
    sys.path.insert(0, str(ROOT))
    from datahub import connectors, pipeline
    reg = pipeline.load_registry()
    out_dir = ROOT / "datasets" / "sources" / "provenance"
    out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for s in reg["sources"]:
        sub = connectors.CACHE / s["id"]
        metas = sorted(sub.rglob("_provenance.json")) if sub.exists() else []
        if not metas:
            continue
        files = [e for f in metas for e in json.loads(f.read_text())]
        (out_dir / f"{s['id']}.json").write_text(json.dumps({
            "source": s["id"], "name": s["name"], "url": s.get("url"), "hub_repo": s.get("hub_repo"), "revision": s.get("revision_full") or s.get("revision"),
            "license": s["license"], "commercial_use": s.get("commercial_use"), "attribution": s.get("attribution"), "status": s["status"], "use": s["use"],
            "transformations": s.get("transformations"), "upstream_risk": s.get("upstream_risk"),
            "files": [{k: e.get(k) for k in ("file", "path", "url", "sha256", "bytes", "fetched_at", "config", "split") if e.get(k) is not None} for e in files]},
            indent=1, ensure_ascii=False))
        n += 1
    rows = ["# Source licenses and provenance", "", "Generated by `python -m datahub.report` from `registry/sources.json`. Licenses are the declared licenses on each "
            "source's Hugging Face card (read 2026-11-14). Third-party data is **not** stored in this repository: only references, hashes and manifests "
            "(per-file SHA-256 in `../provenance/`).", "",
            "Only `approved` sources are ingested; `review_required`/`conditional` sources are quarantined until a person decides; `rejected` and "
            "`unavailable` sources are never used. Evaluation-only sources are never mixed into training.", "",
            "| Source | Status | Use | Origin | License | Commercial | Revision | Attribution / obligations | Upstream risk | Reason |", "|---|---|---|---|---|---|---|---|---|---|"]
    for s in reg["sources"]:
        obl = (s.get("attribution") or "") + (" · share-alike" if s.get("share_alike") else "")
        rows.append(f"| {s['name']} | {s['status']} | {s['use']} | {s['origin']} | {s.get('license')} | {s.get('commercial_use')} | "
                    f"{(s.get('revision') or '')[:12]} | {obl} | {s.get('upstream_risk') or ''} | {s.get('reason', '')} |".replace("\n", " "))
    (ROOT / "datasets" / "sources" / "licenses" / "README.md").write_text("\n".join(rows) + "\n")
    return n


def main() -> None:
    write_source_reports()
    mans = {m: load(m) for m in MODELS}
    reqs = {m: requirements(x) for m, x in mans.items() if x}
    (ROOT / "reports" / "domain_requirements.json").write_text(json.dumps(reqs, indent=1, ensure_ascii=False))
    L = ["# Dataset status, remaining requirements and blockers", "",
         "Generated by `python -m datahub.report` from `datasets/<model>/manifest.json`. Every number is read from a manifest.", "",
         "## Summary", "",
         "| Model | Accepted | Target | Remaining | Synthetic | Human-reviewed / required | Failed gates | production_ready |", "|---|---|---|---|---|---|---|---|"]
    for m, man in mans.items():
        if not man:
            L.append(f"| {m} | — | — | — | — | — | no manifest | false |"); continue
        r = reqs[m]
        L.append(f"| {m} | {r['accepted']:,} | {r['target_records']:,} | {r['remaining_records']:,} | {man['synthetic_ratio']:.1%} | "
                 f"{r['human_review']['accepted']:,} / {r['human_review']['required']:,} | {', '.join(r['failed_gates']) or '—'} | {str(man['production_ready']).lower()} |")
    L += ["", "## Blockers", ""] + [f"- **{t}.** {d}" for t, d in BLOCKERS]
    L += ["", "## Remaining domain requirements", "",
          "`remaining` = records still missing from the selection; `pool` = eligible records available to that model. "
          "When `pool` < `required`, the gap needs new licensed or human-authored data.", ""]
    for m, r in reqs.items():
        gaps = {d: v for d, v in r["domains"].items() if v["remaining"]}
        over = {d: v for d, v in r["domain_max"].items() if v["share"] > v["max_share"]}
        L.append(f"### {m}")
        if not gaps and not over:
            L += ["", "All domain minimums and maximums met.", ""]; continue
        L += ["", "| Domain | Required | Selected | Remaining | Pool | Needs new data |", "|---|---|---|---|---|---|"]
        L += [f"| {d} | {v['required']:,} | {v['selected']:,} | **{v['remaining']:,}** | {v['eligible_in_pool']:,} | {'yes' if v['needs_new_data'] else 'no (selection)'} |"
              for d, v in gaps.items()]
        L += [f"| {d} (max share) | ≤ {v['max_share']} | {v['share']} | over cap | | |" for d, v in over.items()]
        L.append("")
    L += ["## Remaining language requirements", ""]
    for m, r in reqs.items():
        gaps = {l: v for l, v in r["languages"].items() if v["remaining"]}
        L.append(f"- **{m}**: " + ("all language minimums met" if not gaps else
                 "; ".join(f"{l} {v['selected']:,}/{v['required']:,} (needs {v['remaining']:,}, pool {v['eligible_in_pool']:,})" for l, v in gaps.items())))
    L += ["", "## Per-model detail", ""]
    for m, man in mans.items():
        if not man:
            continue
        L += [f"### {m}", "", f"Dataset version `{man['dataset_version']}` · fingerprint `{man['content_fingerprint_sha256'][:16]}…` · "
              f"train/eval/test {man['counts']['train']:,}/{man['counts']['eval']:,}/{man['counts']['test']:,}", ""]
        L += [f"- {'PASS' if g['passed'] else '**FAIL**'} `{k}` — {g['detail'] if isinstance(g['detail'], str) else json.dumps(g['detail'], ensure_ascii=False)}"
              for k, g in man["gates"].items()]
        for title, key in (("Languages", "by_language"), ("Domains", "by_domain"), ("Sources", "by_source"), ("Origins", "by_origin"),
                           ("Review states", "by_review_state")):
            L += ["", f"{title}: " + ", ".join(f"{k} {v:,}" for k, v in man[key].items())]
        if man.get("upstream_risks"):
            L += ["", "Upstream risks: " + "; ".join(f"{k}: {v}" for k, v in man["upstream_risks"].items())]
        L.append("")
    (ROOT / "reports" / "dataset_status.md").write_text("\n".join(L) + "\n")
    print(ROOT / "reports" / "dataset_status.md")


if __name__ == "__main__":
    main()
