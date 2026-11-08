"""Detached supervisor for train_qlora.py (Colab).

Started by colab_pipeline.py `train` in its OWN session (start_new_session=True) with stdout/stderr going to a LOG
FILE — never to a pipe owned by the notebook. Consequences:
  * stopping/interrupting the notebook cell, a browser disconnect, or the launcher dying does NOT kill training;
  * nothing is lost to pipe buffering or BrokenPipe;
  * the trainer's exit status (including a signal kill such as SIGKILL from the OOM killer) is always recorded in
    supervisor_status.json and in the log, as long as this supervisor itself survives.
SIGTERM / SIGINT / SIGHUP sent to the supervisor are forwarded to the trainer, which records them and exits.

    python colab/train_supervisor.py --status-file S.json -- <python> train_qlora.py <args...>
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    argv = sys.argv[1:]
    if "--status-file" not in argv or "--" not in argv:
        sys.exit(__doc__)
    status_file = Path(argv[argv.index("--status-file") + 1])
    cmd = argv[argv.index("--") + 1:]

    def write(**kw):
        cur = json.loads(status_file.read_text()) if status_file.exists() else {}
        cur.update(kw)
        tmp = status_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(cur, indent=2))
        os.replace(tmp, status_file)

    started = time.time()
    child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)  # inherits our stdout/stderr = the log file
    write(state="running", supervisor_pid=os.getpid(), trainer_pid=child.pid, started_at=started, cmd=cmd, exit_code=None,
          signal=None, forwarded_signals=[])
    print(f"=== supervisor {os.getpid()} started trainer pid {child.pid}", flush=True)

    forwarded: list[str] = []

    def forward(signum, frame):
        forwarded.append(signal.Signals(signum).name)
        write(forwarded_signals=forwarded)
        print(f"=== supervisor received {signal.Signals(signum).name}; forwarding SIGTERM to trainer", flush=True)
        try:
            child.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)

    while True:
        try:
            rc = child.wait()
            break
        except InterruptedError:
            continue
    sig = -rc if rc < 0 else None
    note = ""
    if sig:
        note = f" (trainer killed by signal {sig} {signal.Signals(sig).name}; SIGKILL usually = host-RAM OOM killer)"
    elif rc >= 128:
        note = f" (trainer exited after signal {rc - 128})"
    print(f"=== exit code {rc}{note}", flush=True)
    write(state="finished", exit_code=rc, signal=signal.Signals(sig).name if sig else None, finished_at=time.time(),
          seconds=round(time.time() - started, 1), note=note.strip(" ()") or None)
    return 0 if rc == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
