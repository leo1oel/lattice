"""Reference hygiene: papers that build but cite or refer wrongly."""

import unittest

from support import TaskCase, requires_tex

from lattice_env import seeds
from lattice_env.families import reference_hygiene
from lattice_env.mutation import SOFT, mutations


@requires_tex
class MistypedReference(TaskCase):
    seed_name = "sparse-routing"
    old = "\\cref{sec:method}"
    new = "\\cref{sec:mehtod}"
    family = "reference-hygiene"
    track = SOFT

    def test_the_untouched_paper_builds_and_still_scores_zero(self):
        verdict = self.score()
        self.assertEqual((verdict.status, verdict.reward), ("scored", 0.0))
        self.assertIn("references", verdict.details["lost"])

    def test_the_reference_repair_reproduces_the_pdf(self):
        verdict = self.score({"main.tex": self.broken().replace("sec:mehtod", "sec:method")})
        self.assertEqual(verdict.reward, 1.0, verdict.reason)

    def test_pointing_the_reference_at_another_section_resolves_but_scores_zero(self):
        verdict = self.score({"main.tex": self.broken().replace("sec:mehtod", "sec:experiments")})
        self.assertEqual(verdict.reward, 0.0)
        self.assertIn("references", verdict.details["lost"])

    def test_inventing_a_label_for_the_typo_is_a_red_line(self):
        method = (self.task_dir / "environment/workspace/sections/method.tex").read_text("utf-8")
        verdict = self.score({"sections/method.tex": method.replace("\\label{sec:method}", "\\label{sec:method}\\label{sec:mehtod}")})
        self.assertEqual(verdict.reward, 0.0)
        self.assertIn("new_label", {line["code"] for line in verdict.red_lines})


CAPTION = "\\caption{Accuracy and calibration error on the tabular suite (illustrative).}"


@requires_tex
class LabelBeforeCaption(TaskCase):
    """No warning at all: the table's label takes the section's number."""

    seed_name = "tabular-calibration"
    old = CAPTION + "\n  \\label{tab:ece}"
    new = "\\label{tab:ece}\n  " + CAPTION
    family = "reference-hygiene"
    track = SOFT

    def test_the_untouched_paper_prints_the_wrong_number_and_scores_zero(self):
        verdict = self.score()
        self.assertEqual(verdict.reward, 0.0)
        self.assertTrue(verdict.gates["builds"])
        self.assertFalse(verdict.gates["referencesResolved"])
        self.assertIn("label 'tab:ece' now prints", " ".join(verdict.details["referenceProblems"]))

    def test_moving_the_label_back_after_the_caption_reproduces_the_pdf(self):
        verdict = self.score({"main.tex": self.broken().replace(self.new, self.old)})
        self.assertEqual(verdict.reward, 1.0, verdict.reason)


@requires_tex
class RenamedBibEntry(TaskCase):
    seed_name = "curriculum-signals"
    path = "references.bib"
    old = "@inproceedings{wu2021curricula,"
    new = "@inproceedings{wu2021curriclua,"
    family = "reference-hygiene"
    track = SOFT

    def test_the_untouched_paper_scores_zero(self):
        verdict = self.score()
        self.assertEqual(verdict.reward, 0.0)
        self.assertFalse(verdict.gates["referencesResolved"])

    def test_renaming_the_entry_back_reproduces_the_pdf(self):
        bib = self.broken("references.bib").replace("wu2021curriclua", "wu2021curricula")
        self.assertEqual(self.score({"references.bib": bib}).reward, 1.0)

    def test_following_the_typo_in_the_paper_instead_loses_the_citation(self):
        main = self.broken().replace("wu2021curricula", "wu2021curriclua")
        verdict = self.score({"main.tex": main})
        self.assertEqual(verdict.reward, 0.0)
        self.assertIn("citations", verdict.details["lost"])

    def test_adding_an_entry_under_the_typo_is_a_red_line(self):
        bib = self.broken("references.bib") + "\n@misc{wu2021currcula,\n  title = {x}\n}\n"
        main = self.broken().replace("wu2021curricula", "wu2021curricula,wu2021currcula")
        verdict = self.score({"references.bib": bib, "main.tex": main})
        self.assertIn("new_bib_key", {line["code"] for line in verdict.red_lines})


class Operators(unittest.TestCase):
    def test_each_operator_finds_sites_in_the_authored_seeds(self):
        authored = [s for s in seeds.bundled() if s.name in ("sparse-routing", "tabular-calibration",
                                                              "curriculum-signals", "plain-notes")]
        for operator in reference_hygiene.OPERATORS:
            with self.subTest(operator=operator.code):
                self.assertTrue(any(mutations(operator, seed) for seed in authored))


if __name__ == "__main__":
    unittest.main()
