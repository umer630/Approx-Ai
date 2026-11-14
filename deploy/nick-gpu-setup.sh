#!/usr/bin/env bash
# Install the verified Nick 4.8 release on a GPU host for deploy/nick-gpu-compose.yml.
#
#   bash deploy/nick-gpu-setup.sh /path/to/nick-4.8-release.zip
#
# Checks (any failure stops before anything is installed):
#   1. adapter_model.safetensors SHA-256 == the production pin (never changed here)
#   2. adapter_config.json base model == Qwen/Qwen2.5-3B-Instruct
#   3. the ZIP contains a registry release (release.json, metadata.json, adapter/, SHA256SUMS) that passes the
#      same verifier the inference server uses (approx_artifacts.verify_release_dir)
#   4. release.json base_model_revision == aa8e72537993ba99e69dfaafa59ed015b17504d1
# Then installs it to deploy/models/nick-4.8/versions/<version>/ and writes deploy/models/active.json.
set -euo pipefail

PIN=2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4
BASE=Qwen/Qwen2.5-3B-Instruct
BASE_REV=aa8e72537993ba99e69dfaafa59ed015b17504d1
ZIP=${1:?usage: bash deploy/nick-gpu-setup.sh /path/to/nick-4.8-release.zip}
REPO=$(cd "$(dirname "$0")/.." && pwd)
MODELS="$REPO/deploy/models"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

echo "[1/5] Extracting $(basename "$ZIP")"
python3 - "$ZIP" "$WORK/x" <<'PY'
import sys, zipfile, pathlib
z, out = zipfile.ZipFile(sys.argv[1]), pathlib.Path(sys.argv[2])
for n in z.namelist():                                   # refuse path traversal inside the archive
    p = pathlib.PurePosixPath(n)
    if p.is_absolute() or ".." in p.parts: sys.exit(f"unsafe path in zip: {n}")
z.extractall(out)
PY

ST=$(find "$WORK/x" -name adapter_model.safetensors -type f)
[ "$(echo "$ST" | grep -c .)" = "1" ] || { echo "FAIL: expected exactly one adapter_model.safetensors, found: ${ST:-none}"; exit 1; }
ADAPTER_DIR=$(dirname "$ST")

echo "[2/5] Verifying adapter SHA-256 against the production pin"
GOT=$(sha256sum "$ST" | cut -d' ' -f1)
[ "$GOT" = "$PIN" ] || { echo "FAIL: adapter SHA-256 $GOT != pinned $PIN — refusing to install"; exit 1; }
echo "      OK $GOT"

echo "[3/5] Checking base model in adapter_config.json"
python3 - "$ADAPTER_DIR/adapter_config.json" "$BASE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
b = c.get("base_model_name_or_path")
if b != sys.argv[2]: sys.exit(f"FAIL: adapter base model is {b!r}, expected {sys.argv[2]!r}")
print(f"      OK base {b}")
PY

echo "[4/5] Verifying the registry release (same checks as the inference server)"
REL_JSON=$(find "$WORK/x" -name release.json -type f | head -1)
if [ -z "$REL_JSON" ]; then
  echo "FAIL: the ZIP has no release.json. The inference server only serves registry releases:"
  echo "      <version>/release.json, metadata.json, adapter/adapter_model.safetensors, adapter/adapter_config.json, SHA256SUMS."
  echo "      Contents found:"; (cd "$WORK/x" && find . -type f | sed 's/^/        /' | head -40)
  exit 1
fi
REL_DIR=$(dirname "$REL_JSON")
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REL_JSON")
python3 - "$REPO" "$REL_DIR" "$VERSION" "$PIN" "$BASE_REV" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
from approx_artifacts import verify_release_dir, load_catalog
repo, d, version, pin, rev = sys.argv[1:6]
v = verify_release_dir(d, "nick-4.8", version, load_catalog(f"{repo}/backend/config/models.json"))
if not v["ok"]:
    sys.exit("FAIL: release verification:\n  - " + "\n  - ".join(v["errors"]))
r = v["release"]
if v["adapter_sha256"] != pin: sys.exit("FAIL: release adapter SHA-256 differs from the pin")
if r.get("base_model_revision") != rev:
    sys.exit(f"FAIL: release.json base_model_revision is {r.get('base_model_revision')!r}, expected {rev!r}")
if r.get("status") != "validated": sys.exit(f"FAIL: release status is {r.get('status')!r}; the server only serves 'validated' releases")
print(f"      OK nick-4.8 {version}: status={r['status']} production_ready={r.get('production_ready')}")
if r.get("production_ready") is not True:
    print("      NOTE: production_ready is not true in release.json. The server will serve it, but Approx's lifecycle")
    print("            activation requires a production-ready release (see docs/NICK_GPU_DEPLOY.md).")
PY

echo "[5/5] Installing to $MODELS/nick-4.8/versions/$VERSION and writing active.json"
DEST="$MODELS/nick-4.8/versions/$VERSION"
[ -e "$DEST" ] && { echo "FAIL: $DEST already exists (remove it first if you really want to reinstall)"; exit 1; }
mkdir -p "$(dirname "$DEST")"
cp -a "$REL_DIR" "$DEST"
python3 - "$MODELS/active.json" "$VERSION" "$PIN" <<'PY'
import json, sys, time, pathlib
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text()) if p.exists() else {}
act = data.get("active") if isinstance(data.get("active"), dict) else {}
act["nick-4.8"] = {"version": sys.argv[2], "adapter_sha256": sys.argv[3],
                   "activated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "activated_by": "nick-gpu-setup.sh"}
p.write_text(json.dumps({"active": act}, indent=2) + "\n")
PY
echo
echo "Installed nick-4.8 $VERSION. Next: docker compose -f deploy/nick-gpu-compose.yml up -d --build"
