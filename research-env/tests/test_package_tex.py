"""A generated task package works on its own, as Harbor and Tinker run it."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

from support import TaskCase, requires_tex

from lattice_env import seeds
from lattice_env.families import build_repair
from lattice_env.generate import check_seed, generate
from lattice_env.mutation import mutations


@requires_tex
class Package(TaskCase):
    def test_has_harbors_layout_and_config(self):
        for path in ("task.toml", "instruction.md", "environment/Dockerfile", "solution/solve.sh",
                     "tests/test.sh", "tests/verify.py", "tests/task.json"):
            self.assertTrue((self.task_dir / path).is_file(), path)
        config = tomllib.loads((self.task_dir / "task.toml").read_text("utf-8"))
        self.assertEqual(config["task"]["name"], f"lattice/{self.task.id}")
        self.assertEqual(config["metadata"]["operator"], "TEST-OP")

    def test_tests_are_text_only_because_tinker_uploads_them_as_text(self):
        for path in (self.task_dir / "tests").rglob("*"):
            if path.is_file():
                path.read_text("utf-8")

    def test_the_instruction_does_not_give_the_answer_away(self):
        instruction = (self.task_dir / "instruction.md").read_text("utf-8")
        self.assertNotIn("citep", instruction)
        self.assertNotIn("bahdanau", instruction)

    def test_the_oracle_and_the_launcher_score_one_in_an_isolated_interpreter(self):
        workspace = Path(tempfile.mkdtemp(dir=self.scratch)) / "app"
        shutil.copytree(self.task_dir / "environment" / "workspace", workspace)
        env = {**os.environ, "LATTICE_WORKSPACE": str(workspace)}
        subprocess.run(["sh", str(self.task_dir / "solution" / "solve.sh")], check=True, env=env)
        out = workspace.parent / "logs"
        # The workspace is the agent's: a planted module there must not load.
        (workspace / "json.py").write_text("raise SystemExit('planted module imported')\n")
        result = subprocess.run(
            [sys.executable, "-I", str(self.task_dir / "tests" / "verify.py"), "--workspace", str(workspace),
             "--out", str(out)], cwd=workspace, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((out / "reward.json").read_text())["reward"], 1.0)
        self.assertEqual((out / "reward.txt").read_text().strip(), "1.0")

    def test_the_shipped_selftest_launcher_passes(self):
        result = subprocess.run([sys.executable, "-I", str(self.task_dir / "tests" / "selftest.py")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        names = {json.loads(line)["name"] for line in result.stdout.splitlines()}
        self.assertTrue({"reference-fix", "untouched", "delete-enclosing-section", "silence-warnings",
                         "project-latexmkrc", "alias-broken-name", "foreign-paper"} <= names, names)


@requires_tex
class Generation(unittest.TestCase):
    def test_every_bundled_seed_builds_cleanly_and_deterministically(self):
        for seed in seeds.bundled():
            with self.subTest(seed=seed.name):
                self.assertIsNone(check_seed(seed))

    def test_a_small_library_admits_its_tasks_and_keeps_rejections_explained(self):
        out = Path(tempfile.mkdtemp(prefix="lattice-env-generate-"))
        try:
            tutorial = [s for s in seeds.bundled() if s.name == "tutorial"]
            manifest = generate(tutorial, ["build-repair"], out, per_operator=1, jobs=4)
            admitted = [t for t in manifest["tasks"] if t["admitted"]]
            self.assertGreaterEqual(len(admitted), 12)
            self.assertFalse([t for t in manifest["tasks"] if t.get("reason") == "selftest"])
            for task in admitted:
                self.assertTrue((out / task["task"] / "tests" / "task.json").is_file())
        finally:
            shutil.rmtree(out, ignore_errors=True)


class Operators(unittest.TestCase):
    def test_operators_only_touch_live_latex(self):
        seed = seeds.tutorial()
        for operator in build_repair.OPERATORS:
            for mutation in mutations(operator, seed):
                self.assertTrue(mutation.path.endswith(".tex"), (operator.code, mutation.path))
                self.assertNotEqual(mutation.mutated, mutation.original, operator.code)

    def test_codes_are_unique(self):
        codes = [operator.code for operator in build_repair.OPERATORS]
        self.assertEqual(len(codes), len(set(codes)))


if __name__ == "__main__":
    unittest.main()
