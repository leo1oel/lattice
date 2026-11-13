// The GPUI side of the parity diff: `lattice-gpui PROJECT --scenario parity`
// (crates/lattice-gpui/src/scenario/parity.rs) on a copy of the tutorial
// project, in one appearance. It writes the window's capture and the named
// regions it recorded.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TUTORIAL_TEMPLATE } from "../../design-system/screens/tutorial.mjs";

/** A fresh copy of the tutorial at `dir`, with its built PDF (the scene shows it). */
export function stageProject(dir, pdf) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(TUTORIAL_TEMPLATE, dir, { recursive: true });
  cpSync(pdf, join(dir, "main.pdf"));
  return dir;
}

/** Run the scenario; resolves to its JSON result, with `png` the capture's path. */
export function captureGpui({ app, project, theme, dir, name, screen = "mainWindow", timeoutMs = 180_000 }) {
  if (!existsSync(app)) throw new Error(`no GPUI app at ${app}; build it (cargo build --release in gpui/)`);
  const json = join(dir, `${name}.json`);
  const png = join(dir, `${name}.png`);
  rmSync(json, { force: true });
  const run = spawnSync(app, [project, "--scenario", "parity", "--out", json], {
    // The scenario writes nothing else, but `shot` would put shot.json in the current directory.
    cwd: dir,
    env: { ...process.env, LATTICE_APPEARANCE: theme, LATTICE_SHOT_OUT: png, LATTICE_PARITY_SCREEN: screen },
    timeout: timeoutMs,
    encoding: "utf8",
  });
  if (run.error) throw new Error(`the GPUI scenario did not finish: ${run.error.message}`);
  if (!existsSync(json)) throw new Error(`the GPUI scenario wrote no result (exit ${run.status}): ${run.stderr.slice(-2000)}`);
  const result = JSON.parse(readFileSync(json, "utf8"));
  if (result.error) throw new Error(`the GPUI scenario failed: ${result.error}`);
  return { ...result, png };
}
