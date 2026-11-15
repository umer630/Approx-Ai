"""Reproducible dataset distribution through the GitHub repository (Git LFS).

    python -m datahub.dist pack    [--models …]   # builds → training/datasets/dist/<model>/*.jsonl.gz shards + DATASETS.lock.json
    python -m datahub.dist restore [--models …]   # LFS shards → verified training/datasets/<model>/build/ (no rebuild)
    python -m datahub.dist verify  [--models …]   # check local builds against the committed lock

Layout (committed):
  training/datasets/DATASETS.lock.json          SHA-256 of every split (uncompressed JSONL) and every shard (gzip), counts,
                                                dataset version + content fingerprint (normal Git: small, reviewable)
  training/datasets/dist/<model>/<split>.<n>.jsonl.gz   deterministic gzip shards (≤ SHARD_BYTES of JSONL each), stored
                                                in Git LFS (.gitattributes) so normal clones and Vercel deploys stay small

restore is fail-closed: a shard or split whose SHA-256 differs from the lock is refused; nothing is regenerated. It
pulls only the LFS objects of the requested models (`git lfs pull --include`), so Nick alone downloads ~15 MB.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]           # training/
REPO = ROOT.parent
DATASETS = ROOT / "datasets"
DIST = DATASETS / "dist"
LOCK = DATASETS / "DATASETS.lock.json"
MODELS = ["nick-4.8", "hike-6.5", "sona-9.0", "fab-100x", "fab-500x"]
# Extra, separately addressable dataset versions (not trained by default): the original FAB 100X build (90,000 records,
# fingerprint 52df9c56…) kept exactly as validated before the target was raised to 100,000.
EXTRA = ["fab-100x-90k"]
SPLITS = ["train", "eval", "test"]
SHARD_BYTES = 160 * 1024 * 1024      # uncompressed JSONL per shard (~40–60 MB gzip)
TARGETS = {"nick-4.8": 30000, "hike-6.5": 50000, "sona-9.0": 70000, "fab-100x": 100000, "fab-500x": 500000, "fab-100x-90k": 90000}


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _gz(data: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as g:   # deterministic bytes
        g.write(data)
    return buf.getvalue()


def pack(models=MODELS) -> dict:
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {"schema": "approx.dataset-lock/v1", "models": {}}
    for m in models:
        build = DATASETS / m / "build"
        man = json.loads((build / "manifest.json").read_text())
        if man["counts"]["total"] != TARGETS[m]:
            raise SystemExit(f"{m}: build has {man['counts']['total']} records, approved target is {TARGETS[m]} — refusing to pack")
        out = DIST / m
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        entry = {"dataset_version": man["dataset_version"], "content_fingerprint_sha256": man["content_fingerprint_sha256"],
                 "target_records": TARGETS[m], "counts": man["counts"], "production_ready": man["production_ready"],
                 "review_basis": man.get("review_basis"), "manifest_sha256": sha256_file(build / "manifest.json"), "splits": {}}
        shutil.copy2(build / "manifest.json", out / "manifest.json")
        for s in SPLITS:
            src = build / f"{s}.jsonl"
            if sha256_file(src) != man["files"][f"{s}.jsonl"]["sha256"]:
                raise SystemExit(f"{m}/{s}: build file does not match its manifest")
            shards, cur, n, lines = [], [], 0, 0
            def flush():
                nonlocal cur, n
                if not cur:
                    return
                name = f"{s}.{len(shards):03d}.jsonl.gz"
                data = _gz(b"".join(cur))
                (out / name).write_bytes(data)
                shards.append({"path": f"training/datasets/dist/{m}/{name}", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
                cur, n = [], 0
            with open(src, "rb") as f:
                for line in f:
                    cur.append(line); n += len(line); lines += 1
                    if n >= SHARD_BYTES:
                        flush()
            flush()
            entry["splits"][s] = {"sha256": man["files"][f"{s}.jsonl"]["sha256"], "records": lines, "bytes": src.stat().st_size, "shards": shards}
        lock["models"][m] = entry
        print(f"{m:10s} {man['counts']['total']:7d} records → {sum(len(v['shards']) for v in entry['splits'].values())} shards "
              f"({sum(x['bytes'] for v in entry['splits'].values() for x in v['shards']) / 1e6:.1f} MB gzip)")
    LOCK.write_text(json.dumps(lock, indent=1) + "\n")
    return lock


def _is_lfs_pointer(p: Path) -> bool:
    try:
        with open(p, "rb") as f:
            return f.read(64).startswith(b"version https://git-lfs.github.com/spec/")
    except FileNotFoundError:
        return True


def _lfs_pull(paths: list[str]):
    if not paths:
        return
    if shutil.which("git-lfs") is None and subprocess.run(["git", "lfs", "version"], capture_output=True).returncode != 0:
        raise SystemExit("git-lfs is required to download the dataset shards (apt-get install git-lfs; git lfs install)")
    subprocess.run(["git", "lfs", "install", "--local"], cwd=REPO, check=False, capture_output=True)
    rc = subprocess.run(["git", "lfs", "pull", "--include", ",".join(paths), "--exclude", ""], cwd=REPO).returncode
    if rc != 0:
        raise SystemExit(f"git lfs pull failed (exit {rc}). Check network access to GitHub LFS and the repository's LFS quota.")


def _from_drive(drive: Path | None, m: str, x: dict) -> bool:
    """Use a verified shard copy from Google Drive (Colab) instead of downloading it again."""
    if not drive:
        return False
    src = drive / m / Path(x["path"]).name
    dst = REPO / x["path"]
    if src.exists() and src.stat().st_size == x["bytes"] and sha256_file(src) == x["sha256"]:
        if not (dst.exists() and not _is_lfs_pointer(dst) and sha256_file(dst) == x["sha256"]):
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
        return True
    return False


def _to_drive(drive: Path | None, m: str, e: dict):
    """Mirror the verified shards + manifest to Drive so the next Colab session restores without GitHub LFS."""
    if not drive:
        return
    out = drive / m
    out.mkdir(parents=True, exist_ok=True)
    for s in SPLITS:
        for x in e["splits"][s]["shards"]:
            dst = out / Path(x["path"]).name
            if not (dst.exists() and dst.stat().st_size == x["bytes"]):
                shutil.copyfile(REPO / x["path"], dst)
    shutil.copyfile(DIST / m / "manifest.json", out / "manifest.json")
    (out / "SHA256SUMS").write_text("".join(f"{x['sha256']}  {Path(x['path']).name}\n" for s in SPLITS for x in e["splits"][s]["shards"]))


def restore(models=MODELS, force=False, drive_dir=None) -> dict:
    lock = json.loads(LOCK.read_text())
    report = {}
    for m in models:
        e = lock["models"].get(m)
        if not e:
            raise SystemExit(f"{m}: not in {LOCK.name}")
        build = DATASETS / m / "build"
        if not force and verify_one(m, e, quiet=True):
            report[m] = "already present and verified"
            if drive_dir and all(not _is_lfs_pointer(REPO / x["path"]) for s in SPLITS for x in e["splits"][s]["shards"]):
                _to_drive(Path(drive_dir), m, e)
            continue
        drive = Path(drive_dir) if drive_dir else None
        shards = [x for s in SPLITS for x in e["splits"][s]["shards"]]
        from_drive = sum(_from_drive(drive, m, x) for x in shards)
        need = [x["path"] for x in shards if _is_lfs_pointer(REPO / x["path"])]
        _lfs_pull(need)
        build.mkdir(parents=True, exist_ok=True)
        for s in SPLITS:
            sp = e["splits"][s]
            tmp = build / f".{s}.jsonl.part"
            h = hashlib.sha256()
            with open(tmp, "wb") as out:
                for x in sp["shards"]:
                    p = REPO / x["path"]
                    if _is_lfs_pointer(p):
                        raise SystemExit(f"{x['path']} is still an LFS pointer after git lfs pull")
                    if sha256_file(p) != x["sha256"]:
                        raise SystemExit(f"{x['path']}: SHA-256 mismatch with {LOCK.name} — refusing to restore")
                    data = gzip.decompress(p.read_bytes())
                    h.update(data); out.write(data)
            if h.hexdigest() != sp["sha256"]:
                tmp.unlink()
                raise SystemExit(f"{m}/{s}.jsonl: SHA-256 {h.hexdigest()[:12]}… != lock {sp['sha256'][:12]}… — refusing to restore")
            tmp.replace(build / f"{s}.jsonl")
        shutil.copy2(DIST / m / "manifest.json", build / "manifest.json")
        if not verify_one(m, e):
            raise SystemExit(f"{m}: restored files failed verification")
        _to_drive(drive, m, e)
        report[m] = f"restored and verified ({from_drive}/{len(shards)} shards from Drive, {len(need)} from GitHub LFS)"
    return report


def verify_one(m: str, e: dict, quiet=False) -> bool:
    build = DATASETS / m / "build"
    try:
        man = json.loads((build / "manifest.json").read_text())
    except FileNotFoundError:
        return False
    ok = man["content_fingerprint_sha256"] == e["content_fingerprint_sha256"] and man["counts"] == e["counts"]
    for s in SPLITS:
        p = build / f"{s}.jsonl"
        ok = ok and p.exists() and p.stat().st_size == e["splits"][s]["bytes"] and sha256_file(p) == e["splits"][s]["sha256"]
    if not quiet:
        print(f"{m:10s} {'OK ' if ok else 'BAD'} {e['counts']['total']} records · {e['dataset_version']}")
    return ok


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m datahub.dist")
    ap.add_argument("cmd", choices=["pack", "restore", "verify"])
    ap.add_argument("--models", nargs="*", default=MODELS)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--drive-dir", default=None, help="Colab: Drive folder for verified shard copies (read first, written after restore)")
    a = ap.parse_args(argv)
    models = MODELS if a.models in (["all"], []) else a.models
    bad = [m for m in models if m not in MODELS + EXTRA]
    if bad:
        raise SystemExit(f"unknown dataset(s) {bad}; choose from {MODELS + EXTRA}")
    if a.cmd == "pack":
        pack(models)
    elif a.cmd == "restore":
        for k, v in restore(models, a.force, a.drive_dir).items():
            print(f"{k:10s} {v}")
    else:
        lock = json.loads(LOCK.read_text())
        return 0 if all(verify_one(m, lock["models"][m]) for m in models) else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
