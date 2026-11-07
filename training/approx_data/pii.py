"""PII / secret scrubbing. Mirrors backend/src/pii.js so server exports and offline builds agree."""
import re

RULES = [
    ("EMAIL", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("PRIVATE_KEY", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")),
    ("API_KEY", re.compile(r"\b(?:sk|pk|apx|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("CNIC", re.compile(r"\b\d{5}-\d{7}-\d\b")),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("PHONE", re.compile(r"(?:\+92|0092|\b0)3\d{2}[ -]?\d{7}\b|\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b")),
    ("IP", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("PASSWORD", re.compile(r"\b(password|passwd|pwd|pass)\s*[:=]\s*\S+", re.I)),
]


def scrub(text: str) -> tuple[str, int]:
    count = 0
    out = text
    for label, rx in RULES:
        out, n = rx.subn(f"[{label}]", out)
        count += n
    return out, count
