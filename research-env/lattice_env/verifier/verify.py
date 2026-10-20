"""Score one submission: gates first, then a grade.

A submission scores 0 unless it clears every gate: no red line (redlines.py),
the paper builds under the pinned build, the paper's labels, citations,
sections, figures and content environments are all still there, every
reference resolves to the same number the original printed, and the edit
fits the task's budget. Past the gates, a PDF byte-identical to the original
paper's scores 1. Anything else is graded below 1 by how much of the
original's text it restores and how small the edit was, multiplied, so a
weak component cannot be hidden by a strong one.

The result always carries a `status`. `scored` means the reward is real,
including a 0. `infra_error` means the verifier could not judge (TeX missing,
the reference paper failing to build); trainers must drop those episodes
rather than read them as a 0.
"""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import latex_source as tex
from . import restoration, texbuild
from .diffing import text_edit_chars
from .redlines import RedLine, Tree, fault_names, kept_fault_names, scan
from .taskconfig import TaskConfig

REWARD_SCHEMA = "lattice-env.reward/1"


@dataclass
class Verdict:
    status: str
    reward: float
    components: dict[str, float] = field(default_factory=dict)
    gates: dict[str, bool] = field(default_factory=dict)
    red_lines: list[dict] = field(default_factory=list)
    honeypots_touched: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)
    reason: str = ""
    schema: str = REWARD_SCHEMA

    def to_dict(self) -> dict:
        data = asdict(self)
        data["redLines"] = data.pop("red_lines")
        data["honeypotsTouched"] = data.pop("honeypots_touched")
        return data


def read_tree(directory: Path, root: str, keep: frozenset[str] = frozenset()) -> Tree:
    if not directory.is_dir():
        return {}
    return {path: (directory / path).read_bytes() for path in texbuild.source_files(directory, root, keep)}


def overlay(base: Tree, changes: Tree) -> Tree:
    merged = dict(base)
    merged.update(changes)
    return merged


def write_tree(tree: Tree, directory: Path) -> None:
    for path, data in tree.items():
        target = directory / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def editable_text(task: TaskConfig, tree: Tree) -> dict[str, str]:
    return {p: d.decode("utf-8", "replace") for p, d in tree.items() if task.is_editable(p)}


def edit_size(task: TaskConfig, initial: Tree, submission: Tree, limit: int) -> int | None:
    """Characters changed in editable files, plus every new file's size."""
    total = 0
    before = editable_text(task, initial)
    after = editable_text(task, submission)
    for path in sorted(set(before) | set(after)):
        old, new = before.get(path, ""), after.get(path, "")
        changed = text_edit_chars(old, new, limit - total)
        if changed is None:
            return None
        total += changed
    for path in sorted(set(submission) - set(initial)):
        if not task.is_editable(path):
            total += len(submission[path])
    return total if total <= limit else None


@dataclass
class Inventory:
    labels: object
    citations: object
    sections: object
    graphics: object
    environments: object
    items: int
    references: object


def inventory(task: TaskConfig, tree: Tree) -> Inventory:
    body = "\n".join(
        tex.live_text(text) for path, text in sorted(editable_text(task, tree).items())
        if path.endswith(".tex")
    )
    return Inventory(
        labels=tex.labels(body),
        citations=tex.citations(body),
        sections=tex.sections(body),
        graphics=tex.graphics(body),
        environments=tex.environments(body),
        items=tex.items(body),
        references=tex.references(body),
    )


def preservation_losses(original: Inventory, submission: Inventory) -> list[str]:
    """What the original paper had that the submission lost."""
    lost = []
    if submission.labels != original.labels:
        lost.append("labels")
    if any(submission.citations[k] < n for k, n in original.citations.items()):
        lost.append("citations")
    # Every \ref the original made, to the same key: a reference repaired by
    # pointing it at some other label resolves, and is still wrong.
    if any(submission.references[k] < n for k, n in original.references.items()):
        lost.append("references")
    if any(submission.sections[k] < n for k, n in original.sections.items()):
        lost.append("sections")
    if any(submission.graphics[k] < n for k, n in original.graphics.items()):
        lost.append("figures")
    # Every environment, not only the ones holding prose: removing an
    # unmatched \begin is as much a deletion as removing its contents.
    if any(submission.environments[k] < n for k, n in original.environments.items()):
        lost.append("environments")
    if submission.items < original.items:
        lost.append("list items")
    return lost


UNDEFINED = ("Reference `", "Citation `", "There were undefined references",
             "There were undefined citations", "multiply defined", "Empty `thebibliography'")


def reference_problems(original: texbuild.BuildResult, submission: texbuild.BuildResult,
                       inventory: Inventory, pdf_text: str, reference_text: str) -> list[str]:
    """Why the submission's cross-references are not the original's."""
    problems = []
    original_labels = merge_aux(original, tex.aux_labels)
    labels = merge_aux(submission, tex.aux_labels)
    for key, value in sorted(original_labels.items()):
        if key not in labels:
            problems.append(f"label {key!r} is no longer defined")
        elif labels[key] != value:
            problems.append(f"label {key!r} now prints {labels[key]!r}, not {value!r}")
    citations = merge_aux(submission, tex.aux_citations)
    original_citations = merge_aux(original, tex.aux_citations)
    for key, value in sorted(original_citations.items()):
        if citations.get(key) != value:
            problems.append(f"citation {key!r} no longer resolves as it did")
    for key in sorted(set(inventory.references) - set(labels)):
        problems.append(f"\\ref{{{key}}} is undefined")
    for key in sorted(set(inventory.citations) - set(citations)):
        problems.append(f"\\cite{{{key}}} is undefined")
    warnings = sum(submission.log.count(marker) for marker in UNDEFINED)
    if warnings > sum(original.log.count(marker) for marker in UNDEFINED):
        problems.append("LaTeX reports undefined or duplicate references")
    if restoration.unresolved_marks(pdf_text) > restoration.unresolved_marks(reference_text):
        problems.append("the PDF prints ?? or [?] where a reference should be")
    return problems


def merge_aux(build: texbuild.BuildResult, extract) -> dict[str, str]:
    merged: dict[str, str] = {}
    for _path, body in sorted(build.aux.items()):
        merged.update(extract(body))
    return merged


def edit_term(edit: int, reference: int) -> float:
    """1 for an edit no bigger than the reference repair (plus a little
    slack for formatting), falling as the square root beyond that."""
    allowance = reference + 8
    return 1.0 if edit <= allowance else (allowance / edit) ** 0.5


def verify(task: TaskConfig, tests_dir: Path, workspace: Path, scratch: Path | None = None) -> Verdict:
    keep = frozenset(task.keep_artifacts)
    submission = read_tree(workspace, task.root, keep)
    initial = overlay(carried_over(submission, task), read_tree(tests_dir / "initial", task.root))
    original = overlay(initial, read_tree(tests_dir / "original", task.root))

    red_lines = scan(task, original, initial, submission)
    verdict = Verdict(status="scored", reward=0.0)
    verdict.red_lines = [line.to_dict() for line in red_lines]
    verdict.honeypots_touched = sorted({line.path for line in red_lines if line.code == "honeypot_touched"})
    verdict.gates["noRedLines"] = not red_lines

    edit = edit_size(task, initial, submission, task.edit_budget_chars)
    verdict.details["editChars"] = edit
    verdict.details["editBudgetChars"] = task.edit_budget_chars
    verdict.gates["withinBudget"] = edit is not None

    lost = preservation_losses(inventory(task, original), inventory(task, submission))
    verdict.gates["preserved"] = not lost
    verdict.details["lost"] = lost

    # Every gate so far reads only the source, so a submission that fails one
    # is answered without spending two builds on it.
    failed = [name for name, passed in verdict.gates.items() if not passed]
    if failed:
        verdict.reason = "failed gates: " + ", ".join(failed)
        if red_lines:
            verdict.reason += " (" + ", ".join(sorted({r.code for r in red_lines})) + ")"
        return verdict

    work = Path(tempfile.mkdtemp(prefix="lattice-verify-", dir=scratch))
    try:
        return grade(task, verdict, original, initial, submission, edit, work)
    except texbuild.ToolMissing as error:
        return Verdict(status="infra_error", reward=0.0, reason=str(error))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def carried_over(submission: Tree, task: TaskConfig) -> Tree:
    """The submission's copies of the files `tests/initial` does not keep:
    protected files and decoys. The red-line scan has checked them against
    their hashes, so the reference build can reuse them as they are."""
    return {path: submission[path] for path in (*task.protected, *task.honeypots) if path in submission}


def grade(task: TaskConfig, verdict: Verdict, original: Tree, initial: Tree, submission: Tree,
          edit: int | None, work: Path) -> Verdict:
    original_dir = work / "original"
    submission_dir = work / "submission"
    write_tree(original, original_dir)
    write_tree(submission, submission_dir)
    keep = frozenset(task.keep_artifacts)
    options = dict(root=task.root, engine=task.engine, epoch=task.epoch,
                   timeout=task.build_timeout_sec, keep_artifacts=keep, scratch=work)
    reference = texbuild.build(original_dir, **options)
    if not reference.success:
        return Verdict(status="infra_error", reward=0.0,
                       reason="the original paper does not build here; the task or toolchain is broken",
                       details={"referenceLog": reference.log[-2000:]})
    built = texbuild.build(submission_dir, **options)
    verdict.details["buildSeconds"] = round(built.seconds, 3)
    verdict.gates["builds"] = built.success
    if not built.success:
        verdict.reason = "timed out building" if built.timed_out else "does not build"
        verdict.details["log"] = built.log[-3000:]
        return verdict

    late = [RedLine("outside_input", path, "TeX read a file from outside the project and TeX's own trees")
            for path in texbuild.outside_inputs(built.inputs, texbuild.system_trees())[:1]]
    late += kept_fault_names(task, submission, fault_names(task, original, initial))
    if late:
        verdict.gates["noRedLines"] = False
        verdict.red_lines.extend(line.to_dict() for line in late)
        verdict.reason = "crossed a red line once built: " + ", ".join(line.code for line in late)
        return verdict

    submitted_inventory = inventory(task, submission)
    identical = built.pdf == reference.pdf
    verdict.components["pdfIdentical"] = 1.0 if identical else 0.0
    reference_text = restoration.pdf_text(reference.pdf)
    submitted_text = reference_text if identical else restoration.pdf_text(built.pdf)
    # Reported, not gated: text alone cannot see a repair that reflows pages.
    verdict.components["pagesMatch"] = 1.0 if submitted_text.count("\f") == reference_text.count("\f") else 0.0
    problems = reference_problems(reference, built, submitted_inventory, submitted_text, reference_text)
    verdict.gates["referencesResolved"] = not problems
    verdict.details["referenceProblems"] = problems[:20]

    failed = [name for name, passed in verdict.gates.items() if not passed]
    if failed:
        verdict.reason = "failed gates: " + ", ".join(failed)
        return verdict

    if identical:
        verdict.components.update(restoration=1.0, editTerm=1.0, similarity=1.0)
        verdict.reward = 1.0
        verdict.reason = "reproduces the original PDF exactly"
        return verdict

    compared = restoration.compare(restoration.tokens(reference_text), restoration.tokens(submitted_text))
    restored = restoration.restoration_term(compared.token_diff, task.restoration_scale)
    term = edit_term(edit or 0, task.reference_edit_chars)
    verdict.components.update(restoration=round(restored, 6), editTerm=round(term, 6),
                              similarity=compared.similarity)
    verdict.details["tokenDiff"] = compared.token_diff
    verdict.reward = round(task.graded_cap * restored * term, 6)
    verdict.reason = "builds and keeps the paper, but its PDF differs from the original"
    return verdict
