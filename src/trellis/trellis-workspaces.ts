/**
 * The writer's named workspaces: arrangements of panels they switch between
 * from the titlebar, shared by every project.
 *
 * A workspace is live: whatever the writer rearranges while in it is its
 * arrangement from then on, so switching back finds it as it was left. It
 * holds the arrangement only (panels, splits, sizes, tools), never documents:
 * each panel that held documents keeps one empty slot (a file view without a
 * key) where the open documents go when the workspace is entered
 * (`arrangeDocuments` in trellis-layout). Each project remembers which
 * workspace it was last in, in its own saved layout.
 *
 * Eager (the titlebar lists them before the workspace loads) and light:
 * nothing from Trellis but types.
 */
import { i18n } from "../i18n";
import { msg } from "@lingui/core/macro";
import type { LayoutDocument, LayoutNode, PanelNode, ViewRecord } from "@danfessler/trellis";

const LIBRARY_KEY = "lattice.trellis-workspaces.v1";
const LIBRARY_VERSION = 1;
/** Each project's saved layout (trellis-layout's envelope), which the first library is migrated from. */
export const LAYOUT_STORAGE_PREFIX = "lattice.trellis-layout.v1:";
/**
 * The saved layout's version. v2: no stage, and Project shares a panel with
 * the Agent. v3: the same layouts, saved with the workspace they are in.
 */
const LEGACY_LAYOUT_VERSION = 2;
export const LAYOUT_VERSION = 3;
/** Long enough for a word or two, short enough for a titlebar tab. */
export const WORKSPACE_NAME_MAX = 24;
/** Workspaces with a shortcut (⌘1 to ⌘9); the migration makes no more than these. */
export const WORKSPACE_SHORTCUTS = 9;

/** ⌘1 to ⌘9 for the first nine workspaces. */
export const workspaceShortcut = (index: number) => (index < WORKSPACE_SHORTCUTS ? `⌘${index + 1}` : null);

/** `arrangement` is null until the workspace is first used: the default layout. */
export type Workspace = { id: string; name: string; arrangement: LayoutDocument | null };
export type WorkspaceSummary = { id: string; name: string };
type SavedLibrary = { version: number; workspaces: Workspace[]; recent?: string };
type Listener = () => void;

const fileKey = (record: ViewRecord | undefined) => (record?.type === "file" ? String(record.params?.key ?? "") : "");
/** A panel's place for documents in an arrangement: a file view without a document. */
export const isDocumentSlot = (record: ViewRecord | undefined) => record?.type === "file" && !fileKey(record);

/**
 * `doc` as an arrangement: its documents taken out, and each panel that held
 * any given one slot where they stood (selected if one of them was), so the
 * panel survives with its place in the layout.
 */
export function arrangementOf(doc: LayoutDocument): LayoutDocument {
  const views: Record<string, ViewRecord> = {};
  for (const [id, record] of Object.entries(doc.views)) if (record.type !== "file") views[id] = record;
  const panel = (target: PanelNode): PanelNode => {
    const slot = `slot-${target.id}`;
    const members: string[] = [];
    for (const id of target.views) {
      if (doc.views[id]?.type !== "file") members.push(id);
      else if (!members.includes(slot)) members.push(slot);
    }
    if (members.includes(slot)) views[slot] = { type: "file", params: {} };
    const selected = doc.views[target.selected]?.type === "file" ? slot : target.selected;
    return { ...target, views: members, selected: members.includes(selected) ? selected : members[0] ?? selected };
  };
  const node = (target: LayoutNode): LayoutNode => {
    if (target.kind === "panel") return panel(target);
    if (target.kind === "stage") return target.child ? { ...target, child: node(target.child) as typeof target.child } : target;
    return { ...target, children: target.children.map(node) };
  };
  return {
    ...doc,
    root: doc.root ? node(doc.root) : null,
    floating: doc.floating.map((entry) => ({ ...entry, panel: panel(entry.panel) })),
    hidden: doc.hidden.map((entry) => ({ ...entry, panel: panel(entry.panel) })),
    views,
  };
}

/**
 * A layout's arrangement as a string that changes only when the arrangement
 * does: its splits and their weights, panels with their views (documents by
 * file, since re-placing a document gives its view a new id), floating
 * windows and hidden panels. Panel ids and selected tabs are left out.
 */
export function layoutShape(doc: LayoutDocument): string {
  const view = (id: string) => (doc.views[id]?.type === "file" ? `file:${fileKey(doc.views[id])}` : id);
  const panel = (target: PanelNode) => target.views.map(view);
  const node = (target: LayoutNode): unknown => {
    if (target.kind === "panel") return panel(target);
    if (target.kind === "stage") return { stage: target.child ? node(target.child) : null };
    return { [target.axis]: target.children.map(node), weights: target.weights.map((weight) => Math.round(weight * 1000)) };
  };
  return JSON.stringify({
    root: doc.root ? node(doc.root) : null,
    floating: doc.floating.map(({ panel: target, ...entry }) => ({ ...entry, views: panel(target) })),
    hidden: doc.hidden.map(({ panel: target, ...entry }) => ({ ...entry, views: panel(target) })),
  });
}

const newId = () => `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const defaultName = () => i18n._(msg`Workspace`);

function isSavedLayout(value: unknown): value is { version: number; savedAt?: number; document: LayoutDocument; preset?: { previous?: LayoutDocument } } {
  const saved = value as { version?: unknown; document?: { views?: unknown } } | null;
  return typeof saved?.version === "number" && typeof saved.document?.views === "object";
}

/**
 * The first library, from the layouts projects saved before workspaces: each
 * distinct arrangement becomes a workspace, so nobody loses theirs. The most
 * recently saved is "Workspace", the others are numbered after it (up to the
 * shortcut count; any beyond share the first), and each project's layout is
 * rewritten to name the workspace it is in.
 */
function migrate(storage: Storage): SavedLibrary {
  const found: Array<{ key: string; savedAt: number; saved: Record<string, unknown>; arrangement: LayoutDocument }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LAYOUT_STORAGE_PREFIX)) continue;
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (!isSavedLayout(saved) || saved.version !== LEGACY_LAYOUT_VERSION) continue;
      // A layout left in Writing or Reading is the writer's own underneath.
      const own = saved.preset?.previous ?? saved.document;
      found.push({ key, savedAt: Number(saved.savedAt) || 0, saved: saved as Record<string, unknown>, arrangement: arrangementOf(own) });
    } catch {
      // An unreadable layout starts again from the default, as before.
    }
  }
  found.sort((a, b) => b.savedAt - a.savedAt);
  const base = defaultName();
  const workspaces: Workspace[] = [];
  const byShape = new Map<string, string>();
  for (const entry of found) {
    const shape = layoutShape(entry.arrangement);
    let id = byShape.get(shape);
    if (!id && workspaces.length < WORKSPACE_SHORTCUTS) {
      id = newId();
      workspaces.push({ id, name: workspaces.length ? `${base} ${workspaces.length + 1}` : base, arrangement: entry.arrangement });
      byShape.set(shape, id);
    }
    id ??= workspaces[0].id;
    try {
      storage.setItem(entry.key, JSON.stringify({ ...entry.saved, version: LAYOUT_VERSION, workspace: id }));
    } catch {
      // The project falls back to the most recent workspace.
    }
  }
  if (!workspaces.length) workspaces.push({ id: newId(), name: base, arrangement: null });
  return { version: LIBRARY_VERSION, workspaces, recent: workspaces[0].id };
}

function isWorkspace(value: unknown): value is Workspace {
  const entry = value as Partial<Workspace> | null;
  return typeof entry?.id === "string" && typeof entry.name === "string" && (entry.arrangement === null || typeof entry.arrangement?.views === "object");
}

/**
 * The workspaces, in the writer's order, persisted in localStorage. The
 * summary list (ids and names) keeps its identity until one is added,
 * removed, renamed or moved, so the titlebar re-renders only then; an
 * arrangement saved on every layout change notifies nobody.
 */
export class WorkspaceLibrary {
  private saved: SavedLibrary | null = null;
  private summaries: readonly WorkspaceSummary[] = [];
  private listeners = new Set<Listener>();

  private load(): SavedLibrary {
    if (this.saved) return this.saved;
    let saved: SavedLibrary | null = null;
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SavedLibrary>;
        const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isWorkspace) : [];
        if (workspaces.length) saved = { version: LIBRARY_VERSION, workspaces, recent: typeof parsed.recent === "string" ? parsed.recent : undefined };
      } else {
        saved = migrate(localStorage);
        this.saved = saved;
        this.persist();
      }
    } catch {
      // Without storage, one session-only workspace.
    }
    this.saved = saved ?? { version: LIBRARY_VERSION, workspaces: [{ id: newId(), name: defaultName(), arrangement: null }] };
    this.summaries = this.saved.workspaces.map(({ id, name }) => ({ id, name }));
    return this.saved;
  }

  private persist() {
    try {
      if (this.saved) localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.saved));
    } catch {
      // Session-only without storage.
    }
  }

  /** Persist a change to the list, and tell the titlebar. */
  private commit(workspaces: Workspace[], recent = this.load().recent) {
    this.saved = { version: LIBRARY_VERSION, workspaces, recent };
    this.summaries = workspaces.map(({ id, name }) => ({ id, name }));
    this.persist();
    for (const listener of [...this.listeners]) listener();
  }

  list = (): readonly WorkspaceSummary[] => {
    this.load();
    return this.summaries;
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(id: string): Workspace | undefined {
    return this.load().workspaces.find((entry) => entry.id === id);
  }

  /** The workspace last entered in any project, where a project without its own starts. */
  recent(): string {
    const { workspaces, recent } = this.load();
    return workspaces.some((entry) => entry.id === recent) ? recent! : workspaces[0].id;
  }

  use(id: string) {
    const saved = this.load();
    if (saved.recent === id || !this.get(id)) return;
    saved.recent = id;
    this.persist();
  }

  /** The workspace's arrangement from now on (no one is notified: nothing listed changes). */
  setArrangement(id: string, arrangement: LayoutDocument) {
    const entry = this.get(id);
    if (!entry || entry.arrangement === arrangement) return;
    entry.arrangement = arrangement;
    this.persist();
  }

  /** Whether `name` is free for a workspace: none other has it, ignoring case. */
  nameFree(name: string, except?: string) {
    return !this.load().workspaces.some((entry) => entry.id !== except && sameName(entry.name, name.trim()));
  }

  /** `base`, or the first of "base 2", "base 3"… that no workspace has. */
  uniqueName(base: string) {
    const trimmed = base.trim().slice(0, WORKSPACE_NAME_MAX) || defaultName();
    if (this.nameFree(trimmed)) return trimmed;
    for (let count = 2; ; count += 1) {
      const suffix = ` ${count}`;
      const name = `${trimmed.slice(0, WORKSPACE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
      if (this.nameFree(name)) return name;
    }
  }

  /** Add a workspace with a free name, after `after` (else last); returns its id. */
  add(name: string, arrangement: LayoutDocument | null, after?: string): string {
    const workspaces = [...this.load().workspaces];
    const id = newId();
    const at = after ? workspaces.findIndex((entry) => entry.id === after) + 1 : 0;
    workspaces.splice(at > 0 ? at : workspaces.length, 0, { id, name: this.uniqueName(name), arrangement });
    this.commit(workspaces);
    return id;
  }

  /** A copy of `id` right after it, named from `name`; returns its id. */
  duplicate(id: string, name: string): string | null {
    const source = this.get(id);
    if (!source) return null;
    return this.add(name, source.arrangement ? structuredClone(source.arrangement) : null, id);
  }

  /** Rename, unless the name is empty or another workspace has it. */
  rename(id: string, name: string): "renamed" | "empty" | "taken" {
    const trimmed = name.trim().slice(0, WORKSPACE_NAME_MAX);
    if (!trimmed) return "empty";
    if (!this.nameFree(trimmed, id)) return "taken";
    const workspaces = this.load().workspaces;
    if (workspaces.find((entry) => entry.id === id)?.name !== trimmed) {
      this.commit(workspaces.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)));
    }
    return "renamed";
  }

  /** Move `id` to position `index`. */
  move(id: string, index: number) {
    const workspaces = [...this.load().workspaces];
    const from = workspaces.findIndex((entry) => entry.id === id);
    const to = Math.max(0, Math.min(index, workspaces.length - 1));
    if (from < 0 || from === to) return;
    const [entry] = workspaces.splice(from, 1);
    workspaces.splice(to, 0, entry);
    this.commit(workspaces);
  }

  /** Remove `id`, with what `restore` needs to put it back; never the last one. */
  remove(id: string): { workspace: Workspace; index: number } | null {
    const workspaces = [...this.load().workspaces];
    const index = workspaces.findIndex((entry) => entry.id === id);
    if (index < 0 || workspaces.length === 1) return null;
    const [workspace] = workspaces.splice(index, 1);
    this.commit(workspaces);
    return { workspace, index };
  }

  /** Put a removed workspace back where it was (its name made free again if taken since). */
  restore({ workspace, index }: { workspace: Workspace; index: number }) {
    if (this.get(workspace.id)) return;
    const workspaces = [...this.load().workspaces];
    workspaces.splice(Math.min(index, workspaces.length), 0, { ...workspace, name: this.uniqueName(workspace.name) });
    this.commit(workspaces);
  }
}
