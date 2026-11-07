"""CPU tests for the data pipeline (no GPU / model download needed). Run: python -m unittest discover -s tests"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from approx_data.build import build, detect_language, quality_ok, validate_record  # noqa: E402
from approx_data.pii import scrub  # noqa: E402


def rec(domain, q, a):
    return {"domain": domain, "messages": [{"role": "user", "content": q}, {"role": "assistant", "content": a}]}


class Pipeline(unittest.TestCase):
    def test_pii(self):
        t, n = scrub("email ali@x.pk, CNIC 35202-1234567-1, phone 0300-1234567, password: abc123, key sk-ABCDEFGHIJKLMNOP12")
        for leak in ("ali@x.pk", "35202-1234567-1", "abc123", "sk-ABCDEFGHIJKLMNOP12"):
            self.assertNotIn(leak, t)
        self.assertGreaterEqual(n, 4)

    def test_language(self):
        self.assertEqual(detect_language("پاکستان کا دارالحکومت"), "ur")
        self.assertEqual(detect_language("Mujhe batao kya hai"), "roman-ur")
        self.assertEqual(detect_language("What is the capital?"), "en")

    def test_validation_and_quality(self):
        self.assertIsNone(validate_record(rec("coding", "q?", "answer text")))
        self.assertIsNotNone(validate_record(rec("unknown", "q", "a")))
        self.assertIsNotNone(validate_record({"domain": "coding", "messages": [{"role": "user", "content": "x"}]}))
        self.assertEqual(quality_ok(rec("coding", "hello there", "As an AI language model I cannot")), "foreign identity / boilerplate")
        self.assertEqual(quality_ok(rec("coding", "write code", "Here is a ransomware sample")), "harmful content in target")

    def test_build_dedupes_and_respects_approval(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            data = d / "src.jsonl"
            rows = [rec("coding", "How do I reverse a list in Python?", "Use nums[::-1] or nums.reverse()."),
                    rec("coding", "How do I reverse a list in Python?", "duplicate answer text here"),
                    rec("coding", "how do i reverse a list in python??", "near duplicate answer text"),
                    rec("science", "My email is z@z.com, what is gravity?", "Gravity is the attraction between masses.")]
            data.write_text("".join(json.dumps(r) + "\n" for r in rows))
            unapproved = d / "bad.jsonl"
            unapproved.write_text(json.dumps(rec("science", "unapproved question", "unapproved answer")) + "\n")
            cfg = d / "sources.json"
            cfg.write_text(json.dumps({"sources": [
                {"id": "t", "path": str(data), "license": "test", "approved": True},
                {"id": "u", "path": str(unapproved), "license": "unknown", "approved": False}]}))
            m = build(d / "out", "t-0.0.1", cfg, 0.1, 1, 100)
            self.assertEqual(m["rejected"].get("duplicate: exact", 0) + m["rejected"].get("duplicate: near", 0), 2)
            out = (d / "out" / "train.jsonl").read_text()
            self.assertNotIn("z@z.com", out)
            self.assertNotIn("unapproved", out)
            self.assertFalse(m["fab_data_included"])
            self.assertEqual(m["provenance"][1]["ingested"], 0)

    def test_dry_run_validates_real_dataset(self):
        subprocess.run([sys.executable, str(ROOT / "data/seed/make_seed.py")], check=True, capture_output=True)
        subprocess.run([sys.executable, "-m", "approx_data.build"], cwd=ROOT, check=True, capture_output=True)
        r = subprocess.run([sys.executable, "train_qlora.py", "--dry-run"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dataset OK", r.stdout)



class BuilderHardening(unittest.TestCase):
    def _cfg(self, d, lines, approved=True, license="test"):
        src = d / "s.jsonl"
        src.write_text("\n".join(lines) + "\n")
        cfg = d / "sources.json"
        cfg.write_text(json.dumps({"sources": [{"id": "s", "path": str(src), "license": license, "approved": approved}]}))
        return cfg

    def test_malformed_lines_rejected_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            good = json.dumps(rec("science", "What is gravity exactly?", "Gravity is the attraction between masses."))
            cfg = self._cfg(d, [good, "{not json", json.dumps({"domain": "science"}), json.dumps(["list"])])
            m = build(d / "out", "t", cfg, 0.1, 1, 100)
            self.assertEqual(m["files"]["train.jsonl"]["records"] + m["files"]["eval.jsonl"]["records"], 1)
            self.assertEqual(sum(v for k, v in m["rejected"].items() if k.startswith("malformed")), 3)

    def test_unknown_license_not_ingested(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            cfg = self._cfg(d, [json.dumps(rec("science", "What is gravity exactly?", "Gravity is the attraction between masses."))], license="UNKNOWN")
            m = build(d / "out", "t", cfg, 0.1, 1, 100)
            self.assertEqual(m["provenance"][0]["ingested"], 0)

    def test_time_sensitive_filtered(self):
        self.assertIn("time-sensitive", quality_ok(rec("pakistan", "Who is the current prime minister?", "As of 2024 the prime minister is X.")))

    def test_reproducible_and_not_production_ready(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            subprocess.run([sys.executable, str(ROOT / "data/seed/make_seed.py")], check=True, capture_output=True)
            src = ROOT / "configs/dataset_sources.json"
            m1 = build(d / "a", "v", src, 0.1, 4848, 20000)
            m2 = build(d / "b", "v", src, 0.1, 4848, 20000)
            self.assertEqual(m1["files"], m2["files"])
            self.assertEqual(m1["content_fingerprint_sha256"], m2["content_fingerprint_sha256"])
            self.assertFalse(m1["production_ready"])
            self.assertEqual(m1["missing_domains"], [])


if __name__ == "__main__":
    unittest.main()
