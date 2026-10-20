"""Build repair: the paper stops compiling, and the agent has to fix it.

The operators port DocMut's LaTeX catalogue (MIT, Copyright (c) 2026 Prajwal
S. Venkateshmurthy / Oleafly; github.com/prajwal-svm/docmut) and keep its
codes and tiers, so results can be compared with TeXFix-Bench: each
`TEX-*` code below does what DocMut's operator of that code does, on the
same eligible sites, reimplemented here for pdfLaTeX. The categories are
TeXFix-Bench's taxonomy of 168 real LaTeX crashes mined from TeX.SE, GitHub
and package documentation.

DocMut's operators that need another engine or shell escape (minted,
fontspec, glossaries, CSV readers) are left out: the pinned build is
pdfTeX without shell escape. In their place, `LAT-*` operators cover the
taxonomy's categories DocMut left uncovered and that pdfLaTeX can raise:
graphics and bibliography paths, input encoding, alignment tabs, a
paragraph break inside an argument, and the scout report's mistyped macro.

Every operator only proposes sites; the generator keeps a mutant only if
the pinned build really fails on it (the render-diff guard).
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Iterator

from ..mutation import HARD, Mutation, Operator, Source
from ..seeds import Seed

FAMILY = "build-repair"

INSTRUCTION = """\
The LaTeX paper in this folder no longer builds. Find what broke and repair it.

- The root document is `{root}`. It must build with `latexmk -pdf {root}`.
- Make the smallest change that restores the paper as it was meant to be.
  Do not delete or comment out content, and do not work around the problem
  by redefining commands, adding packages or style files, or editing the
  style files that came with the paper.
- When you are done, leave the repaired sources in place; nothing needs to
  be submitted.
"""

# DocMut's TEX-ENV-REN table; any other environment loses its last letter.
ENV_TYPOS = {"itemize": "itemise", "center": "centre", "figure": "figurer", "table": "tabel",
             "equation": "equaton", "abstract": "abstrac"}
# DocMut's TEX-CMD-TRP table.
COMMAND_TYPOS = {"begin": "begn", "frac": "frak", "textbf": "texbf", "section": "sectin",
                 "emph": "empf", "cite": "cit", "caption": "captin", "label": "lable",
                 "includegraphics": "includegrapics", "subsection": "subsecton"}
# TEX-PKG-DRP: a package whose line may go, and the macros that prove it is used.
PACKAGE_MARKERS = {
    "graphicx": r"\\includegraphics", "booktabs": r"\\(?:top|mid|bottom)rule",
    "amsmath": r"\\begin\{align|\\eqref|\\operatorname|\\text\{|\\DeclareMathOperator",
    "amssymb": r"\\mathbb|\\mathfrak", "xcolor": r"\\textcolor|\\definecolor|\\color\{",
    "natbib": r"\\cite[pt]\b", "hyperref": r"\\href|\\autoref", "multirow": r"\\multirow",
    "algorithm": r"\\begin\{algorithm\}", "algpseudocode": r"\\State\b|\\Require\b",
    "subcaption": r"\\begin\{subfigure\}", "tabularx": r"\\begin\{tabularx\}",
    "amsthm": r"\\newtheorem", "cleveref": r"\\[cC]ref\b", "bm": r"\\bm\{",
    "mathtools": r"\\coloneqq|\\DeclarePairedDelimiter", "nicefrac": r"\\nicefrac",
    "listings": r"\\begin\{lstlisting\}", "enumitem": r"\\setlist|\\begin\{(?:itemize|enumerate)\}\[",
    "siunitx": r"\\SI\{|\\num\{|\\si\{",
}
# LAT-ENC-UCS: characters a paste from a PDF brings in that pdfLaTeX's UTF-8
# input has no definition for. The guard drops any this TeX Live does define.
UNSET_CHARACTERS = ("\u2061", "\u200b", "\u2028", "\ufeff")
TWO_ARGUMENT_COMMANDS = ("frac", "dfrac", "tfrac", "binom", "textcolor", "colorbox", "href",
                         "setlength", "parbox", "raisebox", "overset", "underset", "stackrel")


def operator(code: str, tier: int, category: str, description: str):
    def register(sites):
        OPERATORS.append(Operator(code, FAMILY, tier, category, HARD, description, sites))
        return sites
    return register


OPERATORS: list[Operator] = []


def source(code: str, seed: Seed, path: str, text: str) -> Source:
    return Source(next(o for o in OPERATORS if o.code == code), seed, path, text)


def body_matches(src: Source, pattern: str, flags: int = 0) -> Iterator[re.Match]:
    for match in re.finditer(pattern, src.text, flags):
        if src.in_body(match.start()):
            yield match


@operator("TEX-BRC-DRP", 1, "BraceGroupFault", "delete one matched closing brace")
def brace_drop(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-BRC-DRP", seed, path, text)
    for match in body_matches(src, r"\\([A-Za-z]+)\*?(?:\[[^\]]*\])?\{"):
        if match.group(1) in ("begin", "end"):
            continue
        depth, index = 0, match.end() - 1
        while index < len(text):
            if text[index] == "\\":
                index += 2
                continue
            depth += {"{": 1, "}": -1}.get(text[index], 0)
            if depth == 0:
                break
            index += 1
        if index < len(text) and text[index] == "}":
            yield src.replace(index, index + 1, "", f"deleted the closing brace of \\{match.group(1)}")


@operator("TEX-BRC-STR", 1, "BraceGroupFault", "insert a stray opening brace into a text line")
def brace_stray(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-BRC-STR", seed, path, text)
    for offset, line in src.lines():
        if len(line) < 12 or line.lstrip().startswith(("\\", "%")) or not src.in_body(offset):
            continue
        at = offset + int(len(line) * 0.6)
        while at < offset + len(line) and text[at] not in " ":
            at += 1
        if at < offset + len(line) and src.live(at):
            yield src.replace(at, at, " {", "inserted a stray { into a paragraph")


@operator("TEX-ENV-REN", 1, "EnvironmentMismatch", "misspell the name in \\end{...}")
def env_rename(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-ENV-REN", seed, path, text)
    for match in body_matches(src, r"\\end\{([A-Za-z*]+)\}"):
        name = match.group(1)
        if name == "document" or len(name.rstrip("*")) <= 3:
            continue
        bare = name.rstrip("*")
        typo = ENV_TYPOS.get(bare, bare[:-1]) + name[len(bare):]
        yield src.replace(match.start(1), match.end(1), typo, f"\\end{{{name}}} became \\end{{{typo}}}")


@operator("TEX-ENV-UNC", 1, "EnvironmentMismatch", "delete the line holding \\end{...}")
def env_unclosed(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-ENV-UNC", seed, path, text)
    for offset, line in src.lines():
        match = re.search(r"\\end\{([^}]+)\}", line)
        if match and match.group(1) != "document" and src.in_body(offset + match.start()):
            yield src.replace(offset, offset + len(line) + 1, "", f"deleted the line closing {match.group(1)}")


@operator("TEX-MTH-DLR", 1, "MathModeFault", "delete the closing $ of inline math")
def math_dollar(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-MTH-DLR", seed, path, text)
    for match in body_matches(src, r"(?<![\\$])\$([^$\n]+)\$(?!\$)"):
        end = match.end() - 1
        yield src.replace(end, end + 1, "", "deleted the $ closing an inline formula")


@operator("TEX-MTH-DSP", 1, "MathModeFault", "delete a closing \\]")
def math_display(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-MTH-DSP", seed, path, text)
    for match in body_matches(src, r"\\\]"):
        yield src.replace(match.start(), match.end(), "", "deleted the \\] closing a display formula")


@operator("TEX-CLS-DRP", 1, "DocumentBoundaryFault", "delete the \\documentclass line")
def class_drop(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    if path != seed.root:
        return
    src = source("TEX-CLS-DRP", seed, path, text)
    for offset, line in src.lines():
        if line.lstrip().startswith("\\documentclass") and src.live(offset + line.find("\\")):
            yield src.replace(offset, offset + len(line) + 1, "", "deleted the \\documentclass line")
            return


@operator("TEX-ITM-MSN", 1, "OtherFatalCompile", "move an \\item out of its list")
def item_misplaced(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    if path != seed.root:
        return
    src = source("TEX-ITM-MSN", seed, path, text)
    end = re.search(r"\\end\{document\}", text)
    if not end:
        return
    for offset, line in src.lines():
        if line.lstrip().startswith("\\item") and src.in_body(offset + line.find("\\")):
            moved = text[:offset] + text[offset + len(line) + 1 : end.start()] + line + "\n" + text[end.start():]
            mutation = src.replace(0, len(text), moved, "moved an \\item to just before \\end{document}")
            yield dataclasses.replace(mutation, line=src.text.count("\n", 0, offset) + 1, removed=line, inserted="")


@operator("TEX-PKG-DRP", 1, "MissingRequiredPackage", "delete a \\usepackage line the paper relies on")
def package_drop(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-PKG-DRP", seed, path, text)
    for offset, line in src.lines():
        match = re.match(r"\s*\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}", line)
        if not match or offset >= src.body_start or not src.live(offset + match.start(1)):
            continue
        packages = [name.strip() for name in match.group(1).split(",")]
        if any(name in PACKAGE_MARKERS and re.search(PACKAGE_MARKERS[name], text[src.body_start:])
               for name in packages):
            yield src.replace(offset, offset + len(line) + 1, "", f"deleted \\usepackage{{{match.group(1)}}}")


@operator("TEX-CMD-TRP", 2, "UndefinedControlSequence", "misspell a common command")
def command_typo(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-CMD-TRP", seed, path, text)
    for match in body_matches(src, r"\\(" + "|".join(COMMAND_TYPOS) + r")(?![A-Za-z@])"):
        typo = COMMAND_TYPOS[match.group(1)]
        yield src.replace(match.start(1), match.end(1), typo, f"\\{match.group(1)} became \\{typo}")


@operator("TEX-ARG-DRP", 2, "BraceGroupFault", "delete the last argument of a two-argument command")
def argument_drop(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-ARG-DRP", seed, path, text)
    from ..verifier.latex_source import balanced, skip_space

    for match in body_matches(src, r"\\(" + "|".join(TWO_ARGUMENT_COMMANDS) + r")(?![A-Za-z@])"):
        first = balanced(text, skip_space(text, match.end()), "{", "}")
        if first is None:
            continue
        second_start = skip_space(text, first)
        second = balanced(text, second_start, "{", "}")
        if second is not None:
            yield src.replace(first, second, "", f"deleted the second argument of \\{match.group(1)}")


@operator("LAT-CMD-TYP", 2, "UndefinedControlSequence", "swap two letters of a macro the paper uses")
def macro_transposition(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    """The scout report's `\\citpe`: the last two letters of a used command
    swapped, which leaves an undefined control sequence most of the time."""
    src = source("LAT-CMD-TYP", seed, path, text)
    for match in body_matches(src, r"\\([a-z]{4,})(?![A-Za-z@])"):
        name = match.group(1)
        typo = name[:-2] + name[-1] + name[-2]
        if typo != name:
            yield src.replace(match.start(1), match.end(1), typo, f"\\{name} became \\{typo}")


@operator("LAT-GFX-PTH", 3, "GraphicsIncludeFault", "misspell an \\includegraphics path")
def graphics_path(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-GFX-PTH", seed, path, text)
    for match in body_matches(src, r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}"):
        target = match.group(1)
        stem_start = match.start(1) + target.rfind("/") + 1
        stem_end = match.start(1) + (target.rfind(".") if "." in target[target.rfind("/") + 1:] else len(target))
        if stem_end - stem_start >= 3:
            yield src.replace(stem_end - 1, stem_end, "", f"the figure path {target} lost a letter")


@operator("LAT-FIL-BIB", 3, "MissingExternalFile", "misspell the \\bibliography file name")
def bibliography_path(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-FIL-BIB", seed, path, text)
    for match in body_matches(src, r"\\bibliography\{([^}]+)\}"):
        if len(match.group(1)) >= 3:
            yield src.replace(match.end(1) - 1, match.end(1), "", f"\\bibliography{{{match.group(1)}}} lost a letter")
    for match in body_matches(src, r"\\bibliographystyle\{([^}]+)\}"):
        yield src.replace(match.end(1), match.end(1), "x", f"\\bibliographystyle{{{match.group(1)}}} gained a letter")


@operator("LAT-ENC-UCS", 3, "InputEncodingFault", "paste an undefined Unicode character into the text")
def unicode_character(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-ENC-UCS", seed, path, text)
    count = 0
    for match in body_matches(src, r"(?<=[a-z]) (?=[a-z])"):
        character = UNSET_CHARACTERS[count % len(UNSET_CHARACTERS)]
        count += 1
        yield src.replace(match.start(), match.end(), " " + character,
                          f"a pasted U+{ord(character):04X} landed between two words")


@operator("LAT-TAB-XTR", 3, "TableAlignmentFault", "give a table row one cell too many")
def table_extra_cell(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-TAB-XTR", seed, path, text)
    for table in body_matches(src, r"\\begin\{tabular\}.*?\\end\{tabular\}", re.S):
        for row in re.finditer(r"[^\n&]+(?:&[^\n&]+)+\\\\", table.group(0)):
            end = table.start() + row.end() - 2
            yield src.replace(end, end, " & extra ", "a table row gained an extra cell")


@operator("LAT-TAB-AMP", 3, "TableAlignmentFault", "put an unescaped & in running text")
def stray_ampersand(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-TAB-AMP", seed, path, text)
    for match in body_matches(src, r"(?<=[a-z]) and (?=[a-z])"):
        line = text[text.rfind("\n", 0, match.start()) + 1 : text.find("\n", match.end())]
        if "&" not in line and not line.lstrip().startswith("\\"):
            yield src.replace(match.start(), match.end(), " & ", "an and became an unescaped &")


@operator("LAT-ARG-PAR", 3, "BraceGroupFault", "break a paragraph inside a command's argument")
def paragraph_in_argument(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-ARG-PAR", seed, path, text)
    for match in body_matches(src, r"\\(textbf|emph|textit|footnote|texttt)\{([^{}\n]{12,})\}"):
        middle = match.start(2) + len(match.group(2)) // 2
        while middle < match.end(2) and text[middle] != " ":
            middle += 1
        if middle < match.end(2):
            yield src.replace(middle, middle + 1, "\n\n", f"a blank line split the argument of \\{match.group(1)}")


@operator("LAT-DOC-BEG", 3, "DocumentBoundaryFault", "delete \\begin{document}")
def begin_document(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    if path != seed.root:
        return
    src = source("LAT-DOC-BEG", seed, path, text)
    match = re.search(r"^\\begin\{document\}\n", text, re.M)
    if match and src.live(match.start()):
        yield src.replace(match.start(), match.end(), "", "deleted \\begin{document}")
