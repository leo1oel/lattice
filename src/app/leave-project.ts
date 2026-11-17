/**
 * The question a switch to another project in this window asks when the
 * project it leaves still has work running. A left project is suspended, not
 * kept running: the backend aborts its build when no window shows it
 * (`retire_unused_projects`), its terminals' shells end (`followProject` in
 * terminal-window.ts). Active Agent turns keep their project while switching.
 * Loaded on the first switch.
 */
import { msg } from "@lingui/core/macro";
import { i18n, joinList } from "../i18n";
import { confirmAction } from "../app-utils";
import { loadTerminalPanel } from "../terminal/terminal-load";

/** True when nothing runs in the project named `name`, or the writer chose to switch all the same. */
export async function confirmLeavingProject(name: string, building: boolean): Promise<boolean> {
  // Shells exist only once the Terminal panel's chunk is in; asking for it would load xterm for nothing.
  const commands = await loadTerminalPanel.loaded()?.runningTerminalCommands() ?? [];
  const running = [
    building && i18n._(msg`the build`),
    ...[...new Set(commands)].map((command: string) => (
      command ? i18n._(msg`“${command}” in the terminal`) : i18n._(msg`a command in the terminal`)
    )),
  ].filter((item): item is string => Boolean(item));
  if (!running.length) return true;
  const list = joinList(running);
  return confirmAction({
    title: i18n._(msg`Switch away from “${name}”?`),
    message: i18n._(msg`Switching interrupts what is still running there: ${list}.`),
    confirmLabel: i18n._(msg`Switch project`),
    destructive: true,
  });
}
