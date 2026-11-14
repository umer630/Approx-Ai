"""Domain taxonomy + transparent keyword classifier (deterministic).

The classifier is deliberately simple and explainable: a source's own domain label wins when it has one; otherwise
keyword evidence decides; otherwise 'general_knowledge'. Non-English records without English keywords stay
'general_knowledge' (their language is tracked separately) — the coverage report says so instead of guessing.
"""
from __future__ import annotations

import re

DOMAINS = [
    "reasoning", "problem_solving", "mathematics", "science", "coding", "web_fullstack", "web_frontend", "web_backend",
    "software_engineering", "cybersecurity", "education", "research", "writing", "general_knowledge", "pakistan",
    "islamic_studies", "safety_ethics",
]
# Legacy/curriculum labels → taxonomy.
ALIASES = {"physics": "science", "chemistry": "science", "biology": "science", "astronomy": "science", "english": "writing",
           "urdu": "general_knowledge", "roman_urdu": "general_knowledge", "instruction_following": "writing", "structured_output": "software_engineering",
           "media_planning": "writing", "summarization": "writing", "business": "writing", "productivity": "writing", "daily_tasks": "problem_solving",
           "structured_responses": "writing", "malformed_input": "safety_ethics", "hallucination_resistance": "safety_ethics", "safety": "safety_ethics",
           "general": "general_knowledge", "math": "mathematics", "stem": "science", "code": "coding"}
# A source label from the coding family is refined by the prompt into the more specific engineering domains.
CODE_FAMILY = ("cybersecurity", "web_frontend", "web_backend", "web_fullstack", "software_engineering")

RULES = [  # (domain, regex) — order matters: more specific first
    ("cybersecurity", r"\b(xss|csrf|sql injection|vulnerab\w*|exploit\w*|malware|phishing|encrypt\w*|owasp|penetration test\w*|firewall|cve-\d|threat model\w*|authenticat\w* bypass|security audit)\b"),
    ("web_frontend", r"\b(html|css|react|next\.?js|vue|angular|tailwind|dom|frontend|front-end|responsive|jsx|svelte|ui component)\b"),
    ("web_backend", r"\b(rest(ful)? api|endpoint|express\.?js|django|flask|fastapi|node\.?js|graphql|middleware|backend|back-end|database schema|orm|jwt|oauth|server-side)\b"),
    ("web_fullstack", r"\b(full[- ]stack|web app(lication)?|website|deploy(ment)? (to|on) (vercel|heroku|netlify))\b"),
    ("software_engineering", r"\b(unit test\w*|debug\w*|refactor\w*|design pattern\w*|system design|microservice\w*|git\b|ci/cd|code review|big-?o|complexity of)\b"),
    ("coding", r"(```|\b(python|javascript|typescript|java\b|c\+\+|rust|golang|sql|function|algorithm|array|recursion|compile\w*|variable|class\b|def |import |return\b))"),
    ("islamic_studies", r"(قرآن|حدیث|اسلام(?! ?آباد)|نماز|زکوٰۃ|رمضان|فقہ|\b(quran|qur'an|hadith|sunnah|islam\w*|prophet muhammad|salah|zakat|ramadan|fiqh|tafsir|sahih|surah)\b)"),
    ("pakistan", r"(پاکستان|لاہور|کراچی|اسلام آباد|پنجاب|سندھ|بلوچستان|خیبر پختونخوا|قائداعظم|\b(pakistan\w*|lahore|karachi|islamabad|punjab|sindh|khyber|balochistan|jinnah|iqbal|urdu)\b)"),
    ("mathematics", r"\b(equation|integral|derivative|algebra|geometry|calculus|probability|statistic\w*|theorem|polynomial|matrix|percent\w*|fraction|solve for|how many|sum of|\d+\s*[\+\*/×÷^]\s*\d+|\d+\s+-\s+\d+\s*=)\b"),
    ("science", r"\b(physics|chemistry|biology|astronom\w*|molecule|atom\w*|cell\w*|photosynthesis|gravity|energy|force|velocity|electron|dna|evolution|planet\w*|element\w*|ecosystem|organism\w*|chemical|experiment\w*|hypothes\w*)\b"),
    ("safety_ethics", r"\b(ethic\w*|privacy|consent|harm\w*|safety|bias|misinformation|responsible ai|illegal)\b"),
    ("research", r"\b(research|source\w*|citation|evidence|study shows|according to|fact-?check\w*|peer[- ]review\w*|summari[sz]e the (article|passage|text))\b"),
    ("education", r"\b(explain|teach|lesson|student\w*|homework|exam|learn\w*|tutor\w*|curriculum|syllabus)\b"),
    ("writing", r"\b(write|essay|email|letter|poem|story|draft|rewrite|paragraph|blog|cover letter|resume|proofread|tone)\b"),
    ("reasoning", r"\b(puzzle|riddle|logic\w*|deduce|infer\w*|if .{1,40} then|which of the following|true or false|syllogism)\b"),
    ("problem_solving", r"\b(how (do|can|should) i|plan|budget|schedule|steps to|advice|recommend\w*|best way to)\b"),
]
_COMPILED = [(d, re.compile(rx, re.I)) for d, rx in RULES]


def normalise(label: str | None) -> str | None:
    if not label:
        return None
    label = ALIASES.get(label, label)
    return label if label in DOMAINS else None


def classify(user: str, answer: str, hint: str | None = None) -> str:
    h = normalise(hint)
    if h in ("coding", "software_engineering"):
        for d, rx in _COMPILED:
            if d in CODE_FAMILY and d != h and rx.search(user.split("```")[0]):
                return d
        return h
    if h:
        return h
    text = f"{user}\n{answer[:1500]}"
    for d, rx in _COMPILED:
        if rx.search(text):
            return d
    return "general_knowledge"
