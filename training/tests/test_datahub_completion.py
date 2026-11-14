"""Tests for the dataset-completion phase: human-review workflow, optional sources, selection caps, new mappers.

Run:  cd training && python -m unittest tests.test_datahub_completion -v
"""
from __future__ import annotations

import csv
import json
import sys
import unittest
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAINING))
sys.path.insert(0, str(TRAINING / "tests"))
from datahub import connectors, domains, pipeline, review  # noqa: E402
from test_datahub import Fixture, corpus, rec, src  # noqa: E402


class ReviewFixture(Fixture):
    """A built model dataset + review module pointed at temp directories."""
    def setUp(self):
        super().setUp()
        self.write("human.jsonl", corpus())
        self.registry = self.reg(src("human", "human.jsonl"))
        self.datasets = self.tmp / "datasets"
        (self.datasets / "m").mkdir(parents=True)
        (self.datasets / "m" / "profile.json").write_text(json.dumps(self.profile(min_records=30, max_records=30, min_human_reviewed=5)))
        for mod, attr, val in ((pipeline, "DATASETS", self.datasets), (review, "REVIEWS", self.tmp / "reviews"),
                               (review, "SHEETS", self.tmp / "reviews" / "sheets"), (pipeline, "REVIEWS", self.tmp / "reviews")):
            self.addCleanup(setattr, mod, attr, getattr(mod, attr))
            setattr(mod, attr, val)
        self.build()

    def build(self):
        pool = self.pool(self.registry)
        return pipeline.build_model("m", pool, self.datasets / "m" / "build", pipeline.load_profile("m"), reg=self.registry, publish=False)

    def sheet(self, n=6):
        paths = review.make_sheets("m", n=n, batch=100)
        self.assertEqual(len(paths), 1)
        with open(paths[0], newline="", encoding="utf-8") as fh:
            return paths[0], list(csv.DictReader(fh))

    def save(self, path, rows):
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=review.COLUMNS)
            w.writeheader()
            w.writerows(rows)


class TestHumanReviewWorkflow(ReviewFixture):
    def test_sheet_is_stratified_and_has_empty_decisions(self):
        path, rows = self.sheet(n=8)
        self.assertEqual(len(rows), 8)
        self.assertTrue(all(r["reviewer"] == "" and r["verdict"] == "" for r in rows))
        self.assertGreater(len({r["lang"] for r in rows}), 1, "round-robin over language×domain strata")
        self.assertTrue(path.with_name(path.stem + ".meta.json").exists())

    def test_import_counts_only_named_human_accepts(self):
        path, rows = self.sheet()
        rows[0].update(reviewer="ayesha.k", verdict="accept")
        rows[1].update(reviewer="ayesha.k", verdict="Reject", issue_tags="incorrect")
        rows[2].update(reviewer="auto", verdict="accept")                    # program, not a person → refused
        rows[3].update(reviewer="claude-bot", verdict="accept")              # refused
        rows[4].update(reviewer="ayesha.k", verdict="reject")                # reject without reason → refused
        rows[5].update(reviewer="ayesha.k", verdict="maybe")                 # invalid verdict → refused
        self.save(path, rows)
        rep = review.import_sheet(path, "m")
        self.assertEqual(rep["counts"].get("imported:accept"), 1)
        self.assertEqual(rep["counts"].get("imported:reject"), 1)
        self.assertEqual(sum(v for k, v in rep["counts"].items() if k.startswith("refused:")), 4)
        m = self.build()
        self.assertEqual(m["human_reviewed"], 1)
        ids = {json.loads(l)["id"] for f in ("train", "eval", "test") for l in (self.datasets / "m" / "build" / f"{f}.jsonl").read_text().splitlines()}
        self.assertNotIn(rows[1]["record_id"], ids, "human-rejected record removed")
        self.assertIn(rows[0]["record_id"], ids, "human-accepted record always selected")
        prog = review.progress(["m"])["m"]
        self.assertEqual((prog["accepted_in_dataset"], prog["required"], prog["remaining"]), (1, 5, 4))

    def test_edited_content_and_foreign_rows_refused(self):
        path, rows = self.sheet()
        rows[0].update(reviewer="ayesha.k", verdict="accept", content_hash="0" * 32)
        rows[1].update(reviewer="ayesha.k", verdict="accept", record_id="not-in-sheet")
        self.save(path, rows)
        rep = review.import_sheet(path, "m")
        self.assertNotIn("imported:accept", rep["counts"])
        self.assertEqual(len(rep["errors"]), 2)

    def test_unknown_sheet_and_wrong_model_refused(self):
        path, rows = self.sheet()
        for r in rows:
            r["sheet_id"] = "forged-sheet"
        self.save(path, rows)
        with self.assertRaises(ValueError):
            review.import_sheet(path, "m")

    def test_reimport_is_idempotent_and_reject_wins(self):
        path, rows = self.sheet()
        rows[0].update(reviewer="ayesha.k", verdict="accept")
        self.save(path, rows)
        review.import_sheet(path, "m")
        rep = review.import_sheet(path, "m")
        self.assertEqual(rep["counts"].get("duplicate_skipped"), 1)
        rows[0].update(reviewer="bilal.r", verdict="reject", notes="answer is wrong")
        self.save(path, rows)
        review.import_sheet(path, "m")
        self.assertEqual(review.load_ledger()[rows[0]["record_id"]]["verdict"], "reject")

    def test_stale_review_does_not_count(self):
        led = self.tmp / "reviews"
        led.mkdir(exist_ok=True)
        rid = json.loads((self.datasets / "m" / "build" / "train.jsonl").read_text().splitlines()[0])["id"]
        (led / "m.jsonl").write_text(json.dumps({"record_id": rid, "reviewer": "ayesha.k", "verdict": "accept", "content_hash": "f" * 32}) + "\n")
        pool = self.pool(self.registry)
        self.assertGreaterEqual(pool["stats"].get("review_stale_content_changed", 0), 1)
        self.assertNotEqual({r["id"]: r for r in pool["records"]}[rid]["review_state"], "human_reviewed")

    def test_automatic_states_never_count_as_human(self):
        pool = self.pool(self.registry)
        for r in pool["records"]:
            r["review_state"] = "auto_verified"
        m = pipeline.build_model("m", pool, self.tmp / "o", pipeline.load_profile("m"), reg=self.registry, publish=False)
        self.assertEqual(m["human_reviewed"], 0)
        self.assertFalse(m["gates"]["human_review"]["passed"])


class TestOptionalSourcesAndSelection(Fixture):
    def test_optional_absent_source_is_reported_not_failed_and_not_fabricated(self):
        self.write("a.jsonl", corpus())
        reg = self.reg(src("ok", "a.jsonl"), src("history", "data/consented/latest.jsonl", optional=True))
        pool = self.pool(reg)
        self.assertEqual(pool["missing"], [])
        self.assertEqual(pool["per_source"]["history"]["status"], "optional_absent")
        self.assertFalse((self.tmp / "data" / "consented" / "latest.jsonl").exists())
        m = pipeline.build_model("t", pool, self.tmp / "o", self.profile(), reg=reg, publish=False)
        self.assertTrue(m["gates"]["no_missing_sources"]["passed"])
        self.assertIn("optional absent: history", m["gates"]["no_missing_sources"]["detail"])

    def test_domain_cap_enforced_when_pool_smaller_than_target(self):
        self.write("a.jsonl", corpus())
        reg = self.reg(src("ok", "a.jsonl"))
        pool = self.pool(reg)
        m = pipeline.build_model("t", pool, self.tmp / "o", self.profile(min_records=1000, max_records=1000, domain_max_share={"mathematics": 0.1}),
                                 reg=reg, publish=False)
        self.assertTrue(m["gates"]["domain_maximums"]["passed"], m["gates"]["domain_maximums"])
        self.assertFalse(m["gates"]["quantity"]["passed"])

    def test_source_max_share(self):
        self.write("a.jsonl", corpus())
        self.write("b.jsonl", [rec(f"Explain topic number {i} about rivers and mountains in detail please.",
                                   f"Topic {i}: rivers carve valleys over time while mountains rise through tectonic uplift and erode slowly.") for i in range(30)])
        reg = self.reg(src("a", "a.jsonl"), src("b", "b.jsonl"))
        pool = self.pool(reg)
        m = pipeline.build_model("t", pool, self.tmp / "o", self.profile(min_records=30, max_records=30, source_max_share={"b": 0.2}), reg=reg, publish=False)
        self.assertLessEqual(m["by_source"].get("b", 0), 6)


class TestNewMappers(unittest.TestCase):
    def rows(self, items, split="train"):
        return [({"split": split, "file": "f"}, i, r) for i, r in enumerate(items)]

    def test_nemotron_strips_reasoning_and_withheld_prompts(self):
        rows = self.rows([
            {"uuid": "1", "generator": "DeepSeek-R1-0528", "category": "math", "messages": [{"role": "user", "content": "What is 2+2?"},
             {"role": "assistant", "content": "<think>\nadd them\n</think>\n\nThe answer is 4."}]},
            {"uuid": "2", "generator": "DeepSeek-R1-0528", "category": "math", "messages": [{"role": "user", "content": "What is 2+2?"},
             {"role": "assistant", "content": "<think>x</think> 4"}]},                                     # 2nd response to same prompt
            {"uuid": "3", "generator": "DeepSeek-R1-0528", "category": "code", "messages": [{"role": "user", "content": "-"},
             {"role": "assistant", "content": "code"}]},                                                     # withheld prompt
            {"uuid": "4", "generator": "SomeOtherModel", "category": "math", "messages": [{"role": "user", "content": "Q?"},
             {"role": "assistant", "content": "A"}]},                                                        # unapproved generator
            {"uuid": "5", "generator": "DeepSeek-R1-0528", "category": "math", "messages": [{"role": "user", "content": "Truncated?"},
             {"role": "assistant", "content": "<think>never closed"}]}])
        out = list(connectors.map_nemotron(rows))
        self.assertEqual([r["source_record_id"] for r in out], ["1"])
        self.assertEqual(out[0]["messages"][1]["content"], "The answer is 4.")

    def test_stem_answer_must_match_expected_choice(self):
        q = "Which gas do plants absorb?\nA: Oxygen\nB: Carbon dioxide\nC: Helium\nD: Neon"
        mk = lambda u, a, exp: {"uuid": u, "generator": "DeepSeek-R1-0528", "category": "stem", "metadata": json.dumps({"expected_answer": exp}),  # noqa: E731
                                "messages": [{"role": "user", "content": q + u}, {"role": "assistant", "content": a}]}
        out = list(connectors.map_nemotron(self.rows([mk("1", "Plants absorb carbon dioxide. \\boxed{B}", "\\text{B}"),
                                                      mk("2", "Plants absorb oxygen. The answer is A.", "\\text{B}")]), verify_mc=True))
        self.assertEqual([r["source_record_id"] for r in out], ["1"])

    def test_opencodeinstruct_keeps_only_fully_passing(self):
        out = list(connectors.map_opencodeinstruct(self.rows([{"id": "a", "input": "q", "output": "x", "average_test_score": "1.0"},
                                                              {"id": "b", "input": "q", "output": "x", "average_test_score": "0.9"}])))
        self.assertEqual([r["source_record_id"] for r in out], ["a"])

    def test_tydiqa_answer_is_span_plus_source_sentence(self):
        ctx = "Seoul is the capital of South Korea. It has about ten million people."
        out = list(connectors.map_tydiqa(self.rows([{"id": "korean-1", "context": ctx, "question": "What is the capital?",
                                                     "answers": {"text": ["Seoul"], "answer_start": [0]}}])))
        self.assertEqual(out[0]["lang_declared"], "ko")
        self.assertIn("Seoul is the capital of South Korea.", out[0]["messages"][1]["content"])

    def test_transliteration_language_comes_from_answer(self):
        rows = self.rows([{"Urdu text": "آپ کیسے ہیں میرے دوست آج کل", "Roman-Urdu text": f"aap kaise hain mere dost aaj kal {i}"} for i in range(20)])
        out = list(connectors.map_roman_urdu_parl(rows))
        self.assertTrue(out and all(r["lang_from"] == "answer" for r in out))
        self.assertEqual({r["lang_declared"] for r in out}, {"ur", "roman_ur"})
        for r in out:
            ans = r["messages"][1]["content"]
            self.assertEqual(r["lang_declared"] == "roman_ur", ans.startswith("aap"))

    def test_wikipedia_template_is_synthetic_class(self):
        self.assertIn("templated_human", pipeline.SYNTHETIC_ORIGINS)
        self.assertIn("transliteration_unverified", pipeline.SYNTHETIC_ORIGINS)
        out = list(connectors.map_wikipedia_intro(self.rows([{"id": "1", "title": "لاہور", "text": "لاہور پاکستان کا ایک بڑا شہر ہے۔ " * 30}]), lang="ur"))
        self.assertEqual(len(out), 1)
        self.assertIn("لاہور", out[0]["messages"][0]["content"])

    def test_code_family_domain_refinement_and_date_ranges(self):
        self.assertEqual(domains.classify("Build a Flask REST API endpoint for users", "", "coding"), "web_backend")
        self.assertEqual(domains.classify("Reverse a linked list", "", "coding"), "coding")
        self.assertEqual(domains.classify("جنگ 1947-1948 کی تاریخ", ""), "general_knowledge")
        self.assertEqual(domains.classify("اسلام آباد کی آبادی", ""), "pakistan")


class TestRegistryCompletion(unittest.TestCase):
    def test_new_sources_are_pinned_and_flagged(self):
        reg = {s["id"]: s for s in pipeline.load_registry()["sources"]}
        for sid in ("nemotron-math", "nemotron-stem", "opencodeinstruct", "wikipedia-ur"):
            self.assertEqual(len(reg[sid]["revision_full"]), 40)
        for sid in ("opencodeinstruct", "trendyol-cybersec", "roman-urdu-parl"):
            self.assertTrue(reg[sid].get("upstream_risk"), sid)
        self.assertTrue(reg["consented-history"]["optional"])
        for sid in ("nemotron-chat", "urdu-assistant", "cybernative-dpo"):
            self.assertEqual(reg[sid]["status"], "rejected")
        self.assertEqual(reg["urdu-instruct"]["status"], "review_required")

    def test_base_models_unchanged(self):
        nick = pipeline.load_profile("nick-4.8")
        self.assertEqual((nick["base_model"], nick["base_model_revision"]),
                         ("Qwen/Qwen2.5-3B-Instruct", "aa8e72537993ba99e69dfaafa59ed015b17504d1"))
        self.assertIsNone(pipeline.load_profile("fab-100x")["base_model"])


if __name__ == "__main__":
    unittest.main()


class TestGapSources(unittest.TestCase):
    def rows(self, items, split="train"):
        return [({"split": split, "file": "f"}, i, r) for i, r in enumerate(items)]

    def test_commitpack_keeps_only_permissive_licenses(self):
        base = {"old_contents": "def f():\n    return 1\n", "new_contents": "def f():\n    return 2\n", "message": "Change the return value of f",
                "lang": "Python", "new_file": "a.py", "commit": "c"}
        out = list(connectors.map_commitpack(self.rows([{**base, "license": "mit"}, {**base, "license": "agpl-3.0"}, {**base, "license": "lgpl-2.1"},
                                                        {**base, "license": "mit", "old_contents": ""}])))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["meta"]["repo_license"], "mit")
        self.assertEqual(out[0]["domain_hint"], "software_engineering")
        html = list(connectors.map_commitpack(self.rows([{**base, "license": "mit", "lang": "HTML"}])))
        self.assertEqual(html[0]["domain_hint"], "web_frontend")

    def test_mcqa_and_strategyqa_and_aqua(self):
        cs = list(connectors.map_mcqa(self.rows([{"id": "q1", "question": "Where do you keep milk?", "answerKey": "B",
                                                  "choices": {"label": ["A", "B"], "text": ["oven", "fridge"]}}]), prefix="csqa", domain="reasoning"))
        self.assertEqual(cs[0]["messages"][1]["content"], "The answer is B. fridge.")
        sq = list(connectors.map_strategyqa(self.rows([{"qid": "1", "question": "Can a penguin fly?", "answer": "False", "facts": "Penguins are flightless birds."}])))
        self.assertTrue(sq[0]["messages"][1]["content"].endswith("So the answer is: No."))
        aq = list(connectors.map_aqua(self.rows([{"question": "2 apples + 3 apples?", "options": "['A)4', 'B)5']",
                                                  "rationale": "Adding two apples and three apples gives five apples in total.", "correct": "B"}])))
        self.assertTrue(aq[0]["messages"][1]["content"].endswith("Answer: B"))

    def test_ethics_is_templated_class(self):
        reg = {s["id"]: s for s in pipeline.load_registry()["sources"]}
        self.assertIn(reg["ethics-commonsense"]["origin"], pipeline.SYNTHETIC_ORIGINS)
        for s in reg.values():
            if s["status"] == "approved" and s["use"] == "train":
                self.assertTrue(s.get("transformations"), s["id"])



class TestValidator(ReviewFixture):
    def test_validator_rederives_and_flags_unbacked_reviews(self):
        from datahub import validate
        c = {x["check"]: x for x in validate.validate(["m"], self.registry)["models"]["m"]}
        for k in ("artifact_sha256_and_counts", "licenses_and_eval_separation", "no_duplicate_prompts", "no_split_leakage", "human_review_backed_by_ledger",
                  "production_ready_derived"):
            self.assertEqual(c[k]["status"], "PASS", (k, c[k]))
        self.assertEqual(c["human_review_minimum"]["status"], "BLOCKED")
        # tamper: mark a row human_reviewed without a ledger decision → FAIL, and file hash no longer matches → FAIL
        p = self.datasets / "m" / "build" / "train.jsonl"
        lines = p.read_text().splitlines()
        r = json.loads(lines[0]); r["review_state"] = "human_reviewed"; lines[0] = json.dumps(r, ensure_ascii=False)
        p.write_text("\n".join(lines) + "\n")
        c = {x["check"]: x for x in validate.validate(["m"], self.registry)["models"]["m"]}
        self.assertEqual(c["human_review_backed_by_ledger"]["status"], "FAIL")
        self.assertEqual(c["artifact_sha256_and_counts"]["status"], "FAIL")


class TestUnicodeLineSeparators(ReviewFixture):
    def test_rows_with_u2028_are_read_as_one_record(self):
        """JSONL is written with ensure_ascii=False, so U+2028/U+0085 appear raw inside strings: readers must split on \\n only."""
        self.write("sep.jsonl", [rec(f"Explain the separator case number {i} in a little detail please.",
                                     f"Line one line two\u0085line three — record {i} explains how separators behave.") for i in range(5)])
        self.registry = self.reg(src("human", "human.jsonl"), src("sep", "sep.jsonl"))
        self.build()
        n = sum(1 for f in ("train", "eval", "test") for l in (self.datasets / "m" / "build" / f"{f}.jsonl").open(encoding="utf-8"))
        self.assertEqual(len(review._build_rows("m")), n)
        from datahub import validate
        c = {x["check"]: x for x in validate.validate(["m"], self.registry)["models"]["m"]}
        self.assertEqual(c["artifact_sha256_and_counts"]["status"], "PASS")


class TestPromptDedup(Fixture):
    def test_same_prompt_with_different_number_formatting_kept_once(self):
        self.write("a.jsonl", [rec("¿Cuántos minutos son 1 000 segundos?", "Se divide entre sesenta y el resultado es de unos 16.7 minutos.", lang="es"),
                               rec("¿Cuántos minutos son 1.000 segundos?", "Para pasar de segundos a minutos se divide entre sesenta: unos 16.7 minutos.", lang="es")])
        pool = self.pool(self.reg(src("a", "a.jsonl")))
        self.assertEqual(len(pool["records"]), 1)
        self.assertEqual(pool["stats"].get("rejected:duplicate_prompt", 0), 1)
