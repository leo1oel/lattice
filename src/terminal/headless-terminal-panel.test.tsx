import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TrellisController } from "../trellis/trellis-controller";
import { TerminalPanel } from "./terminal-panel";
import { openTerminal } from "./terminal-window";

vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => true }));
const snapshot = { sessions: [], active: null };
vi.mock("./terminal-window", () => ({
  terminals: { get: () => snapshot, subscribe: () => () => {}, rename: vi.fn(), select: vi.fn() },
  closeTerminal: vi.fn(), findRequests: new Set(), followProject: vi.fn(), openTerminal: vi.fn(),
}));
afterEach(() => {
  cleanup();
  delete (window as Window & { __LATTICE_HEADLESS_TERMINAL__?: boolean }).__LATTICE_HEADLESS_TERMINAL__;
  vi.clearAllMocks();
});
function panel() {
  const controller = new TrellisController();
  controller.app.set({ projectRoot: "/projects/example" });
  return render(<TerminalPanel controller={controller} shown focused moving={false} />);
}
it("keeps native-browser handoffs from opening a shell", () => {
  panel();
  expect(screen.getByText("The terminal is in the Lattice window")).toBeInTheDocument();
  expect(openTerminal).not.toHaveBeenCalled();
});
it("opens the existing terminal UI only when the headless adapter confirms terminal capability", () => {
  (window as Window & { __LATTICE_HEADLESS_TERMINAL__?: boolean }).__LATTICE_HEADLESS_TERMINAL__ = true;
  panel();
  expect(screen.getByText("No terminal open")).toBeInTheDocument();
  expect(openTerminal).toHaveBeenCalledOnce();
});
