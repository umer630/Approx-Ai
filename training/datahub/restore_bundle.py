"""Restore prebuilt, checksummed dataset bundles (e.g. from Google Drive) into training/datasets/<model>/build.

    python -m datahub.restore_bundle --bundles-dir /content/drive/MyDrive/ApproxAI/datasets --models nick-4.8 hike-6.5

Fail-closed: a model whose bundle is missing, whose archive does not match SHA256SUMS, whose files do not match their
manifest, or whose content fingerprint differs from the manifest committed in this repository is refused — nothing is
regenerated silently. The runner then uses the restored, verified build (engine/runner.py:prepare_dataset).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def restore(model: str, bundles_dir: Path, datasets_dir: Path | None = None) -> dict:
    datasets_dir = Path(datasets_dir or TRAINING / "datasets")
    sums = {}
    sums_file = bundles_dir / "SHA256SUMS"
    if not sums_file.exists():
        raise SystemExit(f"{sums_file} not found — upload SHA256SUMS together with the bundles")
    for line in sums_file.read_text().split("\n"):
        if line.strip():
            h, name = line.split(None, 1)
            sums[name.strip()] = h
    found = sorted(bundles_dir.glob(f"{model}-*.tar.gz"))
    if len(found) != 1:
        raise SystemExit(f"{model}: expected exactly one bundle {model}-*.tar.gz in {bundles_dir}, found {len(found)}")
    tgz = found[0]
    if sums.get(tgz.name) != _sha(tgz):
        raise SystemExit(f"{model}: {tgz.name} does not match SHA256SUMS (corrupt or incomplete upload)")
    committed = json.loads((datasets_dir / model / "manifest.json").read_text())
    with tempfile.TemporaryDirectory() as tmp:
        with tarfile.open(tgz) as tf:
            names = tf.getnames()
            allowed = {f"{model}/build/{f}" for f in ("train.jsonl", "eval.jsonl", "test.jsonl", "manifest.json")}
            if set(names) - allowed:
                raise SystemExit(f"{model}: unexpected entries in bundle: {sorted(set(names) - allowed)[:5]}")
            try:
                tf.extractall(tmp, filter="data")
            except TypeError:                       # Python < 3.11.4: entry names were already validated above
                tf.extractall(tmp)
        b = Path(tmp) / model / "build"
        man = json.loads((b / "manifest.json").read_text())
        if man["content_fingerprint_sha256"] != committed["content_fingerprint_sha256"]:
            raise SystemExit(f"{model}: bundle fingerprint {man['content_fingerprint_sha256'][:12]}… != repository manifest "
                             f"{committed['content_fingerprint_sha256'][:12]}… (bundle is from a different build)")
        for name, meta in man["files"].items():
            if _sha(b / name) != meta["sha256"]:
                raise SystemExit(f"{model}: {name} does not match its manifest")
        dest = datasets_dir / model / "build"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(b, dest)
    return {"model": model, "dataset_version": man["dataset_version"], "records": man["counts"], "bundle": tgz.name}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m datahub.restore_bundle")
    ap.add_argument("--bundles-dir", required=True)
    ap.add_argument("--models", nargs="+", required=True)
    a = ap.parse_args(argv)
    for m in a.models:
        r = restore(m, Path(a.bundles_dir))
        print(f"{m:10s} restored {r['dataset_version']}  train/eval/test {r['records']['train']}/{r['records']['eval']}/{r['records']['test']}  (from {r['bundle']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
