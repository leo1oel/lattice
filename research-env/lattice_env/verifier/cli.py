"""`verify`: score a workspace against a task and write the reward files.

Run as `python3 -I tests/verify.py --workspace DIR --out DIR` from a task
package (Harbor's `tests/test.sh` does exactly that), or through
`python3 -m lattice_env verify`. `-I` matters: the workspace is the agent's,
and an isolated interpreter will not import a planted module from it.

Writes `reward.txt` (the one number every trainer reads), `reward.json`
(the same number under `reward`, with the named components beside it;
Harbor prefers this file) and `verdict.json` (everything, for analysis),
and prints the verdict. When the verifier cannot judge (`infra_error`) it
writes only `verdict.json` and exits 1, so Harbor records the trial as an
error rather than averaging in a 0 the agent did not earn.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .taskconfig import TaskConfig
from .verify import Verdict, verify


def write_reward(verdict: Verdict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "verdict.json").write_text(json.dumps(verdict.to_dict(), indent=2, sort_keys=True) + "\n", "utf-8")
    if verdict.status != "scored":
        return
    (out / "reward.txt").write_text(f"{verdict.reward}\n", "utf-8")
    flat = {"reward": verdict.reward, **verdict.components}
    (out / "reward.json").write_text(json.dumps(flat, sort_keys=True) + "\n", "utf-8")


def main(argv: list[str] | None = None, tests_dir: Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog="verify", description=__doc__.split("\n\n")[0])
    parser.add_argument("--tests", type=Path, default=tests_dir, help="the task's tests/ folder")
    parser.add_argument("--workspace", type=Path, required=True, help="the project to score")
    parser.add_argument("--out", type=Path, help="where to write reward.txt and reward.json")
    args = parser.parse_args(argv)
    if args.tests is None:
        parser.error("--tests is required")
    task = TaskConfig.load(args.tests / "task.json")
    try:
        verdict = verify(task, args.tests, args.workspace)
    except Exception as error:  # noqa: BLE001 - any crash is the verifier's, not the agent's
        verdict = Verdict(status="infra_error", reward=0.0, reason=f"verifier crashed: {error!r}")
    if args.out:
        write_reward(verdict, args.out)
    json.dump(verdict.to_dict(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if verdict.status == "scored" else 1


if __name__ == "__main__":
    sys.exit(main())
