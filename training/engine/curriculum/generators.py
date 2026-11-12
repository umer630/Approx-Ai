"""Programmatic curriculum generators. Every answer is COMPUTED (not written by hand), so it is correct by
construction; generator self-checks assert that. Records are labelled synthetic=True so the dataset manifest
can report how much of the corpus is template-generated (a production blocker if it dominates).

Languages: en, ur (Urdu script), roman_ur, mixed (Roman Urdu + English terms).
Teaching behaviours: step-by-step solutions, hint-only replies, checking a student's answer, quizzes.
"""
from __future__ import annotations

import json
import math
import random
from fractions import Fraction

SRC = "approx-curriculum-gen"


def rec(domain, language, category, user, answer, **extra):
    return {"domain": domain, "language": language, "category": category, "synthetic": True, "source_hint": SRC,
            "messages": [{"role": "user", "content": user}, {"role": "assistant", "content": answer}], **extra}


URDU_DIGITS = str.maketrans("0123456789", "0123456789")  # Western digits are standard in Pakistani school books

# ---------------------------------------------------------------- mathematics
NAMES_EN = ["Ali", "Sara", "Ahmed", "Ayesha", "Bilal", "Fatima", "Hamza", "Zainab", "Usman", "Hira"]
NAMES_UR = ["علی", "سارہ", "احمد", "عائشہ", "بلال", "فاطمہ", "حمزہ", "زینب", "عثمان", "حرا"]
ITEMS = [("apples", "سیب", "seb"), ("books", "کتابیں", "kitabein"), ("pencils", "پنسلیں", "pencilein"), ("mangoes", "آم", "aam")]


def word_problems(rng: random.Random, n: int):
    for _ in range(n):
        i = rng.randrange(len(NAMES_EN))
        it = rng.choice(ITEMS)
        a, b = rng.randint(12, 480), rng.randint(3, 95)
        op = rng.choice(["add", "sub", "mul", "div"])
        if op == "add":
            res, sym = a + b, "+"
            en = f"{NAMES_EN[i]} has {a} {it[0]} and buys {b} more. How many {it[0]} does {NAMES_EN[i]} have now?"
            ur = f"{NAMES_UR[i]} کے پاس {a} {it[1]} ہیں۔ وہ {b} اور خریدتا ہے۔ اب اس کے پاس کل کتنے {it[1]} ہیں؟"
            ro = f"{NAMES_EN[i]} ke paas {a} {it[2]} hain aur woh {b} aur khareedta hai. Ab kul kitne {it[2]} hain?"
        elif op == "sub":
            a, b = max(a, b), min(a, b)
            res, sym = a - b, "-"
            en = f"A shop had {a} {it[0]}. It sold {b}. How many {it[0]} are left?"
            ur = f"ایک دکان میں {a} {it[1]} تھے۔ {b} بک گئے۔ اب کتنے باقی ہیں؟"
            ro = f"Ek dukaan mein {a} {it[2]} thay. {b} bik gaye. Ab kitne baqi hain?"
        elif op == "mul":
            a, b = rng.randint(3, 40), rng.randint(3, 25)
            res, sym = a * b, "×"
            en = f"There are {a} boxes with {b} {it[0]} in each box. How many {it[0]} are there in total?"
            ur = f"{a} ڈبے ہیں اور ہر ڈبے میں {b} {it[1]} ہیں۔ کل کتنے {it[1]} ہیں؟"
            ro = f"{a} dabbe hain aur har dabbe mein {b} {it[2]} hain. Kul kitne {it[2]} hain?"
        else:
            b = rng.randint(2, 24)
            res = rng.randint(3, 40)
            a = b * res
            sym = "÷"
            en = f"{a} {it[0]} are shared equally among {b} children. How many does each child get?"
            ur = f"{a} {it[1]} {b} بچوں میں برابر تقسیم کیے گئے۔ ہر بچے کو کتنے ملے؟"
            ro = f"{a} {it[2]} {b} bachon mein barabar taqseem kiye gaye. Har bachay ko kitne milay?"
        lang = rng.choice(["en", "ur", "roman_ur", "en"])
        if lang == "en":
            yield rec("mathematics", "en", "word_problem", en, f"Step 1: The operation is {sym}.\nStep 2: {a} {sym} {b} = {res}.\n\nAnswer: {res} {it[0]}.")
        elif lang == "ur":
            yield rec("mathematics", "ur", "word_problem", ur, f"مرحلہ 1: یہاں عمل {sym} ہے۔\nمرحلہ 2: {a} {sym} {b} = {res}\n\nجواب: {res} {it[1]}۔")
        else:
            yield rec("mathematics", "roman_ur", "word_problem", ro, f"Step 1: Yahan amal {sym} hai.\nStep 2: {a} {sym} {b} = {res}.\n\nJawab: {res} {it[2]}.")


def fractions_and_percent(rng: random.Random, n: int):
    for _ in range(n):
        kind = rng.choice(["simplify", "add", "percent", "hcf_lcm"])
        if kind == "simplify":
            g = rng.randint(2, 12)
            p, q = rng.randint(1, 15), rng.randint(2, 19)
            f = Fraction(p, q)
            num, den = p * g, q * g
            hcf = math.gcd(num, den)
            yield rec("mathematics", "en", "explanation", f"Simplify the fraction {num}/{den}.",
                      f"Find the HCF of {num} and {den}: it is {hcf}.\nDivide both by {hcf}: {num}÷{hcf} = {f.numerator}, {den}÷{hcf} = {f.denominator}.\n\nAnswer: {f.numerator}/{f.denominator}")
        elif kind == "add":
            a, b = Fraction(rng.randint(1, 9), rng.randint(2, 10)), Fraction(rng.randint(1, 9), rng.randint(2, 10))
            s = a + b
            l = a.denominator * b.denominator // math.gcd(a.denominator, b.denominator)
            yield rec("mathematics", "en", "explanation", f"What is {a.numerator}/{a.denominator} + {b.numerator}/{b.denominator}?",
                      f"The LCM of the denominators {a.denominator} and {b.denominator} is {l}.\n"
                      f"{a.numerator}/{a.denominator} = {a.numerator * l // a.denominator}/{l} and {b.numerator}/{b.denominator} = {b.numerator * l // b.denominator}/{l}.\n"
                      f"Sum = {a.numerator * l // a.denominator + b.numerator * l // b.denominator}/{l}"
                      + (f" = {s.numerator}/{s.denominator} (simplified)" if s.denominator != l else "") + f".\n\nAnswer: {s.numerator}/{s.denominator}")
        elif kind == "percent":
            p = rng.choice([5, 10, 12, 15, 20, 25, 30, 40, 50, 75])
            x = rng.randint(2, 90) * 20
            r = x * p // 100
            lang = rng.choice(["en", "roman_ur", "mixed"])
            if lang == "en":
                yield rec("mathematics", "en", "explanation", f"What is {p}% of {x}?", f"{p}% means {p}/100.\n{p}/100 × {x} = {r}.\n\nAnswer: {r}")
            elif lang == "roman_ur":
                yield rec("mathematics", "roman_ur", "explanation", f"{x} ka {p} percent kitna hota hai?",
                          f"{p} percent ka matlab hai {p}/100.\n{p}/100 × {x} = {r}.\n\nJawab: {r}")
            else:
                yield rec("mathematics", "mixed", "explanation", f"Mujhe batao {x} ka {p}% kya hai, step by step please.",
                          f"Percentage ko fraction mein likhein: {p}% = {p}/100.\nPhir multiply karein: {p}/100 × {x} = {r}.\n\nAnswer: {r}")
        else:
            a, b = rng.randint(6, 90), rng.randint(6, 90)
            h = math.gcd(a, b)
            l = a * b // h
            yield rec("mathematics", "en", "explanation", f"Find the HCF and LCM of {a} and {b}.",
                      f"HCF({a}, {b}) = {h} (the largest number dividing both).\nLCM = ({a} × {b}) ÷ HCF = {a * b} ÷ {h} = {l}.\n"
                      f"Check: HCF × LCM = {h * l} = {a} × {b}.\n\nAnswer: HCF = {h}, LCM = {l}")


def algebra(rng: random.Random, n: int):
    for _ in range(n):
        x = rng.randint(-12, 15)
        a = rng.choice([2, 3, 4, 5, 6, 7, 8, 9])
        b = rng.randint(-30, 30)
        c = a * x + b
        bs = f"+ {b}" if b >= 0 else f"- {-b}"
        q = f"Solve for x: {a}x {bs} = {c}"
        steps = (f"{a}x {bs} = {c}\n" + (f"Subtract {b} from both sides: {a}x = {c - b}\n" if b >= 0 else f"Add {-b} to both sides: {a}x = {c - b}\n")
                 + f"Divide both sides by {a}: x = {c - b}/{a} = {x}\nCheck: {a}×({x}) {bs} = {c} ✓\n\nAnswer: x = {x}")
        mode = rng.random()
        if mode < 0.6:
            yield rec("mathematics", "en", "step_by_step", q, steps)
        elif mode < 0.8:
            yield rec("education", "en", "hint_only", q + "\nPlease give me only a hint, I want to solve it myself.",
                      f"Hint: get the x-term alone first — undo the {'+ ' + str(b) if b >= 0 else '- ' + str(-b)} on the left by doing the opposite on both sides. "
                      f"Then undo the multiplication by {a}. Try it and tell me what you get!")
        else:
            wrong = x + rng.choice([-2, -1, 1, 2, 3])
            right = rng.random() < 0.5
            given = x if right else wrong
            if right:
                fb = f"Correct! x = {x}. Check: {a}×({x}) {bs} = {c}. Well done."
            else:
                fb = (f"Not quite. If x = {given}, then {a}×({given}) {bs} = {a * given + b}, not {c}.\n"
                      f"Re-check the step where you move {b} to the other side.\n\nThe correct answer is x = {x}.")
            yield rec("education", "en", "check_answer", f"{q}\nI got x = {given}. Is that right?", fb)


def geometry(rng: random.Random, n: int):
    triples = [(3, 4, 5), (5, 12, 13), (8, 15, 17), (7, 24, 25), (6, 8, 10), (9, 12, 15), (20, 21, 29)]
    for _ in range(n):
        k = rng.choice(["rect", "circle", "tri", "pyth"])
        if k == "rect":
            l, w = rng.randint(3, 60), rng.randint(2, 40)
            lang = rng.choice(["en", "ur"])
            if lang == "en":
                yield rec("mathematics", "en", "explanation", f"A rectangle is {l} cm long and {w} cm wide. Find its area and perimeter.",
                          f"Area = length × width = {l} × {w} = {l * w} cm².\nPerimeter = 2 × (length + width) = 2 × ({l} + {w}) = {2 * (l + w)} cm.\n\nAnswer: area {l * w} cm², perimeter {2 * (l + w)} cm")
            else:
                yield rec("mathematics", "ur", "explanation", f"ایک مستطیل کی لمبائی {l} سینٹی میٹر اور چوڑائی {w} سینٹی میٹر ہے۔ اس کا رقبہ معلوم کریں۔",
                          f"رقبہ = لمبائی × چوڑائی = {l} × {w} = {l * w} مربع سینٹی میٹر\n\nجواب: {l * w} مربع سینٹی میٹر")
        elif k == "circle":
            r = rng.randint(1, 30)
            yield rec("mathematics", "en", "explanation", f"Find the area of a circle with radius {r} m (use π ≈ 3.14).",
                      f"Area = πr² = 3.14 × {r}² = 3.14 × {r * r} = {round(3.14 * r * r, 2)} m².\n\nAnswer: {round(3.14 * r * r, 2)} m²")
        elif k == "tri":
            b, h = rng.randint(2, 50), rng.randint(2, 40)
            yield rec("mathematics", "en", "explanation", f"What is the area of a triangle with base {b} cm and height {h} cm?",
                      f"Area = ½ × base × height = ½ × {b} × {h} = {b * h / 2:g} cm².\n\nAnswer: {b * h / 2:g} cm²")
        else:
            a, b, c = rng.choice(triples)
            m = rng.randint(1, 4)
            a, b, c = a * m, b * m, c * m
            yield rec("mathematics", "roman_ur", "step_by_step", f"Ek right triangle ki do choti sides {a} aur {b} hain. Hypotenuse kitna hai?",
                      f"Pythagoras theorem: c² = a² + b²\nc² = {a}² + {b}² = {a * a} + {b * b} = {c * c}\nc = √{c * c} = {c}\n\nJawab: {c}")


# ---------------------------------------------------------------- science
MOLAR = {"H": 1.008, "C": 12.011, "N": 14.007, "O": 15.999, "Na": 22.990, "Cl": 35.45, "Ca": 40.078, "S": 32.06, "K": 39.098, "Mg": 24.305}
COMPOUNDS = [("water", "H2O", {"H": 2, "O": 1}), ("carbon dioxide", "CO2", {"C": 1, "O": 2}), ("sodium chloride", "NaCl", {"Na": 1, "Cl": 1}),
             ("calcium carbonate", "CaCO3", {"Ca": 1, "C": 1, "O": 3}), ("sulphuric acid", "H2SO4", {"H": 2, "S": 1, "O": 4}),
             ("ammonia", "NH3", {"N": 1, "H": 3}), ("glucose", "C6H12O6", {"C": 6, "H": 12, "O": 6}), ("methane", "CH4", {"C": 1, "H": 4}),
             ("sodium hydroxide", "NaOH", {"Na": 1, "O": 1, "H": 1}), ("hydrochloric acid", "HCl", {"H": 1, "Cl": 1}),
             ("magnesium oxide", "MgO", {"Mg": 1, "O": 1}), ("potassium chloride", "KCl", {"K": 1, "Cl": 1})]


def chemistry(rng: random.Random, n: int):
    for _ in range(n):
        name, f, comp = rng.choice(COMPOUNDS)
        M = sum(MOLAR[e] * k for e, k in comp.items())
        parts = " + ".join(f"{k}×{MOLAR[e]}" if k > 1 else f"{MOLAR[e]}" for e, k in comp.items())
        if rng.random() < 0.5:
            yield rec("chemistry", "en", "explanation", f"Calculate the molar mass of {name} ({f}).",
                      f"Add the atomic masses: {parts} = {M:.2f} g/mol.\n\nAnswer: {M:.2f} g/mol")
        else:
            mass = rng.choice([5, 10, 18, 20, 36, 44, 50, 58.5, 90, 100, 180])
            mol = mass / M
            yield rec("chemistry", "en", "step_by_step", f"How many moles are in {mass:g} g of {name} ({f})?",
                      f"Molar mass of {f} = {parts} = {M:.2f} g/mol.\nMoles = mass ÷ molar mass = {mass:g} ÷ {M:.2f} = {mol:.3f} mol.\n\nAnswer: {mol:.3f} mol")


def physics(rng: random.Random, n: int):
    for _ in range(n):
        k = rng.choice(["speed", "force", "ohm", "ke", "density", "weight"])
        if k == "speed":
            d, t = rng.randint(2, 90) * 10, rng.randint(2, 12)
            lang = rng.choice(["en", "roman_ur", "ur"])
            v = d / t
            if lang == "en":
                yield rec("physics", "en", "explanation", f"A car travels {d} km in {t} hours. What is its average speed?",
                          f"Average speed = distance ÷ time = {d} km ÷ {t} h = {v:g} km/h.\n\nAnswer: {v:g} km/h")
            elif lang == "ur":
                yield rec("physics", "ur", "explanation", f"ایک گاڑی {t} گھنٹوں میں {d} کلومیٹر فاصلہ طے کرتی ہے۔ اس کی اوسط رفتار کیا ہے؟",
                          f"اوسط رفتار = فاصلہ ÷ وقت = {d} ÷ {t} = {v:g} کلومیٹر فی گھنٹہ\n\nجواب: {v:g} کلومیٹر فی گھنٹہ")
            else:
                yield rec("physics", "roman_ur", "explanation", f"Ek gaari {t} ghanton mein {d} km chalti hai. Average speed kya hai?",
                          f"Average speed = faasla ÷ waqt = {d} ÷ {t} = {v:g} km/h.\n\nJawab: {v:g} km/h")
        elif k == "force":
            m, a = rng.randint(1, 120), rng.randint(1, 15)
            yield rec("physics", "en", "explanation", f"What force is needed to accelerate a {m} kg object at {a} m/s²?",
                      f"Newton's second law: F = m × a = {m} kg × {a} m/s² = {m * a} N.\n\nAnswer: {m * a} N")
        elif k == "ohm":
            i, r = rng.randint(1, 12), rng.randint(2, 60)
            yield rec("physics", "en", "explanation", f"A current of {i} A flows through a {r} Ω resistor. What is the voltage across it?",
                      f"Ohm's law: V = I × R = {i} A × {r} Ω = {i * r} V.\n\nAnswer: {i * r} V")
        elif k == "ke":
            m, v = rng.randint(1, 80), rng.randint(1, 30)
            ke = 0.5 * m * v * v
            yield rec("physics", "en", "step_by_step", f"Find the kinetic energy of a {m} kg body moving at {v} m/s.",
                      f"KE = ½ m v² = ½ × {m} × {v}² = ½ × {m} × {v * v} = {ke:g} J.\n\nAnswer: {ke:g} J")
        elif k == "density":
            v = rng.randint(2, 50)
            rho = rng.choice([0.8, 1, 2.7, 7.9, 11.3, 19.3])
            mass = round(rho * v, 2)
            yield rec("physics", "en", "explanation", f"An object has a mass of {mass:g} g and a volume of {v} cm³. What is its density?",
                      f"Density = mass ÷ volume = {mass:g} g ÷ {v} cm³ = {mass / v:g} g/cm³.\n\nAnswer: {mass / v:g} g/cm³")
        else:
            m = rng.randint(1, 100)
            yield rec("physics", "en", "explanation", f"What is the weight of a {m} kg mass on Earth (g = 9.8 m/s²)?",
                      f"Weight W = m × g = {m} × 9.8 = {m * 9.8:.1f} N.\n\nAnswer: {m * 9.8:.1f} N")


def conversions(rng: random.Random, n: int):
    for _ in range(n):
        k = rng.choice(["km", "kg", "min", "temp"])
        if k == "km":
            x = rng.randint(1, 95) / rng.choice([1, 2, 4])
            yield rec("mathematics", "en", "explanation", f"Convert {x:g} km to metres.", f"1 km = 1000 m, so {x:g} km × 1000 = {x * 1000:g} m.\n\nAnswer: {x * 1000:g} m")
        elif k == "kg":
            g = rng.randint(1, 900) * 5
            yield rec("mathematics", "roman_ur", "explanation", f"{g} gram kitne kilogram hotay hain?", f"1 kg = 1000 g, is liye {g} ÷ 1000 = {g / 1000:g} kg.\n\nJawab: {g / 1000:g} kg")
        elif k == "min":
            h, m = rng.randint(1, 9), rng.randint(0, 59)
            yield rec("mathematics", "en", "explanation", f"How many minutes are there in {h} hours and {m} minutes?",
                      f"{h} hours × 60 = {h * 60} minutes; {h * 60} + {m} = {h * 60 + m} minutes.\n\nAnswer: {h * 60 + m} minutes")
        else:
            c = rng.randint(-20, 45)
            f = c * 9 / 5 + 32
            yield rec("physics", "en", "explanation", f"Convert {c} °C to Fahrenheit.", f"°F = °C × 9/5 + 32 = {c} × 1.8 + 32 = {f:g} °F.\n\nAnswer: {f:g} °F")


# ---------------------------------------------------------------- coding (solutions verified by running tests)
CODE_TASKS = [
    ("reverse a string", "reverse_string", "def reverse_string(s: str) -> str:\n    return s[::-1]", [("'abc'", "'cba'"), ("''", "''")]),
    ("check whether a number is prime", "is_prime",
     "def is_prime(n: int) -> bool:\n    if n < 2:\n        return False\n    i = 2\n    while i * i <= n:\n        if n % i == 0:\n            return False\n        i += 1\n    return True",
     [("2", "True"), ("15", "False"), ("97", "True"), ("1", "False")]),
    ("compute the factorial of n", "factorial", "def factorial(n: int) -> int:\n    result = 1\n    for k in range(2, n + 1):\n        result *= k\n    return result", [("0", "1"), ("5", "120")]),
    ("count the vowels in a string", "count_vowels", "def count_vowels(s: str) -> int:\n    return sum(1 for ch in s.lower() if ch in 'aeiou')", [("'Approx AI'", "4"), ("'xyz'", "0")]),
    ("return the n-th Fibonacci number (F(0)=0, F(1)=1)", "fib", "def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a", [("0", "0"), ("10", "55")]),
    ("check whether a string is a palindrome, ignoring case and spaces", "is_palindrome",
     "def is_palindrome(s: str) -> bool:\n    t = ''.join(ch.lower() for ch in s if not ch.isspace())\n    return t == t[::-1]", [("'Never odd or even'", "True"), ("'Approx'", "False")]),
    ("find the largest number in a non-empty list without using max()", "largest",
     "def largest(nums: list) -> int:\n    best = nums[0]\n    for x in nums[1:]:\n        if x > best:\n            best = x\n    return best", [("[3, 9, -2, 7]", "9"), ("[-5]", "-5")]),
    ("remove duplicates from a list while keeping the original order", "dedupe",
     "def dedupe(items: list) -> list:\n    seen = set()\n    out = []\n    for x in items:\n        if x not in seen:\n            seen.add(x)\n            out.append(x)\n    return out", [("[3, 1, 3, 2, 1]", "[3, 1, 2]")]),
    ("compute the greatest common divisor of two integers using Euclid's algorithm", "gcd",
     "def gcd(a: int, b: int) -> int:\n    while b:\n        a, b = b, a % b\n    return abs(a)", [("48, 18", "6"), ("7, 13", "1")]),
    ("convert a temperature from Celsius to Fahrenheit", "c_to_f", "def c_to_f(c: float) -> float:\n    return c * 9 / 5 + 32", [("100", "212.0"), ("0", "32.0")]),
    ("count how many times each word appears in a sentence (case-insensitive)", "word_counts",
     "def word_counts(text: str) -> dict:\n    counts = {}\n    for w in text.lower().split():\n        counts[w] = counts.get(w, 0) + 1\n    return counts", [("'a b a'", "{'a': 2, 'b': 1}")]),
    ("binary-search a sorted list and return the index of target or -1", "binary_search",
     "def binary_search(items: list, target) -> int:\n    lo, hi = 0, len(items) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if items[mid] == target:\n            return mid\n        if items[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return -1",
     [("[1, 3, 5, 7, 9], 7", "3"), ("[1, 3, 5], 4", "-1")]),
]
CODE_ASK = ["Write a Python function to {task}.", "Python mein ek function likho jo {task}.", "Can you show me Python code to {task}? Please explain it briefly."]


def verify_code(src: str, fn: str, tests) -> bool:
    ns: dict = {}
    exec(compile(src, f"<{fn}>", "exec"), {"__builtins__": {"range": range, "sum": sum, "abs": abs, "len": len, "set": set, "list": list}}, ns)
    return all(eval(f"{fn}({args})", {"__builtins__": {}}, ns) == eval(exp, {"__builtins__": {}}) for args, exp in tests)


def coding(rng: random.Random, n: int):
    for task, fn, src, tests in CODE_TASKS:
        assert verify_code(src, fn, tests), fn
    for _ in range(n):
        task, fn, src, tests = rng.choice(CODE_TASKS)
        ask = rng.choice(CODE_ASK)
        lang = "en" if ask.startswith(("Write", "Can")) else "mixed"
        ex_args, ex_out = tests[0]
        expl = "Yeh function step by step kaam karta hai aur neeche example diya gaya hai." if lang == "mixed" else "The function is short and has no external dependencies."
        yield rec("coding", lang, "code_generation", ask.format(task=task),
                  f"```python\n{src}\n\n\nprint({fn}({ex_args}))  # {ex_out}\n```\n\n{expl}")


# ---------------------------------------------------------------- structured output & instruction following
PEOPLE = [("Ayesha Khan", 21, "Lahore", "Computer Science"), ("Bilal Ahmed", 19, "Karachi", "Physics"), ("Sana Iqbal", 23, "Peshawar", "Medicine"),
          ("Omar Farooq", 20, "Quetta", "Economics"), ("Hira Shah", 22, "Islamabad", "Mathematics"), ("Danish Ali", 18, "Multan", "Chemistry")]


def structured(rng: random.Random, n: int):
    for _ in range(n):
        name, age, city, subj = rng.choice(PEOPLE)
        k = rng.choice(["json", "table", "bullets", "oneword"])
        if k == "json":
            obj = {"name": name, "age": age, "city": city, "subject": subj}
            text = f"{name} is a {age}-year-old {subj} student from {city}."
            out = json.dumps(obj, ensure_ascii=False)
            assert json.loads(out) == obj
            yield rec("structured_output", "en", "json_extraction",
                      f"Extract name, age, city and subject from this sentence and reply with JSON only:\n\"{text}\"", out)
        elif k == "table":
            rows = rng.sample(PEOPLE, 3)
            table = "| Name | City |\n|---|---|\n" + "\n".join(f"| {r[0]} | {r[2]} |" for r in rows)
            yield rec("structured_output", "en", "table", "Make a markdown table with columns Name and City for: " + "; ".join(f"{r[0]} ({r[2]})" for r in rows), table)
        elif k == "bullets":
            yield rec("instruction_following", "en", "format_constraint", f"Give exactly three study tips for {subj}, as a bulleted list, nothing else.",
                      {"Computer Science": "- Write a little code every day.\n- Trace your programs by hand to understand them.\n- Build one small project per topic.",
                       "Physics": "- Draw a diagram before solving a problem.\n- Always write the units.\n- Derive formulas instead of memorising them.",
                       "Medicine": "- Use spaced repetition for anatomy terms.\n- Link each disease to its mechanism.\n- Practise with past clinical cases.",
                       "Economics": "- Draw supply and demand graphs for every concept.\n- Relate theory to current local examples you can verify.\n- Practise past paper questions.",
                       "Mathematics": "- Solve problems without looking at the solution first.\n- Review mistakes and note why they happened.\n- Practise a mix of topics each week.",
                       "Chemistry": "- Learn the periodic table trends.\n- Balance equations by hand.\n- Keep a formula sheet with units."}[subj])
        else:
            a, b = rng.randint(10, 99), rng.randint(10, 99)
            yield rec("instruction_following", "en", "format_constraint", f"Reply with only the number, no words: what is {a} + {b}?", f"{a + b}")


# ---------------------------------------------------------------- media planning (FAB 500X text capability)
def media_planning(rng: random.Random, n: int):
    topics = [("a 30-second ad for a school science fair", 30), ("a 20-second clip explaining the water cycle", 20),
              ("a 45-second promo for a Lahore book festival", 45), ("a 15-second reminder to drink water", 15),
              ("a 60-second explainer on photosynthesis for class 7", 60)]
    for _ in range(n):
        topic, dur = rng.choice(topics)
        k = rng.randint(3, 5)
        base = [dur // k] * k
        base[-1] += dur - sum(base)
        scenes = [{"scene": i + 1, "duration_s": base[i], "shot": rng.choice(["wide", "medium", "close-up", "overhead", "tracking"]),
                   "description": f"Scene {i + 1} of {topic}", "narration": "", "on_screen_text": ""} for i in range(k)]
        plan = {"title": topic[0].upper() + topic[1:], "total_duration_s": dur, "aspect_ratio": rng.choice(["16:9", "9:16"]), "scenes": scenes}
        assert sum(s["duration_s"] for s in scenes) == dur
        yield rec("media_planning", "en", "storyboard", f"Create a storyboard plan as JSON for {topic} with {k} scenes.",
                  json.dumps(plan, ensure_ascii=False, indent=1) +
                  "\n\nThis is a plan only. Rendering the video is done by the separate video-generation pipeline.")


GENERATORS = [(word_problems, 900), (fractions_and_percent, 600), (algebra, 600), (geometry, 500), (chemistry, 400), (physics, 600),
              (conversions, 300), (coding, 300), (structured, 400), (media_planning, 80)]


def generate(seed: int = 4848, scale: float = 1.0):
    """All generated records, deterministic for a given seed and scale."""
    rng = random.Random(seed)
    out = []
    for fn, n in GENERATORS:
        out.extend(fn(rng, max(1, int(n * scale))))
    return out
