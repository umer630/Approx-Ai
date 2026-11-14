# Backup report — before the dataset/training rebuild

Generated 2026-11-14T17:58:00Z at commit `eec31da22e2c75c1e9c683810e5dcea435b5604c`. Nothing listed here is modified or deleted by the rebuild;
new datasets and training runs write to new, versioned paths only.

## Recovered Nick 4.8 adapter (not in this repository)

- Pinned SHA-256 (backend catalog `pinned_adapter_sha256`): `2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4`
- Deployment pin: `deploy/inference.env.example` → `INFERENCE_PIN_SHA256=nick-4.8=2faae216…`
- Location (owner-reported): Google Drive `/content/drive/MyDrive/ApproxAI/work/nick-4.8/nick-4.8-release.zip`;
  checkpoint `…/nick-4.8/train_output/checkpoint-21`. The rebuild never reads or writes Drive paths except a new,
  versioned output directory (`…/nick-4.8/runs/<run-id>/`), and the runner refuses to write into an existing run directory.
- Production status: lifecycle `REGISTERED` (not ACTIVE). The old adapter is **not** declared production-ready by this work.

## File checksums (SHA-256)

| File | SHA-256 | Bytes |
|---|---|---|
| `backend/config/models.json` | `ea64807d89bc24e3c64192d8f9580044ccb3e25f9367de7f0d6002cf662e20ed` | 7079 |
| `deploy/inference.env.example` | `f694874e20ac71b3333d5dd36d4002f1abebdff4d2aa35a95364d166fec4693b` | 1400 |
| `deploy/nick-gpu-compose.yml` | `3c260bc5b00a3ea95e7b0ce3b77a56d52fb2a035fac2b08e6a1b09b341205f44` | 1227 |
| `deploy/nick-gpu-setup.sh` | `b2fc809ef4ec505ccfcce478b81cc20df96fde879dc104df1411b84d772a5134` | 5062 |
| `training/configs/nick-4.8-qlora.json` | `22a10db57fc4379cf81eae1255ca0493bdcd80ad76f35cfaab31ce7da25c8ff8` | 1401 |
| `training/configs/dataset_sources.json` | `5fcca88ee6845f04fc51876c827c0a1fb8f73ea3d93cb009d5f9da1b34ef0c39` | 2693 |
| `training/models/nick-4.8.yaml` | `fe448f8b7d2ca53101215b34088b24574eb0422912953f2aa0fc08cbdba1b31b` | 2795 |
| `training/models/hike-6.5.yaml` | `fa1773552c776f149fd77c7d692234a89ab1359ed46fb62f5c3b1c492da62239` | 2160 |
| `training/models/sona-9.0.yaml` | `20bf956860865344f7e25248148bee68483b3ec962cdf900301cdaa605cc1e2d` | 2190 |
| `training/models/fab-500x.yaml` | `9f3f60d4639b8e309cae83028cce25083cd63251d8b5b41ea7cc2591ebb28a18` | 3039 |
| `training/data/seed/approx_seed_v0_1.jsonl` | `2802a288ab301e7f5c3d2b5042ce18d29bfd4aa51cd4e9d11668ad8004922792` | 26178 |
| `training/data/processed/manifest.json` | `af1b58a0a579f265d327936cf2509a7fdab9a7fd9374335c4560407aedbfce41` | 4698 |
| `training/data/processed/train.jsonl` | `fccfa9ae065706f5950c1b9063e15d15a8295f01fc08ad5f3a6a26bcfc806547` | 27735 |
| `training/data/processed/eval.jsonl` | `f3016d82b6da30a303323c0b4ba6ec43fc1ed92feac482ff96f5e7d874197f02` | 2817 |
| `training/recover_adapter.py` | `23be49f4356443c4fa5faf9e8eb5886aadd02e750ea1200ec0f80e2615344c14` | 11057 |
| `training/adapter_finalize.py` | `ffc49c92e5836c6e57baa6f328e7e826ce5aebf9a23a3eccd842949dc28a5753` | 2281 |
| `training/verify_adapter.py` | `9b3268496f85f2e1fbc5ea525ff4643464a3541b8f09bb09edae5e0728075790` | 17138 |
| `training/package_adapter.py` | `e82e299b2814100cc6c818951a52c424e7885286ebb922bae6d6af8c6c0ad701` | 4423 |
| `training/train_qlora.py` | `244b7c78cb5a9980a13a85c778fc9019b0afa1847a08e110df793f250c8bbcb0` | 31713 |
| `inference/server.py` | `af585fa07f176b8f93ba1f8792cf31d42fd1ea91d75cadd78234e0d0a4c90936` | 25482 |
