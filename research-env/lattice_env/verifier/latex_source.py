"""Just enough of a LaTeX reader to compare two versions of a paper.

Not a parser: TeX can only be read by running it. This finds the commands
the verifier compares (labels, references, citations, sections, figures,
definitions) in the *live* text, meaning the source with what TeX would
never typeset removed first: `%` comments, `\\iffalse ... \\fi` blocks and
`comment` environments. Comparing raw text instead would let a submission
"keep" a section by commenting it out.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

NAME = r"[A-Za-z@]+"

REFERENCE_COMMANDS = (
    "ref", "eqref", "pageref", "autoref", "Autoref", "cref", "Cref", "cpageref", "Cpageref",
    "nameref", "vref", "Vref", "labelcref",
)
CITE_COMMANDS = (
    "cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "citeyearpar",
    "citenum", "nocite", "Citep", "Citet", "Citealp", "Citealt", "Citeauthor", "parencite",
    "Parencite", "textcite", "Textcite", "autocite", "Autocite", "footcite", "smartcite",
)
SECTION_COMMANDS = (
    "part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph",
)
DEFINING_COMMANDS = (
    "newcommand", "renewcommand", "providecommand", "DeclareRobustCommand",
    "DeclareMathOperator", "NewDocumentCommand", "RenewDocumentCommand",
    "ProvideDocumentCommand", "DeclareDocumentCommand", "newrobustcmd", "renewrobustcmd",
)
PRIMITIVE_DEFINERS = ("def", "gdef", "edef", "xdef", "let", "global\\def", "global\\let")
ENVIRONMENT_DEFINERS = (
    "newenvironment", "renewenvironment", "NewDocumentEnvironment", "RenewDocumentEnvironment",
    "newtheorem",
)


def strip_comments(text: str) -> str:
    """Drop every `%` comment, keeping line breaks so line numbers survive.

    A `%` is a comment unless an odd run of backslashes escapes it. Verbatim
    material is not special-cased: the seeds keep `%` out of it, and a
    mistake here only makes the comparison stricter on both sides alike.
    """
    out: list[str] = []
    for line in text.split("\n"):
        cut = len(line)
        index = line.find("%")
        while index != -1:
            slashes = 0
            back = index - 1
            while back >= 0 and line[back] == "\\":
                slashes += 1
                back -= 1
            if slashes % 2 == 0:
                cut = index
                break
            index = line.find("%", index + 1)
        out.append(line[:cut])
    return "\n".join(out)


IF_TOKEN = re.compile(r"\\(if[A-Za-z@]*|else|fi)(?![A-Za-z@])")
COMMENT_ENV = re.compile(r"\\begin\{comment\}.*?\\end\{comment\}", re.S)


def strip_iffalse(text: str) -> str:
    """Remove `\\iffalse ... \\fi` (keeping a live `\\else` branch), nesting-aware."""
    out: list[str] = []
    position = 0
    while True:
        start = re.search(r"\\iffalse(?![A-Za-z@])", text[position:])
        if not start:
            out.append(text[position:])
            return "".join(out)
        begin = position + start.start()
        out.append(text[position:begin])
        depth = 0
        cursor = begin
        live_from = None
        end = len(text)
        for token in IF_TOKEN.finditer(text, begin):
            name = token.group(1)
            if name.startswith("if"):
                depth += 1
            elif name == "else" and depth == 1:
                live_from = token.end()
            elif name == "fi":
                depth -= 1
                if depth == 0:
                    end = token.start()
                    cursor = token.end()
                    break
        else:
            cursor = len(text)
        if live_from is not None:
            out.append(text[live_from:end])
        # Keep the line count: blank lines stand in for the removed text.
        removed = text[begin:cursor]
        kept = text[live_from:end] if live_from is not None else ""
        out.append("\n" * (removed.count("\n") - kept.count("\n")))
        position = cursor


def live_text(text: str) -> str:
    """What TeX would typeset or act on: no comments, no dead branches."""
    text = strip_comments(text)
    text = COMMENT_ENV.sub(lambda match: "\n" * match.group(0).count("\n"), text)
    return strip_iffalse(text)


def split_preamble(text: str) -> tuple[str, str]:
    """(preamble, body) around the first live `\\begin{document}`."""
    match = re.search(r"\\begin\s*\{document\}", text)
    if not match:
        return text, ""
    return text[: match.start()], text[match.start():]


def balanced(text: str, start: int, opening: str, closing: str) -> int | None:
    """Index just past the group opening at `start`, or None when unbalanced."""
    if start >= len(text) or text[start] != opening:
        return None
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def skip_space(text: str, index: int) -> int:
    while index < len(text) and text[index] in " \t\n":
        index += 1
    return index


@dataclass(frozen=True)
class Command:
    name: str
    star: bool
    optional: tuple[str, ...]
    argument: str | None
    start: int
    end: int


def commands(text: str, names: tuple[str, ...]) -> list[Command]:
    """Each use of `\\name` in `names`, with its star, `[...]` options and first `{...}`."""
    pattern = re.compile(r"\\(" + "|".join(re.escape(n) for n in names) + r")(?![A-Za-z@])")
    found = []
    for match in pattern.finditer(text):
        index = match.end()
        star = False
        if index < len(text) and text[index] == "*":
            star = True
            index += 1
        optional = []
        while True:
            probe = skip_space(text, index)
            end = balanced(text, probe, "[", "]")
            if end is None:
                break
            optional.append(text[probe + 1 : end - 1])
            index = end
        probe = skip_space(text, index)
        end = balanced(text, probe, "{", "}")
        argument = None
        if end is not None:
            argument = text[probe + 1 : end - 1]
            index = end
        found.append(Command(match.group(1), star, tuple(optional), argument, match.start(), index))
    return found


def keys(argument: str | None) -> list[str]:
    if not argument:
        return []
    return [key.strip() for key in argument.split(",") if key.strip()]


def labels(text: str) -> Counter:
    return Counter(key for c in commands(text, ("label",)) for key in keys(c.argument))


def references(text: str) -> Counter:
    return Counter(key for c in commands(text, REFERENCE_COMMANDS) for key in keys(c.argument))


def citations(text: str) -> Counter:
    return Counter(
        key
        for c in commands(text, CITE_COMMANDS)
        for key in keys(c.argument)
        if key != "*"
    )


def sections(text: str) -> Counter:
    return Counter(c.name for c in commands(text, SECTION_COMMANDS))


def graphics(text: str) -> Counter:
    return Counter(c.argument.strip() for c in commands(text, ("includegraphics",)) if c.argument)


def environments(text: str) -> Counter:
    return Counter(
        match.group(1) for match in re.finditer(r"\\begin\s*\{([^}]+)\}", text)
    )


def items(text: str) -> int:
    return len(re.findall(r"\\item(?![A-Za-z@])", text))


def control_sequences(text: str) -> Counter:
    return Counter(re.findall(r"\\(" + NAME + ")", text))


def environment_names(text: str) -> Counter:
    return Counter(re.findall(r"\\(?:begin|end)\s*\{([^}]+)\}", text))


def definitions(text: str) -> set[tuple[str, str]]:
    """(kind, name) for every macro or environment `text` defines.

    `kind` is `macro` or `environment`; names carry no backslash.
    """
    defined: set[tuple[str, str]] = set()
    for command in commands(text, DEFINING_COMMANDS):
        target = command.argument
        if target is None:
            # `\newcommand\foo{...}`: the name follows without braces.
            match = re.match(r"\s*\\(" + NAME + ")", text[command.start + len(command.name) + 1 :])
            if match:
                defined.add(("macro", match.group(1)))
            continue
        match = re.match(r"\s*\\(" + NAME + ")", target)
        if match:
            defined.add(("macro", match.group(1)))
    for definer in ("def", "gdef", "edef", "xdef", "let"):
        for match in re.finditer(r"\\" + definer + r"\s*\\(" + NAME + ")", text):
            defined.add(("macro", match.group(1)))
    for command in commands(text, ENVIRONMENT_DEFINERS):
        if command.argument:
            defined.add(("environment", command.argument.strip()))
    return defined


def bib_keys(text: str) -> Counter:
    """Entry keys of a .bib file (`@type{key,`), skipping @string/@preamble/@comment."""
    found = Counter()
    for match in re.finditer(r"@\s*([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,", text):
        if match.group(1).lower() not in ("string", "preamble", "comment"):
            found[match.group(2)] += 1
    return found


def bibitems(text: str) -> Counter:
    return Counter(key for c in commands(text, ("bibitem",)) for key in keys(c.argument))


NEWLABEL = re.compile(r"\\newlabel\{([^}]*)\}\{\{")
BIBCITE = re.compile(r"\\bibcite\{([^}]*)\}\{")


def aux_labels(aux: str) -> dict[str, str]:
    """`\\newlabel{key}{{value}...}` from an .aux: key to the printed value."""
    found = {}
    for match in NEWLABEL.finditer(aux):
        end = balanced(aux, match.end() - 1, "{", "}")
        if end is not None:
            found[match.group(1)] = aux[match.end() : end - 1]
    return found


def aux_citations(aux: str) -> dict[str, str]:
    """`\\bibcite{key}{...}`: key to its first field (the number natbib prints)."""
    found = {}
    for match in BIBCITE.finditer(aux):
        start = match.end() - 1
        end = balanced(aux, start, "{", "}")
        if end is None:
            continue
        body = aux[start + 1 : end - 1]
        if body.startswith("{"):
            inner = balanced(body, 0, "{", "}")
            body = body[1 : inner - 1] if inner else body
        found[match.group(1)] = body
    return found
