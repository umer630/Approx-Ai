"""Report training results to the Approx backend model lifecycle (worker API, API key with scope training:worker).

    TRAINING (start) → TRAINING_COMPLETE (artifact: version, SHA-256, base + revision, location) → EVALUATING →
    VERIFIED (the release's verification report) — or FAILED with the exact reason.

The publisher never activates anything. Activation happens in the backend: once the model's inference server serves
exactly the VERIFIED version + adapter SHA-256, the backend runs its own deployment check (health, version, SHA,
production release, real generation) and only then sets ACTIVE (backend/src/lifecycle.js autoActivate).
A release that is not validated / not production-ready / has a failed verification is reported FAILED (NOT ACTIVATED).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path


class Publisher:
    def __init__(self, url: str, api_key: str, artifact_base: str | None = None, log=print):
        self.url = (url or "").rstrip("/")
        self.key = api_key or ""
        self.artifact_base = artifact_base or os.environ.get("APPROX_ARTIFACT_BASE_URI") or "registry://"
        self.log = log

    @property
    def enabled(self) -> bool:
        return bool(self.url and self.key)

    def artifact_uri(self, model_id: str, version: str) -> str:
        base = self.artifact_base if self.artifact_base.endswith("://") else self.artifact_base.rstrip("/") + "/"
        return f"{base}{model_id}/versions/{version}"

    def _post(self, model_id: str, body: dict) -> tuple[int, dict]:
        rq = urllib.request.Request(f"{self.url}/api/v1/worker/models/{model_id}/lifecycle", data=json.dumps(body).encode(), method="POST",
                                    headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(rq, timeout=60) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode() or "{}")
            except Exception:
                return e.code, {}
        except Exception as e:   # network problems never break training; they are reported
            return 0, {"error": {"code": type(e).__name__, "message": str(e)}}

    def step(self, model_id: str, body: dict) -> dict:
        code, out = self._post(model_id, body)
        state = (out.get("lifecycle") or {}).get("state")
        err = (out.get("error") or {})
        self.log(f"[lifecycle] {model_id}: → {body['to']}: " + (f"{state}" if code == 200 else f"HTTP {code} {err.get('code')} {err.get('message', '')}"))
        return {"ok": code == 200, "status": code, "state": state, "error": err}

    def started(self, model_id: str):
        if self.enabled:
            return self.step(model_id, {"to": "TRAINING", "reason": "training started by run_all.py"})

    def failed(self, model_id: str, stage: str, reason: str):
        if self.enabled:
            return self.step(model_id, {"to": "FAILED", "failed_stage": stage[:40], "reason": f"NOT ACTIVATED — {reason}"[:1000]})

    def completed(self, model_id: str, release_dir: str | Path) -> dict:
        """Report a finished release. Returns {"verified": bool, "reason": str}."""
        if not self.enabled:
            return {"verified": False, "reason": "publishing disabled (no control-plane URL / worker key)"}
        d = Path(release_dir)
        rel = json.loads((d / "release.json").read_text())
        ver_p = d / "adapter" / "verification.json"
        verification = json.loads(ver_p.read_text()) if ver_p.exists() else None
        problems = []
        if rel.get("smoke_test"):
            problems.append("smoke-test release")
        if rel.get("status") != "validated":
            problems.append(f"release status is {rel.get('status')}")
        if not rel.get("production_ready"):
            problems.append("not production-ready: " + "; ".join(rel.get("blockers") or []) if rel.get("blockers") else "not production-ready")
        if not verification or verification.get("verification_passed") is not True:
            problems.append("adapter verification report missing or failed")
        r = self.step(model_id, {"to": "TRAINING_COMPLETE", "version": rel["version"], "reason": "training finished",
                                 "artifact": {"uri": self.artifact_uri(model_id, rel["version"]),
                                              "sha256": rel["adapter_sha256"], "base_model": rel["base_model"], "base_revision": rel.get("base_model_revision") or ""}})
        if not r["ok"]:
            return {"verified": False, "reason": f"artifact registration refused: {r['error'].get('message')}"}
        if problems:
            self.failed(model_id, "evaluation", "; ".join(problems))
            return {"verified": False, "reason": "; ".join(problems)}
        self.step(model_id, {"to": "EVALUATING", "reason": "evaluation gates passed in the pipeline"})
        ev = {**verification, "safety_passed": bool((rel.get("verification") or {}).get("safety_passed")), "smoke_test": False,
              "base_model": rel["base_model"]}
        v = self.step(model_id, {"to": "VERIFIED", "evaluation": ev, "reason": f"release {rel['version']} verified"})
        if not v["ok"]:
            self.failed(model_id, "verification", v["error"].get("message") or "verification refused by the backend")
            return {"verified": False, "reason": v["error"].get("message")}
        return {"verified": True, "reason": "VERIFIED — the backend activates it automatically once its inference server serves this version"}
