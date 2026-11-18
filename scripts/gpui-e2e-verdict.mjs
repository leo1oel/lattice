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
 * `--check-quit` also checks what the scenario cannot check from inside:
 * once the app has quit, the file holds the text typed just before
 * (`after_quit`), as gpui/script/e2e and gpui.yml do. With
 * $GITHUB_STEP_SUMMARY set, the verdict is written there too.
 */
import { appendFileSync, readFileSync } from "node:fs";
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
  return { total: parsed.total, error: parsed.error ?? null, known, fresh, fixed, ok: !parsed.error && parsed.total > 0 && fresh.length === 0 };
}

function main() {
  const argv = process.argv.slice(2);
  const platform = argv.includes("--platform") ? argv[argv.indexOf("--platform") + 1] : null;
  const baselineFile = argv.includes("--baseline") ? argv[argv.indexOf("--baseline") + 1] : null;
  const file = argv.filter((arg, index) => !arg.startsWith("--") && !["--platform", "--baseline"].includes(argv[index - 1])).at(-1);
  if (!PLATFORMS.includes(platform) || !file) throw new Error("usage: gpui-e2e-verdict.mjs --platform macos|windows [--check-quit] [--baseline FILE] RESULT.json");
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
  const verdict = judge(result, entries, platform);
  const reasons = new Map(entries.map((entry) => [entry.step, entry]));
  const lines = [`${verdict.total} steps on ${platform}: ${verdict.fresh.length} new failure(s), ${verdict.known.length} known (scripts/gpui-e2e-known-failures.json), ${verdict.fixed.length} known that passed.`];
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
