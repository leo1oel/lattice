"""The preference exporter on a project shaped exactly like Lattice writes it.

The fixture's `.research/` files are read by the app's own parser in a Rust
test (`research_env::tests`), so a change to Lattice's annotation schema
fails there before this exporter silently reads the wrong fields.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from lattice_env.preferences import export, hunks

FIXTURE = Path(__file__).parent / "fixtures" / "annotated-paper"


def rows(out: Path, name: str) -> list[dict]:
    return [json.loads(line) for line in (out / f"{name}.jsonl").read_text("utf-8").splitlines()]


class Export(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp(prefix="lattice-prefs-"))

    def tearDown(self):
        shutil.rmtree(self.out, ignore_errors=True)

    def by_note(self, records, word):
        return next(r for r in records if word in json.dumps(r))

    def test_level_one_writes_trl_pairs_from_what_the_writer_kept(self):
        manifest = export(FIXTURE, self.out, level=1, salt="s", writer="u-jane")
        self.assertEqual(manifest["decisions"], {"accept": 1, "accept-partial": 1, "reject": 2})
        dpo = rows(self.out, "dpo")
        # The exact accept makes no pair; the partial accept and the rejection do.
        self.assertEqual(sorted(r["meta"]["decision"] for r in dpo), ["accept-partial", "reject"])
        partial = next(r for r in dpo if r["meta"]["decision"] == "accept-partial")
        self.assertEqual(partial["chosen"][0]["content"], "We measure how writers accept or reject an agent's edits.")
        self.assertEqual(partial["rejected"][0]["content"], "We measure which of an agent's proposed edits writers accept.")
        rejected = next(r for r in dpo if r["meta"]["decision"] == "reject")
        self.assertEqual(rejected["chosen"][0]["content"], "Our results show that writers keep most short edits.")
        self.assertEqual(rejected["meta"]["chosenFrom"], "kept-passage")
        prompt = partial["prompt"][0]["content"]
        self.assertIn("Make the passage clearer as the note asks.", prompt)
        self.assertIn("<passage>\nWe study how writers accept", prompt)
        self.assertNotIn("<before>", prompt, "context is level 2")

    def test_kto_takes_only_the_clear_decisions(self):
        export(FIXTURE, self.out, level=1, salt="s", writer="u-jane")
        kto = rows(self.out, "kto")
        self.assertEqual(sorted(r["label"] for r in kto), [False, True])

    def test_edit_triples_hunks_and_writer_turns(self):
        export(FIXTURE, self.out, level=1, salt="s", writer="u-jane")
        partial = self.by_note(rows(self.out, "edits"), "accept-partial")
        self.assertEqual(partial["finalFrom"], "round-after")
        self.assertGreater(partial["editCost"], 0)
        exact = self.by_note(rows(self.out, "edits"), '"accept"')
        self.assertEqual((exact["editChars"], exact["editCost"]), (0, 0.0))
        split = self.by_note(rows(self.out, "hunks"), "accept-partial")["hunks"]
        self.assertTrue(any(h["kept"] for h in split) and any(not h["kept"] for h in split), split)
        asked = self.by_note(rows(self.out, "writer-turns"), "corresponding author")
        self.assertEqual(asked["writerAnswer"], "Yes, use the lab's address.")
        self.assertIsNone(asked["decision"])

    def test_privacy_comments_emails_urls_names_and_co_authors(self):
        export(FIXTURE, self.out, level=1, salt="s")
        everything = "".join((self.out / name).read_text("utf-8") for name in
                             ("dpo.jsonl", "edits.jsonl", "writer-turns.jsonl", "labels.jsonl"))
        for secret in ("jane.doe@example.org", "https://example.org", "Jane Doe", "TODO: cite", "Carol", "u-jane",
                       "main.tex"):
            self.assertNotIn(secret, everything)
        self.assertIn("<email>", everything)
        turns = rows(self.out, "writer-turns")
        first = self.by_note(turns, "one plain sentence")
        self.assertEqual(first["replies"], ["Thanks, will do."], "a co-author's reply is dropped")
        # Without --writer, the co-author's own undecided annotation is still only a label.
        self.assertEqual(len(turns), 5)

    def test_earlier_rounds_keep_their_outcome_without_text(self):
        export(FIXTURE, self.out, level=1, salt="s", writer="u-jane")
        labels = rows(self.out, "labels")
        textless = [r for r in labels if r.get("text") is False]
        self.assertEqual([(r["round"], r["decision"]) for r in textless], [(1, "reject")])

    def test_level_zero_has_no_text_and_level_two_has_context_and_files(self):
        export(FIXTURE, self.out, level=0, salt="s")
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["datasheet.md", "labels.jsonl", "manifest.json"])
        self.assertNotIn("writers", (self.out / "labels.jsonl").read_text("utf-8"))
        full = self.out / "full"
        export(FIXTURE, full, level=2, salt="s")
        dpo = rows(full, "dpo")
        self.assertIn("<before>", dpo[0]["prompt"][0]["content"])
        self.assertIn("TODO: cite", (full / "rounds.jsonl").read_text("utf-8"), "comments are kept at level 2")

    def test_hashes_are_salted_per_export(self):
        export(FIXTURE, self.out / "a", level=0, salt="one")
        export(FIXTURE, self.out / "b", level=0, salt="two")
        ids = lambda name: {r["annotation"] for r in rows(self.out / name, "labels")}
        self.assertFalse(ids("a") & ids("b"))
        self.assertIn("consent level 0", (self.out / "a" / "datasheet.md").read_text("utf-8"))


class Hunks(unittest.TestCase):
    def test_a_hunk_is_kept_when_the_applied_text_made_the_same_change(self):
        split = hunks("the cat sat on the mat", "the dog sat on a mat", "the dog sat on the mat")
        self.assertEqual([(h["old"], h["new"], h["kept"]) for h in split], [("cat", "dog", True), ("the", "a", False)])


if __name__ == "__main__":
    unittest.main()
