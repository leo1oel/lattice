import { describe, expect, it, vi } from "vitest";
import type { WorkspaceHandle } from "@danfessler/trellis";
import { TrellisController } from "./trellis-controller";

type FakeView = { id: string; type: string; placement: "docked" | "hidden"; visible: boolean; panelId: string; params?: { key: string } };

/** Just enough of a Trellis workspace for the controller's reveal and toggle rules. */
function fakeWorkspace(views: FakeView[]) {
  const calls: string[] = [];
  const ws = {
    view: (id: string) => views.find((view) => view.id === id) ?? null,
    views: (filter?: { type?: string }) => views.filter((view) => !filter?.type || view.type === filter.type),
    dock: vi.fn(),
    focus: vi.fn((id: string) => calls.push(`focus ${id}`)),
    hide: vi.fn((id: string) => calls.push(`hide ${id}`)),
    open: vi.fn((type: string) => {
      calls.push(`open ${type}`);
      return { id: type };
    }),
  };
  return { ws: ws as unknown as WorkspaceHandle, calls };
}

describe("TrellisController", () => {
  it("hides a panel only when it is on screen; one behind a tab or hidden comes forward", () => {
    const controller = new TrellisController();
    const { ws, calls } = fakeWorkspace([
      { id: "project", type: "project", placement: "docked", visible: true, panelId: "a" },
      { id: "papers", type: "papers", placement: "docked", visible: false, panelId: "b" },
      { id: "agent", type: "agent", placement: "hidden", visible: false, panelId: "c" },
    ]);
    controller.attachWorkspace(ws);
    controller.togglePanel("project");
    controller.togglePanel("papers");
    controller.togglePanel("agent");
    expect(calls).toEqual(["hide project", "focus papers", "focus agent"]);
  });

  it("reveals a tool panel again when its drawer is already open, and leaves a closed one to the drawer", () => {
    const controller = new TrellisController();
    const { ws, calls } = fakeWorkspace([{ id: "history", type: "history", placement: "docked", visible: false, panelId: "t" }]);
    controller.attachWorkspace(ws);
    controller.revealOpenTool("history");
    expect(calls).toEqual([]);
    controller.openDrawers.set({ history: () => {} });
    controller.revealOpenTool("history");
    expect(calls).toEqual(["focus history"]);
  });

  it("leaves a tool panel restored from a saved layout where it was when its drawer reopens", () => {
    // Reloaded in the Reading layout, the Source control panel parked hidden
    // asked for its drawer, which then docked it into the notes.
    const controller = new TrellisController();
    const { ws, calls } = fakeWorkspace([
      { id: "file", type: "file", params: { key: "notes.md" }, placement: "docked", visible: true, panelId: "panel-notes" },
      { id: "git", type: "git", placement: "hidden", visible: false, panelId: "parked-git" },
    ]);
    controller.attachWorkspace(ws);
    controller.app.set({ activeKey: "notes.md" });
    controller.openDrawer("git", () => {});
    expect(ws.dock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // A drawer opened with no panel of its own still brings one up beside the document.
    controller.openDrawer("comments", () => {});
    expect(ws.open).toHaveBeenCalledWith("comments", { id: "comments", placement: { into: "panel-notes" } });
  });

  it("opens tools in the last panel under the pointer and moves existing tools there", () => {
    const controller = new TrellisController();
    const { ws } = fakeWorkspace([
      { id: "project", type: "project", placement: "docked", visible: true, panelId: "left" },
      { id: "history", type: "history", placement: "docked", visible: true, panelId: "old" },
    ]);
    controller.attachWorkspace(ws);
    const panel = document.createElement("div");
    panel.dataset.trellisPart = "panel";
    panel.dataset.panel = "left";
    controller.rememberPointerPanel(panel);
    controller.revealTool("comments");
    expect(ws.open).toHaveBeenCalledWith("comments", { id: "comments", placement: { into: "left" } });
    controller.revealTool("history");
    expect(ws.dock).toHaveBeenCalledWith("history", { into: "left" });
    expect(ws.focus).toHaveBeenCalledWith("history");
  });

  it("falls back to the active document when the hovered panel has gone away", () => {
    const controller = new TrellisController();
    const { ws } = fakeWorkspace([
      { id: "file", type: "file", params: { key: "main.tex" }, placement: "docked", visible: true, panelId: "editor" },
    ]);
    controller.attachWorkspace(ws);
    controller.app.set({ activeKey: "main.tex" });
    const panel = document.createElement("div");
    panel.dataset.trellisPart = "panel";
    panel.dataset.panel = "closed";
    controller.rememberPointerPanel(panel);
    controller.revealTool("comments");
    expect(ws.open).toHaveBeenCalledWith("comments", { id: "comments", placement: { into: "editor" } });
  });

  it("does not activate a file from focus while it is being dragged in from the Project panel", () => {
    vi.useFakeTimers();
    const controller = new TrellisController();
    const activate = vi.fn();
    controller.setBridge({ activate } as unknown as Parameters<TrellisController["setBridge"]>[0]);
    controller.pendingDrops.add("notes.md");
    controller.activateFromFocus("notes.md");
    controller.activateFromFocus("main.tex");
    vi.runAllTimers();
    expect(activate.mock.calls).toEqual([["main.tex"]]);
    vi.useRealTimers();
  });

  it("does not activate a PDF from focus while its Reading snapshot is being used", () => {
    vi.useFakeTimers();
    const controller = new TrellisController();
    const activate = vi.fn();
    controller.setBridge({ activate } as unknown as Parameters<TrellisController["setBridge"]>[0]);
    controller.holdReading("reference.pdf");
    controller.activateFromFocus("reference.pdf");
    controller.activateFromFocus("main.tex");
    vi.runAllTimers();
    expect(activate.mock.calls).toEqual([["main.tex"]]);
    // Released by the next press elsewhere, and stale once it is old.
    controller.holdReading(null);
    controller.activateFromFocus("reference.pdf");
    vi.runAllTimers();
    controller.holdReading("paper.pdf");
    vi.advanceTimersByTime(600);
    controller.activateFromFocus("paper.pdf");
    vi.runAllTimers();
    expect(activate.mock.calls).toEqual([["main.tex"], ["reference.pdf"], ["paper.pdf"]]);
    vi.useRealTimers();
  });
});
