import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, layout as L, type LayoutDocument, type LayoutNode } from "@danfessler/trellis";
import { TrellisController } from "./trellis-controller";
import { defaultLayout, differsFromWorkspace, loadLayout, saveLayout } from "./trellis-layout";
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

  it("is where a project without a layout of its own starts, its documents in its places", async () => {
    // Proofing: the source beside the PDF, the navigators gone.
    const proofing = arrangementOf(createDocument(L.row([
      L.panel({ id: "panel-proof" }, L.view("slot", { id: "slot-panel-proof" })),
      L.panel({ id: "panel-pdf" }, L.view("pdf", { id: "pdf" })),
    ], [0.7, 0.3]), { version: 3 }));
    const library = new WorkspaceLibrary();
    const id = library.add("Proofing", proofing);
    library.use(id);
    const { controller, ws } = await open("/new", OPEN);
    expect(controller.ui.get()).toMatchObject({ workspace: id, dirty: false });
    expect(layoutShape(arrangementOf(ws.getDocument()))).toBe(layoutShape(proofing));
    expect(documentPanels(ws.getDocument())).toEqual([OPEN]);
    expect(ws.view("project")).toBeNull();
  });

  it("saved by another window, keeps the project's layout and marks it as differing, or no longer", async () => {
    const id = splitWorkspace();
    saveLayout("/a", { document: split(), workspace: id });
    const { controller, ws } = await open("/a", OPEN);
    const before = documentPanels(ws.getDocument());
    const saveElsewhere = (arrangement: LayoutDocument) => act(() => {
      new WorkspaceLibrary().setArrangement(id, arrangement);
      window.dispatchEvent(new StorageEvent("storage", { key: "lattice.trellis-workspaces.v1" }));
    });
    expect(controller.ui.get().dirty).toBe(false);
    // The other window saves its own arrangement, with the documents in one panel.
    saveElsewhere(arrangementOf(defaultLayout()));
    expect(differsFromWorkspace(ws.getDocument(), controller.workspaces, id)).toBe(true);
    expect(controller.ui.get().dirty).toBe(true);
    expect(documentPanels(ws.getDocument())).toEqual(before);
    // And then this project's own: nothing left to save or revert.
    saveElsewhere(arrangementOf(split()));
    expect(controller.ui.get().dirty).toBe(false);
    expect(documentPanels(ws.getDocument())).toEqual(before);
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
    expect(loadLayout("/a")?.workspace).toBe(other);
  });
});

/** Two documents side by side, the second an asset (an image) or a deck. */
async function openBeside(second: string) {
  const document = split();
  document.views["doc-1"] = { type: "file", params: { key: second } };
  saveLayout("/a", { document });
  const controller = new TrellisController();
  const readAsset = vi.fn(async (path: string) => ({ path, mimeType: "image/png", url: "data:image/png;base64," }));
  controller.setBridge({
    tabKind: (key: string) => (key.endsWith(".png") ? "asset" : "file"),
    tabLabel: (key: string) => key,
    readAsset,
    activate: () => {},
    viewState: () => undefined,
    rememberViewState: () => {},
    readText: async () => "",
    documentMode: () => "source",
    agentShown: () => {},
    openTool: () => {},
    panelMenu: () => [],
  } as unknown as Parameters<TrellisController["setBridge"]>[0]);
  const openTabs = ["main.tex", second];
  controller.app.set({ projectRoot: "/a", activeKey: "main.tex", openTabs, tabsReady: true });
  render(<TrellisWorkspace controller={controller} projectRoot="/a" dark={false} />);
  await waitFor(() => expect(controller.ws?.views({ type: "file" })).toHaveLength(2));
  const ws = controller.ws!;
  const viewOf = (key: string) => ws.views({ type: "file" }).find((view) => view.params.key === key)!;
  return { controller, ws, readAsset, viewOf };
}

describe("an inactive document on screen", () => {
  // jsdom has no layout: give the workspace host a window's box (as the App suites do), so its panels are on screen.
  const natives = (["clientWidth", "clientHeight"] as const).map((axis) => [axis, Object.getOwnPropertyDescriptor(Element.prototype, axis)!] as const);
  beforeEach(() => {
    for (const [axis, native] of natives) {
      Object.defineProperty(Element.prototype, axis, {
        configurable: true,
        get(this: Element) { return this.hasAttribute("data-trellis-host") ? (axis === "clientWidth" ? 1440 : 900) : native.get!.call(this); },
      });
    }
  });
  afterEach(() => {
    for (const [axis, native] of natives) Object.defineProperty(Element.prototype, axis, native);
  });

  // Beta r20: "Why do tabs go to sleep even when they remain open?"
  it("stays drawn beside the active document, and with that document's panel hidden", async () => {
    const { ws, readAsset, viewOf } = await openBeside("figure.png");
    await waitFor(() => expect(document.querySelector(".trellis-pdf-snapshot")).toBeInTheDocument());
    act(() => ws.view(viewOf("main.tex").id)!.hide());
    await waitFor(() => expect(ws.view(viewOf("main.tex").id)!.placement).toBe("hidden"));
    expect(document.querySelector(".trellis-pdf-snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Sleeping · click to open")).toBeNull();
    expect(readAsset).toHaveBeenCalledWith("figure.png");
  });

  it("waits as a card while it has only just covered the active document in its own panel", async () => {
    const { ws, readAsset, viewOf } = await openBeside("figure.png");
    act(() => ws.dock(viewOf("figure.png").id, { into: viewOf("main.tex").panelId }));
    act(() => ws.select(viewOf("figure.png").id));
    await waitFor(() => expect(screen.getByText("Sleeping · click to open")).toBeInTheDocument());
    readAsset.mockClear();
    expect(document.querySelector(".trellis-pdf-snapshot")).toBeNull();
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("wakes the PDF a layout switch brings back once the switch has animated, not in its frames", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const { controller, ws } = await openBeside("figure.png");
      await waitFor(() => expect(controller.ui.get().pdfLive).toBe(true));
      // A layout without the PDF panel, then one that brings it back.
      await act(async () => { await ws.close("pdf"); });
      await waitFor(() => expect(controller.ui.get().pdfLive).toBe(false));
      act(() => controller.beginSwitch());
      act(() => controller.showPanel("pdf", { focus: false }));
      await waitFor(() => expect(controller.ui.get().present.pdf).toBe(true));
      expect(controller.ui.get().pdfLive).toBe(false);
      act(() => { vi.advanceTimersByTime(500); });
      expect(controller.ui.get().pdfLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a deck's own host in its panel, active or not, until the panel has been hidden a while", async () => {
    // Only the timers: Trellis animates the hide by frames.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const deck = "slides/talk/index.tsx";
      const { controller, ws, viewOf } = await openBeside(deck);
      const host = controller.decks.host(deck);
      await waitFor(() => expect(ws.view(viewOf(deck).id)!.element.contains(host)).toBe(true));
      act(() => controller.app.set({ activeKey: deck }));
      act(() => controller.app.set({ activeKey: "main.tex" }));
      expect(ws.view(viewOf(deck).id)!.element.contains(host)).toBe(true);
      expect(controller.decks.sleeping()).toEqual([]);
      act(() => ws.view(viewOf(deck).id)!.hide());
      await waitFor(() => expect(ws.view(viewOf(deck).id)!.visible).toBe(false));
      act(() => { vi.advanceTimersByTime(19_000); });
      expect(controller.decks.sleeping()).toEqual([]);
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(controller.decks.sleeping()).toEqual([deck]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes an inactive deck the active document once focus moves into its frame", async () => {
    const deck = "slides/talk/index.tsx";
    const { controller, ws, viewOf } = await openBeside(deck);
    const host = controller.decks.host(deck);
    await waitFor(() => expect(ws.view(viewOf(deck).id)!.element.contains(host)).toBe(true));
    const activate = vi.spyOn(controller, "activate").mockImplementation(() => {});
    const frame = document.createElement("iframe");
    host.append(frame);
    const otherFrame = document.createElement("iframe");
    document.body.append(otherFrame);
    // Focus moving into a frame fires no focusin here: only what this page can observe.
    let focused: Element = document.body;
    const activeElement = vi.spyOn(document, "activeElement", "get").mockImplementation(() => focused);
    try {
      // A blur elsewhere (another app's window) leaves the deck alone.
      act(() => { window.dispatchEvent(new Event("blur")); });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(activate).not.toHaveBeenCalled();
      // A press from another deck's frame into this one: the window is already blurred and nothing fires.
      focused = otherFrame;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(activate).not.toHaveBeenCalled();
      focused = frame;
      await waitFor(() => expect(activate).toHaveBeenCalledWith(deck));
      activate.mockClear();
      // A press from this page into the frame: the window's blur.
      focused = document.body;
      act(() => { window.dispatchEvent(new Event("focus")); });
      act(() => { window.dispatchEvent(new Event("blur")); });
      focused = frame;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(activate).toHaveBeenCalledWith(deck);
    } finally {
      activeElement.mockRestore();
      otherFrame.remove();
    }
    activate.mockClear();
    // Another document becoming active without taking focus leaves none in
    // the deck's frame, so pressing back into it is a move this page sees.
    act(() => controller.app.set({ activeKey: deck }));
    act(() => { frame.focus(); });
    expect(activate).not.toHaveBeenCalled();
    act(() => controller.app.set({ activeKey: "main.tex" }));
    expect(document.activeElement).not.toBe(frame);
    act(() => { frame.focus(); });
    expect(activate).toHaveBeenCalledWith(deck);
  });
});
