import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { XtermScreen } from "./terminal-screen";
import type { TerminalSession } from "./terminal-sessions";
import { terminals } from "./terminal-window";
import { TerminalTab } from "./terminal-panel";

vi.mock("./terminal-window", () => ({
  terminals: { rename: vi.fn(), select: vi.fn(), get: vi.fn(() => ({ sessions: [] })) },
  closeTerminal: vi.fn(),
  findRequests: { subscribe: vi.fn(() => () => {}), get: vi.fn(() => null) },
  followProject: vi.fn(),
  openTerminal: vi.fn(),
}));

const session = {
  key: 1,
  number: 1,
  name: null,
  shell: "zsh",
  screen: { focus: vi.fn() } as unknown as XtermScreen,
  state: { kind: "running" },
} satisfies TerminalSession<XtermScreen>;

describe("TerminalTab rename under an input method", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps renaming through the composition's Enter and Escape", () => {
    render(<TerminalTab session={session} selected label="Terminal 1" />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Terminal 1" }));
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(input, { target: { value: "shiyan" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229, isComposing: true });
    expect(terminals.rename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Terminal name" })).toBe(input);
  });

  it("renames on a plain Enter and gives up on a plain Escape", () => {
    render(<TerminalTab session={session} selected label="Terminal 1" />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Terminal 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal name" }), { target: { value: "build" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal name" }), { key: "Enter", keyCode: 13 });
    expect(terminals.rename).toHaveBeenCalledWith(1, "build");

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Terminal 1" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal name" }), { key: "Escape", keyCode: 27 });
    expect(terminals.rename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Terminal name" })).toBeNull();
  });
});
