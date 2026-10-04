import { beforeEach, describe, expect, it } from "vitest";
import { sanitize, type LayoutDocument, type LayoutNode, type PanelNode } from "@danfessler/trellis";
import {
  arrangeDocuments, defaultLayout, enterPreset, loadLayout, openProjectLayout, placesOf, presetLayout, returnLayout, saveLayout, undoReset,
} from "./trellis-layout";
import { arrangementOf, layoutShape, withDocumentPanel, WorkspaceLibrary } from "./trellis-workspaces";

const PAPER = "paper:1706.03762:";
const isReading = (key: string) => key.startsWith("paper:") || key.endsWith(".pdf");

/** The default layout with these documents in one panel, as App's tab sync leaves them. */
function workspaceWith(keys: string[]): LayoutDocument {
  let doc = defaultLayout();
  const [first, ...rest] = keys;
  doc = withDocumentPanel(doc, { id: "doc-0", key: first }, { after: ["panel-project"] });
  const panel = findPanel(doc.root, "panel-doc-0")!;
  rest.forEach((key, index) => {
    doc.views[`doc-${index + 1}`] = { type: "file", params: { key } };
    panel.views.push(`doc-${index + 1}`);
  });
  return doc;
}

function findPanel(node: LayoutNode | null | undefined, id: string): PanelNode | null {
  if (!node) return null;
  if (node.kind === "panel") return node.id === id ? node : null;
  if (node.kind === "stage") return findPanel(node.child, id);
  for (const child of node.children) {
    const found = findPanel(child, id);
    if (found) return found;
  }
  return null;
}

function panels(doc: LayoutDocument): Array<{ id: string; views: string[]; selected: string }> {
  const out: PanelNode[] = [];
  const walk = (node: LayoutNode | null | undefined) => {
    if (!node) return;
    if (node.kind === "panel") out.push(node);
    else if (node.kind === "stage") walk(node.child);
    else node.children.forEach(walk);
  };
  walk(doc.root);
  return out.map(({ id, views, selected }) => ({ id, views, selected }));
}

describe("layout presets", () => {
  const keys = ["main.tex", "notes.md", PAPER];
  const documents = { activeKey: "notes.md", openTabs: keys, isReading };

  it("Writing keeps every open document beside the PDF, with the LaTeX source in front", () => {
    const doc = presetLayout("writing", workspaceWith(keys), documents);
    expect(panels(doc)).toEqual([
      { id: "panel-writing", views: ["doc-0", "doc-1", "doc-2"], selected: "doc-0" },
      { id: "panel-pdf", views: ["pdf"], selected: "pdf" },
    ]);
    expect(Object.keys(doc.views).sort()).toEqual(["agent", "doc-0", "doc-1", "doc-2", "papers", "pdf", "project"]);
  });

  it("Reading puts the paper with the library beside the notes", () => {
    const doc = presetLayout("reading", workspaceWith(keys), documents);
    expect(panels(doc)).toEqual([
      { id: "panel-reading", views: ["papers", "doc-2"], selected: "doc-2" },
      { id: "panel-notes", views: ["doc-0", "doc-1"], selected: "doc-1" },
    ]);
  });

  it("parks the navigators, the Agent and tools hidden, so their content stays mounted", () => {
    const previous = workspaceWith(keys);
    previous.views.history = { type: "history" };
    previous.floating.push({ panel: { kind: "panel", id: "panel-history", views: ["history"], selected: "history" }, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, z: 1, layer: "overlay" });
    const parked = (doc: LayoutDocument) => doc.hidden.map(({ panel }) => ({ id: panel.id, views: panel.views, selected: panel.selected }));
    const writing = presetLayout("writing", previous, documents);
    expect(parked(writing)).toEqual([
      { id: "panel-project", views: ["project", "agent"], selected: "project" },
      { id: "panel-papers", views: ["papers"], selected: "papers" },
      { id: "panel-history", views: ["history"], selected: "history" },
    ]);
    expect(writing.floating).toEqual([]);
    // From one preset to the other, a view the next one shows leaves the parked panels.
    const reading = presetLayout("reading", writing, documents);
    expect(parked(reading)).toEqual([
      { id: "panel-pdf", views: ["pdf"], selected: "pdf" },
      { id: "panel-project", views: ["project", "agent"], selected: "project" },
      { id: "panel-history", views: ["history"], selected: "history" },
    ]);
    // A parked panel whose id the preset uses takes another.
    const empty = presetLayout("writing", defaultLayout(), { activeKey: "", openTabs: [], isReading });
    expect(parked(empty)).toEqual([
      { id: "panel-project-parked", views: ["agent"], selected: "agent" },
      { id: "panel-papers", views: ["papers"], selected: "papers" },
    ]);
  });

  it("Reading with no paper open offers the library to pick one", () => {
    const doc = presetLayout("reading", workspaceWith(["main.tex"]), { activeKey: "main.tex", openTabs: ["main.tex"], isReading });
    expect(panels(doc)[0]).toEqual({ id: "panel-reading", views: ["papers"], selected: "papers" });
  });

  it("Writing with nothing open shows the Project panel beside the PDF", () => {
    const doc = presetLayout("writing", defaultLayout(), { activeKey: "", openTabs: [], isReading });
    expect(panels(doc).map((panel) => panel.views)).toEqual([["project"], ["pdf"]]);
  });

  it("returns to the writer's layout with surviving documents, new ones joined, and closed ones gone", () => {
    const previous = workspaceWith(keys);
    const preset = presetLayout("reading", previous, documents);
    // While reading: notes.md closed, draft.md opened (App's tab sync gave it a view).
    preset.views["doc-9"] = { type: "file", params: { key: "draft.md" } };
    const now = { activeKey: "draft.md", openTabs: ["main.tex", PAPER, "draft.md"] };
    const back = returnLayout(previous, preset, now);
    expect(panels(back)).toEqual([
      { id: "panel-project", views: ["project", "agent"], selected: "project" },
      { id: "panel-papers", views: ["papers"], selected: "papers" },
      { id: "panel-doc-0", views: ["doc-0", "doc-2", "doc-9"], selected: "doc-9" },
      { id: "panel-pdf", views: ["pdf"], selected: "pdf" },
    ]);
    expect(back.views["doc-1"]).toBeUndefined();
  });

  it("returns with the panels opened while away and without those closed", () => {
    const previous = workspaceWith(keys);
    previous.views.history = { type: "history" };
    delete previous.views.agent;
    findPanel(previous.root, "panel-project")!.views = ["project"];
    findPanel(previous.root, "panel-doc-0")!.views.push("history");
    const preset = presetLayout("writing", previous, documents);
    // While writing: the Agent opened (docked beside the PDF), History's drawer closed.
    preset.views.agent = { type: "agent" };
    findPanel(preset.root, "panel-pdf")!.views.push("agent");
    delete preset.views.history;
    preset.hidden = preset.hidden.filter(({ panel }) => !panel.views.includes("history"));
    const back = returnLayout(previous, preset, documents);
    expect(findPanel(back.root, "panel-doc-0")).toEqual(expect.objectContaining({ views: ["doc-0", "doc-1", "doc-2", "agent"], selected: "doc-1" }));
    expect(back.views.agent).toEqual({ type: "agent" });
    expect(back.views.history).toBeUndefined();
  });

  it("keeps a document panel whose documents all closed while away, as an empty slot", () => {
    const previous = workspaceWith(["notes.md"]);
    const back = returnLayout(previous, presetLayout("writing", previous, { ...documents, openTabs: ["notes.md"] }), { activeKey: "", openTabs: [] });
    expect(panels(back).map((panel) => panel.id)).toEqual(["panel-project", "panel-papers", "panel-doc-0", "panel-pdf"]);
    expect(findPanel(back.root, "panel-doc-0")).toMatchObject({ views: ["slot-panel-doc-0"], selected: "slot-panel-doc-0" });
    expect(back.views["slot-panel-doc-0"].type).toBe("slot");
  });

  it("returns without the panels a preset brought in, through Writing and then Reading", () => {
    // The writer's own layout: Project and the documents, no PDF and no Papers.
    const previous = workspaceWith(keys);
    delete previous.views.pdf;
    delete previous.views.papers;
    const column = (previous.root as { children: LayoutNode[] }).children[0] as { children: LayoutNode[]; weights: number[] };
    column.children = [column.children[0]];
    column.weights = [1];
    (previous.root as { children: LayoutNode[] }).children.pop();
    (previous.root as { weights: number[] }).weights.pop();
    const writing = enterPreset("writing", previous, null, documents);
    expect(writing.active.supplied).toEqual(["pdf"]);
    const reading = enterPreset("reading", writing.document, writing.active, documents);
    expect(reading.active).toEqual({ preset: "reading", previous, supplied: ["pdf", "papers"] });
    const back = returnLayout(previous, reading.document, documents, reading.active.supplied);
    expect(back.views.pdf).toBeUndefined();
    expect(back.views.papers).toBeUndefined();
    expect(panels(back)).toEqual(panels(returnLayout(previous, previous, documents)));
    // One the writer asked for while reading stays.
    const kept = returnLayout(previous, reading.document, documents, ["papers"]);
    expect(kept.views.pdf).toEqual({ type: "pdf" });
    expect(kept.views.papers).toBeUndefined();
  });

  it("persists the preset with the layout, per project", () => {
    const previous = workspaceWith(keys);
    const { document: reading, active } = enterPreset("reading", previous, null, documents);
    saveLayout("/a", { document: reading, preset: active });
    saveLayout("/b", { document: previous });
    expect(loadLayout("/a").preset?.preset).toBe("reading");
    expect(panels(loadLayout("/a").preset!.previous)).toEqual(panels(previous));
    expect(loadLayout("/b").preset).toBeNull();
  });

  it("reads a preset saved before it recorded what it supplied", () => {
    const previous = workspaceWith(keys);
    localStorage.setItem("lattice.trellis-layout.v1:/old", JSON.stringify({
      version: 2, savedAt: 0, document: presetLayout("writing", previous, documents), preset: { preset: "writing", previous },
    }));
    expect(loadLayout("/old").preset).toEqual(expect.objectContaining({ preset: "writing", supplied: [] }));
  });
});

describe("undoing a reset", () => {
  const keys = ["main.tex", "notes.md", PAPER];

  /** The writer's own layout: Papers closed (its column closes up), History docked with the documents. */
  function arranged(): LayoutDocument {
    const doc = workspaceWith(keys);
    delete doc.views.papers;
    const column = (doc.root as { children: LayoutNode[] }).children[0] as { children: LayoutNode[]; weights: number[] };
    column.children = [column.children[0]];
    column.weights = [1];
    doc.views.history = { type: "history" };
    findPanel(doc.root, "panel-doc-0")!.views.push("history");
    return sanitize(doc);
  }

  /** The default layout as a reset leaves it: App's tab sync re-placed the documents under new views. */
  function reset(open: string[]): LayoutDocument {
    let doc = withDocumentPanel(defaultLayout(), { id: "file-new0", key: open[0] }, { after: ["panel-project"] });
    open.slice(1).forEach((key, index) => {
      doc = { ...doc, views: { ...doc.views, [`file-new${index + 1}`]: { type: "file", params: { key } } } };
      findPanel(doc.root, "panel-file-new0")!.views.push(`file-new${index + 1}`);
    });
    return doc;
  }

  it("brings back the writer's arrangement, without the panels only the reset brought in", () => {
    const previous = arranged();
    const back = undoReset(previous, reset(keys), { activeKey: "main.tex", openTabs: keys }, (type) => type === "history");
    expect(panels(back)).toEqual([
      { id: "panel-project", views: ["project", "agent"], selected: "project" },
      { id: "panel-doc-0", views: ["doc-0", "doc-1", "doc-2", "history"], selected: "doc-0" },
      { id: "panel-pdf", views: ["pdf"], selected: "pdf" },
    ]);
    expect(back.views.papers).toBeUndefined();
    expect(layoutShape(back)).toBe(layoutShape(previous));
  });

  it("never brings back a document closed since, or a tool no longer open", () => {
    const open = ["main.tex", PAPER];
    const back = undoReset(arranged(), reset(open), { activeKey: PAPER, openTabs: open }, () => false);
    expect(findPanel(back.root, "panel-doc-0")).toEqual(expect.objectContaining({ views: ["doc-0", "doc-2"], selected: "doc-2" }));
    expect(back.views["doc-1"]).toBeUndefined();
    expect(back.views.history).toBeUndefined();
  });

  it("tells a change of arrangement from documents re-placed or another tab selected", () => {
    const previous = arranged();
    const same = undoReset(previous, reset(keys), { activeKey: PAPER, openTabs: keys }, () => true);
    expect(layoutShape(same)).toBe(layoutShape(previous));
    const resized = structuredClone(previous);
    (resized.root as { weights: number[] }).weights = [0.3, 0.3, 0.4];
    expect(layoutShape(resized)).not.toBe(layoutShape(previous));
    const moved = structuredClone(previous);
    findPanel(moved.root, "panel-doc-0")!.views.pop();
    findPanel(moved.root, "panel-pdf")!.views.push("history");
    expect(layoutShape(moved)).not.toBe(layoutShape(previous));
  });
});

describe("named workspaces", () => {
  beforeEach(() => localStorage.clear());
  const keys = ["main.tex", "notes.md", PAPER];

  /** Two document panels side by side: the LaTeX source and the notes left of the paper. */
  function sideBySide(): LayoutDocument {
    const doc = workspaceWith(keys);
    const first = findPanel(doc.root, "panel-doc-0")!;
    first.views = ["doc-0", "doc-1"];
    first.selected = "doc-1";
    const root = doc.root as { children: LayoutNode[]; weights: number[] };
    root.children.splice(2, 0, { kind: "panel", id: "panel-doc-2", views: ["doc-2"], selected: "doc-2" });
    root.weights = [0.25, 0.3, 0.2, 0.25];
    return doc;
  }

  it("puts each open document back where it sat in the workspace", () => {
    const own = sideBySide();
    const arranged = arrangeDocuments(arrangementOf(own), workspaceWith(keys), { activeKey: "main.tex", openTabs: keys }, placesOf(own));
    expect(panels(arranged)).toEqual([
      { id: "panel-project", views: ["project", "agent"], selected: "project" },
      { id: "panel-papers", views: ["papers"], selected: "papers" },
      { id: "panel-doc-0", views: ["doc-0", "doc-1"], selected: "doc-0" },
      { id: "panel-doc-2", views: ["doc-2"], selected: "doc-2" },
      { id: "panel-pdf", views: ["pdf"], selected: "pdf" },
    ]);
    expect(layoutShape(arranged)).toBe(layoutShape(own));
  });

  it("brings documents new to the workspace into the active one's panel, and keeps an unfilled slot", () => {
    const own = sideBySide();
    const open = ["main.tex", "refs.bib"];
    const current = workspaceWith(open);
    const arranged = arrangeDocuments(arrangementOf(own), current, { activeKey: "refs.bib", openTabs: open }, placesOf(own));
    expect(panels(arranged).map(({ id, views }) => [id, views.map((view) => arranged.views[view].params?.key ?? view)])).toEqual([
      ["panel-project", ["project", "agent"]],
      ["panel-papers", ["papers"]],
      ["panel-doc-0", ["main.tex", "refs.bib"]],
      ["panel-doc-2", ["slot-panel-doc-2"]],
      ["panel-pdf", ["pdf"]],
    ]);
    // The documents keep their views, so their tabs survive the switch.
    expect(findPanel(arranged.root, "panel-doc-0")).toMatchObject({ views: ["doc-0", "doc-1"], selected: "doc-1" });
  });

  it("fills a slot nothing returns to with a document that has no place there yet", () => {
    const stored = arrangementOf(sideBySide());
    const open = ["intro.tex", "refs.bib", "notes.md"];
    const arranged = arrangeDocuments(stored, workspaceWith(open), { activeKey: "notes.md", openTabs: open }, {});
    const keysIn = (id: string) => findPanel(arranged.root, id)!.views.map((view) => arranged.views[view].params?.key);
    expect([keysIn("panel-doc-0"), keysIn("panel-doc-2")]).toEqual([["notes.md", "refs.bib"], ["intro.tex"]]);
  });

  it("leaves documents to App's tab sync when the workspace has no place for them", () => {
    const arranged = arrangeDocuments(defaultLayout(), workspaceWith(keys), { activeKey: "main.tex", openTabs: keys }, {});
    expect(panels(arranged)).toEqual(panels(defaultLayout()));
    expect(Object.values(arranged.views).some((record) => record.type === "file")).toBe(false);
  });

  it("migrates the projects' saved layouts into one workspace, arranged as the most recent", () => {
    // Saved before workspaces (v2); the most recent was left in Writing over the writer's own layout.
    const custom = sideBySide();
    const save = (root: string, document: LayoutDocument, savedAt: number, extra = {}) => localStorage.setItem(
      `lattice.trellis-layout.v1:${root}`, JSON.stringify({ version: 2, savedAt, document, ...extra }),
    );
    const a = workspaceWith(keys);
    const b = workspaceWith(["main.tex"]);
    save("/a", a, 300);
    save("/b", b, 100);
    const { document: writing, active } = enterPreset("writing", custom, null, { activeKey: "main.tex", openTabs: keys, isReading });
    save("/c", writing, 400, { preset: active });

    const library = new WorkspaceLibrary();
    expect(library.list().map((entry) => entry.name)).toEqual(["Workspace"]);
    const [only] = library.list();
    expect(layoutShape(library.get(only.id)!.arrangement!)).toBe(layoutShape(arrangementOf(custom)));
    // Every project names it, and keeps its own document as saved.
    for (const [root, document] of [["/a", a], ["/b", b], ["/c", writing]] as const) {
      const saved = JSON.parse(localStorage.getItem(`lattice.trellis-layout.v1:${root}`)!);
      expect(saved).toMatchObject({ version: 3, workspace: only.id });
      expect(saved.document).toEqual(JSON.parse(JSON.stringify(document)));
      expect(openProjectLayout(root, library).workspace).toBe(only.id);
    }
    const c = openProjectLayout("/c", library);
    expect(c.preset?.preset).toBe("writing");
    expect(panels(c.preset!.previous)).toEqual(panels(custom));
    // Migrated once: a later library reads the same workspace.
    expect(new WorkspaceLibrary().list()).toEqual(library.list());
  });

  it("opens a project as it was left, whatever its workspace saved since", () => {
    const library = new WorkspaceLibrary();
    const id = library.recent();
    const own = workspaceWith(keys);
    saveLayout("/a", { document: own, workspace: id });
    const arrangement = arrangementOf(sideBySide());
    library.setArrangement(id, arrangement);
    const opened = openProjectLayout("/a", library);
    expect(panels(opened.document)).toEqual(panels(own));
    expect(library.get(id)!.arrangement).toEqual(arrangement);
  });

  it("opens a project whose workspace was deleted in the one last entered", () => {
    const library = new WorkspaceLibrary();
    const kept = library.recent();
    const gone = library.add("Review", null);
    saveLayout("/a", { document: workspaceWith(keys), workspace: gone });
    library.remove(gone);
    expect(openProjectLayout("/a", library).workspace).toBe(kept);
  });

  it("opens a project against the library as stored, not one this window read before another changed it", () => {
    const here = new WorkspaceLibrary();
    const there = new WorkspaceLibrary();
    const kept = here.recent();
    const review = here.add("Review", null);
    expect(there.list().map((entry) => entry.name)).toEqual(["Workspace", "Review"]);
    // Another window deletes one workspace and adds another, with no storage event heard here.
    const draft = here.add("Draft", null);
    here.remove(review);
    saveLayout("/a", { document: workspaceWith(keys), workspace: draft });
    saveLayout("/b", { document: workspaceWith(keys), workspace: review });
    expect(openProjectLayout("/b", there).workspace).toBe(kept);
    expect(there.list().map((entry) => entry.name)).toEqual(["Workspace", "Draft"]);
    expect(openProjectLayout("/a", there).workspace).toBe(draft);
  });
});
