"""Approx AI release-artifact rules, shared by the training pipeline (which writes releases) and the
inference server (which loads them). Standard library only.

The same rules are enforced independently by the Node backend in backend/src/registry.js; keep both in step.

Layout:
    <models_dir>/<model-id>/versions/<x.y.z>/
        adapter/adapter_model.safetensors, adapter_config.json, tokenizer files
        release.json  metadata.json  evaluation.json  training.json
        SHA256SUMS    (every file, "<sha256>  <relative path>")
        SIGNATURE     (optional HMAC-SHA256 of SHA256SUMS)
    <models_dir>/active.json     which version of each model is live
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import tarfile
from pathlib import Path

RELEASE_SCHEMA = "approx.release/v1"
ACTIVE_SCHEMA = "approx.active/v1"
VERSION_RE = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9][a-z0-9.]{0,30})?$")
MODEL_ID_RE = re.compile(r"^[a-z][a-z0-9.-]{1,40}$")
ALLOWED_EXT = {".safetensors", ".json", ".txt", ".model", ".jinja", ".md"}
ALLOWED_BARE = {"SHA256SUMS", "SIGNATURE"}
REQUIRED_FILES = ["release.json", "metadata.json", "adapter/adapter_model.safetensors", "adapter/adapter_config.json"]
STATUSES = ("validated", "failed", "smoke_test")
MODEL_KINDS = ("language_model", "code_model", "multimodal_model", "video_pipeline")
MAX_FILES = 200

REPO_ROOT = Path(__file__).resolve().parent.parent


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_catalog(path=None) -> dict:
    """The model catalog (single source of truth for model ids, kinds and base models)."""
    p = Path(path or os.environ.get("APPROX_MODEL_CATALOG") or REPO_ROOT / "backend" / "config" / "models.json")
    data = json.loads(p.read_text(encoding="utf-8"))
    return {m["id"]: m for m in data["models"]}


def allowed_file(rel: str) -> bool:
    if rel in ALLOWED_BARE:
        return True
    base = rel.rsplit("/", 1)[-1]
    if base.startswith("."):
        return False
    return os.path.splitext(base)[1].lower() in ALLOWED_EXT


def safe_rel(rel) -> bool:
    return (isinstance(rel, str) and 0 < len(rel) < 300 and not rel.startswith("/") and "\\" not in rel and "\0" not in rel
            and all(seg and seg not in (".", "..") for seg in rel.split("/")))


def _walk(root: Path, errors: list) -> list:
    out = []

    def rec(abs_dir: Path, rel: str):
        for name in sorted(os.listdir(abs_dir)):
            a = abs_dir / name
            r = f"{rel}/{name}" if rel else name
            if a.is_symlink():
                errors.append(f"symlink not allowed: {r}")
            elif a.is_dir():
                rec(a, r)
            elif a.is_file():
                out.append(r)
            else:
                errors.append(f"special file not allowed: {r}")
            if len(out) > MAX_FILES:
                errors.append(f"too many files (> {MAX_FILES})")
                return

    rec(root, "")
    return out


def compare_versions(a: str, b: str) -> int:
    pa = [int(x) for x in a.split("-")[0].split(".")]
    pb = [int(x) for x in b.split("-")[0].split(".")]
    if pa != pb:
        return -1 if pa < pb else 1
    sa, sb = "-" in a, "-" in b
    if sa != sb:
        return -1 if sa else 1
    return (a > b) - (a < b)


def write_sha256sums(release_dir, signing_key: str = "") -> str:
    """Write SHA256SUMS (and SIGNATURE when a key is given) for a finished release directory."""
    d = Path(release_dir)
    for stale in ("SHA256SUMS", "SIGNATURE"):
        if (d / stale).exists():
            (d / stale).unlink()
    errors: list = []
    files = _walk(d, errors)
    bad = [f for f in files if not allowed_file(f)]
    if errors or bad:
        raise ValueError(f"release directory contains files that are not allowed in an artifact: {errors + bad}")
    body = "".join(f"{sha256_file(d / f)}  {f}\n" for f in files)
    (d / "SHA256SUMS").write_text(body, encoding="utf-8")
    if signing_key:
        (d / "SIGNATURE").write_text(hmac.new(signing_key.encode(), body.encode(), hashlib.sha256).hexdigest() + "\n", encoding="utf-8")
    return body


def verify_release_dir(release_dir, model_id: str, version: str, catalog: dict | None = None, signing_key: str | None = None) -> dict:
    """Verify one release directory. Returns {ok, errors, release, files, bytes, adapter_sha256, signed}."""
    if signing_key is None:
        signing_key = os.environ.get("APPROX_RELEASE_SIGNING_KEY", "")
    if catalog is None:
        catalog = load_catalog()
    errors: list = []
    result = {"ok": False, "errors": errors, "release": None, "files": 0, "bytes": 0, "adapter_sha256": None, "signed": False}
    d = Path(release_dir)
    if d.is_symlink() or not d.is_dir():
        errors.append("release directory does not exist")
        return result
    files = _walk(d, errors)
    result["files"] = len(files)
    errors.extend(f"disallowed file type: {f}" for f in files if not allowed_file(f))

    sums: dict = {}
    if "SHA256SUMS" not in files:
        errors.append("SHA256SUMS is missing")
    else:
        raw = (d / "SHA256SUMS").read_text(encoding="utf-8")
        for line in raw.split("\n"):
            if not line.strip():
                continue
            m = re.match(r"^([a-f0-9]{64}) {2}(.+)$", line)
            if not m or not safe_rel(m.group(2)):
                errors.append(f"malformed SHA256SUMS line: {line[:80]}")
                continue
            if m.group(2) in sums:
                errors.append(f"duplicate SHA256SUMS entry: {m.group(2)}")
            sums[m.group(2)] = m.group(1)
        errors.extend(f"file not listed in SHA256SUMS: {f}" for f in files if f not in ALLOWED_BARE and f not in sums)
        for f, expected in sums.items():
            if f not in files:
                errors.append(f"listed file is missing: {f}")
                continue
            result["bytes"] += (d / f).stat().st_size
            if sha256_file(d / f) != expected:
                errors.append(f"SHA-256 mismatch: {f}")
        if "SIGNATURE" in files and signing_key:
            want = hmac.new(signing_key.encode(), raw.encode(), hashlib.sha256).hexdigest()
            if hmac.compare_digest((d / "SIGNATURE").read_text(encoding="utf-8").strip(), want):
                result["signed"] = True
            else:
                errors.append("SIGNATURE does not match (wrong signing key or modified artifact)")
    errors.extend(f"required file is missing: {f}" for f in REQUIRED_FILES if f not in files)
    if signing_key and not result["signed"] and not any(e.startswith("SIGNATURE") for e in errors):
        errors.append("release is not signed but APPROX_RELEASE_SIGNING_KEY is configured")

    rel = None
    if "release.json" in files:
        try:
            rel = json.loads((d / "release.json").read_text(encoding="utf-8"))
        except ValueError:
            errors.append("release.json is not valid JSON")
    if rel is not None and not isinstance(rel, dict):
        errors.append("release.json must be an object")
        rel = None
    if rel:
        cat = catalog.get(model_id)
        if rel.get("schema") != RELEASE_SCHEMA:
            errors.append(f"release.json: schema must be {RELEASE_SCHEMA}")
        if rel.get("model_id") != model_id:
            errors.append(f"release.json: model_id '{rel.get('model_id')}' does not match directory '{model_id}'")
        if rel.get("version") != version:
            errors.append(f"release.json: version '{rel.get('version')}' does not match directory '{version}'")
        if rel.get("status") not in STATUSES:
            errors.append(f"release.json: status must be one of {', '.join(STATUSES)}")
        if not isinstance(rel.get("production_ready"), bool):
            errors.append("release.json: production_ready must be a boolean")
        if not isinstance(rel.get("blockers"), list):
            errors.append("release.json: blockers must be an array")
        if not isinstance(rel.get("base_model"), str) or not rel.get("base_model"):
            errors.append("release.json: base_model is required")
        if rel.get("kind") not in MODEL_KINDS:
            errors.append(f"release.json: kind must be one of {', '.join(MODEL_KINDS)}")
        smoke = rel.get("smoke_test") is True
        if not cat:
            errors.append(f"model '{model_id}' is not in the model catalog")
        else:
            if rel.get("kind") and rel["kind"] != cat["kind"]:
                errors.append(f"release.json: kind '{rel['kind']}' does not match catalog kind '{cat['kind']}'")
            if not smoke and cat.get("base_model") and rel.get("base_model") != cat["base_model"]:
                errors.append(f"base model mismatch: release was trained on '{rel.get('base_model')}' but {cat['name']} is defined on '{cat['base_model']}'")
        weights = sums.get("adapter/adapter_model.safetensors")
        result["adapter_sha256"] = weights
        if not re.match(r"^[a-f0-9]{64}$", str(rel.get("adapter_sha256"))):
            errors.append("release.json: adapter_sha256 must be a SHA-256 hex digest")
        elif weights and rel["adapter_sha256"] != weights:
            errors.append("release.json: adapter_sha256 does not match adapter/adapter_model.safetensors")
        if smoke and rel.get("status") != "smoke_test":
            errors.append("release.json: a smoke-test artifact must have status smoke_test")
        if rel.get("status") == "smoke_test" and not smoke:
            errors.append("release.json: status smoke_test requires smoke_test=true")
        verification = rel.get("verification") or {}
        if rel.get("production_ready") is True:
            why = []
            if rel.get("status") != "validated":
                why.append("status is not validated")
            if smoke:
                why.append("smoke test")
            if rel.get("blockers"):
                why.append("blockers are listed")
            if verification.get("passed") is not True:
                why.append("verification did not pass")
            if (rel.get("evaluation") or {}).get("gate_passed") is not True:
                why.append("quality gate did not pass")
            if (rel.get("dataset") or {}).get("production_ready") is not True:
                why.append("dataset is not production-ready")
            if why:
                errors.append(f"release.json: production_ready=true contradicts the release evidence ({'; '.join(why)})")
        if rel.get("status") == "validated" and verification.get("passed") is not True:
            errors.append("release.json: status validated requires verification.passed=true")
    result["release"] = rel
    result["ok"] = not errors
    return result


def release_dir(models_dir, model_id: str, version: str) -> Path:
    if not MODEL_ID_RE.match(model_id) or not VERSION_RE.match(version):
        raise ValueError(f"invalid model id or version: {model_id!r} {version!r}")
    return Path(models_dir) / model_id / "versions" / version


def list_versions(models_dir, model_id: str) -> list:
    d = Path(models_dir) / model_id / "versions"
    if not d.is_dir():
        return []
    import functools
    return sorted((v for v in os.listdir(d) if VERSION_RE.match(v) and (d / v).is_dir()), key=functools.cmp_to_key(compare_versions))


def next_version(models_dir, model_id: str, start: str = "1.0.0") -> str:
    """Releases are immutable: every pipeline run that produces an artifact gets a new patch version."""
    have = [v for v in list_versions(models_dir, model_id) if "-" not in v]
    if not have:
        return start
    a, b, c = (int(x) for x in have[-1].split("."))
    return f"{a}.{b}.{c + 1}"


def read_active(models_dir) -> dict:
    """{model_id: entry}. Unreadable or malformed → nothing active (fail closed)."""
    try:
        raw = json.loads((Path(models_dir) / "active.json").read_text(encoding="utf-8"))
        act = raw.get("active")
        if not isinstance(act, dict):
            return {}
        return {k: v for k, v in act.items() if MODEL_ID_RE.match(k) and isinstance(v, dict) and VERSION_RE.match(str(v.get("version")))}
    except (OSError, ValueError, AttributeError):
        return {}


def pack_release(models_dir, model_id: str, version: str, out_file) -> dict:
    """Portable archive `<model-id>/versions/<version>/…` accepted by the backend import endpoint and CLI."""
    src = release_dir(models_dir, model_id, version)
    out = Path(out_file)
    out.parent.mkdir(parents=True, exist_ok=True)
    prefix = f"{model_id}/versions/{version}"

    def clean(ti: tarfile.TarInfo):
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        ti.mode = 0o755 if ti.isdir() else 0o644
        return ti if (ti.isdir() or ti.isfile()) else None

    with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for part in (model_id, f"{model_id}/versions", prefix):
            ti = tarfile.TarInfo(part)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            tar.addfile(ti)
        for name in sorted(os.listdir(src)):
            tar.add(src / name, arcname=f"{prefix}/{name}", filter=clean)
    return {"file": str(out), "sha256": sha256_file(out), "bytes": out.stat().st_size}
