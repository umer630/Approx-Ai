"""Package a trained + verified adapter.

    python package_adapter.py --adapter <out>/adapter

Produces in <out>/ :
  nick-4.8-adapter-<version>.tar.gz   (the real adapter files — adapter_model.safetensors etc.)
  verification.json                   (copy of the real verification report)
  SHA256SUMS                          (tarball, verification.json, and every file inside the adapter)

Refuses to package if adapter_model.safetensors is missing/empty, if verification.json is missing, or if the
adapter is a smoke test (smoke runs are packaged as SMOKE-TEST-NOT-NICK-*.tar.gz so they can never be confused
with Nick). A FAILED verification is still packaged (for inspection) but the status line says FAILED.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def deterministic_targz(src_dir: Path, arc_root: str, dest: Path) -> None:
    """Sorted entries, fixed mtime/uid/gid, gzip mtime 0 → same files ⇒ same tarball hash."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for p in sorted(src_dir.rglob("*")):
            if not p.is_file():
                continue
            info = tar.gettarinfo(str(p), arcname=f"{arc_root}/{p.relative_to(src_dir).as_posix()}")
            info.mtime, info.uid, info.gid, info.uname, info.gname, info.mode = 0, 0, 0, "", "", 0o644
            with p.open("rb") as f:
                tar.addfile(info, f)
    with dest.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
        gz.write(buf.getvalue())


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    a = ap.parse_args(argv)
    adir = Path(a.adapter).resolve()
    out = adir.parent
    weights = adir / "adapter_model.safetensors"
    if not weights.exists() or weights.stat().st_size == 0:
        print("REFUSED: adapter_model.safetensors missing or empty — nothing real to package.", file=sys.stderr)
        return 2
    ver_path = adir / "verification.json"
    if not ver_path.exists():
        print("REFUSED: verification.json missing — run verify_adapter.py first.", file=sys.stderr)
        return 2
    manifest = json.loads((adir / "approx_adapter_manifest.json").read_text())
    verification = json.loads(ver_path.read_text(encoding="utf-8"))
    smoke = bool(manifest.get("smoke_test") or verification.get("smoke_test"))
    version = manifest["adapter_version"]
    name = f"SMOKE-TEST-NOT-NICK-adapter-{version}.tar.gz" if smoke else f"nick-4.8-adapter-{version}.tar.gz"
    tarball = out / name
    deterministic_targz(adir, "adapter", tarball)
    (out / "verification.json").write_bytes(ver_path.read_bytes())

    lines = [(sha256_file(tarball), name), (sha256_file(out / "verification.json"), "verification.json")]
    lines += [(sha256_file(p), f"adapter/{p.relative_to(adir).as_posix()}") for p in sorted(adir.rglob("*")) if p.is_file()]
    (out / "SHA256SUMS").write_text("".join(f"{h}  {n}\n" for h, n in lines))

    # self-check: re-read the tarball and confirm the safetensors inside matches the file on disk
    with tarfile.open(tarball, "r:gz") as tar:
        member = tar.extractfile("adapter/adapter_model.safetensors")
        inner = sha256_bytes(member.read()) if member else None
    ok_inner = inner == sha256_file(weights)
    status = "SMOKE TEST (not Nick)" if smoke else ("VERIFIED" if verification.get("verification_passed") else "VERIFICATION FAILED")
    summary = {"status": status, "tarball": str(tarball), "tarball_sha256": lines[0][0], "tarball_bytes": tarball.stat().st_size,
               "adapter_model.safetensors_sha256": sha256_file(weights), "safetensors_inside_tarball_matches": ok_inner,
               "verification_passed": verification.get("verification_passed"), "SHA256SUMS": str(out / "SHA256SUMS")}
    (out / "package_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0 if ok_inner else 1


if __name__ == "__main__":
    sys.exit(main())
