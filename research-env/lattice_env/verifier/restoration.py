"""How much of the original paper's text a repair brought back.

Measured on what the reader sees, the PDF's text layer from `pdftotext`, not
on the source: two sources can differ and typeset the same, and a source can
look intact while a `\\renewcommand` hides half of it.
"""

from __future__ import annotations

import difflib
import re
import subprocess
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .diffing import edit_distance
from .texbuild import find_tool

LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"}

# The unresolved-reference marks LaTeX prints in place of a number.
UNRESOLVED_MARKS = re.compile(r"\?\?|\[\?\]|\(\?\)")


def pdf_text(pdf: bytes) -> str:
    """The PDF's text laid out as on the page, one form feed between pages."""
    pdftotext = find_tool("pdftotext")
    with tempfile.TemporaryDirectory(prefix="lattice-text-") as scratch:
        source = Path(scratch) / "in.pdf"
        source.write_bytes(pdf)
        result = subprocess.run(
            [pdftotext, "-layout", "-enc", "UTF-8", str(source), "-"],
            capture_output=True,
            timeout=60,
        )
    if result.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {result.stderr.decode('utf-8', 'replace')[:200]}")
    return result.stdout.decode("utf-8", "replace")


def tokens(text: str) -> list[str]:
    """Lowercased whitespace tokens, as TeXFix-Bench's S_pdf reads them, after
    Unicode and ligature folding (which it lacks), so a font that encodes
    "fi" as one glyph reads the same as one that does not."""
    text = unicodedata.normalize("NFKC", text)
    for ligature, letters in LIGATURES.items():
        text = text.replace(ligature, letters)
    return text.lower().split()


def unresolved_marks(text: str) -> int:
    return len(UNRESOLVED_MARKS.findall(text))


@dataclass(frozen=True)
class Restoration:
    # Tokens inserted plus deleted between the reference text and the
    # submission's; None when the difference exceeded the comparison limit.
    token_diff: int | None
    # TeXFix-Bench's S_pdf: 2M / (|A| + |B|), M the tokens difflib matches.
    similarity: float
    reference_tokens: int
    submission_tokens: int


def compare(reference: list[str], submission: list[str], limit: int = 2_000) -> Restoration:
    """The exact token difference (for the graded score) and S_pdf (for
    comparison with TeXFix-Bench), which approximates the LCS greedily."""
    distance = edit_distance(reference, submission, limit)
    total = len(reference) + len(submission)
    if total == 0 or not reference or not submission:
        similarity = 1.0 if reference == submission else 0.0
    else:
        matcher = difflib.SequenceMatcher(None, reference, submission, autojunk=False)
        matched = sum(block.size for block in matcher.get_matching_blocks())
        similarity = 2 * matched / total
    return Restoration(distance, round(similarity, 6), len(reference), len(submission))


def restoration_term(token_diff: int | None, scale: float) -> float:
    """1 for a text identical to the reference, falling fast with each token
    that differs: `scale` differing tokens halve it.

    The decay is steep on purpose. Deleting one sentence that holds the fault
    keeps a 4-page paper's similarity near 0.99, which a linear score would
    pay almost in full; here it pays a few percent.
    """
    if token_diff is None:
        return 0.0
    return 1.0 / (1.0 + token_diff / scale)
