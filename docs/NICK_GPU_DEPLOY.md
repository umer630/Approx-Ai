# Nick 4.8: real GPU deployment runbook

Status (2026-11-14): Nick 4.8 is `REGISTERED` on production, not `ACTIVE`. No GPU host exists yet. Nothing below has
been run on a GPU by Claude: this build environment has no GPU, no Google Cloud credentials and no Drive access.
Every step checks its own result; stop at the first failure.

## What the server needs (from `deploy/nick-gpu-compose.yml`, `inference/Dockerfile`, `inference/server.py`)

| Item | Requirement |
|---|---|
| GPU | NVIDIA with compute capability ≥ 7.0 (bitsandbytes 4-bit NF4). **≥ 6 GB VRAM free** (Qwen2.5-3B in 4-bit + LoRA); 8 GB+ recommended. T4 16 GB / L4 24 GB / RTX 3060 12 GB+ all fit. CPU-only is refused (`GPU_REQUIRED`). |
| Driver / CUDA | Image `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime` → NVIDIA driver for CUDA 12.x (550+ recommended), Docker + NVIDIA Container Toolkit. |
| Disk / RAM | ~40 GB disk (image ~9 GB, base model download ~6 GB, release). 16 GB RAM. |
| Port | Container `8000` (HTTP). Put HTTPS in front (Caddy below); do **not** open 8000 to the internet. |
| Env (`deploy/inference.env`) | `INFERENCE_API_KEY` (required, bearer for completions), `INFERENCE_ADMIN_KEY` (bearer for `/admin/reload`), `INFERENCE_MODELS=nick-4.8`, `INFERENCE_PIN_SHA256=nick-4.8=2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4`, optional `HF_TOKEN` (base model is public), `APPROX_RELEASE_SIGNING_KEY` only if releases are signed. |
| Health | `GET /health` (no auth): `serving`, and `details.nick-4.8` = version, adapter_sha256, production_ready, base_model. |
| Inference | `POST /v1/chat/completions` (OpenAI-compatible, `stream` true/false), `Authorization: Bearer <INFERENCE_API_KEY>`. Model `nick-4.8` or `nick-4.8@<version>`. |
| Release layout | `deploy/models/nick-4.8/versions/<version>/{release.json, metadata.json, adapter/adapter_model.safetensors, adapter/adapter_config.json, SHA256SUMS}` + `deploy/models/active.json`. `release.json` must be `status: validated` with `base_model_revision: aa8e72537993ba99e69dfaafa59ed015b17504d1` (the server loads the base at that exact revision). `deploy/nick-gpu-setup.sh` checks and installs this. |

## Choosing a GPU host (decide; nothing is created for you)

- **Free (testing only, not production):** a Colab or Kaggle T4 can run the server for one session, reached through
  a temporary tunnel. The session ends (hours), the URL changes, and those platforms restrict hosting services.
  Kaggle GPU/Internet was not enabled on this account earlier.
- **Cheapest persistent:** a spot/interruptible T4 or L4 VM (Google Cloud spot `n1-standard-4` + 1× T4, or a
  community GPU on RunPod/Vast.ai), roughly US$0.10–0.30 per hour while running. **This costs money and needs a
  billing account.** Check current prices on the provider's page. Stop the VM when you don't need it.
  Spot VMs can be interrupted, and Nick goes offline until restarted (the app shows "offline", never another model).

## A. Copy the release from Google Drive to private Cloud Storage (run in a Google Colab notebook)

```python
from google.colab import drive, auth
drive.mount('/content/drive'); auth.authenticate_user()
PROJECT = "YOUR_GCP_PROJECT_ID"            # placeholder
BUCKET  = "approx-models-" + PROJECT        # private bucket (uniform access, no public ACLs)
ZIP = "/content/drive/MyDrive/ApproxAI/work/nick-4.8/nick-4.8-release.zip"
!gcloud config set project {PROJECT}
!gcloud storage buckets create gs://{BUCKET} --location=us-central1 --uniform-bucket-level-access --public-access-prevention || true
!sha256sum "{ZIP}"
!gcloud storage cp "{ZIP}" gs://{BUCKET}/nick-4.8/nick-4.8-release.zip
!gcloud storage ls -l gs://{BUCKET}/nick-4.8/
```
The `gs://…/nick-4.8/nick-4.8-release.zip` path is the **artifact location** you will enter in Approx later.

## B. Create the GPU VM (Google Cloud Shell, which works in a phone browser)

```bash
PROJECT=YOUR_GCP_PROJECT_ID; ZONE=us-central1-a; BUCKET=approx-models-$PROJECT
gcloud config set project $PROJECT
# Pick a current Deep Learning VM image family with CUDA 12 (NVIDIA driver preinstalled):
gcloud compute images list --project deeplearning-platform-release --no-standard-images --filter="family~cu12" --format="value(family)" | sort -u
FAMILY=PASTE_A_FAMILY_FROM_THE_LIST
gcloud compute instances create approx-nick-gpu --zone=$ZONE --machine-type=n1-standard-4 \
  --accelerator=type=nvidia-tesla-t4,count=1 --maintenance-policy=TERMINATE \
  --provisioning-model=SPOT --instance-termination-action=STOP \
  --image-family=$FAMILY --image-project=deeplearning-platform-release \
  --boot-disk-size=60GB --metadata=install-nvidia-driver=True \
  --scopes=storage-ro --tags=approx-inference
gcloud compute firewall-rules create approx-inference-https --allow=tcp:80,tcp:443 --target-tags=approx-inference
gcloud compute ssh approx-nick-gpu --zone=$ZONE
```

## C. On the GPU VM: Docker + NVIDIA toolkit, repo, release, keys

```bash
nvidia-smi                                                   # must show the T4 and a CUDA 12.x driver
command -v docker || curl -fsSL https://get.docker.com | sudo sh
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
sudo docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi   # GPU visible inside Docker

git clone https://github.com/umer630/Approx-Ai.git && cd Approx-Ai && git checkout ccr-b9e70091-57vl48
#   (private repo? run `gh auth login` on the VM first; never paste a token into chat)
BUCKET=approx-models-YOUR_GCP_PROJECT_ID
gcloud storage cp gs://$BUCKET/nick-4.8/nick-4.8-release.zip /tmp/
bash deploy/nick-gpu-setup.sh /tmp/nick-4.8-release.zip      # SHA pin, base model, base revision, release checks

cp deploy/inference.env.example deploy/inference.env && chmod 600 deploy/inference.env
sed -i "s/^INFERENCE_API_KEY=.*/INFERENCE_API_KEY=$(openssl rand -hex 32)/; s/^INFERENCE_ADMIN_KEY=.*/INFERENCE_ADMIN_KEY=$(openssl rand -hex 32)/" deploy/inference.env
grep -c '^INFERENCE_API_KEY=.\{64\}$' deploy/inference.env                      # prints 1 (key set; value not shown)
```

## D. Start the real inference server and test it

```bash
sudo docker compose -f deploy/nick-gpu-compose.yml up -d --build
sudo docker compose -f deploy/nick-gpu-compose.yml logs -f --tail=50   # wait for "nick-4.8: now serving <version> (sha256 2faae2162…)"; Ctrl+C
curl -s localhost:8000/health | python3 -m json.tool                    # details.nick-4.8.adapter_sha256 = 2faae216…09c34c4
KEY=$(grep '^INFERENCE_API_KEY=' deploy/inference.env | cut -d= -f2-)
curl -s localhost:8000/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"nick-4.8","stream":false,"max_tokens":80,"messages":[{"role":"user","content":"Assalam o Alaikum! Apna taaruf do jumlon mein karwao."}]}' | python3 -m json.tool
curl -s -o /dev/null -w "no key → %{http_code} (expect 401)\n" localhost:8000/v1/chat/completions -d '{}'
unset KEY
```

## E. HTTPS in front (no domain needed: sslip.io + Let's Encrypt via Caddy)

```bash
IP=$(curl -s -H Metadata-Flavor:Google http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
HOST="$(echo "$IP" | tr . -).sslip.io"
sudo docker run -d --name caddy --restart unless-stopped --network host -v caddy-data:/data caddy:2 \
  caddy reverse-proxy --from "$HOST" --to localhost:8000
sleep 20; curl -s "https://$HOST/health" | python3 -m json.tool
echo "APPROX_MODEL_NICK_URL=https://$HOST/v1"
```
Spot VMs get a new external IP after a restart unless you reserve a static IP (`gcloud compute addresses create …`).

## F. Only after D and E succeed: Vercel and activation

1. Vercel → Settings → Environment Variables (Production):
   - `APPROX_MODEL_NICK_URL` = `https://<HOST from step E>/v1`
   - `APPROX_MODEL_NICK_KEY` = the `INFERENCE_API_KEY` value in `deploy/inference.env` on the VM (Sensitive).
     View it on the VM with `grep '^INFERENCE_API_KEY=' deploy/inference.env | cut -d= -f2-`. Never paste it into chat.
   - Redeploy.
2. Approx → Admin console → Model lifecycle → nick-4.8 → **Deploy trained adapter & verify**:
   - **Version:** `version` from `release.json`.
   - **Artifact:** `gs://approx-models-…/nick-4.8/nick-4.8-release.zip`.
   - **SHA-256:** pre-filled `2faae216…09c34c4`.
   - **Base revision:** `aa8e72537993ba99e69dfaafa59ed015b17504d1`.
3. The backend checks the live server (version + SHA-256 + production-ready + a real generation). Only then is Nick
   `ACTIVE`, in the web app and the existing APK, with no rebuild.

**Production-readiness:** activation requires `release.json` to say `production_ready: true`, which the release
verifier only accepts if the release's own evidence supports it (verification passed, quality gate passed,
production-ready dataset). `deploy/nick-gpu-setup.sh` prints a NOTE when it is not true. In that case activation stops
at the `release` stage. The options are to produce that evidence (evaluation gate) or a deliberate, audited decision
by the owner. Nothing switches it on silently.
