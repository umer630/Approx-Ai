"""Language identification for the dataset pipeline (dependency-free, deterministic).

Strategy: dominant Unicode script → language family; within a script, language-specific letters and function words
decide (Arabic vs Urdu vs Persian; Chinese vs Japanese; Hindi vs Marathi/Nepali share Devanagari → reported as 'hi'
only with Hindi function words); Latin-script text is scored against function-word lists, including Roman Urdu.
Returns (lang, script, confidence). 'und' (undetermined) is returned instead of guessing, and records whose detected
language contradicts the source's declared language are flagged by the pipeline.

Adding a language = add its script range and/or function-word list below. No core change needed.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter

# Script ranges (first match wins for each character).
SCRIPTS = [
    ("Arab", [(0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)]),
    ("Cyrl", [(0x0400, 0x04FF)]),
    ("Deva", [(0x0900, 0x097F)]),
    ("Beng", [(0x0980, 0x09FF)]),
    ("Hang", [(0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F)]),
    ("Kana", [(0x3040, 0x30FF)]),
    ("Hani", [(0x4E00, 0x9FFF), (0x3400, 0x4DBF)]),
    ("Grek", [(0x0370, 0x03FF)]),
    ("Hebr", [(0x0590, 0x05FF)]),
    ("Thai", [(0x0E00, 0x0E7F)]),
    ("Taml", [(0x0B80, 0x0BFF)]),
    ("Telu", [(0x0C00, 0x0C7F)]),
    ("Guru", [(0x0A00, 0x0A7F)]),
    ("Gujr", [(0x0A80, 0x0AFF)]),
    ("Ethi", [(0x1200, 0x137F)]),
    ("Latn", [(0x0041, 0x005A), (0x0061, 0x007A), (0x00C0, 0x024F), (0x1E00, 0x1EFF)]),
]
SINGLE_SCRIPT_LANG = {"Hang": "ko", "Beng": "bn", "Grek": "el", "Hebr": "he", "Thai": "th", "Taml": "ta", "Telu": "te", "Guru": "pa", "Gujr": "gu", "Ethi": "am"}

URDU_LETTERS = set("ٹڈڑںےۓھہۃ")
PERSIAN_ONLY = set("ژ")                     # ژ is Persian (rare in Urdu); پچگ are shared by Urdu and Persian
ARABIC_LETTERS = set("ةىإأؤ")
PERSIAN_WORDS = {"است", "این", "که", "را", "برای", "می", "شود", "های", "یک", "آن", "با", "هم", "نیست", "چه"}
URDU_WORDS = {"ہے", "کے", "کی", "کا", "میں", "اور", "سے", "کو", "نہیں", "یہ", "ہیں", "کیا", "آپ", "ہم"}
ARABIC_WORDS = {"في", "من", "على", "إلى", "هو", "هي", "التي", "الذي", "كان", "هذا", "ما", "لا", "عن", "مع"}
RUSSIAN_WORDS = {"и", "в", "не", "на", "что", "это", "как", "с", "по", "я", "он", "она", "для", "но"}
UKRAINIAN_LETTERS = set("іїєґ")
HINDI_WORDS = {"है", "के", "की", "का", "में", "और", "से", "को", "नहीं", "यह", "हैं", "क्या", "आप", "हम", "था", "थे", "थी", "पर", "एक", "लिए", "भी",
               "जो", "ने", "कर", "किया", "गया", "वह", "इस", "उस", "कि", "तो", "हो", "होता", "होती", "रहा", "रही", "साथ", "बाद", "द्वारा"}

LATIN_WORDS = {
    "en": {"the", "and", "is", "are", "of", "to", "in", "that", "it", "for", "with", "you", "this", "what", "how", "be", "on", "can", "your", "have"},
    "es": {"el", "la", "los", "las", "de", "que", "y", "en", "es", "por", "para", "con", "una", "un", "del", "como", "se", "más", "pero", "está"},
    "fr": {"le", "la", "les", "des", "et", "est", "que", "une", "un", "pour", "dans", "pas", "qui", "avec", "sur", "vous", "ce", "du", "sont", "être",
           "il", "elle", "ils", "au", "aux", "cette", "ont", "été", "leur", "leurs", "nous", "mais", "ou", "où", "aussi", "très", "été", "à", "d", "l", "qu"},
    "de": {"der", "die", "das", "und", "ist", "nicht", "ein", "eine", "zu", "mit", "den", "auf", "für", "sie", "es", "ich", "auch", "von", "sich", "wie"},
    "pt": {"o", "a", "os", "as", "de", "que", "e", "é", "do", "da", "em", "um", "uma", "para", "com", "não", "por", "mais", "como", "você"},
    "it": {"il", "lo", "la", "di", "che", "e", "è", "un", "una", "per", "non", "con", "del", "della", "sono", "come", "anche", "più", "ma", "nel"},
    "id": {"yang", "dan", "di", "ini", "itu", "dengan", "untuk", "adalah", "dari", "tidak", "ke", "pada", "akan", "juga", "atau", "saya", "anda", "bisa", "ada", "kita"},
    "tr": {"ve", "bir", "bu", "da", "de", "için", "ile", "mi", "ne", "çok", "daha", "olarak", "gibi", "değil", "var", "ben", "sen", "nasıl", "olan", "kadar"},
    "nl": {"de", "het", "een", "en", "van", "is", "dat", "niet", "te", "op", "voor", "met", "zijn", "ook", "maar", "wat", "hoe", "je", "er", "aan"},
    "pl": {"i", "w", "nie", "na", "się", "to", "jest", "że", "z", "do", "jak", "co", "ale", "po", "tak", "dla", "czy", "od", "jestem", "być"},
    "vi": {"và", "của", "là", "có", "không", "được", "trong", "cho", "một", "những", "với", "các", "này", "người", "đã", "để", "khi", "như", "từ", "thì"},
    "sw": {"na", "ya", "wa", "kwa", "ni", "za", "katika", "la", "kuwa", "hii", "au", "lakini", "pia", "sana", "yake", "wako", "nini", "gani", "hapa", "kama"},
    "roman_ur": {"hai", "hain", "kya", "nahi", "nahin", "mein", "aap", "hum", "ka", "ki", "ke", "ko", "se", "karo", "kar", "yeh", "woh", "kaise",
                 "kyun", "bhi", "tha", "thi", "raha", "rahi", "mujhe", "tum", "apna", "acha", "theek", "kuch", "bohat", "bahut", "liye", "wala",
                 "aur", "par", "jo", "ya", "lekin", "agar", "unhon", "unki", "unke", "unka", "keh", "kay", "gaya", "gayi", "diya", "kiya", "hota",
                 "hoti", "jab", "tak", "sakta", "sakti", "sakte", "jata", "jati", "ek", "is", "us", "inhon", "apne", "apni", "baad", "pehle", "saath", "dauran"},
}
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def script_of(ch: str) -> str | None:
    o = ord(ch)
    for name, ranges in SCRIPTS:
        for a, b in ranges:
            if a <= o <= b:
                return name
    return None


def dominant_script(text: str) -> tuple[str, float]:
    c = Counter(s for s in map(script_of, text) if s)
    if not c:
        return "Zyyy", 0.0
    s, n = c.most_common(1)[0]
    return s, n / sum(c.values())


def detect(text: str) -> tuple[str, str, float]:
    """(language, script, confidence in [0,1]). 'und' when the evidence is too weak."""
    t = unicodedata.normalize("NFC", re.sub(r"```.*?```", " ", text or "", flags=re.S))
    script, share = dominant_script(t)
    if script == "Zyyy":
        return "und", script, 0.0
    words = [w.lower() for w in WORD.findall(t)]
    wset = Counter(words)
    hits = lambda vocab: sum(wset[w] for w in vocab)  # noqa: E731
    if script in SINGLE_SCRIPT_LANG:
        return SINGLE_SCRIPT_LANG[script], script, round(share, 3)
    if script == "Kana" or (script == "Hani" and any(script_of(ch) == "Kana" for ch in t)):
        return "ja", "Jpan", round(share, 3)
    if script == "Hani":
        return "zh", "Hani", round(share, 3)
    if script == "Cyrl":
        if any(ch in UKRAINIAN_LETTERS for ch in t.lower()):
            return "uk", script, round(share * 0.9, 3)
        return ("ru", script, round(share, 3)) if hits(RUSSIAN_WORDS) else ("ru", script, round(share * 0.6, 3))
    if script == "Deva":
        return ("hi", script, round(share, 3)) if hits(HINDI_WORDS) else ("und", script, 0.3)
    if script == "Arab":
        scores = {"ur": sum(ch in URDU_LETTERS for ch in t) * 2 + hits(URDU_WORDS) * 3,
                  "fa": sum(ch in PERSIAN_ONLY for ch in t) * 2 + hits(PERSIAN_WORDS) * 3,
                  "ar": sum(ch in ARABIC_LETTERS for ch in t) * 2 + hits(ARABIC_WORDS) * 3}
        best = max(scores, key=scores.get)
        total = sum(scores.values())
        if scores[best] == 0:
            return "und", script, 0.2
        return best, script, round(share * scores[best] / total, 3)
    if script == "Latn":
        scores = {lang: hits(vocab) for lang, vocab in LATIN_WORDS.items()}
        best = max(scores, key=scores.get)
        n = max(1, len(words))
        if scores[best] == 0 or scores[best] / n < 0.05:
            return "und", script, 0.2
        second = sorted(scores.values())[-2]
        conf = (scores[best] - second) / max(1, scores[best])
        return best, script, round(min(1.0, 0.5 + conf / 2) * share, 3)
    return "und", script, 0.2
