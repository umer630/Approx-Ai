"""Dataset quality gates. Every rejection has a named reason that is counted in the dataset manifest.

Record-level gates (check_record): schema, empty turns, Unicode problems, invalid formatting (raw chat-template
tokens, unbalanced code fences), prompt leakage (system prompt or hidden instructions repeated in the answer),
prompt-injection contamination (answer complies with an injection), repetition, nonsensical text, low quality
(too short/long, boilerplate, foreign identity), harmful targets, time-sensitive facts.

Corpus-level gates: exact duplicates, near-duplicates (MinHash/LSH over character 5-grams; number-aware, so
"23 + 45" and "23 + 46" are NOT duplicates), contradictions (the same question with conflicting final answers).
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter, defaultdict

ROLES = ("system", "user", "assistant")
CHAT_TOKENS = re.compile(r"<\|(im_start|im_end|endoftext|system|user|assistant)\|>|\[INST\]|<<SYS>>")
MOJIBAKE = re.compile(r"(Ã.|Ø.|Ù.|â€|Â\s)")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‎‏‪-‮⁦-⁩]")
INJECTION = re.compile(r"(ignore (all |any )?(the )?(previous|prior|above) (instructions|rules)|disregard (your|the) (rules|instructions)|"
                       r"you are now (dan|in developer mode)|developer mode enabled|jailbreak(ed)? mode|pretend you have no (rules|restrictions)|"
                       r"reveal (your|the) system prompt|print your (hidden|system) (prompt|instructions))", re.I)
LEAK_PHRASES = re.compile(r"(my system prompt (is|says)|here (is|are) my (hidden |system )?instructions|my hidden instructions)", re.I)
REFUSAL = re.compile(r"(i can(no|')t help|i can(no|')t assist|i won'?t (help|provide|write|create)|i'?m not able to (help|provide)|"
                     r"i can(no|')t (do|share|provide|write|create|reveal|ignore|follow|disregard)|i won'?t (ignore|disregard|reveal)|not able to share|"
                     r"main (is|iss) (mein|me) madad nahi|madad nahi kar (sakta|sakti)|nahi bata (sakta|sakti)|"
                     r"میں اس (میں|کام میں) مدد نہیں|مدد نہیں کر سکتا|نہیں بتا سکتا)", re.I)
HARMFUL_TARGET = re.compile(r"(ransomware (code|source|payload)|keylogger (code|source)|credential stealer|steal (their |the )?passwords? (with|using)|"
                            r"make a (pipe )?bomb|nerve agent synthesis|import pynput.*keyboard.*listener|encrypt all files and demand)", re.I | re.S)
FOREIGN_ID = re.compile(r"^(as an ai language model|i am chatgpt|i'?m chatgpt|i am claude|i'?m claude|i am gemini|i am llama)", re.I)
TIME_SENSITIVE = re.compile(
    r"\b(as of (19|20)\d\d|currently|current (prime minister|president|ceo|price|rate|champion)|latest (version|news|price)|"
    r"this year|today'?s (price|rate|news)|stock price|exchange rate|breaking news)\b", re.I)
URDU_CHARS = re.compile(r"[؀-ۿ]")
ROMAN_URDU = re.compile(r"\b(kya|hai|hain|kaise|kaisay|mujhe|aap|nahi|nahin|kyun|batao|bataen|karein|karo|kar|ka|ki|ke|mein|se|ko|hota|hoti|wala|wali)\b", re.I)
NUM = re.compile(r"-?\d+(?:[.,]\d+)?")


def detect_language(text: str) -> str:
    ur = len(URDU_CHARS.findall(text))
    latin = len(re.findall(r"[A-Za-z]", text))
    roman = len(ROMAN_URDU.findall(text))
    if ur and latin > ur * 0.6:
        return "mixed"
    if ur:
        return "ur"
    words = max(1, len(text.split()))
    if roman >= 2 and roman / words >= 0.12:
        eng = len(re.findall(r"\b(the|is|are|what|how|why|and|of|to|in)\b", text, re.I))
        return "mixed" if eng >= 3 and eng / words > 0.12 else "roman_ur"
    return "en"


def user_text(r: dict) -> str:
    return " ".join(m["content"] for m in r["messages"] if m["role"] == "user")


def answer_text(r: dict) -> str:
    return r["messages"][-1]["content"]


def norm_text(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[^\w؀-ۿ]+", " ", t).strip()


def prompt_key(r: dict) -> str:
    return hashlib.sha256(norm_text(user_text(r)).encode()).hexdigest()


def final_answer(text: str):
    """Best-effort final answer used for contradiction checks: the last number, or yes/no."""
    tail = text[-200:]
    m = re.search(r"(answer|jawab|جواب)\s*[:=]?\s*\**\s*(-?\d+(?:\.\d+)?)", tail, re.I)
    if m:
        return ("num", m.group(2))
    nums = NUM.findall(tail)
    if nums:
        return ("num", nums[-1].replace(",", ""))
    low = text.strip().lower()
    if re.match(r"^(yes|haan|جی ہاں|ہاں)\b", low):
        return ("yn", "yes")
    if re.match(r"^(no|nahi|nahin|نہیں)\b", low):
        return ("yn", "no")
    return None


def check_schema(r, domains: set) -> str | None:
    if not isinstance(r, dict):
        return "malformed: record is not an object"
    msgs = r.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        return "malformed: messages must be a list with >= 2 turns"
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ROLES or not isinstance(m.get("content"), str):
            return "malformed: bad message shape"
    if msgs[-1]["role"] != "assistant":
        return "malformed: last turn must be assistant"
    if not any(m["role"] == "user" for m in msgs):
        return "malformed: no user turn"
    if sum(1 for m in msgs if m["role"] == "system") > 1 or any(m["role"] == "system" for m in msgs[1:]):
        return "malformed: system turn must be first and unique"
    if r.get("domain") not in domains:
        return f"malformed: unknown domain {r.get('domain')!r}"
    return None


def _repetitive(text: str) -> bool:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if lines and Counter(lines).most_common(1)[0][1] >= 4 and len(lines) >= 5:
        return True
    toks = text.split()
    if len(toks) >= 40:
        grams = Counter(tuple(toks[i:i + 4]) for i in range(len(toks) - 3))
        if grams.most_common(1)[0][1] / max(1, len(toks) - 3) > 0.15:
            return True
    return bool(re.search(r"(\b\w+\b)(\s+\1\b){5,}", text, re.I))


def _nonsensical(text: str, domain: str) -> bool:
    t = re.sub(r"```.*?```", " ", text, flags=re.S)
    letters = len(re.findall(r"[A-Za-z؀-ۿ]", t))
    visible = len(re.sub(r"\s", "", t))
    if visible >= 20 and domain not in ("mathematics", "coding", "structured_output", "physics", "chemistry", "science", "media_planning") and letters / visible < 0.35:
        return True
    words = re.findall(r"[A-Za-z]{4,}", t)
    if len(words) >= 12:
        no_vowel = sum(1 for w in words if not re.search(r"[aeiouy]", w, re.I))
        if no_vowel / len(words) > 0.4:
            return True
    return False


def check_record(r: dict, system_prompt: str = "") -> str | None:
    """Content gates for one schema-valid record. Returns a rejection reason or None."""
    msgs = r["messages"]
    for m in msgs:
        if not m["content"].strip():
            return "empty: a turn has no content"
        if "�" in m["content"] or MOJIBAKE.search(m["content"]):
            return "unicode: replacement characters or mojibake"
        if CONTROL.search(m["content"]):
            return "unicode: control / bidi-override characters"
        if unicodedata.normalize("NFC", m["content"]) != m["content"]:
            m["content"] = unicodedata.normalize("NFC", m["content"])
        if CHAT_TOKENS.search(m["content"]):
            return "formatting: raw chat-template tokens in text"
    user, ans = user_text(r), answer_text(r)
    if ans.count("```") % 2:
        return "formatting: unbalanced code fence"
    min_ans = 1 if r.get("category") == "format_constraint" else 8
    if len(user.strip()) < 3 or len(ans.strip()) < min_ans:
        return "quality: too short"
    if len(ans) > 12000:
        return "quality: too long"
    if FOREIGN_ID.search(ans.strip()):
        return "quality: foreign identity / boilerplate"
    if LEAK_PHRASES.search(ans):
        return "leakage: answer exposes hidden instructions"
    sys_msg = msgs[0]["content"] if msgs[0]["role"] == "system" else system_prompt
    if sys_msg and len(sys_msg) >= 60:
        probe = norm_text(sys_msg)[:80]
        if len(probe) >= 50 and probe in norm_text(ans):
            return "leakage: answer repeats the system prompt"
    if INJECTION.search(ans) and not REFUSAL.search(ans):
        return "injection: answer contains injection text"
    if INJECTION.search(user) and not REFUSAL.search(ans) and r.get("category") != "injection_resistance":
        return "injection: answer complies with a prompt injection"
    if HARMFUL_TARGET.search(ans):
        return "safety: harmful content in target"
    if TIME_SENSITIVE.search(user) or TIME_SENSITIVE.search(ans):
        return "quality: time-sensitive fact (use retrieval, not weights)"
    if _repetitive(ans) and r.get("domain") not in ("media_planning", "structured_output", "coding"):
        return "repetition: degenerate repetition in answer"
    if _nonsensical(ans, r.get("domain", "")) or _nonsensical(user, r.get("domain", "")):
        return "nonsensical: text is not meaningful language"
    return None


# ---------------------------------------------------------------- near-duplicates (MinHash + LSH)
_PERMS = 64
_BANDS = 16
_MASK = (1 << 61) - 1
_SEEDS = [int.from_bytes(hashlib.blake2b(f"approx-minhash-{i}".encode(), digest_size=8).digest(), "big") & _MASK for i in range(_PERMS)]


def _shingles(text: str, k: int = 5) -> set:
    t = re.sub(r"\s+", " ", norm_text(text))
    return {t[i:i + k] for i in range(max(1, len(t) - k + 1))}


def _minhash(sh: set) -> tuple:
    hs = [int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "big") & _MASK for s in sh]
    try:
        import numpy as np
        a = np.array(hs, dtype=np.uint64)[:, None] ^ np.array(_SEEDS, dtype=np.uint64)[None, :]
        return tuple(int(x) for x in a.min(axis=0))
    except ImportError:
        return tuple(min(h ^ s for h in hs) for s in _SEEDS)


class NearDupIndex:
    """Number-aware near-duplicate detection: Jaccard > threshold on 5-gram shingles AND identical numbers."""

    def __init__(self, threshold: float = 0.85):
        self.threshold = threshold
        self.buckets = defaultdict(list)
        self.items = []    # (shingles, numbers, cluster_id)

    def find(self, text: str):
        sh = _shingles(text)
        nums = tuple(NUM.findall(text))
        mh = _minhash(sh)
        rows = _PERMS // _BANDS
        cands = set()
        keys = [(b, mh[b * rows:(b + 1) * rows]) for b in range(_BANDS)]
        for k in keys:
            cands.update(self.buckets.get(k, ()))
        for i in sorted(cands):
            osh, onums, cid = self.items[i]
            if onums == nums and len(sh & osh) / max(1, len(sh | osh)) > self.threshold:
                return cid, (sh, nums, keys)
        return None, (sh, nums, keys)

    def add(self, sig, cluster_id: str):
        sh, nums, keys = sig
        idx = len(self.items)
        self.items.append((sh, nums, cluster_id))
        for k in keys:
            self.buckets[k].append(idx)


def find_contradictions(records: list) -> set:
    """Indices of records whose (normalised) question has conflicting final answers elsewhere in the corpus."""
    groups = defaultdict(list)
    for i, r in enumerate(records):
        groups[prompt_key(r)].append(i)
    bad = set()
    for idxs in groups.values():
        if len(idxs) < 2:
            continue
        answers = {final_answer(answer_text(records[i])) for i in idxs}
        answers.discard(None)
        kinds = defaultdict(set)
        for kind, val in answers:
            kinds[kind].add(val)
        if any(len(v) > 1 for v in kinds.values()):
            bad.update(idxs)
    return bad
