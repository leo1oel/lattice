#!/usr/bin/env node
/**
 * `node scripts/gpui-main-baseline-agent.mjs install`: keeps the main
 * baseline (`scripts/gpui-main-baseline.mjs`) current by itself, as a launchd
 * agent of the user who installs it. Nothing installs it but this command;
 * the app never does.
 *
 * Lanes sort their light e2e failures against `latest.json`, and a baseline
 * that nobody re-ran sat 44 commits behind main, so every lane parked on
 * failures it could not show were main's. The agent's `tick` runs every
 * `--every` minutes (15 by default) and records `origin/main` only when all
 * of these hold:
 *
 *   - origin/main has moved past the commit `latest.json` names, and the
 *     agent has not already tried that commit (a run that died is not
 *     retried until main moves again);
 *   - its last run started `--min-hours` ago or longer (2 by default), so a
 *     burst of merges is one baseline, of the newest of them;
 *   - nothing holds the machine-wide GPUI build lock
 *     (`scripts/lib/gpui-lock.mjs`): a lane building or testing has the
 *     machine, and the next tick tries again;
 *   - no other tick is running one (`agent.lock` in the baseline directory).
 *
 * It runs in a checkout of its own, which `install` clones beside the
 * baseline directory (`main-checkout`, or `--checkout DIR`), since the
 * baseline refuses a checkout with edits and moves HEAD to the commit it
 * records. launchd runs the tick from that checkout's copy of this file, so
 * the agent follows main's version of it; `install` therefore needs this
 * file on origin/main.
 *
 * Commands:
 *   install [--checkout DIR] [--every MIN] [--min-hours H]
 *             clone the checkout if it is missing, write
 *             ~/Library/LaunchAgents/<label>.plist and load it; PATH and
 *             LATTICE_GPUI_BUILD_DIR are taken from the installing shell,
 *             since launchd's own PATH has neither pnpm nor cargo nor TeX
 *   uninstall unload the agent and remove its plist (the checkout and the
 *             records stay)
 *   status    the agent's state, origin/main and latest.json's commit
 *   tick      what launchd runs; `--force` skips the interval and the
 *             "already tried" check (not the build lock)
 *
 * Its output goes to `agent.log` in the baseline directory, and its state
 * (the last commit tried, when, and how it ended) to `agent-state.json`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { baselineDir } from "./gpui-main-baseline.mjs";
import { GPUI_BUILD_LOCK_DIR } from "./lib/gpui-lock.mjs";

export const LABEL = "dev.lattice.gpui-main-baseline";
const HOUR = 3_600_000;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

/** The checkout the agent records main in, unless `--checkout` names one. */
export function defaultCheckout(env = process.env) {
  return path.join(path.dirname(baselineDir(env)), "main-checkout");
}

/**
 * Whether a tick records `originSha` now, and why (or why not). `lockHolder`
 * is the build lock's owner line while a live process holds it.
 */
export function decide({ originSha, latestSha, state, now, minIntervalMs, lockHolder, force = false }) {
  if (!originSha) return { run: false, reason: "origin/main could not be read" };
  if (originSha === latestSha) return { run: false, reason: `latest.json is already at ${originSha.slice(0, 9)}` };
  if (!force && state?.sha === originSha) return { run: false, reason: `${originSha.slice(0, 9)} was already tried (${state.outcome ?? "started"} at ${state.started}); waiting for main to move` };
  const since = state?.started ? now - Date.parse(state.started) : Infinity;
  if (!force && since < minIntervalMs) {
    const minutes = Math.ceil((minIntervalMs - since) / 60_000);
    return { run: false, reason: `the last run started ${Math.floor(since / 60_000)} min ago; the next may start in ${minutes} min` };
  }
  if (lockHolder) return { run: false, reason: `the GPUI build lock is held by ${lockHolder}` };
  return { run: true, reason: `origin/main ${originSha.slice(0, 9)} is past latest.json's ${latestSha ? latestSha.slice(0, 9) : "(none)"}` };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The owner line of a lock directory a live process holds, else null. */
export function lockHolder(dir) {
  if (!existsSync(dir)) return null;
  let line;
  try {
    line = readFileSync(path.join(dir, "owner"), "utf8").trim();
  } catch {
    // Created but not yet written: a holder starting up, unless it has
    // been so for a minute (it died between the two).
    try {
      return Date.now() - statSync(dir).mtimeMs < 60_000 ? "a process starting up" : null;
    } catch {
      return null;
    }
  }
  const pid = Number(line.split(" ")[0]);
  return pid && alive(pid) ? line : null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function parseArgs(argv) {
  const options = { command: argv[0], checkout: defaultCheckout(), every: 15, minHours: Number(process.env.LATTICE_BASELINE_MIN_HOURS) || 2, force: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--checkout") options.checkout = path.resolve(argv[++index]);
    else if (arg === "--every") options.every = Number(argv[++index]);
    else if (arg === "--min-hours") options.minHours = Number(argv[++index]);
    else if (arg === "--force") options.force = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!(options.every > 0) || !(options.minHours >= 0)) throw new Error("--every and --min-hours take positive numbers");
  return options;
}

const stamp = () => new Date().toISOString();
const say = (line) => console.log(`${stamp()} gpui-main-baseline-agent: ${line}`);

function originMain(checkout) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: checkout, stdio: ["ignore", "ignore", "inherit"] });
    return execFileSync("git", ["rev-parse", "origin/main"], { cwd: checkout, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function tick(options) {
  const out = baselineDir();
  mkdirSync(out, { recursive: true });
  const checkout = options.checkout;
  if (!existsSync(path.join(checkout, ".git"))) throw new Error(`no checkout at ${checkout}; run install first`);
  // One tick at a time records: launchd never overlaps its own runs, but a
  // tick run by hand could.
  const tickLock = path.join(out, "agent.lock");
  const holder = lockHolder(tickLock);
  if (holder) return say(`another tick is recording (${holder})`);
  rmSync(tickLock, { recursive: true, force: true });
  try {
    mkdirSync(tickLock);
  } catch {
    return say("another tick took the agent lock first");
  }
  writeFileSync(path.join(tickLock, "owner"), `${process.pid} tick\n`);
  process.on("exit", () => rmSync(tickLock, { recursive: true, force: true }));

  const stateFile = path.join(out, "agent-state.json");
  const state = readJson(stateFile);
  const originSha = originMain(checkout);
  const verdict = decide({
    originSha,
    latestSha: readJson(path.join(out, "latest.json"))?.sha ?? null,
    state,
    now: Date.now(),
    minIntervalMs: options.minHours * HOUR,
    lockHolder: lockHolder(GPUI_BUILD_LOCK_DIR),
    force: options.force,
  });
  if (!verdict.run) return say(`skipped: ${verdict.reason}`);
  say(`recording: ${verdict.reason}`);
  const started = stamp();
  writeJson(stateFile, { sha: originSha, started, outcome: "running", pid: process.pid });
  const result = spawnSync(process.execPath, [path.join(checkout, "scripts", "gpui-main-baseline.mjs"), "--sha", originSha], { cwd: checkout, stdio: "inherit" });
  const outcome = result.status === 0 ? "recorded" : `exited ${result.status ?? result.signal}`;
  writeJson(stateFile, { sha: originSha, started, finished: stamp(), outcome });
  say(`${originSha.slice(0, 9)} ${outcome}`);
}

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The launchd property list that runs `tick` from `checkout` every `every` minutes. */
export function plist({ node, checkout, every, minHours, log, env }) {
  const environment = Object.entries(env)
    .filter(([, value]) => value)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(path.join(checkout, "scripts", "gpui-main-baseline-agent.mjs"))}</string>
    <string>tick</string>
    <string>--checkout</string>
    <string>${xml(checkout)}</string>
    <string>--min-hours</string>
    <string>${minHours}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(checkout)}</string>
  <key>StartInterval</key>
  <integer>${Math.round(every * 60)}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function install(options) {
  if (process.platform !== "darwin") throw new Error("the agent is a launchd agent; elsewhere, run `tick` from cron");
  const checkout = options.checkout;
  if (!existsSync(path.join(checkout, ".git"))) {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim();
    const objects = path.resolve(repo, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim());
    say(`cloning ${origin} into ${checkout}`);
    mkdirSync(path.dirname(checkout), { recursive: true });
    // Borrowing this repository's objects, then copying them, so the clone
    // needs little from the network and does not depend on this checkout.
    execFileSync("git", ["clone", "--quiet", "--reference-if-able", objects, "--dissociate", origin, checkout], { stdio: "inherit" });
  }
  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: checkout, stdio: "inherit" });
  execFileSync("git", ["checkout", "--quiet", "--detach", "origin/main"], { cwd: checkout, stdio: "inherit" });
  if (!existsSync(path.join(checkout, "scripts", "gpui-main-baseline-agent.mjs"))) {
    throw new Error(`origin/main does not have scripts/gpui-main-baseline-agent.mjs yet; install once it is merged`);
  }
  // The gate's cargo checks need the bundled Synara runtime's resource, and
  // a stub stands in for it (CLAUDE.md); the folder is git-ignored.
  mkdirSync(path.join(checkout, "src-tauri", "synara-runtime"), { recursive: true });
  writeFileSync(path.join(checkout, "src-tauri", "synara-runtime", "placeholder.txt"), "");
  const log = path.join(baselineDir(), "agent.log");
  mkdirSync(path.dirname(log), { recursive: true });
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(
    plistPath,
    plist({
      node: process.execPath,
      checkout,
      every: options.every,
      minHours: options.minHours,
      log,
      env: { PATH: process.env.PATH, HOME: os.homedir(), LATTICE_GPUI_BUILD_DIR: process.env.LATTICE_GPUI_BUILD_DIR },
    }),
  );
  const domain = `gui/${process.getuid()}`;
  launchctl("bootout", `${domain}/${LABEL}`);
  const loaded = launchctl("bootstrap", domain, plistPath);
  if (loaded.status !== 0) throw new Error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`);
  say(`installed ${plistPath}: a tick every ${options.every} min, a run at most every ${options.minHours} h, from ${checkout}; log ${log}`);
}

function uninstall() {
  launchctl("bootout", `gui/${process.getuid()}/${LABEL}`);
  rmSync(plistPath, { force: true });
  say(`removed ${plistPath}; the checkout and the records stay`);
}

function status(options) {
  const out = baselineDir();
  const loaded = process.platform === "darwin" && launchctl("print", `gui/${process.getuid()}/${LABEL}`).status === 0;
  const latest = readJson(path.join(out, "latest.json"));
  const origin = existsSync(path.join(options.checkout, ".git")) ? originMain(options.checkout) : null;
  console.log(
    JSON.stringify(
      {
        installed: existsSync(plistPath),
        loaded,
        checkout: options.checkout,
        origin_main: origin,
        latest: latest ? { sha: latest.sha, green: latest.green, finished: latest.finished } : null,
        state: readJson(path.join(out, "agent-state.json")),
        build_lock: lockHolder(GPUI_BUILD_LOCK_DIR),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const commands = { install, uninstall, status, tick };
    if (!commands[options.command]) throw new Error("usage: gpui-main-baseline-agent.mjs install|uninstall|status|tick [options]");
    commands[options.command](options);
  } catch (error) {
    console.error(`gpui-main-baseline-agent: ${error.message}`);
    process.exit(1);
  }
}
