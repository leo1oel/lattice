"""Calibration over Harbor job folders, and the held-out leakage scan."""

import itertools
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from lattice_env import calibrate, seeds
from lattice_env.split import leaks


TRIAL_IDS = itertools.count()


def harbor_trial(job: Path, task: str, n: int, *, reward=None, exception=None, verdict=None,
                 agent="claude-code", model="anthropic/claude-x"):
    """A trial folder shaped like Harbor 0.24's TrialResult and verifier output.

    Harbor names it after the task's first 32 characters plus a short id,
    so trials of tasks that differ only later in their names sit side by side."""
    trial = job / f"{task[:32]}__{next(TRIAL_IDS):07d}"
    (trial / "verifier").mkdir(parents=True)
    result = {
        "task_name": f"lattice/{task}",
        "trial_name": trial.name,
        "agent_info": {"name": agent, "version": "1", "model_info": {"name": model, "provider": "x"}},
        "verifier_result": {"rewards": {"reward": reward, "pdfIdentical": float(reward == 1.0)}} if reward is not None else None,
        "exception_info": {"exception_type": exception, "exception_message": "", "exception_traceback": "",
                           "occurred_at": "2026-10-20T00:00:00Z"} if exception else None,
    }
    (trial / "result.json").write_text(json.dumps(result))
    if verdict is not None:
        (trial / "verifier" / "verdict.json").write_text(json.dumps(verdict))


class Calibration(unittest.TestCase):
    def setUp(self):
        self.job = Path(tempfile.mkdtemp(prefix="lattice-job-"))
        (self.job / "result.json").write_text(json.dumps({"id": "job", "stats": {}}))  # the job's own, ignored
        trivial, keep, flat, hard = (f"build-repair__tutorial__tex-brc-drp__00{i}" for i in range(1, 5))
        for n in range(3):
            harbor_trial(self.job, trivial, n, reward=1.0)
            harbor_trial(self.job, flat, n, reward=0.6)
            harbor_trial(self.job, hard, n, reward=0.0, verdict={"status": "scored", "redLines": [{"code": "silenced_warnings"}],
                                                               "honeypotsTouched": []})
        harbor_trial(self.job, keep, 0, reward=1.0)
        harbor_trial(self.job, keep, 1, reward=0.0, exception="AgentTimeoutError")
        harbor_trial(self.job, keep, 2, reward=0.0)
        # The verifier could not judge: no reward file, so Harbor raised.
        harbor_trial(self.job, keep, 3, exception="RewardFileNotFoundError", verdict={"status": "infra_error"})
        self.names = (trivial, keep, flat, hard)

    def tearDown(self):
        shutil.rmtree(self.job, ignore_errors=True)

    def test_labels_count_scored_attempts_only(self):
        result = calibrate.calibrate(calibrate.read_trials([self.job]))
        trivial, keep, flat, hard = (result["tasks"][name] for name in self.names)
        self.assertEqual(trivial["label"], "TRIVIAL")
        self.assertEqual((keep["label"], keep["scored"], keep["unscored"]), ("KEEP", 3, 1))
        self.assertEqual(flat["label"], "KEEP")
        self.assertEqual(hard["label"], "UNSOLVABLE")

    def test_summary_separates_informative_groups_unscored_trials_and_hacks(self):
        summary = calibrate.calibrate(calibrate.read_trials([self.job]))["summary"]
        # Four groups of attempts; only the mixed one tells a learner anything,
        # even though the flat 0.6 task is KEEP too.
        self.assertEqual((summary["groups"], summary["informativeGroups"]), (4, 1))
        self.assertEqual(summary["unscoredReasons"], {"RewardFileNotFoundError": 1})
        self.assertEqual(summary["redLines"], {"silenced_warnings": 3})
        self.assertAlmostEqual(summary["hackRate"], 3 / 12)
        self.assertIn("| build-repair | 1 | 2 | 1 | 0 |", calibrate.report({"summary": summary, "tasks": {}}))

    def test_selection_and_ci_expectations(self):
        result = calibrate.calibrate(calibrate.read_trials([self.job]))
        self.assertEqual(calibrate.select(result, {"KEEP"}), sorted(self.names[1:3]))
        trials = calibrate.read_trials([self.job])
        failures = calibrate.expectation_failures(trials, 1.0)
        self.assertTrue(any("unscored (RewardFileNotFoundError)" in failure for failure in failures))

    def test_episode_records_from_the_in_binary_environment(self):
        episodes = self.job / "episodes.jsonl"
        episodes.write_text("\n".join(json.dumps(r) for r in (
            {"task": "t1", "agent": "env", "model": "m", "reward": 0.5, "status": "scored"},
            {"task": "t1", "agent": "env", "model": "m", "reward": None, "status": "infra_error"},
        )) + "\n")
        result = calibrate.calibrate(calibrate.read_trials([episodes]), min_attempts=1)
        self.assertEqual(result["tasks"]["t1"]["label"], "KEEP")
        self.assertEqual(result["summary"]["unscoredReasons"], {"infra_error": 1})


class Leakage(unittest.TestCase):
    def test_a_private_copy_of_a_public_seed_is_flagged_and_distinct_seeds_are_not(self):
        public = seeds.bundled()
        plain = next(seed for seed in public if seed.name == "plain-notes")
        copy = seeds.Seed("held-out-copy", plain.root, dict(plain.files), dict(plain.licences), "test")
        found = leaks([seed for seed in public if seed.name != "plain-notes"], [plain])
        self.assertEqual(found, [], "authored seeds share no paper text")
        self.assertEqual([leak["public"] for leak in leaks(public, [copy])], ["plain-notes"])


if __name__ == "__main__":
    unittest.main()
