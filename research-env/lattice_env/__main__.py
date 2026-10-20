"""`python3 -m lattice_env <command>`: the environment's host-side tools."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import seeds as seed_registry
from .families import FAMILIES


def cmd_generate(args: argparse.Namespace) -> int:
    from .generate import DEFAULT_SALT, generate

    chosen = seed_registry.load(args.seed or None, args.seeds_dir)
    manifest = generate(chosen, args.family or sorted(FAMILIES), args.out, args.per_operator,
                        args.salt or DEFAULT_SALT, args.jobs, not args.no_honeypots)
    admitted = sum(1 for task in manifest["tasks"] if task["admitted"])
    leaks = [task for task in manifest["tasks"] if task.get("reason") == "selftest"]
    print(json.dumps({"admitted": admitted, "candidates": len(manifest["tasks"]),
                      "selftestRejections": len(leaks), "skippedSeeds": manifest["skippedSeeds"],
                      "out": str(args.out)}, indent=2))
    for task in leaks:
        print(f"selftest rejected {task['seed']} {task['operator']}: {task['summary']}", file=sys.stderr)
        for failure in task["failures"]:
            print(f"  {failure['name']}: expected {failure['expect']}, got {failure['reward']} ({failure['reason']})",
                  file=sys.stderr)
    # --strict: any self-test rejection means a family's verifier lets a
    # cheat or probe through on these seeds, which CI should not accept.
    return 1 if args.strict and (leaks or manifest["skippedSeeds"]) else 0


def cmd_selftest(args: argparse.Namespace) -> int:
    from .verifier.selftest import main

    return main([str(path) for path in args.tasks])


def cmd_verify(args: argparse.Namespace) -> int:
    from .verifier.cli import main

    argv = ["--tests", str(args.task / "tests"), "--workspace", str(args.workspace)]
    if args.out:
        argv += ["--out", str(args.out)]
    return main(argv)


def cmd_calibrate(args: argparse.Namespace) -> int:
    from . import calibrate

    trials = calibrate.read_trials(args.runs)
    if args.expect_reward is not None:
        failures = calibrate.expectation_failures(trials, args.expect_reward)
        for failure in failures:
            print(failure, file=sys.stderr)
        print(f"{len(trials)} trials, {len(failures)} not scored {args.expect_reward}")
        return 1 if failures or not trials else 0
    result = calibrate.calibrate(trials, args.min_attempts, calibrate.manifest_index(args.tasks or []))
    if args.out:
        args.out.write_text(calibrate.to_json(result), "utf-8")
    print(calibrate.report(result), end="")
    return 0


def cmd_select(args: argparse.Namespace) -> int:
    import shutil

    from . import calibrate

    chosen = calibrate.select(json.loads(args.calibration.read_text("utf-8")), set(args.label))
    for task in chosen:
        print(task)
        if args.copy_to:
            shutil.copytree(args.tasks / task, args.copy_to / task, dirs_exist_ok=True)
    return 0


def cmd_split_check(args: argparse.Namespace) -> int:
    from .split import THRESHOLD, leaks

    public = seed_registry.load(None, args.public_seeds_dir)
    private = [seed for directory in args.private_seeds_dir for seed in seed_registry.from_directory(directory)]
    found = leaks(public, private, args.threshold or THRESHOLD)
    for leak in found:
        print(json.dumps(leak))
    print(f"{len(private)} private seeds against {len(public)} public: {len(found)} leaks", file=sys.stderr)
    return 1 if found or not private else 0


def cmd_seeds(args: argparse.Namespace) -> int:
    for seed in seed_registry.load(None, args.seeds_dir):
        print(json.dumps({"name": seed.name, "root": seed.root, "files": len(seed.files),
                          "redistributable": seed.redistributable,
                          "licences": sorted(set(seed.licences.values())), "source": seed.source}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lattice_env", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    generate = sub.add_parser("generate", help="generate and admit task packages")
    generate.add_argument("--out", type=Path, required=True)
    generate.add_argument("--family", action="append", choices=sorted(FAMILIES))
    generate.add_argument("--seed", action="append", help="limit to these seed names")
    generate.add_argument("--seeds-dir", type=Path, action="append", help="extra (private) seed folders")
    generate.add_argument("--per-operator", type=int, default=2)
    generate.add_argument("--salt", help="site-selection salt (a private split uses its own)")
    generate.add_argument("--jobs", type=int)
    generate.add_argument("--no-honeypots", action="store_true")
    generate.add_argument("--strict", action="store_true",
                          help="fail when a seed is unusable or any candidate fails its self-tests")
    generate.set_defaults(run=cmd_generate)

    selftest = sub.add_parser("selftest", help="run task packages' self-tests")
    selftest.add_argument("tasks", nargs="+", type=Path)
    selftest.set_defaults(run=cmd_selftest)

    verify = sub.add_parser("verify", help="score a workspace against a task package")
    verify.add_argument("task", type=Path)
    verify.add_argument("workspace", type=Path)
    verify.add_argument("--out", type=Path)
    verify.set_defaults(run=cmd_verify)

    calibrate = sub.add_parser("calibrate", help="label tasks TRIVIAL/KEEP/UNSOLVABLE from baseline runs")
    calibrate.add_argument("runs", nargs="+", type=Path, help="Harbor job folders or episode JSONL files")
    calibrate.add_argument("--tasks", type=Path, action="append", help="generated task folders (for their manifest)")
    calibrate.add_argument("--min-attempts", type=int, default=3)
    calibrate.add_argument("--out", type=Path, help="write calibration.json here")
    calibrate.add_argument("--expect-reward", type=float,
                           help="instead: fail unless every trial scored exactly this (oracle 1, nop 0)")
    calibrate.set_defaults(run=cmd_calibrate)

    select = sub.add_parser("select", help="list (or copy) the tasks with given calibration labels")
    select.add_argument("calibration", type=Path)
    select.add_argument("--label", action="append", default=None, choices=["TRIVIAL", "KEEP", "UNSOLVABLE", "UNDERSAMPLED"])
    select.add_argument("--tasks", type=Path, help="the generated task folder, for --copy-to")
    select.add_argument("--copy-to", type=Path)
    select.set_defaults(run=cmd_select)

    split = sub.add_parser("split-check", help="scan private (held-out) seeds for text shared with public ones")
    split.add_argument("--private-seeds-dir", type=Path, action="append", required=True)
    split.add_argument("--public-seeds-dir", type=Path, action="append", help="more public seeds besides the bundled")
    split.add_argument("--threshold", type=float)
    split.set_defaults(run=cmd_split_check)

    seeds = sub.add_parser("seeds", help="list the seed papers and their licences")
    seeds.add_argument("--seeds-dir", type=Path, action="append")
    seeds.set_defaults(run=cmd_seeds)

    args = parser.parse_args(argv)
    if args.command == "select":
        args.label = args.label or ["KEEP"]
        if args.copy_to and not args.tasks:
            parser.error("--copy-to needs --tasks")
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
