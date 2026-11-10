import { describe, expect, it, vi } from "vitest";
import type { WorkspaceHandle } from "@danfessler/trellis";
import { TrellisController } from "../trellis/trellis-controller";

const closeActiveTerminal = vi.fn(() => true);
vi.mock("./terminal-load", () => ({
  loadTerminalPanel: { loaded: () => ({ closeActiveTerminal }) },
}));

const { closeFocusedTerminal } = await import("./close-focused-terminal");

const VIEWS = [
  { id: "doc-main", type: "file" },
  { id: "terminal", type: "terminal" },
];

function controllerOn(focusedView: string | null) {
  const close = vi.fn(async () => true);
  const ws = {
    views: (filter?: { type?: string }) => VIEWS.filter((view) => !filter?.type || view.type === filter.type),
    getSnapshot: () => ({ focusedView }),
    close,
  };
  const controller = new TrellisController();
  controller.attachWorkspace(ws as unknown as WorkspaceHandle);
  return { controller, close };
}

describe("closeFocusedTerminal", () => {
  it("closes the terminal in front when the Terminal panel has focus", () => {
    closeActiveTerminal.mockClear().mockReturnValue(true);
    const { controller, close } = controllerOn("terminal");
    expect(closeFocusedTerminal(controller)).toBe(true);
    expect(closeActiveTerminal).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes the panel once no terminal is left in it", () => {
    closeActiveTerminal.mockClear().mockReturnValue(false);
    const { controller, close } = controllerOn("terminal");
    expect(closeFocusedTerminal(controller)).toBe(true);
    expect(close.mock.calls).toEqual([["terminal"]]);
  });

  it("leaves ⌘W to the documents when the focus is elsewhere", () => {
    closeActiveTerminal.mockClear();
    for (const focused of ["doc-main", null]) {
      const { controller, close } = controllerOn(focused);
      expect(closeFocusedTerminal(controller)).toBe(false);
      expect(close).not.toHaveBeenCalled();
    }
    expect(closeActiveTerminal).not.toHaveBeenCalled();
    expect(closeFocusedTerminal(new TrellisController())).toBe(false);
  });
});
