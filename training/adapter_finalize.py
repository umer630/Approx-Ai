"""Shared adapter finalization: the ONE place that writes the final adapter directory's metadata + manifest, so
train_qlora.py (normal training) and recover_adapter.py (recovering a checkpoint) produce byte-for-byte the same
schema and SHA-256 logic. Also defines what a *finished* adapter directory must contain, used to fail closed.

A run is only "completed" when every REQUIRED_ADAPTER_FILES file is present. Anything less is "incomplete" and must
not be packaged or reported as a production training run.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

# Every finished adapter directory must contain these. verify_adapter.py and the packaging stage refuse without them.
REQUIRED_ADAPTER_FILES = [
    "adapter_model.safetensors",
    "adapter_config.json",
    "tokenizer_config.json",
    "training_config.json",
    "train_metadata.json",
    "approx_adapter_manifest.json",
]


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with Path(p).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def missing_required(adapter_dir) -> list:
    d = Path(adapter_dir)
    return [f for f in REQUIRED_ADAPTER_FILES if not (d / f).exists() or (d / f).stat().st_size == 0]


def write_adapter_manifest(adapter_dir, meta: dict) -> dict:
    """Write train_metadata.json + approx_adapter_manifest.json using the canonical schema.
    verification_passed / safety_passed are ALWAYS null here — only the real verifier sets them."""
    d = Path(adapter_dir)
    (d / "train_metadata.json").write_text(json.dumps(meta, indent=2, default=str))
    manifest = {
        "model_id": meta["model_id"],
        "adapter_version": meta["adapter_version"],
        "base_model": meta["base_model"],
        "base_model_revision": meta.get("base_model_revision"),
        "smoke_test": bool(meta.get("smoke_test")),
        "files_sha256": {p.name: sha256_file(p) for p in sorted(d.iterdir())
                         if p.is_file() and p.name != "approx_adapter_manifest.json"},
        "verification_passed": None,
        "safety_passed": None,
    }
    (d / "approx_adapter_manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest
