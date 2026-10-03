import { describe, expect, it } from "vitest";
import type { LayoutDocument, LayoutNode, PanelNode } from "@danfessler/trellis";
import { defaultLayout, enterPreset, loadLayout, presetLayout, returnLayout, saveLayout, withDocumentPanel } from "./trellis-layout";

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

  it("closes up a panel whose documents all closed while away", () => {
    const previous = workspaceWith(["notes.md"]);
    const back = returnLayout(previous, presetLayout("writing", previous, { ...documents, openTabs: ["notes.md"] }), { activeKey: "", openTabs: [] });
    expect(panels(back).map((panel) => panel.id)).toEqual(["panel-project", "panel-papers", "panel-pdf"]);
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
    saveLayout("/a", reading, active);
    saveLayout("/b", previous);
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
