# Agent validation

How a coding agent proves a change, recovers from a red check, resumes an
interrupted session, reads evidence, and reviews. Reached from `CLAUDE.md`.

## Prove the change

An ordinary fix ships as a pull request, and pull requests do not run GitHub
Actions: `ci.yml` and `gpui.yml` run for a release tag, weekly on main, and by
hand (`gh workflow run ci.yml --ref <branch>`). A pull request has no required
check, local or remote. Run only what directly proves your change:

- the test file you added or changed: `pnpm vitest run <file>`;
- a new lint rule against a fixture that should trip it;
- a new or changed script, invoked once on a real input;
- for UI work, the mock-backend page in [`driving-the-app.md`](driving-the-app.md).

Before pushing any change to `src/`, run `pnpm gate:changed` once (2–5 min;
the App suites run for any change reachable from `App.tsx`): lint, knip,
typecheck, the i18n catalogs, and, when their inputs changed, `perf:evidence`,
`notices:check` and `cargo fmt --check`; then the tests `vitest related` finds
from your changed files, and `pnpm test:invariants`, the tests that read
stylesheets and fixtures, or run scripts, no import leads to. Do not assemble
your own list of test files. The no-mistakes pipeline's test step runs this
same gate (`.no-mistakes.yaml`).

`pnpm signoff` (or `mise run signoff`) is optional and slower; nothing
requires or waits for it before merge. Reach for it when a change goes past
what the gate covers. It runs the same stages
plus, each only when your branch changed its inputs: the production bundle's
WebKit check and startup budgets (the eager-JS budget among them), the bench
harness, the Synara pin check, clippy and `cargo test` for the changed Tauri
crates, and for `gpui/` (or `lattice-core`, the design-system exports it
reads, and the `src/` modules its webview islands are built from, listed in
`GPUI_INPUTS` in `scripts/signoff.mjs`) rustfmt, the release build, the unit tests and the `e2e` scenario on a
scratch fixture with a scratch `HOME` (`gpui/script/e2e`). Expect about 5–10
minutes without GPUI; a GPUI release build adds its own, and only one runs on
the machine at a time. When every stage passes and the tree is clean, it
records a green `signoff` commit status on that exact commit (informational)
through
[gh-signoff](https://github.com/basecamp/gh-signoff)
(`gh extension install basecamp/gh-signoff`; without it, the same status
through `gh api`). `--no-status` runs the
checks without recording anything, and `--gpui` forces the GPUI stages.

The no-launch rule is about the installed or release Lattice app and the
Tauri host: never run those. The locally built GPUI binary
(`gpui/target/release/lattice-gpui`) and its offscreen `e2e` scenario may run,
on a scratch copy of `gpui/fixtures/e2e` with a scratch `HOME`, which is what
`pnpm signoff` does.

Build that binary with `node scripts/gpui-build.mjs` from the repository root,
not with `cargo build` in your worktree.
It mirrors your checkout, uncommitted edits included, into one build tree the
machine shares, builds the release binary with `offscreen-shots` there under the
machine-wide GPUI lock, and copies it back to `gpui/target/release/lattice-gpui`
for `gpui/script/e2e`.
Every checkout builds from the same paths there, so Cargo rebuilds only what
changed since the last build, whichever worktree ran it: about 10 s for a change
to `lattice-gpui` from a brand-new worktree, and about 2 minutes for one to the
vendored `gpui` crate everything builds on.
In a new worktree, a plain `cargo build` starts cold (about 5.5 minutes on an
idle machine, much longer while other builds run), because sccache keys Rust
compiles on the checkout's absolute paths.
Run it in the foreground and wait for it; if a command timeout stops it, run it
again, since the shared tree keeps what was already built.
A worktree that builds GPUI only this way needs nothing else in its own
`gpui/target`: a target left by an earlier plain `cargo build` (10–17 GB) can go
with `rm -rf gpui/target`, and the next `node scripts/gpui-build.mjs` puts the
binary back.
Arguments after `--` run another cargo command there instead, for example
`node scripts/gpui-build.mjs -- test --release --locked --workspace --features lattice-gpui/offscreen-shots`.
A `--manifest-path` runs it on the Tauri crates in the same shared tree, for example
`node scripts/gpui-build.mjs -- clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`.
In a no-mistakes run worktree, send every cargo command that compiles (check, clippy, test, build) through it: a plain one there leaves a cold 8–10 GB `gpui/target` or 2–3 GB `src-tauri/target` in every run.
The run worktree enforces this: the pipeline's prepare command (`node scripts/run-worktree-cargo-guard.mjs install`) writes a git-ignored `.cargo/config.toml` whose rustc wrapper makes a compiling cargo command fail within a second, before `target/` grows, and print the same command through `scripts/gpui-build.mjs` to run instead.
`cargo fmt` and `cargo metadata` still run, `LATTICE_ALLOW_LOCAL_CARGO=1` lifts the guard for one command, and deleting the file lifts it for good.
Lane worktrees, the primary checkout, the shared build tree and CI never run that prepare command, so plain cargo there is unchanged.
One `CARGO_TARGET_DIR` shared by every checkout is not the fix: Cargo judges freshness by mtime and names path crates relative to the workspace root, so a worktree checked out before another's build silently reuses that build's artifacts and tests the other worktree's code.

A `cargo test` through `scripts/gpui-build.mjs` fails as soon as one test runs past a per-test limit (300 s, or `LATTICE_GPUI_TEST_TIMEOUT_SECONDS`), naming the test, instead of holding the build lock while it loops; the limit counts from libtest's "has been running for over 60 seconds" line, so it is never under a minute.
The build lock (`scripts/lib/gpui-lock.mjs`) prints a timestamped line on acquire and release, and a waiter prints its waiting line every minute with the holder and how long it has held.
A waiter takes it over from a holder that died, or that has held it past 30 minutes (`LATTICE_GPUI_BUILD_LOCK_MAX_MINUTES`); a holder that was taken over leaves its successor's lock alone when it exits.

### A review round's GPUI e2e, and the main baseline

A review round does not run the whole GPUI `e2e` scenario.
`node scripts/gpui-e2e-light.mjs` builds the binary, then runs `gpui/script/e2e --only <modules>`: the scenario's smoke flow (open, build, SyncTeX both ways, edits and ⌘S, autosave and outside edits, a second window, the quit that saves), plus only the modules the branch's paths touch (`scripts/gpui-e2e-modules.mjs` holds the path map; the modules and what each needs are `MODULES` in `gpui/crates/lattice-gpui/src/scenario/e2e/steps.rs`).
When only quarantined steps fail (`scripts/gpui-e2e-quarantine.json`, the few that caused most red runs), it runs once more and keeps only the steps that failed both times.
It then sorts what still fails against the main baseline and exits 1 only for failures that are the branch's own.

The full scenario and the gate run once per merge to main instead:

```bash
node scripts/gpui-main-baseline.mjs --sha origin/main   # in a clean checkout set aside for it
```

It checks the commit out, runs `pnpm gate:changed --base <sha>`, the release build through `scripts/gpui-build.mjs` and the full `e2e` scenario, and writes `known-failures@<sha>.json` (failing gate stages and e2e steps, quarantined ones listed again), `e2e@<sha>.json`, `logs@<sha>/` and `latest.json` into `~/Library/Caches/lattice-gpui-build/main-baseline/` (under `$LATTICE_GPUI_BUILD_DIR` when that is set).
`latest.json` moves only to a commit that descends from the one it names.
A failure listed there for your merge base with `origin/main` is pre-existing on main: say so, naming the file, rather than re-running main to prove it.

The full local gate, `pnpm check` (stages and CI parity in
[`architecture.md` §6](architecture.md#6-the-gate)), belongs to an official
release; see [`release-process.md`](release-process.md). When you do run it and
it is green locally but red in CI, suspect its freshness cache first:
`mise run --force check` re-runs every stage.

## A failed check

A red CI check that your change cannot reach is probably a known flake: search
the pinned [Known flakes](https://github.com/leo1oel/lattice/issues/342) issue
for the test's name before you investigate it. When CI fails on `main`,
`flake-rerun.yml` re-runs the failed jobs once; on any branch, a re-run that
passes records what failed the attempt before. `synara-pin` is never recorded:
it checks the published Synara fork, so it rightly passes on a re-run once the
fork branch is pushed. `flake-hunt.yml` records what
fails in its nightly stress passes. The issue also holds the quarantine policy.
To see how flaky a test is, run its file many times under load with
`node scripts/burn-in.mjs --runs 20 --burn 4 <file> -- -t "<test name>"`; CI's
`new-tests` job runs a pull request's added and modified test files five times
the same way. Otherwise:

1. Read the failing CI job's log, or your local log file, from the **first**
   fatal error; a tail-only summary hides it. Keep long output in a file under
   `.tmp/<task>/` and print bounded excerpts (`grep -n -m 20`, `sed -n`).
2. Name the hypothesis that error supports and the evidence that would
   disconfirm it.
3. Re-run only the failing test or command until it passes, then push.

A local `pnpm perf:bench --check` red is not yet a finding: the ceilings were
set on CI runners, and a laptop running other lanes' builds can measure a count
above one on main itself. Run
`pnpm perf:bench --against origin/main --only <scenario>` for an A/B of the
same scenarios on both builds. A gated count that moves by a commit or two, or
not at all, is noise; one your change multiplies is yours. A CI layout or
scenario failure's screenshot is an artifact on the run's page.

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
