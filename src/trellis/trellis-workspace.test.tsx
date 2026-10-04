import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LayoutDocument, LayoutNode } from "@danfessler/trellis";
import { TrellisController } from "./trellis-controller";
import { defaultLayout, loadLayout, saveLayout } from "./trellis-layout";
import TrellisWorkspace from "./trellis-workspace";
import { arrangementOf, layoutShape, withDocumentPanel, WorkspaceLibrary } from "./trellis-workspaces";

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
  controller.app.set({ projectRoot, activeKey: openTabs[0] ?? "", openTabs, tabsReady: true });
  const view = render(<TrellisWorkspace controller={controller} projectRoot={projectRoot} dark={false} />);
  await waitFor(() => expect(controller.ws?.views({ type: "file" })).toHaveLength(openTabs.length));
  return { controller, ws: controller.ws!, unmount: view.unmount };
}

/** The workspace's arrangement as saved (a fresh library reads it from storage). */
const stored = (id: string) => new WorkspaceLibrary().get(id)!.arrangement!;

/** The document panels of `doc`, each by the documents it holds. */
function documentPanels(doc: LayoutDocument) {
  const found: string[][] = [];
  const walk = (node: LayoutNode | null | undefined) => {
    if (!node) return;
    if (node.kind === "panel") {
      const keys = node.views.flatMap((id) => (doc.views[id]?.type === "file" ? [String(doc.views[id].params?.key)] : []));
      if (keys.length || node.views.some((id) => doc.views[id]?.type === "slot")) found.push(keys);
    } else if (node.kind === "stage") walk(node.child);
    else node.children.forEach(walk);
  };
  walk(doc.root);
  return found;
}

const SAVED = () => layoutShape(arrangementOf(split()));

describe("a named workspace", () => {
  it("is never written by selecting tabs or opening and closing documents, which leave it clean", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    // Project B enters this workspace from another with one document: the second split is an empty slot.
    const other = new WorkspaceLibrary().add("Other", null);
    saveLayout("/b", { document: defaultLayout(), workspace: other });
    const { controller, ws, unmount } = await open("/b", ["main.tex"]);
    act(() => controller.switchWorkspace(id));
    const dirty = () => controller.ui.get().dirty;
    const [main] = ws.views({ type: "file" });
    const [slot] = ws.views({ type: "slot" });
    expect(slot.panelId).not.toBe(main.panelId);
    expect(dirty()).toBe(false);
    // Clicking between tabs, and cycling them with the keyboard.
    act(() => ws.select("agent"));
    act(() => ws.select("project"));
    act(() => ws.select(main.id));
    act(() => ws.focus("project"));
    act(() => ws.run("tab.next"));
    expect(ws.view("agent")?.selected).toBe(true);
    act(() => ws.run("tab.previous"));
    expect(ws.view("project")?.selected).toBe(true);
    expect(dirty()).toBe(false);
    // A document opened by App's tab sync fills the empty slot, which leaves.
    act(() => controller.app.set({ openTabs: OPEN, activeKey: "notes.md" }));
    await waitFor(() => expect(ws.views({ type: "file" })).toHaveLength(2));
    expect(ws.views({ type: "file" }).find((view) => view.params.key === "notes.md")!.panelId).toBe(slot.panelId);
    expect(ws.views({ type: "slot" })).toHaveLength(0);
    expect(dirty()).toBe(false);
    // Closing it by its tab keeps its panel, an empty slot again.
    const notes = ws.views({ type: "file" }).find((view) => view.params.key === "notes.md")!;
    await act(async () => { await ws.close(notes.id); });
    expect(ws.views({ type: "slot" }).map((view) => view.panelId)).toEqual([notes.panelId]);
    expect(dirty()).toBe(false);
    unmount();
    expect(layoutShape(stored(id))).toBe(SAVED());
    // Project A, opened again, keeps its split.
    const again = await open("/a", OPEN);
    expect(documentPanels(again.ws.getDocument())).toEqual([["main.tex"], ["notes.md"]]);
  });

  it("is not written by rearranging a project in it, which then differs from it", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    const notes = ws.views({ type: "file" }).find((view) => view.params.key === "notes.md")!;
    const main = ws.views({ type: "file" }).find((view) => view.params.key === "main.tex")!;
    // The writer drags the notes back beside the source: their split closes up.
    act(() => { ws.dock(notes.id, { into: main.panelId }); });
    expect(controller.ui.get().dirty).toBe(true);
    unmount();
    expect(layoutShape(stored(id))).toBe(SAVED());
    // The project reopens as it was left, still differing from its workspace.
    const again = await open("/a", OPEN);
    expect(documentPanels(again.ws.getDocument())).toEqual([["main.tex", "notes.md"]]);
    expect(again.controller.ui.get().dirty).toBe(true);
  });

  it("is not written by a preset entered and left with panels changed meanwhile", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    act(() => controller.setPreset("writing"));
    // Writing over the workspace is no change of the writer's own layout.
    expect(controller.ui.get().dirty).toBe(false);
    // The Agent, parked hidden by Writing, closes meanwhile.
    await act(async () => { await ws.close("agent", { force: true }); });
    act(() => controller.setPreset(null));
    expect(ws.view("agent")).toBeNull();
    act(() => ws.select("project"));
    unmount();
    expect(layoutShape(stored(id))).toBe(SAVED());
  });

  it("is not written by switching away from it, nor is the one entered", async () => {
    const id = splitWorkspace();
    const other = new WorkspaceLibrary().add("Other", null);
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    act(() => ws.dock("pdf", { beside: ws.views({ type: "file" })[0].panelId, edge: "bottom" }));
    act(() => controller.switchWorkspace(other));
    expect(controller.ui.get()).toMatchObject({ workspace: other, dirty: false });
    unmount();
    expect(layoutShape(stored(id))).toBe(SAVED());
    expect(new WorkspaceLibrary().get(other)!.arrangement).toBeNull();
  });

  it("differs once split, saves that arrangement for another project to load, and is clean again", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    const [main] = ws.views({ type: "file" });
    act(() => ws.dock("pdf", { beside: main.panelId, edge: "bottom" }));
    expect(controller.ui.get().dirty).toBe(true);
    act(() => controller.saveWorkspace());
    expect(controller.ui.get().dirty).toBe(false);
    const saved = layoutShape(arrangementOf(ws.getDocument()));
    unmount();
    expect(layoutShape(stored(id))).toBe(saved);
    // Project B, in another workspace, switches into it and gets it.
    const other = new WorkspaceLibrary().add("Other", arrangementOf(split()));
    saveLayout("/b", { document: split(), workspace: other });
    const b = await open("/b", OPEN);
    act(() => b.controller.switchWorkspace(id));
    expect(layoutShape(arrangementOf(b.ws.getDocument()))).toBe(saved);
    expect(b.controller.ui.get().dirty).toBe(false);
  });

  it("reverts to its saved arrangement with the open documents kept, and is clean again", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws } = await open("/a", OPEN);
    const notes = ws.views({ type: "file" }).find((view) => view.params.key === "notes.md")!;
    const main = ws.views({ type: "file" }).find((view) => view.params.key === "main.tex")!;
    act(() => { ws.dock(notes.id, { into: main.panelId }); });
    act(() => ws.dock("pdf", { beside: main.panelId, edge: "bottom" }));
    expect(controller.ui.get().dirty).toBe(true);
    act(() => controller.revertWorkspace());
    expect(layoutShape(arrangementOf(ws.getDocument()))).toBe(SAVED());
    expect(ws.views({ type: "file" }).map((view) => view.params.key).sort()).toEqual([...OPEN].sort());
    expect(controller.ui.get().dirty).toBe(false);
    expect(layoutShape(stored(id))).toBe(SAVED());
  });

  it("leaves no slot behind when a file dragged from the Project panel goes back", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    let dragging = false;
    act(() => { dragging = controller.beginFileDrag("refs.bib", { pointerId: 7 } as PointerEvent); });
    expect(dragging).toBe(true);
    expect(ws.views({ type: "file" }).map((view) => view.params.key)).toContain("refs.bib");
    window.dispatchEvent(Object.assign(new Event("pointercancel"), { pointerId: 7 }));
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    await act(async () => {});
    expect(ws.views({ type: "file" }).map((view) => view.params.key)).not.toContain("refs.bib");
    expect(ws.views({ type: "slot" })).toHaveLength(0);
    expect(controller.ui.get().dirty).toBe(false);
    unmount();
    expect(layoutShape(stored(id))).toBe(SAVED());
  });

  it("saved with no document open keeps a place for one, so opening a document leaves it clean", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    // Every document closes, and the writer closes the empty panels they leave.
    act(() => controller.app.set({ openTabs: [], activeKey: "" }));
    await waitFor(() => expect(ws.views({ type: "file" })).toHaveLength(0));
    for (const slot of ws.views({ type: "slot" })) await act(async () => { await ws.close(slot.id); });
    expect(ws.views({ type: "slot" })).toHaveLength(0);
    act(() => controller.saveWorkspace());
    const saved = layoutShape(stored(id));
    expect(documentPanels(stored(id))).toEqual([[]]);
    act(() => controller.app.set({ openTabs: ["main.tex"], activeKey: "main.tex" }));
    await waitFor(() => expect(ws.views({ type: "file" })).toHaveLength(1));
    expect(controller.ui.get().dirty).toBe(false);
    unmount();
    expect(layoutShape(stored(id))).toBe(saved);
  });

  it("added with no document open keeps a place for one, so opening a document leaves it clean", async () => {
    saveLayout("/a", { document: defaultLayout() });
    const { controller, ws, unmount } = await open("/a", []);
    let id: string | null = null;
    act(() => { id = controller.createWorkspace("Empty"); });
    expect(id).not.toBeNull();
    const saved = layoutShape(stored(id!));
    expect(documentPanels(stored(id!))).toEqual([[]]);
    expect(controller.ui.get()).toMatchObject({ workspace: id, dirty: false });
    act(() => controller.app.set({ openTabs: ["main.tex"], activeKey: "main.tex" }));
    await waitFor(() => expect(ws.views({ type: "file" })).toHaveLength(1));
    expect(controller.ui.get().dirty).toBe(false);
    unmount();
    expect(layoutShape(stored(id!))).toBe(saved);
  });

  it("saved again with no document, after a panel took the place it made, loads with every panel", async () => {
    saveLayout("/a", { document: defaultLayout() });
    const { controller, ws, unmount } = await open("/a", []);
    // A never-saved workspace loads with a place for documents.
    act(() => controller.revertWorkspace());
    const [slot] = ws.views({ type: "slot" });
    act(() => { ws.dock("pdf", { into: slot.panelId }); });
    await act(async () => { await ws.close(slot.id); });
    expect(ws.views({ type: "slot" })).toHaveLength(0);
    act(() => controller.saveWorkspace());
    act(() => controller.revertWorkspace());
    const doc = ws.getDocument();
    const panels: string[] = [];
    const walk = (node: LayoutNode | null | undefined) => {
      if (!node) return;
      if (node.kind === "panel") panels.push(node.id);
      else if (node.kind === "stage") walk(node.child);
      else node.children.forEach(walk);
    };
    walk(doc.root);
    expect(new Set(panels).size).toBe(panels.length);
    expect(ws.view("pdf")).not.toBeNull();
    expect(ws.views({ type: "slot" })).toHaveLength(1);
    expect(controller.ui.get().dirty).toBe(false);
    unmount();
  });

  it("deleted by another window, moves the project to the one last entered with its layout kept", async () => {
    const id = splitWorkspace();
    const other = new WorkspaceLibrary().add("Other", null);
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws, unmount } = await open("/a", OPEN);
    const before = documentPanels(ws.getDocument());
    act(() => {
      new WorkspaceLibrary().remove(id);
      window.dispatchEvent(new StorageEvent("storage", { key: "lattice.trellis-workspaces.v1" }));
    });
    expect(controller.ui.get().workspace).toBe(other);
    expect(documentPanels(ws.getDocument())).toEqual(before);
    // The split differs from Other, never saved: Save makes it Other's.
    expect(controller.ui.get().dirty).toBe(true);
    act(() => controller.saveWorkspace());
    expect(controller.ui.get().dirty).toBe(false);
    expect(layoutShape(stored(other))).toBe(SAVED());
    act(() => controller.revertWorkspace());
    expect(documentPanels(ws.getDocument())).toEqual(before);
    expect(controller.ui.get()).toMatchObject({ workspace: other, dirty: false });
    unmount();
    expect(loadLayout("/a").workspace).toBe(other);
  });
});
