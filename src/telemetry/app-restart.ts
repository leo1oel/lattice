// Restarting Lattice, shared by the updater (app-updater.tsx) and the switch to
// the native app (app/native-app-dialog.tsx): what a restart would stop, and
// the restart itself, which waits for every window to save first.

import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { spaceMixedScript } from "../trellis/trellis-titles";

type RestartImpact = { terminalCommands: number; builds: number; agentTurns: number };

/**
 * What restarting now would stop, as a phrase ("an Agent task and 2 compiles"),
 * or null for nothing. The switch to the native app warns with it too.
 */
export async function runningWorkStoppedByRestart(): Promise<string | null> {
  const impact = await invoke<RestartImpact | null>("restart_impact").catch(() => null);
  if (!impact) return null;
  const { agentTurns, terminalCommands, builds } = impact;
  const parts = [
    agentTurns === 1 ? i18n._(msg`an Agent task`) : agentTurns > 1 ? i18n._(msg`${agentTurns} Agent tasks`) : "",
    terminalCommands === 1
      ? i18n._(msg`a terminal command`)
      : terminalCommands > 1 ? i18n._(msg`${terminalCommands} terminal commands`) : "",
    builds === 1 ? i18n._(msg`a compile`) : builds > 1 ? i18n._(msg`${builds} compiles`) : "",
  ].filter(Boolean);
  // "1 个 Agent 任务和 2 次编译": spaced where Han meets a digit.
  return parts.length ? spaceMixedScript(new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(parts)) : null;
}

/**
 * Restart once every window has saved. Resolves only from an older backend;
 * rejects when a window could not save its edits and the restart was called off.
 */
export async function restartLattice() {
  try {
    await invoke("restart_lattice");
  } catch (reason) {
    // An updater can replace the app bundle before the old process exits. If
    // that process then reloads the new frontend, an older release does not
    // know this command: v0.1.251 through v0.13 restart with
    // `restart_after_update`, and releases before those through the process
    // plugin. Neither saves first, as those releases never did.
    if (toMessage(reason) !== "Command restart_lattice not found") throw reason;
    try {
      await invoke("restart_after_update");
    } catch (older) {
      if (toMessage(older) !== "Command restart_after_update not found") throw older;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    }
  }
}
