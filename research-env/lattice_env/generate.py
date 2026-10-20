"""Generate a task library: seeds × operators → admitted task packages.

For each seed paper and operator, the operator's sites are shuffled with a
key derived from the generation salt, the seed's content and the operator
code, and the first `per_operator` sites whose mutant passes the guard
become tasks. The guard is the render-diff check: a hard fault must stop
the pinned build, a soft one must build yet fail the verifier's reference
gate. Duplicate mutants (same operator, same broken text) are dropped.

Every candidate is then packaged with its self-tests and admitted only if
all of them hold (the grading-consistency gate): the reference repair
scores 1, the untouched workspace 0, every applicable cheat 0 and every
probe stays unsolved. Rejections are kept in the manifest with their
reason, so a family whose verifier leaks shows up as a rejection rate
instead of disappearing.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .families import FAMILIES
from .mutation import HARD, Mutation, choose, mutations
from .package import build_task, task_name
from .seeds import Seed
from .verifier import texbuild
from .verifier.selftest import run_task

DEFAULT_SALT = "lattice-env-public-1"


@dataclass
class Candidate:
    seed: Seed
    mutation: Mutation
    index: int
    foreign_root: str | None


def seed_digest(seed: Seed) -> str:
    digest = hashlib.sha256()
    for path in sorted(seed.files):
        digest.update(path.encode() + b"\0" + hashlib.sha256(seed.files[path]).digest())
    return digest.hexdigest()


def materialize(files: dict[str, bytes], directory: Path) -> None:
    for path, data in files.items():
        target = directory / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def check_seed(seed: Seed) -> str | None:
    """Why `seed` cannot be used, or None when it builds cleanly twice alike."""
    with tempfile.TemporaryDirectory(prefix="lattice-seed-") as scratch:
        directory = Path(scratch) / "seed"
        materialize(seed.files, directory)
        first = texbuild.build(directory, seed.root, scratch=Path(scratch))
        if not first.success:
            return "does not build"
        undefined = [m for m in ("undefined", "multiply defined") if m in first.log]
        if undefined:
            return f"its log reports {', '.join(undefined)} references"
        second = texbuild.build(directory, seed.root, scratch=Path(scratch))
        if first.pdf != second.pdf:
            return "two builds of it differ: the PDF is not deterministic here"
    return None


# Each worker builds a seed's original once; guards compare mutants to it.
ORIGINAL_PDFS: dict[str, bytes | None] = {}


def built_pdf(files: dict[str, bytes], root: str) -> texbuild.BuildResult:
    with tempfile.TemporaryDirectory(prefix="lattice-guard-") as scratch:
        directory = Path(scratch) / "project"
        materialize(files, directory)
        return texbuild.build(directory, root, scratch=Path(scratch))


def guard(candidate: Candidate) -> bool:
    """Whether the mutant really breaks the paper (DocMut's render-diff gate):
    a hard fault must stop the build; a soft one must build into a PDF that
    differs from the original's, or there is nothing to repair."""
    seed, mutation = candidate.seed, candidate.mutation
    if mutation.mutated == mutation.original:
        return False
    files = dict(seed.files)
    files[mutation.path] = mutation.mutated.encode("utf-8")
    built = built_pdf(files, seed.root)
    if mutation.track == HARD:
        return not built.success and not built.timed_out
    if not built.success:
        return False
    key = seed_digest(seed)
    if key not in ORIGINAL_PDFS:
        ORIGINAL_PDFS[key] = built_pdf(seed.files, seed.root).pdf
    return built.pdf != ORIGINAL_PDFS[key]


def admit(candidate: Candidate, out_dir: Path, honeypots: bool) -> dict:
    record = {
        "seed": candidate.seed.name,
        "family": candidate.mutation.family,
        "operator": candidate.mutation.operator,
        "tier": candidate.mutation.tier,
        "category": candidate.mutation.category,
        "track": candidate.mutation.track,
        "summary": candidate.mutation.summary,
    }
    if not guard(candidate):
        return {**record, "admitted": False, "reason": "guard: the mutant does not break the paper"}
    name = task_name(candidate.mutation, candidate.seed, candidate.index)
    target = out_dir / name
    if target.exists():
        shutil.rmtree(target)
    build_task(target, candidate.seed, candidate.mutation, candidate.index,
               foreign_root=candidate.foreign_root, honeypots=honeypots)
    results = run_task(target)
    failures = [r.summary() for r in results if not r.passed]
    record.update(task=name, selftests=len(results))
    if failures and all(ambiguous(failure) for failure in failures):
        shutil.rmtree(target)
        return {**record, "admitted": False, "reason": "ambiguous: deleting the faulty line leaves the paper unchanged"}
    if failures:
        rejected = out_dir / "_rejected" / name
        rejected.parent.mkdir(parents=True, exist_ok=True)
        if rejected.exists():
            shutil.rmtree(rejected)
        shutil.move(str(target), rejected)
        return {**record, "admitted": False, "reason": "selftest", "failures": failures}
    return {**record, "admitted": True}


def ambiguous(failure: dict) -> bool:
    """A fault on a line the paper does not need (a skeleton's unused
    `\\bibliography`): deleting the line reproduces the PDF, so there is
    no wrong answer to tell from the right one. Not a verifier leak."""
    return failure["name"] == "delete-fault-line" and failure["reward"] == 1.0


def candidates(seeds: list[Seed], families: list[str], per_operator: int, salt: str) -> list[list[Candidate]]:
    """For each (seed, operator), its sites in the order they are tried."""
    groups = []
    for seed in seeds:
        foreign = next((s for s in seeds if s.name != seed.name), None)
        foreign_root = foreign.text(foreign.root) if foreign else None
        key = seed_digest(seed)
        for family in families:
            for operator in FAMILIES[family].OPERATORS:
                found = mutations(operator, seed)
                ordered = choose(found, len(found), f"{salt}:{key}:{operator.code}")
                groups.append([Candidate(seed, m, i, foreign_root) for i, m in enumerate(ordered)])
    return groups


def run_group(group: list[Candidate], per_operator: int, out_dir: Path, honeypots: bool) -> list[dict]:
    """Try a group's sites in order until `per_operator` tasks are admitted.

    Sites that fail the guard do not count; a cap on attempts keeps an
    operator whose sites never break this paper from building forever.
    """
    records, admitted = [], 0
    for attempt, candidate in enumerate(group):
        if admitted >= per_operator or attempt >= per_operator * 6:
            break
        candidate.index = admitted + 1
        record = admit(candidate, out_dir, honeypots)
        records.append(record)
        admitted += record["admitted"]
    return records


def generate(seeds: list[Seed], families: list[str], out_dir: Path, per_operator: int = 2,
             salt: str = DEFAULT_SALT, jobs: int | None = None, honeypots: bool = True) -> dict:
    """Generate, guard and admit tasks into `out_dir`, and write its manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    usable, skipped = [], {}
    for seed in seeds:
        reason = check_seed(seed)
        if reason:
            skipped[seed.name] = reason
        else:
            usable.append(seed)
    groups = candidates(usable, families, per_operator, salt)
    jobs = jobs or max(1, (os.cpu_count() or 2) // 2)
    records: list[dict] = []
    with ProcessPoolExecutor(max_workers=jobs) as pool:
        for result in pool.map(run_group, groups, [per_operator] * len(groups),
                               [out_dir] * len(groups), [honeypots] * len(groups)):
            records.extend(result)
    manifest = {
        "generator": {"name": "lattice-env", "version": __version__, "salt": salt},
        "texVersion": texbuild.tex_version(),
        "seeds": {seed.name: {"digest": seed_digest(seed), "licences": sorted(set(seed.licences.values())),
                              "redistributable": seed.redistributable, "source": seed.source}
                  for seed in usable},
        "skippedSeeds": skipped,
        "tasks": sorted(records, key=lambda r: (r.get("task") or "", r["operator"])),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", "utf-8")
    return manifest

