#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { isMain } from "./lib/util.mjs";

export function buildPreparationPlan(debugValue) {
  if (debugValue !== undefined && debugValue !== "true" && debugValue !== "false") {
    throw new Error(`Invalid TAURI_ENV_DEBUG value: ${debugValue}`);
  }
  const debug = debugValue === "true";
  return {
    profile: debug ? "debug" : "release",
    scripts: [
      debug ? "prepare:runtime:dev" : "prepare:runtime",
      "build",
    ],
  };
}

function prepareBuild() {
  const plan = buildPreparationPlan(process.env.TAURI_ENV_DEBUG);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  console.log(`Preparing ${plan.profile} package resources.`);
  for (const script of plan.scripts) {
    execFileSync(pnpm, ["run", script], { stdio: "inherit" });
  }
}

if (isMain(import.meta.url)) {
  prepareBuild();
}
