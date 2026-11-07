"""Creates a TINY randomly initialised Qwen2-architecture model + byte-level BPE tokenizer with a Qwen-style
chat template, entirely offline. Used ONLY to exercise the training/verification/packaging code on CPU.
It has no knowledge and is not Nick 4.8 — its outputs are gibberish by design.

    python tests/make_tiny_model.py <out_dir>
"""
import json
import sys
from pathlib import Path

from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers
from transformers import PreTrainedTokenizerFast, Qwen2Config, Qwen2ForCausalLM

QWEN_STYLE_TEMPLATE = (
    "{% for message in messages %}"
    "{{ '<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n' }}"
    "{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"
)


def main(out: str) -> None:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[1]
    corpus = [json.dumps(json.loads(l), ensure_ascii=False) for l in (root / "data/seed/approx_seed_v0_1.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    specials = ["<|endoftext|>", "<|im_start|>", "<|im_end|>"]
    tk = Tokenizer(models.BPE())
    tk.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tk.decoder = decoders.ByteLevel()
    tk.train_from_iterator(corpus * 3, trainers.BpeTrainer(vocab_size=1200, special_tokens=specials,
                                                           initial_alphabet=pre_tokenizers.ByteLevel.alphabet()))
    tok = PreTrainedTokenizerFast(tokenizer_object=tk, eos_token="<|im_end|>", pad_token="<|endoftext|>",
                                  additional_special_tokens=["<|im_start|>"])
    tok.chat_template = QWEN_STYLE_TEMPLATE
    tok.save_pretrained(out_dir)
    cfg = Qwen2Config(vocab_size=len(tok), hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=4,
                      num_key_value_heads=2, max_position_embeddings=4096, tie_word_embeddings=True,
                      eos_token_id=tok.eos_token_id, pad_token_id=tok.pad_token_id)
    Qwen2ForCausalLM(cfg).save_pretrained(out_dir, safe_serialization=True)
    print(f"tiny smoke model written to {out_dir} (vocab {len(tok)})")


if __name__ == "__main__":
    main(sys.argv[1])
