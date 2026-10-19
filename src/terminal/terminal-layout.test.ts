import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, layout as L, type LayoutDocument, type LayoutNode, type WorkspaceHandle } from "@danfessler/trellis";
import { TrellisController } from "../trellis/trellis-controller";
import { defaultLayout, openProjectLayout, saveLayout } from "../trellis/trellis-layout";
import { arrangementOf, LAYOUT_VERSION, WorkspaceLibrary } from "../trellis/trellis-workspaces";
import { TERMINAL_SHARE, terminalHome } from "./terminal-layout";

/** The default layout with the Terminal panel docked across its foot, `share` of the height. */
function withTerminal(share: number, { hidden = false } = {}): LayoutDocument {
  const doc = defaultLayout();
  const panel = { kind: "panel" as const, id: "panel-terminal", views: ["terminal"], selected: "terminal" };
  const views = { ...doc.views, terminal: { type: "terminal" } };
  if (hidden) {
    return { ...doc, views, hidden: [{ panel, restore: { kind: "docked", beside: doc.root!.id, edge: "bottom", share } }] };
  }
  const root: LayoutNode = { kind: "split", id: "split-terminal", axis: "y", weights: [1 - share, share], children: [doc.root!, panel] };
  return { ...doc, root, views };
}

/** The share of its split the docked Terminal panel takes, or null when it is not docked. */
function terminalShare(doc: LayoutDocument): number | null {
  const find = (node: LayoutNode | null | undefined): number | null => {
    if (!node || node.kind === "panel") return null;
    if (node.kind === "stage") return find(node.child);
    const index = node.children.findIndex((child) => child.kind === "panel" && child.views.includes("terminal"));
    if (index >= 0) return node.weights[index] / node.weights.reduce((sum, weight) => sum + weight, 0);
    return node.children.reduce<number | null>((found, child) => found ?? find(child), null);
  };
  return find(doc.root);
}

/** Just enough of a Trellis workspace for the controller's open, show and hide rules. */
function fakeWorkspace(terminal: { placement: "docked" | "hidden"; visible: boolean } | null) {
  const doc = createDocument(L.row([L.panel({ id: "panel-project" }, L.view("project", { id: "project" }))]), { version: LAYOUT_VERSION });
  const ws = {
    view: (id: string) => (id === "terminal" && terminal ? { id, type: "terminal", panelId: "panel-terminal", ...terminal } : null),
    views: () => [],
    getDocument: () => doc,
    focus: vi.fn(),
    hide: vi.fn(),
    dock: vi.fn(),
    open: vi.fn(() => ({ id: "terminal" })),
  };
  return { ws, root: doc.root!.id };
}

describe("the Terminal panel's place", () => {
  beforeEach(() => localStorage.clear());

  it("opens across the foot of the whole workspace", () => {
    const { ws, root } = fakeWorkspace(null);
    expect(terminalHome(ws as unknown as WorkspaceHandle)).toEqual({ beside: root, edge: "bottom", share: TERMINAL_SHARE });
    expect(terminalHome(null)).toBe("side");
  });

  it("opens when closed, hides when on screen and comes back when hidden, on the same toggle", () => {
    const controller = new TrellisController();
    const closed = fakeWorkspace(null);
    controller.attachWorkspace(closed.ws as unknown as WorkspaceHandle);
    controller.togglePanel("terminal");
    expect(closed.ws.open).toHaveBeenCalledWith("terminal", {
      id: "terminal", focus: true, placement: { beside: closed.root, edge: "bottom", share: TERMINAL_SHARE },
    });
    const shown = fakeWorkspace({ placement: "docked", visible: true });
    controller.attachWorkspace(shown.ws as unknown as WorkspaceHandle);
    controller.togglePanel("terminal");
    expect(shown.ws.hide).toHaveBeenCalledWith("terminal");
    const hidden = fakeWorkspace({ placement: "hidden", visible: false });
    controller.attachWorkspace(hidden.ws as unknown as WorkspaceHandle);
    controller.togglePanel("terminal");
    expect(hidden.ws.focus).toHaveBeenCalledWith("terminal");
    expect(hidden.ws.open).not.toHaveBeenCalled();
  });

  it("a project's saved layout keeps the panel open at its height, or hidden", () => {
    const library = new WorkspaceLibrary();
    saveLayout("/projects/thesis", { document: withTerminal(0.25) });
    const reopened = openProjectLayout("/projects/thesis", library).document;
    expect(reopened.views.terminal).toEqual({ type: "terminal" });
    expect(terminalShare(reopened)).toBeCloseTo(0.25);
    saveLayout("/projects/notes", { document: withTerminal(0.4, { hidden: true }) });
    const hidden = openProjectLayout("/projects/notes", library).document;
    expect(hidden.hidden.map((entry) => entry.panel.views)).toEqual([["terminal"]]);
    expect(terminalShare(hidden)).toBeNull();
  });

  it("a named workspace keeps the panel and its height in its arrangement", () => {
    const library = new WorkspaceLibrary();
    const id = library.add("With a terminal", arrangementOf(withTerminal(0.35)));
    const arrangement = new WorkspaceLibrary().get(id)?.arrangement;
    expect(arrangement?.views.terminal).toEqual({ type: "terminal" });
    expect(terminalShare(arrangement!)).toBeCloseTo(0.35);
  });
});
