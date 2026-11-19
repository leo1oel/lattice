#!/usr/bin/env node
/**
 * `node scripts/gpui-e2e-verdict.mjs --platform macos|windows RESULT.json`:
 * whether a GPUI e2e run failed anything that passes on main.
 *
 * `scripts/gpui-e2e-known-failures.json` lists the steps that fail on main
 * on the hosted runners, each with its platforms, the reason and the issue
 * that owns the fix. Main is red on them today, so a plain `.passed` check
 * failed every branch and every red needed a hand diff against main. This
 * fails only for:
 *
 *   - a step that failed and is not listed for this platform;
 *   - a run that did not finish (`error` in the result, or no result).
 *
 * The listed steps that failed are reported apart, and a listed step that
 * passed is reported as one to take off the list. Everything that passes on
 * main stays enforced: a step joins the list only with the main run that
 * shows it failing.
 *
 * `--baseline FILE` adds the e2e steps a local main baseline record fails
 * (scripts/gpui-main-baseline.mjs's known-failures@<sha>.json) to the known
 * ones, for a run on a developer's Mac rather than a hosted runner.
 *
 * `--rerun-app BIN --fixture DIR` reruns, once, the modules of the steps that
 * failed and are not listed (`--only`, in a fresh copy of the fixture), and a
 * step that passes the second time is reported as flaky rather than new. The
 * hosted Windows runner fails a different handful of steps on most runs; one
 * rerun tells those from a change that broke a step. A run that did not
 * finish is not rerun.
 *
 * `--check-quit` also checks what the scenario cannot check from inside:
 * once the app has quit, the file holds the text typed just before
 * (`after_quit`), as gpui/script/e2e and gpui.yml do. With
 * $GITHUB_STEP_SUMMARY set, the verdict is written there too.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseE2e } from "./gpui-main-baseline.mjs";
import { isMain } from "./lib/util.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORMS = ["macos", "windows"];

export function knownFailures(file = path.join(repo, "scripts", "gpui-e2e-known-failures.json")) {
  return JSON.parse(readFileSync(file, "utf8")).steps;
}

/** The run's failures split into new ones and known ones, and the known steps that passed. */
export function judge(result, entries, platform) {
  const parsed = parseE2e(result);
  const listed = new Set(entries.filter((entry) => entry.platforms.includes(platform)).map((entry) => entry.step));
  const ran = new Set((result?.steps ?? []).map((step) => step.step));
  const known = parsed.failing.filter((step) => listed.has(step));
  const fresh = parsed.failing.filter((step) => !listed.has(step));
  const fixed = [...listed].filter((step) => ran.has(step) && !parsed.failing.includes(step));
  return { total: parsed.total, error: parsed.error ?? null, known, fresh, fixed, flaky: [], ok: !parsed.error && parsed.total > 0 && fresh.length === 0 };
}

/** The modules to rerun for the new failures: `smoke` for a step outside any module. */
export function rerunModules(result, fresh) {
  const modules = new Set();
  for (const step of result?.steps ?? []) {
    if (fresh.includes(step.step) && step.passed !== true) modules.add(step.module ?? "smoke");
  }
  return [...modules];
}

/** The verdict once the rerun is in: a new failure that passed there is flaky. */
export function settle(verdict, rerun) {
  const passed = new Set((rerun?.steps ?? []).filter((step) => step.passed === true).map((step) => step.step));
  const flaky = verdict.fresh.filter((step) => passed.has(step));
  const fresh = verdict.fresh.filter((step) => !passed.has(step));
  return { ...verdict, fresh, flaky, ok: !verdict.error && verdict.total > 0 && fresh.length === 0 };
}

function rerun(app, fixture, modules) {
  const dir = mkdtempSync(path.join(tmpdir(), "gpui-e2e-rerun-"));
  const project = path.join(dir, "e2e-project");
  const out = path.join(dir, "rerun.json");
  cpSync(fixture, project, { recursive: true });
  console.log(`gpui-e2e-verdict: rerunning ${modules.join(", ")} once`);
  spawnSync(app, [project, "--scenario", "e2e", "--only", modules.join(","), "--out", out], { stdio: "inherit", timeout: 15 * 60_000 });
  try {
    return JSON.parse(readFileSync(out, "utf8"));
  } catch {
    console.log("gpui-e2e-verdict: the rerun wrote no result");
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const platform = argv.includes("--platform") ? argv[argv.indexOf("--platform") + 1] : null;
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const baselineFile = value("--baseline");
  const app = value("--rerun-app");
  const fixture = value("--fixture");
  const file = argv.filter((arg, index) => !arg.startsWith("--") && !["--platform", "--baseline", "--rerun-app", "--fixture"].includes(argv[index - 1])).at(-1);
  if (Boolean(app) !== Boolean(fixture)) throw new Error("--rerun-app and --fixture go together");
  if (!PLATFORMS.includes(platform) || !file) throw new Error("usage: gpui-e2e-verdict.mjs --platform macos|windows [--check-quit] [--baseline FILE] [--rerun-app BIN --fixture DIR] RESULT.json");
  let result = null;
  try {
    result = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // judge() reports the missing result.
  }
  const entries = knownFailures();
  if (baselineFile) {
    const record = JSON.parse(readFileSync(baselineFile, "utf8"));
    for (const step of record.e2e?.failing ?? []) {
      entries.push({ step, platforms: [platform], reason: "fails in this machine's main baseline", followup: path.basename(baselineFile) });
    }
  }
  let verdict = judge(result, entries, platform);
  if (app && verdict.fresh.length && !verdict.error) verdict = settle(verdict, rerun(app, fixture, rerunModules(result, verdict.fresh)));
  const reasons = new Map(entries.map((entry) => [entry.step, entry]));
  const lines = [`${verdict.total} steps on ${platform}: ${verdict.fresh.length} new failure(s), ${verdict.flaky.length} flaky (passed on a rerun), ${verdict.known.length} known (scripts/gpui-e2e-known-failures.json), ${verdict.fixed.length} known that passed.`];
  if (verdict.error || !result) lines.push(`The scenario did not finish: ${verdict.error ?? "no result was written"}`);
  if (argv.includes("--check-quit")) {
    const quit = result?.after_quit;
    let saved = false;
    try {
      saved = Boolean(quit?.file) && readFileSync(quit.file, "utf8").includes(quit.text);
    } catch {
      // Not saved.
    }
    if (!saved) {
      verdict.ok = false;
      lines.push(`Quitting did not save ${quit?.file ?? "the document"}.`);
    }
  }
  console.log(lines.join("\n"));
  for (const step of verdict.fresh) console.log(`::error title=New e2e failure (${platform})::${step}`);
  for (const step of verdict.flaky) console.log(`::warning title=Flaky e2e step (${platform})::${step} (failed, then passed when its module ran again)`);
  if (verdict.known.length) {
    console.log("::group::Known failures on main (not counted)");
    for (const step of verdict.known) console.log(`${step}  [${reasons.get(step).followup}: ${reasons.get(step).reason}]`);
    console.log("::endgroup::");
  }
  for (const step of verdict.fixed) console.log(`::notice title=Known e2e failure passed (${platform})::${step} (take it off scripts/gpui-e2e-known-failures.json once it passes on main)`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const list = (title, steps, note = () => "") => (steps.length ? [`### ${title} (${steps.length})`, "", ...steps.map((step) => `- ${step}${note(step)}`), ""] : []);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## GPUI e2e on ${platform}: ${verdict.ok ? "passed" : "FAILED"}`,
        "",
        ...lines,
        "",
        ...list("New failures", verdict.fresh),
        ...list("Flaky: failed, then passed on a rerun of its module", verdict.flaky),
        ...list("Known failures on main, not counted", verdict.known, (step) => ` — ${reasons.get(step).followup}`),
        ...list("Known failures that passed this run", verdict.fixed),
      ].join("\n") + "\n",
    );
  }
  process.exitCode = verdict.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`gpui-e2e-verdict: ${error.message}`);
    process.exit(1);
  }
}
