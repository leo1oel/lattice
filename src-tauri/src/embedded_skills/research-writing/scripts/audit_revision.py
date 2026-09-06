#!/usr/bin/env python3
"""Flag protected-span changes between an original and revised manuscript.

This is a deterministic review aid, not a semantic or factual verifier. A
difference may be authorized, but it must be checked against the research
record rather than accepted as a side effect of prose editing.
"""

from __future__ import annotations

import argparse
import hashlib
import re
from collections import Counter
from pathlib import Path


PATTERNS = {
    "yaml_frontmatter": re.compile(r"\A---\s*\n.*?\n---(?=\n|\Z)", re.DOTALL),
    "fenced_code": re.compile(
        r"^(?P<fence>`{3,}|~{3,})[^\n]*\n.*?^(?P=fence)\s*$",
        re.MULTILINE | re.DOTALL,
    ),
    "blockquotes": re.compile(r"^\s*>\s?.*$", re.MULTILINE),
    "markdown_tables": re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE),
    "headings": re.compile(r"^#{1,6}\s+.+$", re.MULTILINE),
    "inline_code": re.compile(r"(?<!`)`[^`\n]+`(?!`)"),
    "urls": re.compile(r"https?://[^\s<>()\]]+"),
    "paths": re.compile(
        r"(?<![\w:])(?:(?:\.{0,2}/|/)(?:[A-Za-z0-9_.-]+/)*"
        r"[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*/"
        r"[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?!\w)"
    ),
    "latex_references": re.compile(
        r"\\(?:cite\w*|ref|eqref|autoref|cref|Cref|label)"
        r"\s*(?:\[[^\]]*\]\s*)*\{[^{}]+\}"
    ),
    "numeric_citations": re.compile(r"\[(?:\d+[a-z]?\s*[,;–—-]?\s*)+\]"),
    "display_math": re.compile(
        r"\$\$.*?\$\$|\\\[.*?\\\]|"
        r"\\begin\{(?:equation\*?|align\*?|gather\*?)\}.*?"
        r"\\end\{(?:equation\*?|align\*?|gather\*?)\}",
        re.DOTALL,
    ),
    "inline_math": re.compile(r"(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?(?<!\\)\$"),
    "quoted_text": re.compile(r'“[^”\n]+”|‘[^’\n]+’|"[^"\n]+"'),
}

NUMBER_PATTERN = re.compile(
    r"(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)"
    r"(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\w.])"
)


def normalized(value: str) -> str:
    return " ".join(value.split())


def extract(text: str) -> dict[str, Counter[str]]:
    tokens: dict[str, Counter[str]] = {}
    masked = list(text)

    for name, pattern in PATTERNS.items():
        matches = list(pattern.finditer("".join(masked)))
        tokens[name] = Counter(normalized(match.group(0)) for match in matches)
        for match in matches:
            masked[match.start() : match.end()] = " " * (match.end() - match.start())

    tokens["numbers"] = Counter(NUMBER_PATTERN.findall("".join(masked)))
    return tokens


def expanded(counter: Counter[str]) -> list[str]:
    values: list[str] = []
    for value, count in sorted(counter.items()):
        values.extend([value] * count)
    return values


def print_values(label: str, values: list[str], limit: int = 20) -> None:
    if not values:
        return
    print(f"  {label} ({len(values)}):")
    for value in values[:limit]:
        print(f"    {value}")
    if len(values) > limit:
        print(f"    ... {len(values) - limit} more")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compare protected structure, quotations, numbers, citations, URLs, "
            "paths, and math spans."
        )
    )
    parser.add_argument("original", type=Path)
    parser.add_argument("revised", type=Path)
    args = parser.parse_args()

    original = args.original.read_text(encoding="utf-8")
    revised = args.revised.read_text(encoding="utf-8")
    original_tokens = extract(original)
    revised_tokens = extract(revised)

    print(f"Original SHA-256: {sha256(original)}")
    print(f"Revised SHA-256:  {sha256(revised)}")

    changed = False
    for name in (*PATTERNS, "numbers"):
        missing = expanded(original_tokens[name] - revised_tokens[name])
        added = expanded(revised_tokens[name] - original_tokens[name])
        if not missing and not added:
            continue
        changed = True
        print(f"\n{name}:")
        print_values("missing from revision", missing)
        print_values("added in revision", added)

    if changed:
        print(
            "\nREVIEW REQUIRED: protected spans changed. Confirm every difference "
            "against the research record."
        )
        return 1

    print("\nPASS: no protected-span differences found.")
    print("A separate bidirectional claim and provenance audit is still required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
