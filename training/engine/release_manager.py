"""Write a registry-ready release artifact from a finished training run, using the shared rules in
approx_artifacts. Produces, under <models_dir>/<model>/versions/<version>/:
  adapter/            the LoRA adapter + tokenizer (safetensors only)
  release.json        machine-readable manifest (status, production_ready, blockers, hashes, evidence)
  metadata.json  evaluation.json  training.json
  SHA256SUMS          (+ SIGNATURE when a signing key is given)
The artifact is portable: no absolute /content paths. production_ready is true ONLY when every gate passed.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import approx_artifacts as art  # noqa: E402

ADAPTER_ALLOWED = {".safetensors", ".json", ".txt", ".model", ".jinja", ".md"}


def _copy_adapter(src_adapter: Path, dst_adapter: Path):
    dst_adapter.mkdir(parents=True, exist_ok=True)
    for f in sorted(src_adapter.iterdir()):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ADAPTER_ALLOWED and f.name not in ("SHA256SUMS",):
            continue   # never copy pickle / arbitrary files into a release
        shutil.copy2(f, dst_adapter / f.name)
    if not (dst_adapter / "adapter_model.safetensors").exists():
        raise FileNotFoundError("adapter_model.safetensors is missing from the training output")


def build_release(models_dir, model_cfg: dict, train_meta: dict, evaluation: dict, gate: dict, safety: dict, regression: dict,
                  adapter_dir: Path, version: str | None = None, signing_key: str = "", smoke: bool = False) -> dict:
    model_id = model_cfg["model_id"]
    version = version or art.next_version(models_dir, model_id)
    rdir = art.release_dir(models_dir, model_id, version)
    if rdir.exists():
        raise FileExistsError(f"version {version} already exists for {model_id} (releases are immutable)")
    rdir.mkdir(parents=True, exist_ok=True)
    _copy_adapter(Path(adapter_dir), rdir / "adapter")

    base_model = train_meta.get("base_model")
    catalog = art.load_catalog()
    cat = catalog.get(model_id, {})
    adapter_sha = art.sha256_file(rdir / "adapter/adapter_model.safetensors")

    blockers = []
    if not train_meta.get("dataset", {}).get("production_ready"):
        blockers.append("dataset is not production-ready")
    if not gate.get("passed"):
        for f in gate.get("failures", []):
            blockers.append(f"evaluation gate: {f['category']} — {f['reason']}")
    if not safety.get("passed"):
        blockers.append("safety gate did not pass")
    if regression and not regression.get("passed", True):
        blockers.append("regression test did not pass")
    if cat.get("base_model") and base_model and base_model != cat["base_model"] and not smoke:
        blockers.append(f"base model {base_model} does not match the catalog ({cat['base_model']})")
    license_blocker = model_cfg.get("license_blocker")
    if license_blocker:
        blockers.append(license_blocker)

    verification_passed = bool(train_meta.get("verification_passed", gate.get("passed")))
    status = "smoke_test" if smoke else ("validated" if (verification_passed and gate.get("passed") and safety.get("passed")) else "failed")
    production_ready = (not smoke and status == "validated" and not blockers and gate.get("passed") and safety.get("passed")
                       and train_meta.get("dataset", {}).get("production_ready") is True)

    release = {
        "schema": art.RELEASE_SCHEMA, "model_id": model_id, "version": version, "kind": cat.get("kind", model_cfg.get("kind", "language_model")),
        "status": status, "smoke_test": smoke, "production_ready": production_ready, "blockers": blockers,
        "base_model": base_model, "base_model_revision": train_meta.get("base_model_revision"),
        "adapter_path": "adapter", "adapter_sha256": adapter_sha, "adapter_bytes": (rdir / "adapter/adapter_model.safetensors").stat().st_size,
        "dataset": {"version": train_meta.get("dataset", {}).get("version"), "fingerprint": train_meta.get("dataset", {}).get("fingerprint"),
                    "production_ready": train_meta.get("dataset", {}).get("production_ready")},
        "evaluation": {"score": gate.get("adapter_score"), "base_score": gate.get("base_score"), "target": gate.get("required_score"),
                       "minimum": gate.get("required_score"), "gate_passed": gate.get("passed"), "improvement": gate.get("improvement")},
        "verification": {"passed": verification_passed, "safety_passed": safety.get("passed")},
        "training": {"method": train_meta.get("method"), "steps": train_meta.get("metrics", {}).get("global_step"),
                     "loss_first": train_meta.get("metrics", {}).get("loss_first"), "loss_last": train_meta.get("metrics", {}).get("loss_last"),
                     "gpu": train_meta.get("gpu"), "versions": train_meta.get("versions")},
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (rdir / "release.json").write_text(json.dumps(release, indent=2, ensure_ascii=False), encoding="utf-8")
    (rdir / "metadata.json").write_text(json.dumps({"model_id": model_id, "version": version, "display_name": model_cfg.get("display_name"),
                                                    "system_prompt": model_cfg.get("system_prompt", "").strip(), "base_model": base_model,
                                                    "training_config": model_cfg, "created_at": release["created_at"]}, indent=2, ensure_ascii=False), encoding="utf-8")
    (rdir / "evaluation.json").write_text(json.dumps({"gate": gate, "evaluation": evaluation, "safety": safety, "regression": regression}, indent=2, ensure_ascii=False), encoding="utf-8")
    (rdir / "training.json").write_text(json.dumps(train_meta, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

    art.write_sha256sums(rdir, signing_key=signing_key)
    v = art.verify_release_dir(rdir, model_id, version, catalog, signing_key=signing_key or None)
    if not v["ok"]:
        raise ValueError(f"release artifact failed its own verification: {v['errors']}")
    packed = art.pack_release(models_dir, model_id, version, Path(models_dir) / f"{model_id}-{version}.tar.gz")
    return {"model_id": model_id, "version": version, "dir": str(rdir), "status": status, "production_ready": production_ready,
            "blockers": blockers, "adapter_sha256": adapter_sha, "archive": packed, "release": release}
