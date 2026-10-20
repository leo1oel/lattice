"""Difficulty calibration: label tasks by how a baseline agent does on them.

Run a baseline several times per task (`harbor run -k 4`), then

    python3 -m lattice_env calibrate jobs/<job> [jobs/<job> ...] --out calibration.json

Each task gets CoworkEnv's teacher-difficulty label from the mean reward of
its scored attempts: TRIVIAL (at least 0.999), UNSOLVABLE (at most 0.001),
or KEEP (everything between), which is where RL batches should come from;
fewer than `--min-attempts` scored attempts is UNDERSAMPLED. The report
also counts what makes a run useful for training beyond its mean:

- informative groups: a task's attempts that did not all get the same
  reward. A group with no variance gives a GRPO-style learner nothing to
  compare, even when its mean sits in the KEEP band;
- unscored trials: an environment that failed to build, a verifier that
  could not judge (`infra_error`, which writes no reward). They are counted
  apart and never averaged in as a 0;
- the hack rate: scored trials that crossed any red line, and the share
  that touched the workspace's decoy.

Trials come from Harbor job folders (each trial's `result.json` and the
verifier's `verdict.json` beside it) or from JSON-lines files of episode
records (`task`, `agent`, `model`, `reward` or null, `status`, optional
`redLines` and `honeypotsTouched`), which is what Lattice's in-binary
environment writes.
"""

from __future__ import annotations

import json
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

TRIVIAL, KEEP, UNSOLVABLE, UNDERSAMPLED = "TRIVIAL", "KEEP", "UNSOLVABLE", "UNDERSAMPLED"


@dataclass
class Trial:
    task: str
    agent: str
    model: str
    status: str
    reward: float | None
    red_lines: list[str] = field(default_factory=list)
    honeypot: bool = False
    exception: str | None = None


def task_id(name: str) -> str:
    """Harbor names tasks `lattice/<id>`; the id is the package folder name."""
    return name.split("/", 1)[1] if name.startswith("lattice/") else name


def read_harbor_trial(directory: Path) -> Trial | None:
    path = directory / "result.json"
    if not path.is_file():
        return None
    result = json.loads(path.read_text("utf-8"))
    if "task_name" not in result:
        return None
    agent = result.get("agent_info") or {}
    model = (agent.get("model_info") or {}).get("name") or ""
    exception = (result.get("exception_info") or {}).get("exception_type")
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    verdict_path = directory / "verifier" / "verdict.json"
    verdict = json.loads(verdict_path.read_text("utf-8")) if verdict_path.is_file() else {}
    # Harbor still verifies after an agent timeout or a non-zero agent exit,
    # so a reward with an exception beside it is the agent's own score.
    if "reward" in rewards:
        status, reward = "scored", float(rewards["reward"])
    else:
        status, reward = verdict.get("status") or "unscored", None
    return Trial(
        task=task_id(result["task_name"]),
        agent=agent.get("name") or "",
        model=model,
        status=status,
        reward=reward,
        red_lines=sorted({line["code"] for line in verdict.get("redLines", [])}),
        honeypot=bool(verdict.get("honeypotsTouched")),
        exception=exception,
    )


def read_trials(paths: list[Path]) -> list[Trial]:
    trials: list[Trial] = []
    for path in paths:
        if path.is_file():
            for line in path.read_text("utf-8").splitlines():
                if line.strip():
                    record = json.loads(line)
                    trials.append(Trial(
                        task=task_id(record["task"]), agent=record.get("agent", ""),
                        model=record.get("model", ""), status=record.get("status", "scored"),
                        reward=record.get("reward"), red_lines=sorted(record.get("redLines", [])),
                        honeypot=bool(record.get("honeypotsTouched"))))
            continue
        for result in sorted(path.rglob("result.json")):
            trial = read_harbor_trial(result.parent)
            if trial is not None:
                trials.append(trial)
    return trials


def label(rewards: list[float], min_attempts: int) -> str:
    if len(rewards) < min_attempts:
        return UNDERSAMPLED
    mean = statistics.fmean(rewards)
    if mean >= 0.999:
        return TRIVIAL
    if mean <= 0.001:
        return UNSOLVABLE
    return KEEP


def manifest_index(tasks_dirs: list[Path]) -> dict[str, dict]:
    """Task id to its manifest record (family, operator, tier, ...)."""
    index = {}
    for directory in tasks_dirs:
        manifest = directory / "manifest.json"
        if manifest.is_file():
            for record in json.loads(manifest.read_text("utf-8"))["tasks"]:
                if record.get("task"):
                    index[record["task"]] = record
    return index


def calibrate(trials: list[Trial], min_attempts: int = 3, tasks: dict[str, dict] | None = None) -> dict:
    tasks = tasks or {}
    by_task: dict[str, list[Trial]] = defaultdict(list)
    for trial in trials:
        by_task[trial.task].append(trial)
    labelled = {}
    groups: dict[tuple[str, str], list[float]] = defaultdict(list)
    for trial in trials:
        if trial.status == "scored":
            groups[(trial.task, f"{trial.agent}/{trial.model}")].append(trial.reward)
    for task, attempts in sorted(by_task.items()):
        scored = [t.reward for t in attempts if t.status == "scored"]
        record = tasks.get(task, {})
        labelled[task] = {
            "label": label(scored, min_attempts),
            "mean": round(statistics.fmean(scored), 6) if scored else None,
            "scored": len(scored),
            "unscored": len(attempts) - len(scored),
            "rewards": scored,
            "family": record.get("family") or task.split("__")[0],
            "operator": record.get("operator") or (task.split("__")[2].upper() if task.count("__") >= 3 else ""),
            "tier": record.get("tier"),
        }
    return {"minAttempts": min_attempts, "tasks": labelled, "summary": summarize(trials, labelled, groups)}


def summarize(trials: list[Trial], labelled: dict[str, dict], groups: dict) -> dict:
    scored = [t for t in trials if t.status == "scored"]
    unscored = [t for t in trials if t.status != "scored"]
    multi = [rewards for rewards in groups.values() if len(rewards) >= 2]
    informative = [rewards for rewards in multi if len(set(rewards)) > 1]
    red_lines: dict[str, int] = defaultdict(int)
    for trial in scored:
        for code in trial.red_lines:
            red_lines[code] += 1
    by_family: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for record in labelled.values():
        by_family[record["family"]][record["label"]] += 1
    agents = sorted({f"{t.agent}/{t.model}" for t in trials})
    return {
        "agents": agents,
        "trials": len(trials),
        "scored": len(scored),
        "unscored": len(unscored),
        "unscoredReasons": dict(sorted(_count(t.exception or t.status for t in unscored).items())),
        "meanReward": round(statistics.fmean(t.reward for t in scored), 6) if scored else None,
        "solvedRate": round(sum(t.reward >= 0.5 for t in scored) / len(scored), 6) if scored else None,
        "groups": len(multi),
        "informativeGroups": len(informative),
        "informativeShare": round(len(informative) / len(multi), 6) if multi else None,
        "hackRate": round(sum(bool(t.red_lines) for t in scored) / len(scored), 6) if scored else None,
        "honeypotRate": round(sum(t.honeypot for t in scored) / len(scored), 6) if scored else None,
        "redLines": dict(sorted(red_lines.items())),
        "labels": {family: dict(sorted(counts.items())) for family, counts in sorted(by_family.items())},
    }


def _count(values) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for value in values:
        counts[value] += 1
    return counts


def report(calibration: dict) -> str:
    """A Markdown summary: one table of labels per family, then the rates."""
    summary = calibration["summary"]
    lines = [f"Agents: {', '.join(summary['agents']) or 'none'}  ",
             f"Trials: {summary['trials']} ({summary['scored']} scored, {summary['unscored']} unscored)", "",
             "| Family | TRIVIAL | KEEP | UNSOLVABLE | UNDERSAMPLED |", "| --- | --- | --- | --- | --- |"]
    for family, counts in summary["labels"].items():
        lines.append(f"| {family} | " + " | ".join(str(counts.get(k, 0)) for k in (TRIVIAL, KEEP, UNSOLVABLE, UNDERSAMPLED)) + " |")
    lines += ["", f"- mean reward {summary['meanReward']}, solved (≥ 0.5) {summary['solvedRate']}",
              f"- informative groups {summary['informativeGroups']} of {summary['groups']} ({summary['informativeShare']})",
              f"- hack rate {summary['hackRate']}, decoy touched {summary['honeypotRate']}, red lines {summary['redLines']}",
              f"- unscored {summary['unscoredReasons']}"]
    return "\n".join(lines) + "\n"


def select(calibration: dict, labels: set[str]) -> list[str]:
    return [task for task, record in sorted(calibration["tasks"].items()) if record["label"] in labels]


def expectation_failures(trials: list[Trial], reward: float) -> list[str]:
    """Why `trials` are not all scored at exactly `reward` (for CI's oracle and nop runs)."""
    failures = []
    for trial in trials:
        if trial.status != "scored":
            failures.append(f"{trial.task}: unscored ({trial.exception or trial.status})")
        elif trial.reward != reward:
            failures.append(f"{trial.task}: reward {trial.reward}, expected {reward}")
    return failures


def to_json(calibration: dict) -> str:
    return json.dumps(calibration, indent=2, sort_keys=True) + "\n"

