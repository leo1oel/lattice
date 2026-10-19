/**
 * This window's terminals (one store, see terminal-sessions.ts) and the
 * actions the Terminal panel's header, menu and close offer. Loaded with the
 * panel, never before.
 */
import { i18n } from "../i18n";
import { msg } from "@lingui/core/macro";
import { confirmAction } from "../app-utils";
import type { TrellisController } from "../trellis/trellis-controller";
import { tauriTerminalBackend } from "./terminal-backend";
import { createXtermScreen, type XtermScreen } from "./terminal-screen";
import { TerminalSessions } from "./terminal-sessions";

export const terminals = new TerminalSessions<XtermScreen>(tauriTerminalBackend, createXtermScreen);

let followed: TrellisController | null = null;
let unfollow: (() => void) | null = null;

/**
 * Keep the terminals to the window's project, from the panel's first mount
 * on: a switch to another project ends the last one's shells even while the
 * panel is not mounted.
 */
export function followProject(controller: TrellisController) {
  if (followed === controller) return;
  unfollow?.();
  followed = controller;
  const sync = () => terminals.setProject(controller.app.get().projectRoot);
  unfollow = controller.app.subscribe(sync);
  sync();
}

/**
 * Ask before stopping what runs in `keys` (every terminal by default), and
 * say what that is. True when nothing runs or the writer agreed.
 */
async function confirmStopping(keys?: readonly number[]): Promise<boolean> {
  const running = await terminals.running(keys);
  if (!running.length) return true;
  const name = [...new Set(running.filter(Boolean))].join(", ");
  const several = (keys?.length ?? terminals.get().sessions.length) > 1;
  return confirmAction({
    title: i18n._(several ? msg`Close the terminals?` : msg`Close the terminal?`),
    message: name
      ? i18n._(msg`${name} is still running. Closing stops it.`)
      : i18n._(msg`A command is still running. Closing stops it.`),
    confirmLabel: i18n._(msg`Close`),
    destructive: true,
  });
}

export function openTerminal() {
  terminals.open();
}

/** Close one tab, asking first when a command still runs in it. */
export async function closeTerminal(key: number) {
  if (await confirmStopping([key])) terminals.close(key);
}

/**
 * The Terminal panel is closing (its tab's ×, the panel menu): end every
 * shell, asking first when a command still runs. False keeps the panel.
 */
export async function closeAllTerminals(): Promise<boolean> {
  if (!(await confirmStopping())) return false;
  terminals.endAll();
  return true;
}

function activeScreen(): XtermScreen | null {
  const { sessions, active } = terminals.get();
  return sessions.find((session) => session.key === active)?.screen ?? null;
}

export function clearActiveTerminal() {
  activeScreen()?.clear();
}

/** The panel's find field, opened from the menu as ⌘F opens it. */
export const findRequests = new Set<() => void>();
export function findInActiveTerminal() {
  for (const request of findRequests) request();
}
