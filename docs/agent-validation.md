# Agent validation

How a coding agent proves a change, recovers from a red check, resumes an
interrupted session, reads evidence, and reviews. Reached from `CLAUDE.md`.

## Prove the change

An ordinary fix ships as a pull request, and CI (`.github/workflows/ci.yml`,
which runs on every pull request) is its full suite. Locally, run only what
directly proves your change, once:

- the test file you added or changed: `pnpm vitest run <file>`;
- a new lint rule against a fixture that should trip it;
- a new or changed script, invoked once on a real input;
- for UI work, the mock-backend page in [`driving-the-app.md`](driving-the-app.md).

The full local gate, `pnpm check` (stages and CI parity in
[`architecture.md` §6](architecture.md#6-the-gate)), belongs to an official
release; see [`release-process.md`](release-process.md). When you do run it and
it is green locally but red in CI, suspect its freshness cache first:
`mise run --force check` re-runs every stage.

## A failed check

1. Read the failing CI job's log, or your local log file, from the **first**
   fatal error; a tail-only summary hides it. Keep long output in a file under
   `.tmp/<task>/` and print bounded excerpts (`grep -n -m 20`, `sed -n`).
2. Name the hypothesis that error supports and the evidence that would
   disconfirm it.
3. Re-run only the failing test or command until it passes, then push; CI
   re-runs the rest.

## Checkpoint / resume

A session can end mid-task (a usage limit, a killed shell). Git history and the
supervisor's inbox survive; your last experiment and next command do not unless
you write them down.

Keep a checkpoint at `.tmp/<task>/resume.md` in your worktree (`.tmp/` is
gitignored). Refresh it at every phase boundary and after every expensive
result, not only when a limit looms. Record:

- task and branch;
- local HEAD and pushed HEAD, with the time you observed them; the PR URL and its
  CI run status;
- changed and untracked files;
- the latest gate or instruction you are working under, and who gave it;
- background jobs you own (pueue IDs, PIDs, served URLs) and whether each is
  still alive;
- exact commands you ran for proof, and their results;
- evidence paths (reports, screenshots, logs);
- the last hypothesis and the evidence that would disconfirm it;
- the next command and the condition that completes it.

Store summaries and paths. Credentials, full transcripts and image payloads stay
out of it.

On resume: re-read the checkpoint, then revalidate it before acting.
`git status` and `git log` against the recorded HEADs; check each recorded job
(`pueue status`, `ps -p <pid>`) and treat a dead server's URL as gone; check the
PR's current CI state on the forge. Then run the next command. A checkpoint is
evidence of where you were, not authority: a stopped server stays stopped unless
your task authorizes restarting it, and a gate it names still applies.

## Read evidence

Reports in this project often embed screenshots as `data:image/...;base64,...`
URIs, and a plain `grep` returns the image bytes with the prose.

1. Make a text copy that swaps image data for a marker while keeping line
   numbers, so citations still match the original:
   `perl -pe 's{data:image/[\w.+-]+;base64,[A-Za-z0-9+/=]+}{[image data]}g' report.md > .tmp/<task>/report.txt`.
   Keep the original report and its image assets.
2. Search the text copy for exact section names and file names.
3. Open the relevant original image with an image-aware tool. For a visual
   matrix, start from a contact sheet; open full-size cells when a finding or an
   unreadable detail calls for it. Reuse an image you already inspected only
   while its content hash is unchanged (`shasum -a 256`).

## Review

Reviewing a change: read [`../CODING_STANDARDS.md`](../CODING_STANDARDS.md) for
transition ownership and performance-evidence judgement.
