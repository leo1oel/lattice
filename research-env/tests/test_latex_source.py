import unittest

from lattice_env.verifier import latex_source as tex


class LiveText(unittest.TestCase):
    def test_comments_go_but_escaped_percent_and_line_count_stay(self):
        source = "50\\% of runs % a note\nnext % gone\n\\\\% a comment after a line break\n"
        live = tex.live_text(source)
        self.assertEqual(live, "50\\% of runs \nnext \n\\\\\n")
        self.assertEqual(live.count("\n"), source.count("\n"))

    def test_iffalse_blocks_go_and_their_else_branch_stays(self):
        source = "a\n\\iffalse\nhidden \\ifx\\x\\y nested\\fi\n\\else\nshown\n\\fi\nb\n"
        live = tex.live_text(source)
        self.assertNotIn("hidden", live)
        self.assertIn("shown", live)
        self.assertTrue(live.startswith("a\n") and live.endswith("b\n"))
        self.assertEqual(live.count("\n"), source.count("\n"))

    def test_comment_environments_go(self):
        live = tex.live_text("x\n\\begin{comment}\n\\label{gone}\n\\end{comment}\ny")
        self.assertEqual(tex.labels(live), {})


class Commands(unittest.TestCase):
    def test_reads_star_options_and_the_first_argument(self):
        [command] = tex.commands("\\section*[short]{A {nested} title} rest", ("section",))
        self.assertTrue(command.star)
        self.assertEqual(command.optional, ("short",))
        self.assertEqual(command.argument, "A {nested} title")

    def test_does_not_match_longer_names(self):
        self.assertEqual(tex.commands("\\citeauthor{a}", ("cite",)), [])

    def test_counts_keys_in_lists_and_skips_nocite_star(self):
        body = "\\citep[p.~2]{a, b}\\citet{a}\\nocite{*}\\cref{fig:x,tab:y}\\label{fig:x}"
        self.assertEqual(tex.citations(body), {"a": 2, "b": 1})
        self.assertEqual(tex.references(body), {"fig:x": 1, "tab:y": 1})
        self.assertEqual(tex.labels(body), {"fig:x": 1})

    def test_definitions_in_every_form(self):
        body = (
            "\\newcommand{\\R}{\\mathbb{R}}\\newcommand\\N{n}\\providecommand{\\citpe}{}"
            "\\DeclareMathOperator*{\\argmax}{arg\\,max}\\def\\x{1}\\let\\y\\x"
            "\\newenvironment{equaton}{}{}\\newtheorem{lemma}{Lemma}"
        )
        self.assertEqual(
            tex.definitions(body),
            {("macro", n) for n in ("R", "N", "citpe", "argmax", "x", "y")}
            | {("environment", "equaton"), ("environment", "lemma")},
        )


class Aux(unittest.TestCase):
    def test_reads_hyperref_labels_and_natbib_citations(self):
        aux = (
            "\\newlabel{fig:a}{{2}{3}{Caption {with} braces}{figure.2}{}}\n"
            "\\bibcite{vaswani2017}{{7}{2017}{{Vaswani et~al.}}{{Vaswani, Shazeer}}}\n"
            "\\bibcite{plain}{3}\n"
        )
        labels = tex.aux_labels(aux)
        self.assertEqual(labels, {"fig:a": "2"})
        self.assertEqual(tex.aux_citations(aux), {"vaswani2017": "7", "plain": "3"})

    def test_bib_keys_skip_strings_and_comments(self):
        bib = "@string{x = {y}}\n@article{key1,\n title={T}}\n@Comment{nope,}\n@inproceedings{ key2 ,}"
        self.assertEqual(tex.bib_keys(bib), {"key1": 1, "key2": 1})


if __name__ == "__main__":
    unittest.main()
