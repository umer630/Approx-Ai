"""CLI: python -m datahub {sources|fetch|build|review-sheet|review-import} …"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

from . import connectors, pipeline

MODELS = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m datahub")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sources", help="list the registry with status/license")
    f = sub.add_parser("fetch", help="download approved Hub sources into the cache (provenance recorded)")
    f.add_argument("--only", nargs="*")
    b = sub.add_parser("build", help="build model datasets")
    b.add_argument("--models", nargs="*", default=MODELS)
    b.add_argument("--offline", action="store_true", help="use cached sources only")
    b.add_argument("--curriculum-scale", type=float, default=1.0)
    es = sub.add_parser("eval-suites", help="build evaluation suites from evaluation-only sources")
    es.add_argument("--offline", action="store_true")
    rs = sub.add_parser("review-sheet", help="issue stratified CSV review sheets for HUMAN reviewers")
    rs.add_argument("--model", required=True)
    rs.add_argument("--n", type=int, default=None, help="rows (default: remaining requirement + 10%%)")
    rs.add_argument("--batch", type=int, default=100)
    ri = sub.add_parser("review-import", help="validate a completed sheet and append its decisions to the ledger")
    ri.add_argument("--csv", required=True, nargs="+"); ri.add_argument("--model", required=True)
    sub.add_parser("validate", help="re-derive and check every dataset gate → reports/validation_report.md")
    rp = sub.add_parser("review-progress", help="per-model human review progress → reports/human_review_progress.md")
    rp.add_argument("--models", nargs="*", default=MODELS)
    a = ap.parse_args(argv)
    reg = pipeline.load_registry()
    if a.cmd == "sources":
        for s in reg["sources"]:
            print(f"{s['status']:16s} {s['use']:9s} {s['origin']:18s} {str(s['license']):16s} {s['id']}")
    elif a.cmd == "fetch":
        for s in reg["sources"]:
            kind = s["connector"]["type"]
            if s["status"] == "approved" and kind in ("hf_parquet", "hf_files") and (not a.only or s["id"] in a.only):
                prov = connectors.fetch_hf(s) if kind == "hf_parquet" else connectors.fetch_hf_files(s)
                print(f"{s['id']:22s} files={len(prov)} bytes={sum(p['bytes'] for p in prov)}")
    elif a.cmd == "build":
        t = time.time()
        pool = pipeline.build_pool(reg, offline=a.offline, curriculum_scale=a.curriculum_scale)
        for m in a.models:
            man = pipeline.build_model(m, pool)
            failed = [k for k, g in man["gates"].items() if not g["passed"]]
            print(f"{m:10s} total={man['counts']['total']:7d} train={man['counts']['train']:7d} synthetic={man['synthetic_ratio']:.3f} "
                  f"production_ready={man['production_ready']} failed_gates={failed}")
        print(f"done in {time.time() - t:.0f}s")
    elif a.cmd == "eval-suites":
        for name, m in pipeline.build_eval_suites(reg, offline=a.offline).items():
            print(f"{name:20s} items={m['items']:6d} languages={len(m['by_language'])}")
    elif a.cmd == "review-sheet":
        from . import review
        paths = review.make_sheets(a.model, n=a.n, batch=a.batch)
        print(f"issued {len(paths)} sheet(s) for {a.model}" + (f" in {paths[0].parent}" if paths else " (requirement already met)"))
        print("reviewers: follow documentation/HUMAN_REVIEW.md — fill reviewer, verdict (accept/reject), issue_tags, notes; never edit prompt/answer")
    elif a.cmd == "review-import":
        from . import review
        rc = 0
        for c in a.csv:
            try:
                rep = review.import_sheet(Path(c), a.model)
            except ValueError as e:
                print(f"REFUSED {c}: {e}"); rc = 1; continue
            print(json.dumps(rep, indent=1, ensure_ascii=False))
            rc |= bool(rep["errors"])
        print("rebuild (`python -m datahub build`) so accepted reviews are counted; rejected records are excluded")
        return rc
    elif a.cmd == "validate":
        from . import validate
        res = validate.write(pipeline.TRAINING / "reports" / "validation_report.md")
        for c in res["global"]:
            print(f"{'global':10s} {c['status']:8s} {c['check']}")
        for m, cs in res["models"].items():
            for c in cs:
                print(f"{m:10s} {c['status']:8s} {c['check']}")
        return 1 if any(c["status"] == "FAIL" for cs in [res["global"], *res["models"].values()] for c in cs) else 0
    elif a.cmd == "review-progress":
        from . import review
        prog = review.write_progress_report(a.models, pipeline.TRAINING / "reports" / "human_review_progress.md")
        for m, p in prog.items():
            print(f"{m:10s} accepted={p['accepted_in_dataset']:6d} required={p['required']:6d} remaining={p['remaining']:6d} pending_rows={p['rows_pending']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
