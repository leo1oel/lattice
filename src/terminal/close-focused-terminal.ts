/**
 * ⌘W with the Terminal panel focused closes a terminal, as in a code editor's
 * terminal, never a document tab or the window. Eager and tiny: the command
 * table reads it on every ⌘W, and the terminal code is only asked for once
 * the panel has loaded it (a focused panel always has).
 */
import type { TrellisController } from "../trellis/trellis-controller";
import { loadTerminalPanel } from "./terminal-load";

/**
 * Close the terminal tab in front when the Terminal panel has focus, asking
 * first when a command still runs, or the panel itself once no tab is left
 * in it. False when the focus is elsewhere, for ⌘W to close a document.
 */
export function closeFocusedTerminal(controller: Pick<TrellisController, "ws">): boolean {
  const ws = controller.ws;
  const focused = ws?.getSnapshot().focusedView;
  if (!ws || !focused) return false;
  const panel = ws.views({ type: "terminal" }).find((view) => view.id === focused);
  if (!panel) return false;
  if (!loadTerminalPanel.loaded()?.closeActiveTerminal()) void ws.close(panel.id);
  return true;
}
