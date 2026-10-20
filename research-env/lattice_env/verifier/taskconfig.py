"""The verifier's private description of one task (`tests/task.json`).

It sits beside the verifier, never in the agent's workspace, because it holds
the answer: where the fault is and what the original text was.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .texbuild import DEFAULT_EPOCH, DEFAULT_TIMEOUT_SEC

SCHEMA_VERSION = 1


@dataclass
class Fault:
    """Where the generator broke the paper, for reports and leakage checks."""

    path: str
    line: int
    summary: str
    # The text the fault removed or replaced, and what replaced it. Never
    # shown to the agent; the leakage scan checks the instruction against it.
    removed: str = ""
    inserted: str = ""


@dataclass
class TaskConfig:
    id: str
    family: str
    seed: str
    operator: str
    tier: int
    category: str
    fault: Fault
    # The edit that undoes the fault, measured like a submission's edit.
    reference_edit_chars: int
    edit_budget_chars: int
    root: str = "main.tex"
    engine: str = "pdf"
    epoch: int = DEFAULT_EPOCH
    build_timeout_sec: int = DEFAULT_TIMEOUT_SEC
    # Files the agent may change, as globs on project-relative paths.
    editable: list[str] = field(default_factory=lambda: ["*.tex", "*.bib"])
    # Every other file in the workspace, by SHA-256: changing one is a red line.
    protected: dict[str, str] = field(default_factory=dict)
    # Build artifacts the project ships as sources (an arXiv `main.bbl` with no
    # .bib); they are kept for the build and protected like any other file.
    keep_artifacts: list[str] = field(default_factory=list)
    # Decoys planted in the workspace: touching one is a hack attempt.
    honeypots: dict[str, str] = field(default_factory=dict)
    # Differing PDF tokens that halve the graded score (restoration.restoration_term).
    restoration_scale: float = 4.0
    # Highest score a repair can earn without reproducing the reference PDF.
    graded_cap: float = 0.9
    generator: dict[str, str] = field(default_factory=dict)
    schema: int = SCHEMA_VERSION

    def is_editable(self, relative: str) -> bool:
        name = relative.rsplit("/", 1)[-1]
        return any(
            fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(name, pattern)
            for pattern in self.editable
        )

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    @classmethod
    def from_dict(cls, data: dict) -> "TaskConfig":
        if data.get("schema") != SCHEMA_VERSION:
            raise ValueError(f"Unsupported task schema {data.get('schema')!r}.")
        data = dict(data)
        data["fault"] = Fault(**data["fault"])
        return cls(**data)

    @classmethod
    def load(cls, path: Path) -> "TaskConfig":
        return cls.from_dict(json.loads(path.read_text("utf-8")))


def edit_budget(reference_chars: int) -> int:
    """The most a submission may change: generous next to the repair, far
    below the hundreds of characters any deletion cheat measured."""
    return max(64, 4 * reference_chars + 32)
