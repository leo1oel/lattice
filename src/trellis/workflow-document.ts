import type { LayoutPreset } from "./trellis-layout";

const PREFIX = "lattice.workflow-documents.v1:";
const mode = (preset: LayoutPreset | null) => preset ?? "custom";

/** Per-project document choices, never file contents. Positions remain owned
 * by App's per-document view-state store and parked editors. Closing a tab
 * deliberately wins over this memory: a mode must not resurrect it. */
function load(root: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFIX + root) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch { return {}; }
}

export function rememberWorkflowDocument(root: string, preset: LayoutPreset | null, key: string) {
  if (!root || !key) return;
  try { localStorage.setItem(PREFIX + root, JSON.stringify({ ...load(root), [mode(preset)]: key })); }
  catch { /* A full or unavailable settings store must not block a layout switch. */ }
}

export function workflowDocument(root: string, preset: LayoutPreset | null, openTabs: readonly string[]): string | null {
  const key = load(root)[mode(preset)];
  return typeof key === "string" && openTabs.includes(key) ? key : null;
}
