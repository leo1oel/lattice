"""What a fault generator produces, and the helpers every operator shares.

An operator lists each place in a seed where it can break the paper and
what the broken text is there. Picking among those sites, checking the
result really breaks (the render-diff guard) and packaging it are the
generator's job (`generate.py`), so operators stay small and pure.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from .seeds import Seed

# The track says what "broken" means for the guard. A hard fault must stop the
# pinned build; a soft one must build while leaving a reference unresolved or
# wrong, which the verifier's reference gate has to catch.
HARD = "hard"
SOFT = "soft"


@dataclass(frozen=True)
class Mutation:
    family: str
    operator: str
    tier: int
    category: str
    track: str
    path: str
    original: str
    mutated: str
    line: int
    removed: str
    inserted: str
    summary: str


@dataclass(frozen=True)
class Operator:
    code: str
    family: str
    tier: int
    category: str
    track: str
    description: str
    sites: Callable[[Seed, str, str], Iterator[Mutation]]
    # Which of the seed's files the operator breaks: its LaTeX or its .bib.
    files: str = "tex"


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def dead_spans(text: str) -> list[tuple[int, int]]:
    """Byte spans TeX never reads: `%` comments (to the end of their line),
    `comment` environments and `\\iffalse` blocks. Sites inside them would
    break nothing."""
    spans = []
    offset = 0
    for line in text.split("\n"):
        index = line.find("%")
        while index != -1:
            slashes = len(line[:index]) - len(line[:index].rstrip("\\"))
            if slashes % 2 == 0:
                spans.append((offset + index, offset + len(line)))
                break
            index = line.find("%", index + 1)
        offset += len(line) + 1
    for match in re.finditer(r"\\begin\{comment\}.*?\\end\{comment\}|\\iffalse\b.*?\\fi\b", text, re.S):
        spans.append(match.span())
    return spans


class Source:
    """One file of a seed being mutated, with its dead spans precomputed."""

    def __init__(self, operator: Operator, seed: Seed, path: str, text: str):
        self.operator = operator
        self.seed = seed
        self.path = path
        self.text = text
        self.dead = dead_spans(text)
        body = re.search(r"\\begin\s*\{document\}", text)
        self.body_start = body.end() if body else (0 if path != seed.root else len(text))
        end = re.search(r"\\end\s*\{document\}", text)
        self.body_end = end.start() if end else len(text)

    def live(self, offset: int) -> bool:
        return not any(start <= offset < end for start, end in self.dead)

    def in_body(self, offset: int) -> bool:
        return self.body_start <= offset < self.body_end and self.live(offset)

    def replace(self, start: int, end: int, new: str, summary: str) -> Mutation:
        mutated = self.text[:start] + new + self.text[end:]
        op = self.operator
        return Mutation(op.family, op.code, op.tier, op.category, op.track, self.path, self.text,
                        mutated, line_of(self.text, start), self.text[start:end], new, summary)

    def lines(self) -> Iterator[tuple[int, str]]:
        """(offset, line) for every line, newline excluded."""
        offset = 0
        for line in self.text.split("\n"):
            yield offset, line
            offset += len(line) + 1


def tex_paths(seed: Seed) -> list[str]:
    """The seed's own LaTeX sources, root first: what operators may break."""
    others = sorted(p for p in seed.files if p.endswith(".tex") and p != seed.root)
    return [seed.root, *others]


def bib_paths(seed: Seed) -> list[str]:
    return sorted(p for p in seed.files if p.endswith(".bib"))


def mutations(operator: Operator, seed: Seed) -> list[Mutation]:
    found = []
    for path in tex_paths(seed) if operator.files == "tex" else bib_paths(seed):
        found.extend(operator.sites(seed, path, seed.text(path)))
    unique = {}
    for mutation in found:
        unique.setdefault((mutation.path, mutation.mutated), mutation)
    return list(unique.values())


def choose(candidates: list[Mutation], count: int, key: str) -> list[Mutation]:
    """A seeded sample, the same for the same seed paper, operator and key."""
    rng = random.Random(key)
    ordered = sorted(candidates, key=lambda m: (m.path, m.line, m.mutated))
    rng.shuffle(ordered)
    return ordered[:count]


def fix_edits(mutated: str, original: str, path: str) -> dict:
    """The reference repair as one search-and-replace: the span that differs,
    widened eight characters at a time on both sides until the search text
    occurs once in the broken file, so applying it cannot land elsewhere."""
    prefix = 0
    limit = min(len(mutated), len(original))
    while prefix < limit and mutated[prefix] == original[prefix]:
        prefix += 1
    suffix = 0
    while (suffix < limit - prefix and mutated[len(mutated) - 1 - suffix] == original[len(original) - 1 - suffix]):
        suffix += 1
    end_mutated, end_original = len(mutated) - suffix, len(original) - suffix
    before = after = 0
    while True:
        old = mutated[prefix - before : end_mutated + after]
        if old and mutated.find(old) == mutated.rfind(old):
            break
        if before == prefix and after == suffix:
            break
        before = min(prefix, before + 8)
        after = min(suffix, after + 8)
    return {"path": path, "old": old, "new": original[prefix - before : end_original + after]}


def apply_edit(text: str, edit: dict) -> str:
    if text.find(edit["old"]) != text.rfind(edit["old"]) or edit["old"] not in text:
        raise ValueError(f"the repair's search text is not unique in {edit['path']}")
    return text.replace(edit["old"], edit["new"], 1)
