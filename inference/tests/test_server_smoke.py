"""CPU smoke test of the inference server: a TINY random Qwen2 model + random LoRA adapters packaged as
smoke-test releases (they are NOT Nick 4.8 and their text is gibberish by design).

Checks: artifact verification, active.json loading, streaming + non-streaming, version pinning, auth,
malformed/oversized input, hot adapter swap on /admin/reload, tampered artifact taken offline, real
releases refused in smoke mode.

    python inference/tests/test_server_smoke.py <tiny-model-dir>
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import approx_artifacts as art  # noqa: E402

KEY, ADMIN = "test-key-123", "admin-key-456"


def make_release(models_dir: Path, tiny: str, version: str, seed: int, smoke=True):
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM
    torch.manual_seed(seed)
    m = AutoModelForCausalLM.from_pretrained(tiny)
    p = get_peft_model(m, LoraConfig(r=4, lora_alpha=8, target_modules=["q_proj", "v_proj"], init_lora_weights=False))
    d = art.release_dir(models_dir, "nick-4.8", version)
    p.save_pretrained(d / "adapter", safe_serialization=True)
    for junk in (d / "adapter").glob("README*"):
        junk.unlink()
    (d / "metadata.json").write_text(json.dumps({"model_id": "nick-4.8", "version": version, "note": "SMOKE-TEST-NOT-NICK"}))
    rel = {"schema": art.RELEASE_SCHEMA, "model_id": "nick-4.8", "version": version, "kind": "language_model",
           "status": "smoke_test" if smoke else "validated", "smoke_test": smoke, "production_ready": False,
           "blockers": ["smoke test on a tiny random model"], "base_model": tiny if smoke else "Qwen/Qwen2.5-3B-Instruct",
           "adapter_sha256": art.sha256_file(d / "adapter/adapter_model.safetensors"),
           "verification": {"passed": not smoke}, "evaluation": {"gate_passed": False}, "dataset": {"production_ready": False}}
    (d / "release.json").write_text(json.dumps(rel))
    art.write_sha256sums(d)
    v = art.verify_release_dir(d, "nick-4.8", version)
    assert v["ok"], v["errors"]
    return d, v["adapter_sha256"]


def set_active(models_dir: Path, version, sha):
    act = {} if version is None else {"nick-4.8": {"version": version, "adapter_sha256": sha}}
    (models_dir / "active.json").write_text(json.dumps({"schema": art.ACTIVE_SCHEMA, "active": act}))


def call(port, method, path, body=None, key=KEY, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    rq = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    rq.add_header("Content-Type", "application/json")
    if key:
        rq.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(rq, timeout=120) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if r.headers.get("Content-Type", "").startswith("application/json") else text)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main(tiny: str):
    tmp = Path(tempfile.mkdtemp(prefix="approx-inf-"))
    models = tmp / "models"
    _, sha1 = make_release(models, tiny, "0.0.1", 1)
    _, sha2 = make_release(models, tiny, "0.0.2", 2)
    set_active(models, "0.0.1", sha1)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "APPROX_MODELS_DIR": str(models), "INFERENCE_API_KEY": KEY, "INFERENCE_ADMIN_KEY": ADMIN,
           "INFERENCE_PORT": str(port), "INFERENCE_SMOKE": "1", "INFERENCE_POLL_SECONDS": "2", "INFERENCE_MAX_INPUT_TOKENS": "512"}
    env.pop("APPROX_RELEASE_SIGNING_KEY", None)
    proc = subprocess.Popen([sys.executable, str(ROOT / "inference/server.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    results = []

    def check(name, cond, detail=""):
        results.append((name, bool(cond)))
        print(f"{'PASS' if cond else 'FAIL'}  {name}{('  — ' + str(detail)[:200]) if not cond else ''}", flush=True)

    try:
        for _ in range(240):
            try:
                st, h = call(port, "GET", "/health", key=None)
                if st == 200 and h.get("serving"):
                    break
            except (urllib.error.URLError, ConnectionError):
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.5)
        st, h = call(port, "GET", "/health", key=None)
        check("health reports the activated smoke version", h.get("serving") == {"nick-4.8": "0.0.1"} and h.get("smoke_mode") is True, h)
        check("health exposes no secrets", KEY not in json.dumps(h) and ADMIN not in json.dumps(h))

        msgs = [{"role": "user", "content": "Hello"}]
        st, r = call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": msgs, "max_tokens": 8, "temperature": 0})
        check("non-streaming completion", st == 200 and r["object"] == "chat.completion" and r["model"] == "nick-4.8@0.0.1" and r["usage"]["completion_tokens"] <= 8, r)
        st2, r2 = call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8@0.0.1", "messages": msgs, "max_tokens": 8, "temperature": 0})
        check("greedy decoding is deterministic and version pin works", st2 == 200 and r2["choices"][0]["message"]["content"] == r["choices"][0]["message"]["content"], r2)
        st, sse = call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": msgs, "max_tokens": 8, "stream": True, "frequency_penalty": 1.5})
        check("streaming completion ends with [DONE] and usage", st == 200 and sse.rstrip().endswith("data: [DONE]") and '"usage"' in sse, sse[:200])
        check("unknown version pin → 409", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8@9.9.9", "messages": msgs})[0] == 409)
        check("model without active version → 503", call(port, "POST", "/v1/chat/completions", {"model": "hike-6.5", "messages": msgs})[0] == 503)
        check("unknown model → 404", call(port, "POST", "/v1/chat/completions", {"model": "gpt-x", "messages": msgs})[0] == 404)
        check("missing key → 401", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": msgs}, key=None)[0] == 401)
        check("wrong key → 401", call(port, "GET", "/v1/models", key="nope")[0] == 401)
        check("api key cannot reload", call(port, "POST", "/admin/reload", {}, key=KEY)[0] == 401)
        check("malformed JSON → 400", call(port, "POST", "/v1/chat/completions", raw=b"{oops")[0] == 400)
        check("bad role → 400", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": [{"role": "tool", "content": "x"}]})[0] == 400)
        check("bad temperature → 400", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": msgs, "temperature": "hot"})[0] == 400)
        check("oversized prompt → 413", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": [{"role": "user", "content": "word " * 3000}]})[0] == 413)
        with socket.create_connection(("127.0.0.1", port), timeout=30) as c:   # declares 5 MB; the server must refuse before reading it
            c.sendall(f"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {KEY}\r\nContent-Type: application/json\r\nContent-Length: {5 * 1024 * 1024}\r\n\r\n{{".encode())
            head = c.recv(200).decode(errors="replace")
        check("oversized body → 413 without reading it", head.startswith("HTTP/1.1 413"), head)

        # hot swap to 0.0.2 through the admin reload hook
        set_active(models, "0.0.2", sha2)
        st, rl = call(port, "POST", "/admin/reload", {}, key=ADMIN)
        check("admin reload switches to the new version", st == 200 and rl["serving"] == {"nick-4.8": "0.0.2"}, rl)
        st, r3 = call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": msgs, "max_tokens": 8, "temperature": 0})
        check("new adapter is actually used", st == 200 and r3["model"] == "nick-4.8@0.0.2", r3)
        check("old version pin now → 409", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8@0.0.1", "messages": msgs})[0] == 409)

        # tampering with the live artifact → taken offline by the poller (fail closed)
        with open(models / "nick-4.8/versions/0.0.2/adapter/adapter_model.safetensors", "ab") as f:
            f.write(b"x")
        st, rl = call(port, "POST", "/admin/reload", {}, key=ADMIN)
        check("tampered artifact is taken offline", rl["serving"] == {} and "SHA-256 mismatch" in rl["errors"].get("nick-4.8", ""), rl)
        check("requests fail closed after tampering", call(port, "POST", "/v1/chat/completions", {"model": "nick-4.8", "messages": msgs})[0] == 503)

        # a real (non-smoke) release is refused in smoke mode — and would need CUDA anyway
        _, sha3 = make_release(models, tiny, "1.0.0", 3, smoke=False)
        # (verification fails first: real release says base Qwen/Qwen2.5-3B-Instruct but weights fit the tiny model — that is fine for this check)
        set_active(models, "1.0.0", sha3)
        st, rl = call(port, "POST", "/admin/reload", {}, key=ADMIN)
        check("real release refused in smoke mode", rl["serving"] == {} and "refused" in rl["errors"].get("nick-4.8", ""), rl)

        # deactivate → nothing served, poller picks it up without admin call
        set_active(models, "0.0.1", sha1)
        time.sleep(5)
        st, h = call(port, "GET", "/health", key=None)
        check("poller picks up active.json changes without a reload call", h["serving"] == {"nick-4.8": "0.0.1"}, h)
    finally:
        proc.terminate()
        try:
            out = proc.communicate(timeout=10)[0]
        except subprocess.TimeoutExpired:
            proc.kill()
            out = proc.communicate()[0]
        if not all(ok for _, ok in results):
            print("---- server log ----\n" + out)
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main(sys.argv[1])
