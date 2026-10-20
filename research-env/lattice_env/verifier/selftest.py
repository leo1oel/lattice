"""A task's own proof that its verifier works: `tests/selftests/*.json`.

Each case is a submission (the task's initial workspace with some files
replaced or removed) and the score it must get. Every task ships at least:
the reference repair (scores 1), the untouched workspace (0), and each known
cheat that applies to its fault (0). Probes such as fuzzed edits must stay
below the solved threshold. A task whose cases do not all hold is not
admitted to the library.

Run from a task package with `python3 -I tests/selftest.py`, or through
`python3 -m lattice_env selftest TASK...`.
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .taskconfig import TaskConfig
from .verify import Verdict, verify

# The reward below which an episode does not count as solved.
SOLVED_THRESHOLD = 0.5

EXPECTATIONS = {
    "one": lambda verdict: verdict.reward == 1.0,
    "zero": lambda verdict: verdict.reward == 0.0,
    "unsolved": lambda verdict: verdict.reward < SOLVED_THRESHOLD,
}


@dataclass
class CaseResult:
    name: str
    expect: str
    passed: bool
    verdict: Verdict

    def summary(self) -> dict:
        return {
            "name": self.name,
            "expect": self.expect,
            "passed": self.passed,
            "status": self.verdict.status,
            "reward": self.verdict.reward,
            "reason": self.verdict.reason,
        }


def apply_case(workspace: Path, case: dict) -> None:
    for path in case.get("delete", []):
        target = workspace / path
        if target.is_file():
            target.unlink()
    for path, body in case.get("files", {}).items():
        target = workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, "utf-8")
    for path, encoded in case.get("binary", {}).items():
        target = workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(encoded))


def run_case(task: TaskConfig, tests_dir: Path, workspace: Path, case: dict,
             scratch: Path | None = None) -> CaseResult:
    base = Path(tempfile.mkdtemp(prefix="lattice-selftest-", dir=scratch))
    try:
        target = base / "workspace"
        shutil.copytree(workspace, target, symlinks=True)
        apply_case(target, case)
        verdict = verify(task, tests_dir, target, scratch=base)
    finally:
        shutil.rmtree(base, ignore_errors=True)
    expect = case["expect"]
    passed = verdict.status == "scored" and EXPECTATIONS[expect](verdict)
    return CaseResult(case["name"], expect, passed, verdict)


def run_task(task_dir: Path, scratch: Path | None = None) -> list[CaseResult]:
    """Every self-test case of the task package at `task_dir`."""
    tests_dir = task_dir / "tests"
    task = TaskConfig.load(tests_dir / "task.json")
    workspace = task_dir / "environment" / "workspace"
    results = []
    for path in sorted((tests_dir / "selftests").glob("*.json")):
        case = json.loads(path.read_text("utf-8"))
        results.append(run_case(task, tests_dir, workspace, case, scratch))
    return results


def main(argv: list[str] | None = None, task_dir: Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog="selftest", description=__doc__.split("\n\n")[0])
    parser.add_argument("tasks", nargs="*", type=Path, help="task package folders")
    args = parser.parse_args(argv)
    tasks = args.tasks or ([task_dir] if task_dir else [])
    if not tasks:
        parser.error("name at least one task folder")
    failed = 0
    for directory in tasks:
        for result in run_task(directory):
            line = result.summary()
            line["task"] = directory.name
            print(json.dumps(line, sort_keys=True))
            failed += not result.passed
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
