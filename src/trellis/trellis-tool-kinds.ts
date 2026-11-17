/** Drawers that become dockable tool panels, keyed by their Trellis view type. */
export const TOOL_KINDS = ["history", "git", "comments", "overleaf", "literature", "todos", "checklist", "start", "browser"] as const;
export type TrellisToolKind = typeof TOOL_KINDS[number];

/** Which drawer (by the class it passes to ResizableDrawer) docks as which tool panel. */
const DRAWER_TOOL_CLASSES: Array<[string, TrellisToolKind]> = [
  ["project-history-drawer", "history"],
  ["synara-source-control-drawer", "git"],
  ["editor-comments-drawer", "comments"],
  // With an Overleaf link the comments surface becomes Overleaf's chat, comments and review.
  ["overleaf-collab-drawer", "overleaf"],
  ["literature-drawer", "literature"],
  ["todo-drawer", "todos"],
  ["checklist-drawer", "checklist"],
  ["get-started-drawer", "start"],
  ["browser-drawer", "browser"],
];

export function toolKindForDrawer(className: string | undefined): TrellisToolKind | null {
  if (!className) return null;
  const classes = className.split(/\s+/);
  return DRAWER_TOOL_CLASSES.find(([name]) => classes.includes(name))?.[1] ?? null;
}
