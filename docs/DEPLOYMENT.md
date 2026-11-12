# Deployment

**Status: not deployed.** No deployment credentials (cloud account, domain, TLS, mail provider, GPU host)
were available in the build environment. Everything below is ready to run once they are.

## Requirements
1. A host for the backend container (any Docker host / VM / PaaS) with a persistent volume for `/data`.
2. HTTPS termination (Caddy, nginx, a cloud load balancer). The Android app refuses non-HTTPS servers.
3. A GPU host for inference (≥16 GB VRAM for Qwen2.5-3B-Instruct + LoRA via vLLM), or any
   OpenAI-compatible endpoint you are licensed to use.
4. A transactional mail provider with an HTTP API (for verification and password-reset emails).
5. A trained, verified Nick 4.8 adapter (see `training/README.md`).

## Steps
```bash
cp deploy/approx.env.example deploy/approx.env   # fill in values — never commit
mkdir -p deploy/adapters && tar xzf nick-4.8-adapter-1.0.0.tar.gz -C deploy/adapters && mv deploy/adapters/adapter deploy/adapters/nick-4.8
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec approx node backend/src/cli.js promote you@example.com superadmin
```
Point your HTTPS reverse proxy at `127.0.0.1:8080`. Then:
- Web app: `https://<domain>/` · Signup: `https://<domain>/#/signup` · Developer console:
  `https://<domain>/developers/` · API: `https://<domain>/api/v1`.
- Build the APK with the server baked in: `APPROX_SERVER_URL=https://<domain> ./android/build.sh`
  (sign with Approx Technology's protected release key via `KEYSTORE=` / `KEYSTORE_PASS=`).

## Operations
- Backups: copy `/data/approx.db` (use `sqlite3 .backup`) and `/data/uploads`.
- Logs: stdout; audit and security events in the `audit_logs` / `security_events` tables (admin console).
- Scaling: single-process SQLite design fits a single instance. For horizontal scaling, move to
  PostgreSQL (schema is portable) and a shared rate-limit store.

## Model registry & inference server (1.1)
The backend no longer hard-codes model behaviour. Models live in `backend/config/models.json`; trained adapters
are imported as versioned, verified **release artifacts** and activated under audit. See
`docs/TRAINING_PLATFORM.md` for the full runbook.

- **Inference**: run `inference/server.py` on a GPU host (its own Dockerfile / compose service). It serves only
  registry-activated adapters, loads 4-bit NF4 on CUDA (no CPU fallback — `GPU_REQUIRED` otherwise), and hot-reloads
  on activation. Point the backend's `APPROX_MODEL_<FAMILY>_URL` at it and leave `_NAME` unset so it addresses
  `<model>@<version>`.
- **Shared registry volume**: backend and inference share `APPROX_MODELS_DIR` (`/models`). The backend writes
  `active.json`; the inference server reads it (read-only), re-verifies, and reloads.
- **Activate a model**: `node backend/src/cli.js models import <artifact.tar.gz>` then
  `node backend/src/cli.js models activate <model> <version>`, or use the web/Android admin console.
- **Keys**: generate `INFERENCE_API_KEY` / `INFERENCE_ADMIN_KEY` with `openssl rand -hex 32`; set the admin key as
  the backend's `APPROX_INFERENCE_ADMIN_KEY`. Never commit them.

## NEBIUS notes
The artifact format is object-storage friendly: each release is a self-contained directory (and a portable
`.tar.gz`) with no absolute paths, so `<models_dir>` can be a mounted bucket. Metadata (projects, datasets, GPU
jobs, workers, checkpoints, adapters, versions, evaluations, deployments) lives in the backend database
(`model_releases`, `gpu_jobs`, `gpu_workers`, `audit_logs`). **Model weights are never stored in the database** —
only metadata and hashes. Supabase/PostgreSQL can host that metadata (the schema is portable); weights stay on
object storage / the shared volume. GPU training runs via `run_all_training.py --worker` against the backend
control plane (`/api/admin/compute`, `/api/v1/worker/*`).
