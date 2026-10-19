/**
 * Where the Terminal panel sits and the key that toggles it. Eager and tiny:
 * App's command table and the Trellis controller read it before any terminal
 * code loads (that is `terminal-panel.tsx`, loaded when the panel opens).
 */
import type { Placement, WorkspaceHandle } from "@danfessler/trellis";

/** ⌃`, as in most code editors. ⌘` is the Mac's own key for the next window. */
export const TERMINAL_TOGGLE_KEY = { key: "`", ctrl: true } as const;

/** The share of the window's height a newly opened Terminal panel takes. */
export const TERMINAL_SHARE = 0.3;

/**
 * A closed Terminal panel comes back across the foot of the whole workspace,
 * under every other panel, as a terminal sits below an editor. After that it
 * is a panel like any other: it can be dragged, floated or tabbed elsewhere,
 * and the layout (with each named workspace's) remembers where and how tall.
 */
export function terminalHome(ws: WorkspaceHandle | null): Placement {
  const root = ws?.getDocument().root;
  return root ? { beside: root.id, edge: "bottom", share: TERMINAL_SHARE } : "side";
}
