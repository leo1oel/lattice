import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LayoutDocument, LayoutNode } from "@danfessler/trellis";
import { TrellisController } from "./trellis-controller";
import { arrangeDocuments, defaultLayout, saveLayout, withDocumentPanel } from "./trellis-layout";
import TrellisWorkspace from "./trellis-workspace";
import { arrangementOf, layoutShape, WorkspaceLibrary } from "./trellis-workspaces";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const OPEN = ["main.tex", "notes.md"];

/** The source and the notes in two document panels side by side. */
function split(): LayoutDocument {
  const doc = withDocumentPanel(defaultLayout(), { id: "doc-0", key: "main.tex" }, { after: ["panel-project"] });
  doc.views["doc-1"] = { type: "file", params: { key: "notes.md" } };
  const root = doc.root as { children: LayoutNode[]; weights: number[] };
  const at = root.children.findIndex((child) => child.kind === "panel" && child.id === "panel-doc-0") + 1;
  root.children.splice(at, 0, { kind: "panel", id: "panel-doc-1", views: ["doc-1"], selected: "doc-1" });
  root.weights = root.children.map(() => 1 / root.children.length);
  return doc;
}

/** A library whose one workspace stores the split, as persisted. */
function splitWorkspace() {
  const library = new WorkspaceLibrary();
  const id = library.recent();
  library.setArrangement(id, arrangementOf(split()));
  return id;
}

async function open(projectRoot: string, openTabs: string[]) {
  const controller = new TrellisController();
  controller.app.set({ projectRoot, activeKey: openTabs[0], openTabs, tabsReady: true });
  const view = render(<TrellisWorkspace controller={controller} projectRoot={projectRoot} dark={false} />);
  await waitFor(() => expect(controller.ws?.views({ type: "file" })).toHaveLength(openTabs.length));
  return { controller, ws: controller.ws!, unmount: view.unmount };
}

/** The workspace's arrangement as saved (a fresh library reads it from storage). */
const stored = (id: string) => new WorkspaceLibrary().get(id)!.arrangement!;

/** How many document panels another project entering the workspace with both documents open gets. */
function documentPanels(arrangement: LayoutDocument) {
  const current = withDocumentPanel(defaultLayout(), { id: "doc-0", key: "main.tex" }, { after: ["panel-project"] });
  current.views["doc-1"] = { type: "file", params: { key: "notes.md" } };
  const arranged = arrangeDocuments(arrangement, current, { activeKey: "main.tex", openTabs: OPEN }, {});
  let count = 0;
  const walk = (node: LayoutNode | null | undefined) => {
    if (!node) return;
    if (node.kind === "panel") count += node.views.some((id) => arranged.views[id]?.type === "file") ? 1 : 0;
    else if (node.kind === "stage") walk(node.child);
    else node.children.forEach(walk);
  };
  walk(arranged.root);
  return count;
}

describe("a named workspace's arrangement", () => {
  it("records a split the writer merged away", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { ws, unmount } = await open("/a", OPEN);
    const notes = ws.views({ type: "file" }).find((view) => view.params.key === "notes.md")!;
    const main = ws.views({ type: "file" }).find((view) => view.params.key === "main.tex")!;
    expect(notes.panelId).not.toBe(main.panelId);
    // The writer drags the notes back beside the source: their split closes up.
    act(() => { ws.dock(notes.id, { into: main.panelId }); });
    expect(ws.views({ type: "file" }).every((view) => view.panelId === main.panelId)).toBe(true);
    unmount();
    expect(layoutShape(stored(id))).toBe(layoutShape(arrangementOf(ws.getDocument())));
    // Entering it from another project with both documents open keeps them together.
    expect(documentPanels(stored(id))).toBe(1);
  });

  it("keeps a split App's tab sync left unfilled, even once a second document joins the first", async () => {
    const id = splitWorkspace();
    const { controller, ws, unmount } = await open("/b", ["main.tex"]);
    // One document: the second split closed up.
    act(() => controller.app.set({ openTabs: OPEN, activeKey: "notes.md" }));
    await waitFor(() => expect(ws.views({ type: "file" })).toHaveLength(2));
    const [first, second] = ws.views({ type: "file" });
    expect(second.panelId).toBe(first.panelId);
    unmount();
    expect(layoutShape(stored(id))).toBe(layoutShape(arrangementOf(split())));
    // Another project entering it with both documents open gets the split.
    expect(documentPanels(stored(id))).toBe(2);
  });
});
