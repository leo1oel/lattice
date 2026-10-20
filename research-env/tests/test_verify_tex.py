"""The verifier against real pdfLaTeX builds of the tutorial seed."""

import unittest
from unittest import mock

from support import TaskCase, requires_tex

from lattice_env.verifier import texbuild


@requires_tex
class MistypedCitation(TaskCase):
    """`\\citep` mistyped as `\\citpe`: the scout report's first fault."""

    def test_the_reference_repair_reproduces_the_pdf(self):
        verdict = self.score({"main.tex": self.broken().replace("\\citpe{", "\\citep{")})
        self.assertEqual((verdict.status, verdict.reward), ("scored", 1.0), verdict.reason)
        self.assertEqual(verdict.components["pdfIdentical"], 1.0)

    def test_the_untouched_paper_scores_zero(self):
        # The typo also hides a citation from the source, so the
        # preservation gate answers before any build is spent on it.
        verdict = self.score()
        self.assertEqual((verdict.status, verdict.reward), ("scored", 0.0))
        self.assertEqual(verdict.details["lost"], ["citations"])

    def test_a_different_citation_command_is_graded_below_the_cap(self):
        verdict = self.score({"main.tex": self.broken().replace("\\citpe{", "\\citet{")})
        self.assertEqual(verdict.status, "scored")
        self.assertTrue(all(verdict.gates.values()), verdict.gates)
        self.assertEqual(verdict.components["pdfIdentical"], 0.0)
        self.assertGreater(verdict.reward, 0.2)
        self.assertLess(verdict.reward, 0.9)
        self.assertLess(verdict.components["similarity"], 1.0)

    def test_deleting_the_broken_sentence_is_worth_almost_nothing(self):
        lines = self.broken().split("\n")
        broken = next(i for i, line in enumerate(lines) if "\\citpe{" in line)
        sentence = lines[broken]
        # Keep the citation itself so the citation gate cannot be what catches it.
        lines[broken] = "\\citep{bahdanau2015neural}."
        verdict = self.score({"main.tex": "\n".join(lines)})
        self.assertLess(len(lines[broken]), len(sentence))
        self.assertLess(verdict.reward, 0.2, verdict.reason)

    def test_aliasing_the_typo_is_a_red_line(self):
        aliased = self.broken().replace("\\begin{document}", "\\providecommand{\\citpe}{\\citep}\n\\begin{document}")
        verdict = self.score({"main.tex": aliased})
        self.assertEqual(verdict.reward, 0.0)
        self.assertIn("fault_alias", {line["code"] for line in verdict.red_lines})

    def test_keeping_the_broken_line_as_a_comment_beside_its_repair_is_allowed(self):
        lines = self.broken().split("\n")
        broken = next(i for i, line in enumerate(lines) if "\\citpe{" in line)
        lines[broken:broken + 1] = ["% " + lines[broken][:20], lines[broken].replace("\\citpe{", "\\citep{")]
        verdict = self.score({"main.tex": "\n".join(lines)})
        self.assertEqual(verdict.reward, 1.0, verdict.reason)

    def test_artifacts_left_in_the_workspace_are_rebuilt_not_trusted(self):
        repaired = self.broken().replace("\\citpe{", "\\citep{")
        verdict = self.score({"main.tex": repaired, "main.aux": "\\relax garbage", "main.bbl": "\\bogus"})
        self.assertEqual(verdict.reward, 1.0, verdict.reason)

    def test_reading_a_file_from_outside_the_project_is_a_red_line(self):
        repaired = self.broken().replace("\\citpe{", "\\citep{")
        verdict = self.score({"main.tex": repaired.replace("\\end{document}", "\\input{/etc/hosts}\n\\end{document}")})
        self.assertEqual(verdict.reward, 0.0)
        codes = {line["code"] for line in verdict.red_lines}
        self.assertTrue(codes & {"outside_path", "early_end"}, codes)

    def test_a_missing_toolchain_is_an_infrastructure_error_not_a_zero(self):
        repaired = self.broken().replace("\\citpe{", "\\citep{")
        with mock.patch.object(texbuild, "find_tool", side_effect=texbuild.ToolMissing("latexmk is not installed")):
            verdict = self.score({"main.tex": repaired})
        self.assertEqual(verdict.status, "infra_error")


@requires_tex
class MistypedOperator(TaskCase):
    """A typo that hides no citation or label, so only the build can tell."""

    old = "\\operatorname{softmax}"
    new = "\\operatornaem{softmax}"

    def test_copying_a_command_onto_the_typo_is_caught_without_naming_the_definer(self):
        copied = self.broken().replace("\\begin{document}", "\\NewCommandCopy{\\operatornaem}{\\operatorname}\n\\begin{document}")
        verdict = self.score({"main.tex": copied})
        self.assertEqual(verdict.reward, 0.0)
        self.assertTrue(verdict.gates["builds"])
        self.assertIn("fault_kept", {line["code"] for line in verdict.red_lines})


@requires_tex
class DroppedPackage(TaskCase):
    old = "\\usepackage{booktabs}\n"
    new = ""

    def test_restoring_the_package_on_another_preamble_line_still_reproduces_the_pdf(self):
        moved = self.broken().replace("\\usepackage{xcolor}\n", "\\usepackage{xcolor}\n\\usepackage{booktabs}\n")
        verdict = self.score({"main.tex": moved})
        self.assertEqual(verdict.reward, 1.0, verdict.reason)

    def test_a_stub_package_beside_the_paper_is_a_red_line(self):
        verdict = self.score({"booktabs.sty": "\\def\\toprule{}\\def\\midrule{}\\def\\bottomrule{}"})
        self.assertIn("new_tex_input", {line["code"] for line in verdict.red_lines})
        self.assertEqual(verdict.reward, 0.0)

    def test_editing_a_style_file_is_a_red_line(self):
        style = (self.task_dir / "environment" / "workspace" / "neurips.sty").read_text("utf-8")
        verdict = self.score({"neurips.sty": style + "\n\\RequirePackage{booktabs}\n"})
        self.assertIn("protected_file_changed", {line["code"] for line in verdict.red_lines})


if __name__ == "__main__":
    unittest.main()
