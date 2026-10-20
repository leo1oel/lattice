"""Edit distances that stay cheap when the two sides are nearly the same.

A repair differs from the broken paper by a few characters, and a cheat by a
few thousand. Myers' O((N+M)·D) algorithm costs in proportion to that
difference, and the `limit` cuts it off once the answer can only be "over
budget", so a whole-section deletion is measured in milliseconds rather than
the quadratic time a plain LCS table would take.
"""

from __future__ import annotations

import difflib
from typing import Sequence


def edit_distance(a: Sequence, b: Sequence, limit: int | None = None) -> int | None:
    """Insertions plus deletions turning `a` into `b`; None when above `limit`."""
    n, m = len(a), len(b)
    # Trim the common prefix and suffix first: most of a near-identical pair.
    start = 0
    while start < n and start < m and a[start] == b[start]:
        start += 1
    end_a, end_b = n, m
    while end_a > start and end_b > start and a[end_a - 1] == b[end_b - 1]:
        end_a -= 1
        end_b -= 1
    a = a[start:end_a]
    b = b[start:end_b]
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        distance = n + m
        return distance if limit is None or distance <= limit else None
    bound = n + m if limit is None else min(limit, n + m)
    offset = bound + 1
    frontier = [0] * (2 * bound + 3)
    for d in range(bound + 1):
        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and frontier[offset + k - 1] < frontier[offset + k + 1]):
                x = frontier[offset + k + 1]
            else:
                x = frontier[offset + k - 1] + 1
            y = x - k
            while x < n and y < m and a[x] == b[y]:
                x += 1
                y += 1
            frontier[offset + k] = x
            if x >= n and y >= m:
                return d
    return None


def lcs_length(a: Sequence, b: Sequence, limit: int | None = None) -> int | None:
    distance = edit_distance(a, b, limit)
    if distance is None:
        return None
    return (len(a) + len(b) - distance) // 2


def text_edit_chars(before: str, after: str, limit: int | None = None) -> int | None:
    """Characters inserted plus deleted between two versions of a file.

    Lines anchor the comparison and characters measure it, so a one-character
    fix in a 40 kB file costs one line pair of character diffing.
    """
    if before == after:
        return 0
    old = before.splitlines(keepends=True)
    new = after.splitlines(keepends=True)
    total = 0
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        remaining = None if limit is None else limit - total
        if remaining is not None and remaining < 0:
            return None
        distance = edit_distance("".join(old[i1:i2]), "".join(new[j1:j2]), remaining)
        if distance is None:
            return None
        total += distance
    return total if limit is None or total <= limit else None


def added_lines(before: str, after: str) -> list[str]:
    """Lines of `after` that are not matched to a line of `before`."""
    old = before.splitlines()
    new = after.splitlines()
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    added: list[str] = []
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in ("replace", "insert"):
            added.extend(new[j1:j2])
    return added


def unified(before: str, after: str, path: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )
