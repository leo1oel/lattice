/**
 * The workspace's default layout and its per-project persistence.
 *
 * Layouts are saved per project under a Lattice-owned, versioned envelope
 * instead of Trellis's `storageKey`: Trellis discards a saved layout whose
 * version differs, which would reset every user's arrangement on each schema
 * change. `migrateLayout` decides what an older saved layout becomes.
 */
import { createDocument, layout as L, sanitize, type LayoutDocument, type LayoutNode, type PanelNode } from "@danfessler/trellis";

const STORAGE_PREFIX = "lattice.trellis-layout.v1:";
/** v2: no stage, and Project shares a panel with the Agent. */
const LAYOUT_VERSION = 2;

type SavedLayout = { version: number; savedAt: number; document: LayoutDocument };

export const VIEW_TYPES = [
  "project", "papers", "agent", "pdf", "file",
  "history", "git", "comments", "overleaf", "literature", "todos", "checklist",
] as const;

/**
 * Project and the Agent share a panel above Papers on the left, and the PDF
 * takes the right. There is deliberately no stage: documents get panels of
 * their own between the two (`withDocumentPanel`), so hiding or closing any
 * panel lets its neighbours take the space instead of leaving an empty
 * region. Singletons get fixed ids so code can address them.
 */
export function defaultLayout(): LayoutDocument {
  return createDocument(
    L.row([
      L.column([
        L.panel({ id: "panel-project", selected: 0 }, L.view("project", { id: "project" }), L.view("agent", { id: "agent" })),
        L.panel({ id: "panel-papers" }, L.view("papers", { id: "papers" })),
      ], [0.62, 0.38]),
      L.panel({ id: "panel-pdf" }, L.view("pdf", { id: "pdf" })),
    ], [0.36, 0.64]),
    { version: LAYOUT_VERSION },
  );
}

function containsPanel(node: LayoutNode, panelId: string): boolean {
  if (node.kind === "panel") return node.id === panelId;
  if (node.kind === "stage") return Boolean(node.child && containsPanel(node.child, panelId));
  return node.children.some((child) => containsPanel(child, panelId));
}

/**
 * `doc` with a new panel for a document, used when no document panel is left
 * to join: it goes right after the top-level column holding one of the
 * `after` panels (the navigators), else first, and takes `share` of the
 * width while the others keep their proportions.
 */
export function withDocumentPanel(
  doc: LayoutDocument,
  view: { id: string; key: string },
  options: { after: readonly string[]; share?: number },
): LayoutDocument {
  const share = options.share ?? 0.46;
  const panel: PanelNode = { kind: "panel", id: `panel-${view.id}`, views: [view.id], selected: view.id };
  const views = { ...doc.views, [view.id]: { type: "file", params: { key: view.key } } };
  const root = doc.root;
  if (!root) return { ...doc, root: panel, views };
  if (root.kind === "split" && root.axis === "x") {
    const at = root.children.findIndex((child) => options.after.some((id) => containsPanel(child, id))) + 1;
    const total = root.weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const weights = root.weights.map((weight) => (weight / total) * (1 - share));
    weights.splice(at, 0, share);
    const children = [...root.children];
    children.splice(at, 0, panel);
    return { ...doc, root: { ...root, children, weights }, views };
  }
  return {
    ...doc,
    root: { kind: "split", id: `split-${view.id}`, axis: "x", weights: [1 - share, share], children: [root, panel] },
    views,
  };
}

function storageKey(projectRoot: string) {
  return `${STORAGE_PREFIX}${projectRoot}`;
}

function migrateLayout(saved: SavedLayout): LayoutDocument | null {
  // v1 layouts had a stage and the Agent below the PDF: they start again from
  // the default (open documents are re-placed as App restores its tabs).
  if (saved.version !== LAYOUT_VERSION) return null;
  return saved.document;
}

const knownType = (type: string) => (VIEW_TYPES as readonly string[]).includes(type);

/** The saved layout for `projectRoot`, or the default. File panels are reconciled with App's tabs later. */
export function loadLayout(projectRoot: string): LayoutDocument {
  try {
    const raw = localStorage.getItem(storageKey(projectRoot));
    if (raw) {
      const saved = JSON.parse(raw) as SavedLayout;
      const document = migrateLayout(saved);
      if (document) return sanitize(document, knownType);
    }
  } catch {
    // A corrupt or unreadable layout falls back to the default.
  }
  return defaultLayout();
}

export function saveLayout(projectRoot: string, document: LayoutDocument) {
  try {
    const saved: SavedLayout = { version: LAYOUT_VERSION, savedAt: Date.now(), document };
    localStorage.setItem(storageKey(projectRoot), JSON.stringify(saved));
  } catch {
    // Session-only without storage.
  }
}

export function clearLayout(projectRoot: string) {
  try {
    localStorage.removeItem(storageKey(projectRoot));
  } catch {
    // Nothing persisted.
  }
}
