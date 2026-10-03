/**
 * The workspace's default layout and its per-project persistence.
 *
 * Layouts are saved per project under a Lattice-owned, versioned envelope
 * instead of Trellis's `storageKey`: Trellis discards a saved layout whose
 * version differs, which would reset every user's arrangement on each schema
 * change. `migrateLayout` decides what an older saved layout becomes.
 */
import {
  createDocument, layout as L, sanitize, type HiddenPanel, type LayoutDocument, type LayoutNode, type PanelNode, type ViewRecord,
} from "@danfessler/trellis";

const STORAGE_PREFIX = "lattice.trellis-layout.v1:";
/** v2: no stage, and Project shares a panel with the Agent. */
const LAYOUT_VERSION = 2;

/**
 * Writing puts the source beside the compiled PDF; Reading puts a paper beside
 * your notes. Either is a temporary arrangement over the writer's own layout,
 * which is kept as `previous` until they return to it. `supplied` holds the
 * views a preset brought in that `previous` lacked and the writer has not
 * asked for since: they leave again on the return.
 */
export type LayoutPreset = "writing" | "reading";
export type ActivePreset = { preset: LayoutPreset; previous: LayoutDocument; supplied: string[] };

type SavedLayout = { version: number; savedAt: number; document: LayoutDocument; preset?: ActivePreset };

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

/** How a preset sorts the open documents: papers (and PDFs) are read; everything else is written. */
export type PresetDocuments = {
  activeKey: string;
  /** The open documents, in tab order. */
  openTabs: readonly string[];
  isReading: (key: string) => boolean;
};

const fileKey = (record: ViewRecord | undefined) => (record?.type === "file" ? String(record.params?.key ?? "") : "");

/** Every panel of `doc`: docked, then floating, then (with `hidden`) hidden. */
function panelsOf(doc: LayoutDocument, { hidden = false } = {}): PanelNode[] {
  const panels: PanelNode[] = [];
  const collect = (node: LayoutNode | null | undefined) => {
    if (!node) return;
    if (node.kind === "panel") panels.push(node);
    else if (node.kind === "stage") collect(node.child);
    else node.children.forEach(collect);
  };
  collect(doc.root);
  doc.floating.forEach((entry) => panels.push(entry.panel));
  if (hidden) doc.hidden.forEach((entry) => panels.push(entry.panel));
  return panels;
}

/**
 * `doc` rearranged as `preset`. Every open document keeps its view (and so its
 * tab), only regrouped: Writing gathers them into one panel before the PDF,
 * selecting the source being written; Reading gathers papers with the Papers
 * library before a panel of everything else, selecting the paper and the
 * notes. Every other view (navigators, the Agent, tools) is parked hidden in
 * its own panel rather than dropped, so its content stays mounted: the Agent's
 * frame must not reload a running turn.
 */
export function presetLayout(preset: LayoutPreset, doc: LayoutDocument, documents: PresetDocuments): LayoutDocument {
  const { activeKey, openTabs, isReading } = documents;
  const byKey = new Map<string, string>();
  for (const [id, record] of Object.entries(doc.views)) {
    const key = fileKey(record);
    if (key && !byKey.has(key)) byKey.set(key, id);
  }
  const keys = [...openTabs, activeKey].filter((key, index, all) => key && byKey.has(key) && all.indexOf(key) === index);
  const views: Record<string, ViewRecord> = {};
  for (const key of keys) views[byKey.get(key)!] = doc.views[byKey.get(key)!];
  const panel = (id: string, members: string[], selectedKey: string | undefined): PanelNode => ({
    kind: "panel", id, views: members, selected: (selectedKey && byKey.get(selectedKey)) || members[0],
  });
  // The active document when it belongs on this side, else the first that `prefer`s, else the first.
  const pick = (candidates: string[], prefer: (key: string) => boolean) => (
    candidates.includes(activeKey) ? activeKey : candidates.find(prefer) ?? candidates[0]
  );
  const row = (id: string, children: LayoutNode[], weights: number[]): LayoutNode => (
    children.length === 1 ? children[0] : { kind: "split", id, axis: "x", weights, children }
  );
  let root: LayoutNode;
  if (preset === "writing") {
    views.pdf = { type: "pdf" };
    const written = keys.filter((key) => !isReading(key));
    // LaTeX is what the PDF is compiled from, so a .tex source wins over the active note.
    const tex = (key: string) => key.toLocaleLowerCase().endsWith(".tex");
    const source = (tex(activeKey) && written.includes(activeKey) ? activeKey : written.find(tex)) ?? pick(written, tex) ?? keys[0];
    const ids = keys.map((key) => byKey.get(key)!);
    // With nothing open to write, the Project panel stands in for the source.
    if (!ids.length) views.project = { type: "project" };
    root = row("split-writing", [
      ids.length ? panel("panel-writing", ids, source) : panel("panel-project", ["project"], undefined),
      panel("panel-pdf", ["pdf"], undefined),
    ], [0.5, 0.5]);
  } else {
    views.papers = { type: "papers" };
    const read = keys.filter(isReading);
    const notes = keys.filter((key) => !isReading(key));
    const paper = read.includes(activeKey) ? activeKey : read[0];
    const reading = panel("panel-reading", ["papers", ...read.map((key) => byKey.get(key)!)], paper);
    if (!paper) reading.selected = "papers";
    const children: LayoutNode[] = [reading];
    if (notes.length) {
      const note = pick(notes, (key) => key.toLocaleLowerCase().endsWith(".md"));
      children.push(panel("panel-notes", notes.map((key) => byKey.get(key)!), note));
    }
    root = row("split-reading", children, [0.5, 0.5]);
  }
  const placed = new Set(panelsOf({ ...doc, root, floating: [] }).map((target) => target.id));
  const restore = { kind: "docked", beside: root.id, edge: "left", share: 0.3 } as const;
  const hidden: HiddenPanel[] = [];
  for (const source of panelsOf(doc, { hidden: true })) {
    const members = source.views.filter((id) => doc.views[id] && doc.views[id].type !== "file" && !views[id]);
    if (!members.length) continue;
    for (const id of members) views[id] = doc.views[id];
    const id = placed.has(source.id) ? `${source.id}-parked` : source.id;
    hidden.push({ panel: { ...source, id, views: members, selected: members.includes(source.selected) ? source.selected : members[0] }, restore });
  }
  return { schema: 1, version: doc.version, root, floating: [], hidden, views };
}

/**
 * `doc` (the writer's own layout, or that of the `active` preset) rearranged as
 * `preset`, with the preset to return from: switching between presets keeps
 * the layout from before the first, and what each preset supplied.
 */
export function enterPreset(
  preset: LayoutPreset,
  doc: LayoutDocument,
  active: ActivePreset | null,
  documents: PresetDocuments,
): { document: LayoutDocument; active: ActivePreset } {
  const document = presetLayout(preset, doc, documents);
  const supplied = Object.keys(document.views).filter((id) => document.views[id].type !== "file" && !doc.views[id]);
  return { document, active: { preset, previous: active?.previous ?? doc, supplied: [...active?.supplied ?? [], ...supplied] } };
}

/**
 * The writer's own layout to return to from a preset, brought up to date with
 * what is open now: documents and panels closed meanwhile stay closed, and
 * those opened meanwhile (not those the preset `supplied`) join the panel holding the active document (else the
 * first document panel), keeping the views they have now. The active document
 * is selected in its panel. With no document panel left to join, App's tab
 * sync gives new documents one, while other new views join the first panel.
 */
export function returnLayout(
  previous: LayoutDocument,
  current: LayoutDocument,
  documents: Pick<PresetDocuments, "activeKey" | "openTabs">,
  supplied: readonly string[] = [],
): LayoutDocument {
  const open = new Set([...documents.openTabs, documents.activeKey].filter(Boolean));
  const views = { ...previous.views };
  const kept = new Set<string>();
  for (const [id, record] of Object.entries(views)) {
    const key = fileKey(record);
    const survives = record.type === "file" ? open.has(key) && !kept.has(key) : Boolean(current.views[id]);
    if (!survives) delete views[id];
    else if (key) kept.add(key);
  }
  const panels = panelsOf(previous);
  const holdsDocument = (target: PanelNode, key?: string) => target.views.some((id) => views[id] && fileKey(views[id]) && (!key || fileKey(views[id]) === key));
  const group = panels.find((target) => holdsDocument(target, documents.activeKey)) ?? panels.find((target) => holdsDocument(target));
  const target = group ?? panels[0];
  const joining = Object.entries(current.views).filter(([id, record]) => (
    record.type === "file" ? Boolean(group) && open.has(fileKey(record)) && !kept.has(fileKey(record)) : !views[id] && !supplied.includes(id)
  ));
  for (const [id, record] of joining) views[id] = record;
  const joined = joining.map(([id]) => id);
  const active = documents.activeKey ? Object.keys(views).find((id) => fileKey(views[id]) === documents.activeKey) : undefined;
  const replace = (panel: PanelNode): PanelNode => {
    const members = panel.id === target?.id ? [...panel.views, ...joined] : panel.views;
    return { ...panel, views: members, selected: active && members.includes(active) ? active : panel.selected };
  };
  const mapNode = (node: LayoutNode): LayoutNode => {
    if (node.kind === "panel") return replace(node);
    if (node.kind === "stage") return node.child ? { ...node, child: mapNode(node.child) as typeof node.child } : node;
    return { ...node, children: node.children.map(mapNode) };
  };
  const doc: LayoutDocument = {
    ...previous,
    views,
    root: previous.root ? mapNode(previous.root) : joined.length ? { kind: "panel", id: `panel-${joined[0]}`, views: joined, selected: joined[0] } : null,
    floating: previous.floating.map((entry) => ({ ...entry, panel: replace(entry.panel) })),
    hidden: previous.hidden.map((entry) => ({ ...entry, panel: replace(entry.panel) })),
  };
  // Panels left without a view go, and their splits close up around them.
  return sanitize(doc, knownType);
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

/**
 * The saved layout for `projectRoot`, or the default, with the preset it was
 * left in. File panels are reconciled with App's tabs later.
 */
export function loadLayout(projectRoot: string): { document: LayoutDocument; preset: ActivePreset | null } {
  try {
    const raw = localStorage.getItem(storageKey(projectRoot));
    if (raw) {
      const saved = JSON.parse(raw) as SavedLayout;
      const document = migrateLayout(saved);
      if (document) {
        const preset = saved.preset?.previous && (saved.preset.preset === "writing" || saved.preset.preset === "reading")
          ? {
            preset: saved.preset.preset,
            previous: sanitize(saved.preset.previous, knownType),
            supplied: Array.isArray(saved.preset.supplied) ? saved.preset.supplied.filter((id) => typeof id === "string") : [],
          }
          : null;
        return { document: sanitize(document, knownType), preset };
      }
    }
  } catch {
    // A corrupt or unreadable layout falls back to the default.
  }
  return { document: defaultLayout(), preset: null };
}

export function saveLayout(projectRoot: string, document: LayoutDocument, preset: ActivePreset | null = null) {
  try {
    const saved: SavedLayout = { version: LAYOUT_VERSION, savedAt: Date.now(), document, ...(preset ? { preset } : {}) };
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
