"""Reference hygiene: the paper builds, but a cross-reference or citation is wrong.

A compile-only reward misses these entirely (the scout's broken `\\ref` and
wrong cite key both built), so the verifier checks the build's `.aux`: every
label the original printed must print the same number, and every citation
must resolve as it did. That also catches the faults LaTeX never warns
about, such as a `\\label` placed before its figure's `\\caption`, which
quietly points every reference at the section number instead.

`TEX-REF-UDF` and `TEX-LBL-DUP` are DocMut's soft operators (see
build_repair.py for the attribution); DocMut renames a key to `key__ghost`,
which a search finds at once, so this port mistypes it the way an author
would. The `LAT-*` operators are Lattice's own.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from ..mutation import SOFT, Mutation, Operator, Source
from ..seeds import Seed
from ..verifier import latex_source as tex

FAMILY = "reference-hygiene"

INSTRUCTION = """\
The LaTeX paper in this folder builds, but some of its cross-references or
citations are broken: one may be undefined, defined twice, or print the
wrong number. Find the problem and repair it.

- The root document is `{root}`. Build it with `latexmk -pdf {root}`.
- Make the smallest change that restores the paper as it was meant to be.
  Do not delete or comment out content, do not add new labels or
  bibliography entries, and do not silence LaTeX's warnings.
- When you are done, leave the repaired sources in place; nothing needs to
  be submitted.
"""

OPERATORS: list[Operator] = []


def operator(code: str, tier: int, category: str, description: str, files: str = "tex"):
    def register(sites):
        OPERATORS.append(Operator(code, FAMILY, tier, category, SOFT, description, sites, files))
        return sites
    return register


def source(code: str, seed: Seed, path: str, text: str) -> Source:
    return Source(next(o for o in OPERATORS if o.code == code), seed, path, text)


def mistype(key: str) -> str | None:
    """An author's typo: two neighbouring letters swapped, else one dropped."""
    letters = [i for i in range(len(key) - 1) if key[i].isalpha() and key[i + 1].isalpha() and key[i] != key[i + 1]]
    if letters:
        i = letters[len(letters) // 2]
        return key[:i] + key[i + 1] + key[i] + key[i + 2:]
    return key[:-1] if len(key) > 3 else None


def key_spans(src: Source, names: tuple[str, ...]) -> Iterator[tuple[str, int, int]]:
    """(key, start, end) of every key inside a live command from `names`."""
    for command in tex.commands(src.text, names):
        if command.argument is None or not src.in_body(command.start):
            continue
        argument_start = src.text.index("{", command.start) + 1
        for match in re.finditer(r"[^,\s]+", command.argument):
            yield match.group(0), argument_start + match.start(), argument_start + match.end()


@operator("TEX-REF-UDF", 2, "UndefinedReference", "mistype the key of a \\ref")
def reference_typo(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("TEX-REF-UDF", seed, path, text)
    for key, start, end in key_spans(src, tex.REFERENCE_COMMANDS):
        typo = mistype(key)
        if typo:
            yield src.replace(start, end, typo, f"\\ref{{{key}}} became \\ref{{{typo}}}")


@operator("LAT-CIT-UDF", 2, "UndefinedCitation", "mistype the key of a \\cite")
def citation_typo(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-CIT-UDF", seed, path, text)
    for key, start, end in key_spans(src, tex.CITE_COMMANDS):
        typo = mistype(key)
        if typo and key != "*":
            yield src.replace(start, end, typo, f"the citation key {key} became {typo}")


@operator("LAT-LBL-DRP", 2, "UndefinedReference", "delete a \\label the paper refers to")
def label_drop(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-LBL-DRP", seed, path, text)
    referenced = set()
    for name in seed.files:
        if name.endswith(".tex"):
            referenced |= set(tex.references(tex.live_text(seed.text(name))))
    for command in tex.commands(text, ("label",)):
        if command.argument in referenced and src.in_body(command.start):
            yield src.replace(command.start, command.end, "", f"deleted \\label{{{command.argument}}}")


@operator("TEX-LBL-DUP", 2, "MultiplyDefinedLabel", "define a label a second time")
def label_duplicate(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    """DocMut puts the copy right after the original, where the reference
    still resolves; here it goes into the next float or section, so the
    duplicate changes what the reference prints, as a copied figure does."""
    src = source("TEX-LBL-DUP", seed, path, text)
    labels = [c for c in tex.commands(text, ("label",)) if c.argument and src.in_body(c.start)]
    for first, second in zip(labels, labels[1:], strict=False):
        yield src.replace(second.end, second.end, f"\\label{{{first.argument}}}",
                          f"\\label{{{first.argument}}} was copied after \\label{{{second.argument}}}")


@operator("LAT-LBL-CAP", 3, "WrongReferenceTarget", "move a figure's \\label before its \\caption")
def label_before_caption(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    """No warning at all: the label then takes the section's number."""
    src = source("LAT-LBL-CAP", seed, path, text)
    for float_env in re.finditer(r"\\begin\{(figure|table)\*?\}.*?\\end\{\1\*?\}", text, re.S):
        if not src.in_body(float_env.start()):
            continue
        body = float_env.group(0)
        caption = re.search(r"\\caption\{", body)
        label = re.search(r"\\label\{[^}]+\}", body)
        if not caption or not label or label.start() < caption.start():
            continue
        start = float_env.start()
        moved = (body[: caption.start()] + label.group(0) + "\n  " + body[caption.start() : label.start()]
                 + body[label.end():])
        yield src.replace(start, float_env.end(), moved, f"{label.group(0)} moved before its \\caption")


@operator("LAT-BIB-KEY", 2, "UndefinedCitation", "rename a cited entry's key in the .bib", files="bib")
def bib_key_rename(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-BIB-KEY", seed, path, text)
    cited = set()
    for name in seed.files:
        if name.endswith(".tex"):
            cited |= set(tex.citations(tex.live_text(seed.text(name))))
    for match in re.finditer(r"@\s*[A-Za-z]+\s*\{\s*([^,\s]+)\s*,", text):
        key = match.group(1)
        typo = mistype(key)
        if key in cited and typo:
            yield src.replace(match.start(1), match.end(1), typo, f"the .bib entry {key} was renamed {typo}")


@operator("LAT-BIB-DRP", 1, "UndefinedCitation", "delete the \\bibliography command")
def bibliography_drop(seed: Seed, path: str, text: str) -> Iterator[Mutation]:
    src = source("LAT-BIB-DRP", seed, path, text)
    for offset, line in src.lines():
        if re.match(r"\s*\\bibliography\{", line) and src.in_body(offset + line.find("\\")):
            yield src.replace(offset, offset + len(line) + 1, "", "deleted the \\bibliography line")
