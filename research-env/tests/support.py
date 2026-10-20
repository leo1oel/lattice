"""Shared helpers: a task package built from one hand-made fault."""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from lattice_env import seeds
from lattice_env.mutation import HARD, Mutation
from lattice_env.package import build_task
from lattice_env.verifier import texbuild
from lattice_env.verifier.taskconfig import TaskConfig
from lattice_env.verifier.verify import verify


def has_tex() -> bool:
    try:
        for tool in ("latexmk", "pdflatex", "pdftotext", "kpsewhich"):
            texbuild.find_tool(tool)
    except texbuild.ToolMissing:
        return False
    return True


requires_tex = unittest.skipUnless(has_tex(), "needs latexmk, pdfLaTeX and pdftotext")


def mutate(seed: seeds.Seed, old: str, new: str, *, family="build-repair", operator="TEST-OP",
           track=HARD, path=None) -> Mutation:
    path = path or seed.root
    original = seed.text(path)
    if original.count(old) != 1:
        raise AssertionError(f"{old!r} is not unique in {path}")
    at = original.index(old)
    return Mutation(family, operator, 1, "Test", track, path, original, original.replace(old, new, 1),
                    original.count("\n", 0, at) + 1, old, new, f"{old!r} became {new!r}")


class TaskCase(unittest.TestCase):
    """Builds one task package per test class and scores edits of its workspace."""

    seed_name = "tutorial"
    old = "\\citep{bahdanau2015neural}"
    new = "\\citpe{bahdanau2015neural}"
    family = "build-repair"
    track = HARD

    @classmethod
    def setUpClass(cls):
        cls.scratch = Path(tempfile.mkdtemp(prefix="lattice-env-test-"))
        cls.seed = next(s for s in seeds.bundled() if s.name == cls.seed_name)
        cls.mutation = mutate(cls.seed, cls.old, cls.new, family=cls.family, track=cls.track)
        cls.task_dir = cls.scratch / "task"
        foreign = next(s for s in seeds.bundled() if s.name != cls.seed_name)
        cls.task = build_task(cls.task_dir, cls.seed, cls.mutation, 1, foreign_root=foreign.text(foreign.root))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.scratch, ignore_errors=True)

    def score(self, edits: dict[str, str | None] | None = None):
        """Verify the workspace with `edits` applied: path to new text, or None to delete."""
        workspace = Path(tempfile.mkdtemp(dir=self.scratch)) / "workspace"
        shutil.copytree(self.task_dir / "environment" / "workspace", workspace)
        for path, body in (edits or {}).items():
            target = workspace / path
            if body is None:
                target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(body, "utf-8")
        return verify(TaskConfig.load(self.task_dir / "tests" / "task.json"), self.task_dir / "tests", workspace)

    def broken(self, path: str | None = None) -> str:
        return (self.task_dir / "environment" / "workspace" / (path or self.seed.root)).read_text("utf-8")
