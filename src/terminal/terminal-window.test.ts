import { describe, expect, it, vi } from "vitest";
import type { TrellisController } from "../trellis/trellis-controller";
import type { TerminalBackend, TerminalScreen } from "./terminal-sessions";

// The real store with a host that only starts shells when the test says so,
// and screens with nothing behind them: no Tauri, no xterm.js.
const opened: Parameters<TerminalBackend["open"]>[0][] = [];
vi.mock("./terminal-backend", () => ({
  tauriTerminalBackend: {
    open: async (request: Parameters<TerminalBackend["open"]>[0]) => {
      opened.push(request);
      return { id: opened.length, shell: "zsh" };
    },
    write: async () => {},
    resize: async () => {},
    ack: async () => {},
    runningCommand: async () => null,
    close: async () => {},
  } satisfies TerminalBackend,
}));
vi.mock("./terminal-screen", () => ({
  createXtermScreen: (): TerminalScreen => ({
    element: document.createElement("div"),
    cols: () => 80,
    rows: () => 24,
    write: (_data, done) => done(),
    note: () => {},
    onInput: () => {},
    onResize: () => {},
    dispose: () => {},
  }),
}));

const { followProject, openTerminal, terminals } = await import("./terminal-window");

/** A window whose Terminal panel is in the layout (or already closed, `panel: false`). */
function fakeController(projectRoot: string, { panel = true } = {}) {
  const close = vi.fn(async () => true);
  return {
    app: { get: () => ({ projectRoot }), subscribe: () => () => {} },
    ws: { view: (id: string) => (panel && id === "terminal" ? { id } : null), close },
    close,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the window's terminals", () => {
  it("close the Terminal panel, past its guard, when the last shell exits cleanly, for the controller followed now", async () => {
    const first = fakeController("/projects/thesis");
    followProject(first as unknown as TrellisController);
    const second = fakeController("/projects/thesis");
    followProject(second as unknown as TrellisController);
    openTerminal();
    openTerminal();
    await settle();
    opened[0].onExit(0);
    expect(second.close).not.toHaveBeenCalled();
    opened[1].onExit(0);
    expect(terminals.get().sessions).toEqual([]);
    expect(second.close).toHaveBeenCalledWith("terminal", { force: true });
    expect(first.close).not.toHaveBeenCalled();
  });

  it("leave a layout without the Terminal panel alone", async () => {
    const controller = fakeController("/projects/thesis", { panel: false });
    followProject(controller as unknown as TrellisController);
    openTerminal();
    await settle();
    opened.at(-1)!.onExit(0);
    expect(terminals.get().sessions).toEqual([]);
    expect(controller.close).not.toHaveBeenCalled();
  });
});
