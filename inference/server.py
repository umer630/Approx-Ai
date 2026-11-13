"""Approx AI inference server.

Serves the model versions that the registry has activated (<models_dir>/active.json) through an
OpenAI-compatible HTTP API that the Approx backend talks to (APPROX_MODEL_<FAMILY>_URL=http://host:8000/v1).

    GET  /health                 liveness + what is being served (no auth)
    GET  /v1/models              served models (bearer INFERENCE_API_KEY)
    POST /v1/chat/completions    model "nick-4.8" or "nick-4.8@1.0.0", stream true/false
    POST /admin/reload           re-read active.json now (bearer INFERENCE_ADMIN_KEY)

How a newly trained version goes live (no code change, no restart):
  1. the release artifact is imported into the registry (backend import endpoint / CLI / shared volume);
  2. the release is activated → the backend rewrites active.json and calls /admin/reload
     (this server also polls active.json every INFERENCE_POLL_SECONDS);
  3. this server re-verifies the artifact (SHA256SUMS, file allow-list, release.json, base model, optional
     signature), loads the new LoRA adapter next to the already loaded base model, and only then switches
     the serving pointer. A release that fails verification or loading is never served; the previous
     version keeps serving and the error is reported in /health.
If the newly activated version needs a different BASE model, that base is loaded first (minutes, needs
free GPU memory); this is a controlled reload, not an instant swap, and /health shows "loading".

Safety rules: safetensors adapters only (never pickle), verified hashes only, 4-bit NF4 on CUDA.
There is NO CPU fallback for real models: without CUDA the server refuses to load them and reports
GPU_REQUIRED. INFERENCE_SMOKE=1 is a test-only mode that serves smoke-test artifacts built on a tiny
random model on CPU; it refuses real releases, and real mode refuses smoke artifacts.

Environment:
  APPROX_MODELS_DIR        registry directory (required)
  INFERENCE_API_KEY        bearer key the backend uses (required unless bound to loopback)
  INFERENCE_ADMIN_KEY      bearer key for /admin/reload (defaults to INFERENCE_API_KEY)
  INFERENCE_HOST / INFERENCE_PORT   default 127.0.0.1 / 8000
  INFERENCE_MODELS         comma list of model ids this server may serve (default: all in the catalog)
  INFERENCE_POLL_SECONDS   default 15
  INFERENCE_MAX_NEW_TOKENS hard cap, default 4096
  INFERENCE_MAX_INPUT_TOKENS  default 8192
  APPROX_RELEASE_SIGNING_KEY  if set, unsigned releases are refused
  APPROX_MODEL_CATALOG     path to models.json (defaults to backend/config/models.json)
  HF_TOKEN                 only if the base model needs it; never logged
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import approx_artifacts as art  # noqa: E402

SMOKE = os.environ.get("INFERENCE_SMOKE") == "1"
MODELS_DIR = os.environ.get("APPROX_MODELS_DIR", "")
API_KEY = os.environ.get("INFERENCE_API_KEY", "")
ADMIN_KEY = os.environ.get("INFERENCE_ADMIN_KEY", "") or API_KEY
HOST = os.environ.get("INFERENCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("INFERENCE_PORT", "8000"))
POLL = max(2, int(os.environ.get("INFERENCE_POLL_SECONDS", "15")))
MAX_NEW = int(os.environ.get("INFERENCE_MAX_NEW_TOKENS", "4096"))
MAX_INPUT = int(os.environ.get("INFERENCE_MAX_INPUT_TOKENS", "8192"))
MAX_BODY = 4 * 1024 * 1024
ONLY = {m.strip() for m in os.environ.get("INFERENCE_MODELS", "").split(",") if m.strip()}
# Hard SHA-256 pins: "model_id=hex,model_id=hex". A pinned model is served only if its adapter hash matches.
PINNED_SHA = {}
for _item in os.environ.get("INFERENCE_PIN_SHA256", "").split(","):
    if "=" in _item:
        _k, _v = _item.split("=", 1)
        if _k.strip() and _v.strip():
            PINNED_SHA[_k.strip()] = _v.strip().lower()


def log(msg: str) -> None:
    print(f"[inference {time.strftime('%H:%M:%S')}] {msg}", flush=True)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class Base:
    """One loaded base model (+ tokenizer) and the adapters attached to it."""

    def __init__(self, key, model, tokenizer):
        self.key, self.model, self.tokenizer = key, model, tokenizer
        self.peft = None            # PeftModel once the first adapter is attached
        self.lock = threading.Lock()  # one generation / adapter change at a time per base


class Engine:
    def __init__(self):
        self.catalog = art.load_catalog()
        self.bases: dict = {}        # (base_model, revision) → Base
        self.serving: dict = {}      # model_id → {version, base, adapter_name, adapter_sha256, production_ready, loaded_at}
        self.errors: dict = {}       # model_id → reason the activated version is not being served
        self.state = "starting"
        self.reload_lock = threading.Lock()
        self.last_reload = None
        self._active_mtime = None
        import torch
        self.torch = torch
        self.cuda = torch.cuda.is_available()
        self.gpu = None
        if self.cuda:
            p = torch.cuda.get_device_properties(0)
            self.gpu = {"name": p.name, "vram_gb": round(p.total_memory / 2**30, 2)}

    # ------------------------------------------------------------ loading
    def _load_base(self, base_model: str, revision):
        key = (base_model, revision or "")
        if key in self.bases:
            return self.bases[key]
        from transformers import AutoModelForCausalLM, AutoTokenizer
        torch = self.torch
        if SMOKE:
            if not Path(base_model).is_dir():
                raise RuntimeError("smoke mode only loads a local tiny test model")
            tok = AutoTokenizer.from_pretrained(base_model)
            model = AutoModelForCausalLM.from_pretrained(base_model, torch_dtype=torch.float32)
        else:
            if not self.cuda:
                raise RuntimeError("GPU_REQUIRED: no CUDA device; real models are never served on CPU")
            from transformers import BitsAndBytesConfig
            bf16 = torch.cuda.is_bf16_supported()
            q = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                                   bnb_4bit_compute_dtype=torch.bfloat16 if bf16 else torch.float16)
            kw = {"revision": revision} if revision else {}
            log(f"loading base model {base_model} (revision {revision or 'default'}) in 4-bit NF4 …")
            tok = AutoTokenizer.from_pretrained(base_model, **kw)
            model = AutoModelForCausalLM.from_pretrained(base_model, quantization_config=q, device_map={"": 0}, **kw)
        model.eval()
        if tok.pad_token_id is None:
            tok.pad_token = tok.eos_token
        self.bases[key] = Base(key, model, tok)
        return self.bases[key]

    def _attach(self, base: Base, adapter_dir: Path, name: str):
        from peft import PeftModel
        with base.lock:
            if base.peft is None:
                base.peft = PeftModel.from_pretrained(base.model, str(adapter_dir), adapter_name=name, is_trainable=False)
            else:
                base.peft.load_adapter(str(adapter_dir), adapter_name=name, is_trainable=False)
            base.peft.eval()

    def _detach(self, base: Base, name: str):
        with base.lock:
            try:
                if base.peft is not None and name in base.peft.peft_config and len(base.peft.peft_config) > 1:
                    base.peft.delete_adapter(name)
            except Exception as e:  # an unused adapter left in memory is harmless
                log(f"could not unload adapter {name}: {type(e).__name__}")

    def _verify(self, model_id: str, entry: dict):
        version = str(entry.get("version"))
        d = art.release_dir(MODELS_DIR, model_id, version)
        v = art.verify_release_dir(d, model_id, version, self.catalog)
        if not v["ok"]:
            raise RuntimeError(f"artifact failed verification: {v['errors'][0]}")
        rel = v["release"]
        if entry.get("adapter_sha256") and entry["adapter_sha256"] != v["adapter_sha256"]:
            raise RuntimeError("adapter SHA-256 differs from the hash recorded at activation")
        # Optional hard pin: refuse to serve unless the adapter matches a known-good SHA-256 for this model.
        # Set INFERENCE_PIN_SHA256="nick-4.8=2faae2...,hike-6.5=..." to lock exact weights (never a substitute).
        pinned = PINNED_SHA.get(model_id)
        if pinned and pinned != v["adapter_sha256"]:
            raise RuntimeError(f"adapter SHA-256 {v['adapter_sha256'][:12]}… does not match the pinned hash "
                               f"{pinned[:12]}… for {model_id} — refusing to serve (possible wrong/substituted adapter)")
        smoke = rel.get("smoke_test") is True
        if smoke and not SMOKE:
            raise RuntimeError("smoke-test artifact refused: this is not a real model")
        if not smoke and SMOKE:
            raise RuntimeError("real release refused in INFERENCE_SMOKE mode")
        if not smoke and rel["status"] != "validated":
            raise RuntimeError(f"release status is '{rel['status']}', only validated releases are served")
        return d, v, rel

    def reload(self, reason: str = "poll") -> dict:
        """Bring `serving` in line with active.json. Never raises; failures are recorded per model."""
        with self.reload_lock:
            active = art.read_active(MODELS_DIR)
            if ONLY:
                active = {k: v for k, v in active.items() if k in ONLY}

            for model_id in list(self.serving):
                if model_id not in active:
                    old = self.serving.pop(model_id)
                    self._detach(old["base"], old["adapter_name"])
                    log(f"{model_id}: deactivated (was {old['version']})")
            for model_id in list(self.errors):
                if model_id not in active:
                    self.errors.pop(model_id)
            for model_id, entry in sorted(active.items()):
                cur = self.serving.get(model_id)
                if cur and cur["version"] == entry["version"] and cur["adapter_sha256"] == entry.get("adapter_sha256", cur["adapter_sha256"]):
                    try:   # cheap re-check that the live artifact was not modified on disk
                        self._verify(model_id, entry)
                        self.errors.pop(model_id, None)
                    except Exception as e:
                        self.serving.pop(model_id)
                        self._detach(cur["base"], cur["adapter_name"])
                        self.errors[model_id] = f"{entry['version']}: {e}"
                        log(f"{model_id}@{entry['version']} taken offline: {e}")
                    continue
                try:
                    d, v, rel = self._verify(model_id, entry)
                    self.state = "loading"
                    base = self._load_base(rel["base_model"], rel.get("base_model_revision"))
                    name = f"{model_id}@{rel['version']}".replace(".", "_").replace("@", "__")
                    self._attach(base, d / "adapter", name)
                    self.serving[model_id] = {"version": rel["version"], "base": base, "adapter_name": name, "adapter_sha256": v["adapter_sha256"],
                                              "production_ready": rel.get("production_ready") is True, "smoke_test": rel.get("smoke_test") is True,
                                              "base_model": rel["base_model"], "loaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                    self.errors.pop(model_id, None)
                    if cur:
                        self._detach(cur["base"], cur["adapter_name"])
                    log(f"{model_id}: now serving {rel['version']} (sha256 {v['adapter_sha256'][:12]}…, production_ready={rel.get('production_ready')})"
                        + (f", replaced {cur['version']}" if cur else ""))
                except Exception as e:
                    msg = f"{entry.get('version')}: {type(e).__name__}: {e}"[:400]
                    self.errors[model_id] = msg
                    log(f"{model_id}: NOT serving {entry.get('version')} — {msg}" + (f"; still serving {cur['version']}" if cur else ""))
            self.state = "ready"
            self.last_reload = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "reason": reason}
            return self.status()

    def status(self) -> dict:
        return {"status": "ok" if self.state == "ready" else self.state, "smoke_mode": SMOKE, "cuda": self.cuda, "gpu": self.gpu,
                "serving": {m: s["version"] for m, s in self.serving.items()},
                "details": {m: {k: s[k] for k in ("version", "adapter_sha256", "production_ready", "smoke_test", "base_model", "loaded_at")} for m, s in self.serving.items()},
                "errors": dict(self.errors), "last_reload": self.last_reload}

    def poll_forever(self):
        while True:
            time.sleep(POLL)
            try:
                p = Path(MODELS_DIR) / "active.json"
                mtime = p.stat().st_mtime_ns if p.exists() else 0
                if mtime != self._active_mtime or self.errors:
                    self._active_mtime = mtime
                    self.reload("poll")
            except Exception as e:
                log(f"poll error: {type(e).__name__}: {e}")

    # ------------------------------------------------------------ generation
    def resolve(self, name: str) -> dict:
        if not isinstance(name, str) or not name:
            raise ApiError(400, "invalid_request", "model is required")
        model_id, _, version = name.partition("@")
        s = self.serving.get(model_id)
        if not s:
            why = self.errors.get(model_id)
            raise ApiError(503 if model_id in self.catalog else 404, "model_not_served",
                           f"{model_id} is not being served" + (f" ({why})" if why else " (no active version)"))
        if version and version != s["version"]:
            raise ApiError(409, "model_version_not_active", f"{model_id}@{version} is not the active version (serving {s['version']})")
        return {"model_id": model_id, **s}

    def generate(self, body: dict, on_text):
        """Runs one completion; calls on_text(str) for each piece. Returns (finish_reason, prompt_tokens, completion_tokens)."""
        torch = self.torch
        from transformers import LogitsProcessor, LogitsProcessorList, StoppingCriteria, StoppingCriteriaList
        s = self.resolve(body.get("model"))
        msgs = body.get("messages")
        if not isinstance(msgs, list) or not msgs or len(msgs) > 200:
            raise ApiError(400, "invalid_request", "messages must be a non-empty array")
        clean = []
        for m in msgs:
            if not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str):
                raise ApiError(400, "invalid_request", "each message needs role (system|user|assistant) and string content")
            clean.append({"role": m["role"], "content": m["content"]})

        def num(key, default, lo, hi):
            v = body.get(key, default)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not (lo <= v <= hi):
                raise ApiError(400, "invalid_request", f"{key} must be a number between {lo} and {hi}")
            return v
        max_new = int(min(num("max_tokens", 512, 1, 1_000_000), MAX_NEW))
        temperature = float(num("temperature", 0.7, 0, 2))
        top_p = float(num("top_p", 0.9, 0.01, 1))
        freq = float(num("frequency_penalty", 0, 0, 2))

        base: Base = s["base"]
        tok = base.tokenizer
        ids = tok.apply_chat_template(clean, add_generation_prompt=True, return_tensors="pt")
        if ids.shape[1] > MAX_INPUT:
            raise ApiError(413, "context_too_long", f"prompt is {ids.shape[1]} tokens; the limit is {MAX_INPUT}")
        n_prompt = ids.shape[1]

        class FrequencyPenalty(LogitsProcessor):
            """OpenAI-style frequency penalty: subtract penalty × (times the token was already generated)."""
            def __call__(self, input_ids, scores):
                gen = input_ids[0, n_prompt:]
                if gen.numel():
                    counts = torch.bincount(gen, minlength=scores.shape[-1]).to(scores.dtype)
                    scores = scores - freq * counts.unsqueeze(0)
                return scores

        cancelled = threading.Event()

        class Cancel(StoppingCriteria):
            def __call__(self, input_ids, scores, **kw):
                return cancelled.is_set()

        class Piece:
            """Incremental detokeniser (emits only complete UTF-8 text)."""
            def __init__(self):
                self.ids, self.sent = [], 0

            def put(self, value):
                if value.dim() > 1:
                    value = value[0]
                if self.sent == 0 and not self.ids and value.shape[0] == n_prompt:
                    return  # the prompt itself
                self.ids.extend(value.tolist())
                text = tok.decode(self.ids, skip_special_tokens=True)
                if text.endswith("�"):
                    return
                if len(text) > self.sent:
                    try:
                        on_text(text[self.sent:])
                    except Exception:
                        cancelled.set()
                    self.sent = len(text)

            def end(self):
                pass

        piece = Piece()
        kw = dict(max_new_tokens=max_new, pad_token_id=tok.pad_token_id, streamer=piece, stopping_criteria=StoppingCriteriaList([Cancel()]))
        if temperature > 0:
            kw.update(do_sample=True, temperature=max(temperature, 0.01), top_p=top_p)
        else:
            kw.update(do_sample=False)
        if freq > 0:
            kw["logits_processor"] = LogitsProcessorList([FrequencyPenalty()])
        with base.lock:
            cur = self.serving.get(s["model_id"])
            if not cur or cur["adapter_name"] != s["adapter_name"]:
                raise ApiError(409, "model_version_not_active", "the active version changed; retry")
            base.peft.set_adapter(s["adapter_name"])
            device = next(base.peft.parameters()).device
            with torch.inference_mode():
                out = base.peft.generate(input_ids=ids.to(device), attention_mask=torch.ones_like(ids).to(device), **kw)
        n_out = int(out.shape[1] - n_prompt)
        return ("length" if n_out >= max_new else "stop"), int(n_prompt), n_out, s


ENGINE: Engine | None = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ApproxInference/1.0"

    def log_message(self, *a):  # request bodies / headers are never logged
        pass

    def _json(self, status: int, obj: dict):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _error(self, e: ApiError):
        self._json(e.status, {"error": {"code": e.code, "message": e.message}})

    def _auth(self, key: str):
        if not key:
            return  # only possible on loopback (enforced at start-up)
        got = self.headers.get("Authorization", "")
        if not (got.startswith("Bearer ") and hmac.compare_digest(got[7:].encode(), key.encode())):
            raise ApiError(401, "unauthorized", "missing or invalid bearer key")

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "invalid_request", "bad Content-Length")
        if n > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "payload_too_large", "request body is too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "invalid_json", "request body is not valid JSON")
        if not isinstance(obj, dict):
            raise ApiError(400, "invalid_request", "request body must be a JSON object")
        return obj

    def do_GET(self):
        try:
            if self.path == "/health":
                st = ENGINE.status()
                st.pop("details")
                return self._json(200, st)
            if self.path == "/v1/models":
                self._auth(API_KEY)
                st = ENGINE.status()
                return self._json(200, {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "approx-technology", **d} for m, d in st["details"].items()],
                                        "errors": st["errors"]})
            raise ApiError(404, "not_found", "unknown route")
        except ApiError as e:
            self._error(e)

    def do_POST(self):
        try:
            if self.path == "/admin/reload":
                self._auth(ADMIN_KEY)
                self._body()
                return self._json(200, ENGINE.reload("admin"))
            if self.path != "/v1/chat/completions":
                raise ApiError(404, "not_found", "unknown route")
            self._auth(API_KEY)
            body = self._body()
            stream = body.get("stream", False)
            if not isinstance(stream, bool):
                raise ApiError(400, "invalid_request", "stream must be a boolean")
            rid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            created = int(time.time())
            if not stream:
                parts = []
                finish, n_in, n_out, s = ENGINE.generate(body, parts.append)
                return self._json(200, {"id": rid, "object": "chat.completion", "created": created, "model": f"{s['model_id']}@{s['version']}",
                                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(parts)}, "finish_reason": finish}],
                                        "usage": {"prompt_tokens": n_in, "completion_tokens": n_out, "total_tokens": n_in + n_out}})
            ENGINE.resolve(body.get("model"))   # fail with a proper status before the stream starts
            started = False

            def send(obj):
                nonlocal started
                if not started:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    started = True
                self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode() if obj is not None else b"data: [DONE]\n\n")
                self.wfile.flush()

            def chunk(delta, finish=None):
                return {"id": rid, "object": "chat.completion.chunk", "created": created, "model": body.get("model"),
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.close_connection = True
            try:
                finish, n_in, n_out, _ = ENGINE.generate(body, lambda t: send(chunk({"content": t})))
                send({**chunk({}, finish), "usage": {"prompt_tokens": n_in, "completion_tokens": n_out, "total_tokens": n_in + n_out}})
                send(None)
            except ApiError as e:
                if not started:
                    raise
                send({"error": {"code": e.code, "message": e.message}})
            except (BrokenPipeError, ConnectionResetError):
                pass
        except ApiError as e:
            try:
                self._error(e)
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # never leak internals
            log(f"request failed: {type(e).__name__}: {e}")
            try:
                self._json(500, {"error": {"code": "internal_error", "message": "inference failed"}})
            except Exception:
                pass


def main():
    global ENGINE
    if not MODELS_DIR:
        sys.exit("APPROX_MODELS_DIR is required")
    if not API_KEY and HOST not in ("127.0.0.1", "localhost", "::1"):
        sys.exit("INFERENCE_API_KEY is required when the server is not bound to loopback")
    ENGINE = Engine()
    if not SMOKE and not ENGINE.cuda:
        log("GPU_REQUIRED: no CUDA device. The server stays up for health checks but will not serve any real model.")
    ENGINE.reload("startup")
    threading.Thread(target=ENGINE.poll_forever, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f"listening on http://{HOST}:{srv.server_address[1]}  smoke_mode={SMOKE}  serving={ENGINE.status()['serving']}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
