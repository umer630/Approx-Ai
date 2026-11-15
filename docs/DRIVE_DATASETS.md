# Datasets on Google Drive

The datasets are too large for Git (they are gitignored). They are delivered as verified bundles and live on Google
Drive, where the Colab notebook restores them without regenerating anything.

## Drive layout

```
MyDrive/ApproxAI/
  datasets/            ← upload the bundles + SHA256SUMS here (this folder only)
    SHA256SUMS
    nick-4.8-…tar.gz  hike-6.5-…tar.gz  sona-9.0-…tar.gz  fab-100x-…tar.gz  fab-500x-…tar.gz
    review-sheets.tar.gz   (for reviewers; not used by training)
  work/<model>/runs/<RUN_ID>/   ← training runs (checkpoints, logs), created by the notebook
  work/nick-4.8/train_output/   ← recovered Qwen-based Nick adapter: never read or written
  registry/                     ← release artifacts
```

## Bundles (final build `edae620`, 2026-11-15)

| Model | Bundle | Records | Train / eval / test | Size | SHA-256 |
|---|---|---|---|---|---|
| nick-4.8 | `nick-4.8-nick-4.8-datahub-1.1-df7a0440e5.tar.gz` | 30,000 | 28,250 / 881 / 869 | 23 MB | `e90f8a80b1226f044c7b70dcd5b57ced9914cb73877b6ba8a304c0d7fca91c8d` |
| hike-6.5 | `hike-6.5-hike-6.5-datahub-1.1-7beafa5436.tar.gz` | 50,000 | 47,074 / 1,493 / 1,433 | 38 MB | `fed7d27ecd21ea06a867cf53462d00d49604a8f28253956b70fd6175ea40de06` |
| sona-9.0 | `sona-9.0-sona-9.0-datahub-1.1-781f9b7e9b.tar.gz` | 70,000 | 65,877 / 2,071 / 2,052 | 53 MB | `0115daa29e6af9a2178c18601fdc42bc6da76860f2de4c070f8e98a4659a772b` |
| fab-100x | `fab-100x-fab-100x-datahub-1.1-52df9c5655.tar.gz` | 90,000 | 84,671 / 2,667 / 2,662 | 66 MB | `a53c910371020e875f290aedcc53e032a5c1ff4c3af846662c474d9f92f963aa` |
| fab-500x | `fab-500x-fab-500x-datahub-1.1-9948ea2a5b.tar.gz` | 708,436 | 666,483 / 20,986 / 20,967 | 339 MB | `ae69b14d0bbcf1394282af006f18713ab75a993d67c2088767f4b9cbd5ab37d1` |

Each bundle contains `<model>/build/{train,eval,test}.jsonl` and `manifest.json`. Before packaging, every file's
SHA-256 and record count were checked against its manifest, and every content fingerprint against the manifest committed in
`training/datasets/<model>/manifest.json`.

## Colab

Notebook cell **2b** runs `python -m datahub.restore_bundle --bundles-dir MyDrive/ApproxAI/datasets --models <MODELS>`:
the archive must match `SHA256SUMS`, its files their manifest, and its fingerprint the repository manifest. A missing or
mismatching bundle stops the notebook (`DATASET_NOT_RESTORED`); nothing is rebuilt silently. A resumed run reuses the
dataset copy inside its own run folder.

## When the bundles change

Importing human reviews (`python -m datahub review-import …`) and rebuilding changes the datasets (rejected records are
removed, accepted ones are marked). Rebuild, then regenerate and re-upload the bundles; cell 2b refuses stale bundles
because their fingerprint no longer matches the repository manifest.
