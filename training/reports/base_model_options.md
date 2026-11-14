# Base-model options (approval required)

Checked 2026-11-14. Hugging Face Hub model API (cardData.license, gated, sha, safetensors parameter count) + LICENSE text; tokenizer fertility measured on 300 Belebele passages per language (reports/tokenizer_fertility.json).

## Current state

- **Nick 4.8**: `Qwen/Qwen2.5-3B-Instruct` @ `aa8e7253…` — **Qwen Research License: non-commercial (research/evaluation only)**. Locked; not changed.
- **FAB 100X**: no base model — training blocked.

## Tokenizer cost (tokens per 100 characters, lower is better)

| Language | Qwen2.5-3B-Instruct | Qwen3-4B-Instruct-2507 | Phi-4-mini-instruct | SmolLM3-3B | granite-3.3-8b-instruct | Mistral-Small-3.1-24B | Qwen3-14B |
|---|---|---|---|---|---|---|---|
| en | 20.7 | 20.7 | 20.2 | 20.3 | 24.8 | 21.1 | 20.7 |
| ur | 66.8 | 66.8 | 33.8 | 63.5 | 93.1 | 37.5 | 66.8 |
| roman_ur | 36.3 | 36.3 | 31.0 | 35.3 | 40.1 | 34.8 | 36.3 |
| hi | 92.9 | 92.9 | 31.9 | 51.9 | 115.3 | 58.4 | 92.9 |
| ko | 67.2 | 67.2 | 58.5 | 60.0 | 83.5 | 53.2 | 67.2 |
| id | 29.4 | 29.4 | 23.0 | 28.9 | 35.8 | 25.4 | 29.4 |
| ar | 38.4 | 38.4 | 31.8 | 38.4 | 75.7 | 30.4 | 38.4 |
| zh | 65.2 | 65.2 | 76.5 | 79.5 | 94.3 | 90.4 | 65.2 |
| bn | 106.9 | 106.9 | 35.0 | 119.8 | 94.5 | 61.2 | 106.9 |
| fa | 57.0 | 57.0 | 32.6 | 32.8 | 73.3 | 32.1 | 57.0 |

## Candidates for nick-4.8

| Model | License | Gated | Params | Revision | GPU fit | Pros | Cons |
|---|---|---|---|---|---|---|---|
| `microsoft/Phi-4-mini-instruct` | mit | no | 3.84B | `cfbefacb9925` | QLoRA on a 16 GB T4/L4 | MIT; best tokenizer for ur/hi/bn/fa (about half Qwen's tokens per character) | Urdu/Hindi not in its declared language list; different chat template → full retrain, new adapter |
| `Qwen/Qwen3-4B-Instruct-2507` | apache-2.0 | no | 4.02B | `cdbee75f17c0` | QLoRA on a 16 GB T4/L4 | Apache-2.0; same tokenizer family as the current base (smallest migration); card claims 100+ languages | Urdu/Hindi tokenization as costly as Qwen2.5; new adapter required |
| `HuggingFaceTB/SmolLM3-3B` | apache-2.0 | no | 3.08B | `a07cc9a04f16` | QLoRA on a 16 GB GPU | Apache-2.0, same size as today | officially 6 European languages; weak fit for Urdu |

**Recommendation:** Phi-4-mini-instruct if Urdu/Hindi quality and serving cost matter most; Qwen3-4B-Instruct-2507 for the smallest migration. Either way the recovered Qwen2.5-3B adapter (2faae216…) stays archived and research-only; a new version (e.g. nick-4.9) gets a new adapter.

## Candidates for fab-100x

| Model | License | Gated | Params | Revision | GPU fit | Pros | Cons |
|---|---|---|---|---|---|---|---|
| `Qwen/Qwen3-14B` | apache-2.0 | no | 14.77B | `40c069824f42` | QLoRA on 24 GB (L4) or 40 GB A100 | Apache-2.0; strong reasoning/coding; 100+ languages claimed | Urdu/Hindi tokenization costly |
| `mistralai/Mistral-Small-3.1-24B-Instruct-2503` | apache-2.0 | no | 24.01B | `68faf511d618` | QLoRA on 40–80 GB A100 | Apache-2.0; much better ur/hi/fa tokenization than Qwen | larger → higher GPU cost; vision tower unused |
| `Qwen/Qwen3-30B-A3B-Instruct-2507` | apache-2.0 | no | 30.53B | `0d7cf23991f4` | MoE; 80 GB A100 for LoRA | Apache-2.0; fast inference (3B active) | MoE fine-tuning is less mature |

**Recommendation:** Qwen3-14B (cost-effective) or Mistral-Small-3.1-24B (better Urdu/Hindi tokenization).

## Not recommended

- `meta-llama/Llama-3.2-3B-Instruct` (llama3.2): gated; license adds naming/acceptable-use obligations
- `google/gemma-3-4b-it` (gemma): gated; Gemma terms of use add use restrictions
- `CohereLabs/aya-expanse-8b` (cc-by-nc-4.0): non-commercial
- `ibm-granite/granite-3.3-8b-instruct` (apache-2.0): permissive but worst tokenizer for ur/hi in this comparison

## What approval changes

No profile was changed. Approve one option per model and its revision is pinned in datasets/<model>/profile.json and training/models/<model>.yaml.
Switching Nick's base means a new adapter and full retraining; the recovered adapter `2faae21620ef0aea6140b296b43ab5fcf5ba2c5b721067f91797b288a09c34c4` is kept as-is.

## Configured base models — verified 2026-11-14 (Hub `cardData.license` + LICENSE file)

| Model | Configured base | Revision | License | Commercial use | Verdict |
|---|---|---|---|---|---|
| nick-4.8 | `Qwen/Qwen2.5-3B-Instruct` | pinned `aa8e7253…` | qwen-research | **no** | BLOCKED — LICENSE (unchanged; awaiting approval) |
| hike-6.5 | `Qwen/Qwen2.5-7B-Instruct` | not pinned (Hub head `a09a3545…`) | apache-2.0 | yes | license OK |
| sona-9.0 | `Qwen/Qwen2.5-14B-Instruct` | not pinned (Hub head `cf98f3b3…`) | apache-2.0 | yes | license OK |
| fab-100x | — | — | — | — | **BLOCKED — BASE MODEL** (none configured) |
| fab-500x | `Qwen/Qwen2.5-Coder-32B-Instruct` | not pinned (Hub head `381fc969…`) | apache-2.0 | yes | license OK |

Unpinned revisions are resolved and recorded at training time; pinning them (to the Hub heads above or a chosen
commit) makes runs reproducible. No configuration was changed.
