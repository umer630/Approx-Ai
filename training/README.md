# Nick 4.8 training pipeline

Base: `Qwen/Qwen2.5-3B-Instruct` · Method: QLoRA (4-bit NF4, LoRA r=16 on all attention + MLP
projections) · Environment: Kaggle or Colab NVIDIA GPU (T4 16 GB is enough).

**Status in this release: training NOT run.** The build environment has no GPU and cannot reach
Hugging Face or Kaggle. Everything that does not need model weights was executed and tested.

```
data/seed/make_seed.py         → original Approx seed set (45 records, all 18 domains, EN/UR/Roman-UR)
configs/dataset_sources.json   → source registry; only approved sources are ingested
python -m approx_data.build    → data/processed/{train,eval}.jsonl + manifest.json (provenance + SHA-256)
python train_qlora.py --dry-run→ validates config and dataset hashes (CPU)
python train_qlora.py          → GPU training, checkpoints, auto-resume, adapter + manifest
python verify_adapter.py --adapter outputs/nick-4.8-qlora-v1/adapter
                               → files, hashes, load, inference, identity/language/safety probes, perplexity
kaggle/nick_4_8_qlora.ipynb    → the whole flow as a Kaggle/Colab notebook
python -m unittest discover -s tests   → CPU tests (5/5 pass)
```

## Completion criteria (spec §30)
Training is complete only when: (1) training ran, (2) adapter files exist, (3) the adapter loads,
(4) inference works, (5) `verify_adapter.py` reports `verification_passed: true`. The backend's
`POST /api/admin/training/adapters` refuses adapters without that flag.

## Data policy
- Public datasets are ingested only after license, quality, privacy and domain review (`approved: true`).
- User history enters only via the consented export (`/api/admin/training/export-consented`): opt-in,
  per-chat eligibility, PII scrubbed twice, no user IDs, FAB conversations excluded by DB constraint.
- Current-world facts belong in Approx Research (retrieval), not in weights.

## Important: the 45-record seed set is for pipeline validation
It teaches identity and format but is far too small for a meaningful fine-tune. A real Nick 4.8 run
needs approved public datasets (tens of thousands of balanced examples, including Urdu and
Roman Urdu) added to `configs/dataset_sources.json`.
