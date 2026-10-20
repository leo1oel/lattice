"""The private held-out split: seeds no public task was made from.

A held-out test split only measures generalisation if nothing from it
leaked into what agents trained or were tuned on. Tasks from one seed share
almost all of their text, so the unit of the split is the seed paper, not
the task: held-out tasks come from private seeds (`generate --seeds-dir`),
drawn with a private salt, and are never committed. Rotating the split
means drawing again with a new salt and new seeds, as RECLAIM regenerates
its benchmark each year.

`check` is the leakage scan between the two sides: CoworkEnv's
near-duplicate test, word 4-grams of each seed's live LaTeX, flagging a
pair when more than half of the smaller seed's 4-grams also occur in the
other. Comments are left out first, since a template's boilerplate
comments would otherwise make every pair look alike.
"""

from __future__ import annotations

import re

from .seeds import Seed
from .verifier.latex_source import live_text

THRESHOLD = 0.5


def shingles(seed: Seed, n: int = 4) -> set[tuple[str, ...]]:
    words: list[str] = []
    for path in sorted(seed.files):
        if path.endswith((".tex", ".bib")):
            words.extend(re.findall(r"\w+", live_text(seed.text(path)).lower()))
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def overlap(left: set, right: set) -> float:
    """Share of the smaller set that the larger one also contains."""
    if not left or not right:
        return 0.0
    return len(left & right) / min(len(left), len(right))


def leaks(public: list[Seed], private: list[Seed], threshold: float = THRESHOLD) -> list[dict]:
    """Every (public, private) pair of seeds that share too much text."""
    public_shingles = {seed.name: shingles(seed) for seed in public}
    found = []
    for seed in private:
        mine = shingles(seed)
        for name, theirs in public_shingles.items():
            score = overlap(mine, theirs)
            if score > threshold or seed.name == name:
                found.append({"private": seed.name, "public": name, "overlap": round(score, 4)})
    return found
