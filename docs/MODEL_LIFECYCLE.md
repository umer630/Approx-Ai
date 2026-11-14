# Model lifecycle, Nick 4.8 connection, and future models

## Where each model stands

| Model | Lifecycle state | Why |
|---|---|---|
| Nick 4.8 | `REGISTERED` | Already trained; its adapter SHA-256 is pinned (`2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4`). It is **not ACTIVE** until the deployment checks below pass. |
| Hike 6.5 | `TRAINING_REQUIRED` | Not trained. Config: `training/models/hike-6.5.yaml` (base `Qwen/Qwen2.5-7B-Instruct`). |
| Sona 9.0 | `TRAINING_REQUIRED` | Not trained. Config: `training/models/sona-9.0.yaml` (base `Qwen/Qwen2.5-14B-Instruct`). |
| FAB 500X | `TRAINING_REQUIRED` | Not trained. Config: `training/models/fab-500x.yaml` (base `Qwen/Qwen2.5-Coder-32B-Instruct`). Remains superadmin-grant-only. |

The base-model revisions in those configs are `null`. Training resolves the exact revision and records it in
`train_metadata.json` → `base_model_revision`. No adapter path or hash is assumed anywhere.

## Lifecycle

```
TRAINING_REQUIRED / REGISTERED → TRAINING → TRAINING_COMPLETE → EVALUATING → VERIFIED → DEPLOYING → ACTIVE
                          any failure → FAILED (stage + reason recorded; never activates)
```

| Step | Gate (backend-enforced) |
|---|---|
| `TRAINING` | A GPU worker claims a queued training job (`/api/admin/compute/jobs`). Only one active job per model. |
| `TRAINING_COMPLETE` | Artifact registered: persistent location (`gs://`, `s3://`, `https://`, `hf://`), adapter SHA-256, base model (must match the config), **exact base revision**, version. Pinned models must match their pin. |
| `VERIFIED` | Evaluation report with `verification_passed`, `safety_passed`, every functional check passing, and the **same SHA-256** as the artifact. Smoke-test adapters are rejected. |
| `DEPLOYING` → `ACTIVE` | The backend calls the live inference server. Its `/health` must report this exact version **and** adapter SHA-256, a production-ready release, **and** a real generation must return text. Otherwise the state becomes `FAILED` with the reason. |

A completed training job **never** activates a model by itself. Workers (API key with scope `training:worker`) report
progress and failures through `POST /api/v1/worker/models/:id/lifecycle`, but cannot set `ACTIVE`.
`ACTIVE` can only be reached through `POST /api/admin/models/:id/lifecycle {"to":"DEPLOYING"}` (superadmin), which runs
the verification. You can also do this from **Admin console → Model lifecycle**.

**Apps:** web and Android read model availability from `GET /api/models` (field `lifecycle`). A model that becomes
`ACTIVE` is selectable immediately. No new APK or frontend deployment is needed. Until then the model selector shows
its state (for example "Training required") and the backend refuses generation for it. Auto routing skips models
that are not active.

## Connecting Nick 4.8 (what is needed, in order)

What is missing today, verified on 2026-11-14:
- **The adapter files.** They are in the owner's Google Drive (Colab run, `MyDrive/ApproxAI/...`). They are not in
  this repository, not on Kaggle (no notebook outputs, datasets or models under the account), and this build
  environment has no Drive or Google Cloud credentials.
- **A GPU inference host.** Nothing is running yet. Vercel cannot run the model. A 3B base model with a QLoRA adapter
  needs a GPU (or a large CPU instance) running `inference/server.py`.

Steps once both exist:
1. On the GPU host, place the Nick 4.8 release (`nick-4.8-adapter-1.0.0.tar.gz`, `SHA256SUMS`, `verification.json`,
   `train_metadata.json`) in the registry directory and start the inference server with
   `deploy/nick-gpu-compose.yml` (`INFERENCE_PIN_SHA256=nick-4.8=2faae216…` refuses any other adapter). Confirm that
   `https://<gpu-host>/health` lists `nick-4.8` with that SHA-256.
2. In Vercel → Settings → Environment Variables, add `APPROX_MODEL_NICK_URL=https://<gpu-host>/v1` and
   `APPROX_MODEL_NICK_KEY=<the inference server's INFERENCE_API_KEY>` (mark it sensitive), then redeploy.
3. Sign in as superadmin → Admin console → **Model lifecycle → nick-4.8 → Deploy trained adapter & verify**. Enter:
   - **Version:** the release version (from the release file name or `release.json`).
   - **Artifact location:** where the release is stored persistently (for example a `gs://` path).
   - **SHA-256:** pre-filled with the pin.
   - **Base revision:** `base_model_revision` from `train_metadata.json`.
4. The backend runs the checks above. If they pass, Nick 4.8 becomes `ACTIVE` and is usable in the web app and the
   existing APK. If anything fails, the reason is shown, and nothing is activated.

## Training Hike 6.5, Sona 9.0, FAB 500X

1. Admin console → Compute → queue a training job for the model. Duplicate jobs are refused.
2. Start a GPU worker with `python training/run_all_training.py --worker` and an admin API key with scope
   `training:worker`. The job moves the model to `TRAINING`. A failure records `FAILED(training)` and the log tail.
   **Retry** re-queues the same job.
3. When training finishes, the worker uploads the release to persistent storage and reports `TRAINING_COMPLETE`
   (artifact + revision), then `EVALUATING` and `VERIFIED` (evaluation report).
4. Deploy the release to the inference server, then **Deploy & verify** as for Nick.

GPU capacity is not assumed: a queued job waits until a worker with a suitable GPU connects (see each config's
`hardware`/`profiles`). The FAB 500X 32B base model needs a large GPU, for example an A100 80 GB.
