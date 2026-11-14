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
    rs = sub.add_parser("review-sheet", help="export a random sample for HUMAN reviewers (CSV)")
    rs.add_argument("--model", required=True); rs.add_argument("--n", type=int, default=500); rs.add_argument("--out", required=True)
    ri = sub.add_parser("review-import", help="import a completed review CSV (reviewer + verdict columns required)")
    ri.add_argument("--csv", required=True); ri.add_argument("--model", required=True)
    a = ap.parse_args(argv)
    reg = pipeline.load_registry()
    if a.cmd == "sources":
        for s in reg["sources"]:
            print(f"{s['status']:16s} {s['use']:9s} {s['origin']:18s} {str(s['license']):16s} {s['id']}")
    elif a.cmd == "fetch":
        for s in reg["sources"]:
            if s["status"] == "approved" and s["connector"]["type"] == "hf_parquet" and (not a.only or s["id"] in a.only):
                prov = connectors.fetch_hf(s)
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
        import random
        rows = [json.loads(l) for l in (pipeline.DATASETS / a.model / "build" / "train.jsonl").read_text(encoding="utf-8").splitlines()]
        rnd = random.Random(f"review-{a.model}")
        sample = rnd.sample(rows, min(a.n, len(rows)))
        with open(a.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["record_id", "lang", "domain", "source", "prompt", "answer", "reviewer", "verdict", "notes"])
            for r in sample:
                u = next(m["content"] for m in r["messages"] if m["role"] == "user")
                w.writerow([r["id"], r["lang"], r["domain"], r["source"], u, r["messages"][-1]["content"], "", "", ""])
        print(f"wrote {len(sample)} rows to {a.out}: a person fills 'reviewer' and 'verdict' (accept/reject) for each row")
    elif a.cmd == "review-import":
        out = pipeline.REVIEWS / f"{a.model}.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        n = 0
        with open(a.csv, encoding="utf-8") as fh, open(out, "a", encoding="utf-8") as o:
            for r in csv.DictReader(fh):
                if (r.get("reviewer") or "").strip() and r.get("verdict") in ("accept", "reject"):
                    o.write(json.dumps({"record_id": r["record_id"], "reviewer": r["reviewer"].strip(), "verdict": r["verdict"],
                                        "notes": r.get("notes", ""), "imported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}) + "\n")
                    n += 1
        print(f"imported {n} human reviews (rows without a reviewer name or verdict are ignored)")


if __name__ == "__main__":
    sys.exit(main())
