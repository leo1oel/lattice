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

    seeds = sub.add_parser("seeds", help="list the seed papers and their licences")
    seeds.add_argument("--seeds-dir", type=Path, action="append")
    seeds.set_defaults(run=cmd_seeds)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
