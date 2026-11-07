"""Drive Kaggle notebooks (push → monitor → download outputs) with the official `kagglesdk`
(shipped inside the `kaggle` package). Never stores credentials.

Credentials: reads KAGGLE_API_TOKEN from the environment. In a Claude cloud session the token is injected by
the network proxy instead, so the variable only holds a placeholder (e.g. "proxy-injected").
The `kaggle` CLI itself is not used because it introspects the token value, which a proxy-injected token
cannot satisfy; the SDK calls below are the same ones the CLI makes.

    python kaggle_runner.py whoami
    python kaggle_runner.py push  --notebook NB.ipynb --slug USER/slug --title "Title" [--gpu] [--internet] [--timeout 43200]
    python kaggle_runner.py status --slug USER/slug
    python kaggle_runner.py wait   --slug USER/slug [--poll 60] [--max-hours 12]
    python kaggle_runner.py output --slug USER/slug --dest DIR [--pattern REGEX]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from kagglesdk import KaggleClient, KaggleEnv
from kagglesdk.kernels.types.kernels_api_service import (ApiGetKernelSessionStatusRequest, ApiListKernelSessionOutputRequest,
                                                         ApiListKernelsRequest, ApiSaveKernelRequest)
from kagglesdk.kernels.types.kernels_enums import KernelsListViewType

TERMINAL = {"COMPLETE", "ERROR", "CANCEL_ACKNOWLEDGED", "CANCELLED"}


def client() -> KaggleClient:
    token = os.environ.get("KAGGLE_API_TOKEN")
    if not token:
        sys.exit("KAGGLE_API_TOKEN is not set (use a placeholder when a proxy injects the real token)")
    return KaggleClient(env=KaggleEnv.PROD, api_token=token)


def split(slug: str) -> tuple[str, str]:
    if "/" not in slug:
        sys.exit("slug must be USER/kernel-slug")
    return tuple(slug.split("/", 1))  # type: ignore[return-value]


def whoami() -> None:
    with client() as k:
        r = ApiListKernelsRequest()
        r.group = KernelsListViewType.PROFILE
        r.page_size = 5
        res = k.kernels.kernels_api_client.list_kernels(r)
        owners = sorted({x.ref.split("/")[0] for x in res.kernels})
        print(json.dumps({"authenticated": True, "own_kernels_listed": len(res.kernels), "owner_usernames": owners}))


def push(a) -> None:
    nb = json.loads(Path(a.notebook).read_text(encoding="utf-8"))
    with client() as k:
        r = ApiSaveKernelRequest()
        r.slug = a.slug
        r.new_title = a.title
        r.text = json.dumps(nb)
        r.language = "python"
        r.kernel_type = "notebook"
        r.is_private = True
        r.enable_gpu = a.gpu
        r.enable_internet = a.internet
        r.enable_tpu = False
        r.machine_shape = "NvidiaTeslaT4" if a.gpu else None
        r.dataset_data_sources = []
        r.kernel_data_sources = a.kernel_source or []
        r.competition_data_sources = []
        r.model_data_sources = []
        r.category_ids = []
        if a.timeout:
            r.session_timeout_seconds = a.timeout
        res = k.kernels.kernels_api_client.save_kernel(r)
        out = {"ref": res.ref, "url": res.url, "version_number": res.version_number, "error": res.error,
               "invalid_kernel_sources": list(res.invalid_kernel_sources or [])}
        print(json.dumps(out))
        if res.error:
            sys.exit(1)


def status(slug: str) -> dict:
    user, kslug = split(slug)
    with client() as k:
        r = ApiGetKernelSessionStatusRequest()
        r.user_name, r.kernel_slug = user, kslug
        res = k.kernels.kernels_api_client.get_kernel_session_status(r)
        st = res.status.name if hasattr(res.status, "name") else str(res.status)
        return {"status": st, "failure_message": res.failure_message}


def wait(a) -> None:
    deadline = time.time() + a.max_hours * 3600
    last = None
    while time.time() < deadline:
        try:
            s = status(a.slug)
        except Exception as e:  # transient network errors: keep polling
            s = {"status": "POLL_ERROR", "failure_message": f"{type(e).__name__}: {e}"[:200]}
        if s != last:
            print(time.strftime("%H:%M:%S"), json.dumps(s), flush=True)
            last = s
        if s["status"] in TERMINAL:
            sys.exit(0 if s["status"] == "COMPLETE" else 1)
        time.sleep(a.poll)
    sys.exit("wait: timed out")


def output(a) -> None:
    user, kslug = split(a.slug)
    dest = Path(a.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    files, token = [], None
    with client() as k:
        while True:
            r = ApiListKernelSessionOutputRequest()
            r.user_name, r.kernel_slug = user, kslug
            r.page_size = 100
            if token:
                r.page_token = token
            res = k.kernels.kernels_api_client.list_kernel_session_output(r)
            files += list(res.files)
            if res.log and not token:
                (dest / f"{kslug}.log").write_text(res.log)
            token = res.next_page_token
            if not token:
                break
    rx = re.compile(a.pattern) if a.pattern else None
    got = []
    for f in files:
        if rx and not rx.search(f.file_name):
            continue
        target = (dest / f.file_name).resolve()
        if not str(target).startswith(str(dest) + os.sep):
            raise SystemExit(f"refusing path outside destination: {f.file_name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(f.url, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(target, "wb") as fh:
                for chunk in resp.iter_content(1 << 20):
                    fh.write(chunk)
        got.append({"file": f.file_name, "bytes": target.stat().st_size, "host": requests.utils.urlparse(f.url).hostname})
    print(json.dumps({"listed": len(files), "downloaded": got}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    p = sub.add_parser("push")
    p.add_argument("--notebook", required=True)
    p.add_argument("--slug", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--gpu", action="store_true")
    p.add_argument("--internet", action="store_true")
    p.add_argument("--timeout", type=int, default=0)
    p.add_argument("--kernel-source", action="append", help="attach a previous notebook's output as input (USER/slug)")
    for name in ("status", "wait", "output"):
        q = sub.add_parser(name)
        q.add_argument("--slug", required=True)
        if name == "wait":
            q.add_argument("--poll", type=int, default=60)
            q.add_argument("--max-hours", type=float, default=12)
        if name == "output":
            q.add_argument("--dest", required=True)
            q.add_argument("--pattern")
    a = ap.parse_args()
    if a.cmd == "whoami":
        whoami()
    elif a.cmd == "push":
        push(a)
    elif a.cmd == "status":
        print(json.dumps(status(a.slug)))
    elif a.cmd == "wait":
        wait(a)
    else:
        output(a)


if __name__ == "__main__":
    main()
