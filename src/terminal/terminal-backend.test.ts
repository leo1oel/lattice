import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tauriTerminalBackend } from "./terminal-backend";

vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const runtime = window as unknown as { __TAURI_INTERNALS__: unknown; __LATTICE_HEADLESS_TERMINAL__?: boolean };
let previous: unknown;
const callbacks = new Map<number, (payload: unknown) => void>();
beforeEach(() => {
  previous = runtime.__TAURI_INTERNALS__;
  callbacks.clear();
  runtime.__TAURI_INTERNALS__ = {
    transformCallback(callback: (payload: unknown) => void) { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number) { callbacks.delete(id); },
  };
  vi.mocked(invoke).mockResolvedValue({ id: 7, shell: "sh" });
});
afterEach(() => { runtime.__TAURI_INTERNALS__ = previous; delete runtime.__LATTICE_HEADLESS_TERMINAL__; vi.resetAllMocks(); });
it("ends a lost headless terminal on SSE reconnection and releases its subscription", async () => {
  runtime.__LATTICE_HEADLESS_TERMINAL__ = true;
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  const exit = vi.fn();
  await tauriTerminalBackend.open({ projectRoot: "/project", cols: 80, rows: 24, onOutput: vi.fn(), onExit: exit });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("This terminal has closed."));
  const ready = vi.mocked(listen).mock.calls[0][1];
  ready({ event: "server-ready", id: 1, payload: {} });
  await Promise.resolve();
  expect(exit).toHaveBeenCalledWith(null);
  expect(unlisten).toHaveBeenCalledOnce();
});
it("keeps native terminal startup free of remote reconnect listeners", async () => {
  await tauriTerminalBackend.open({ projectRoot: "/project", cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
  expect(listen).not.toHaveBeenCalled();
});
it("starts a program with literal argv through the dedicated native/server command", async () => {
  const program = { executable: "python3", args: ["./analysis.py", "$(literal)"] };
  await tauriTerminalBackend.open({ projectRoot: "/project", program, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
  expect(invoke).toHaveBeenCalledWith("terminal_run", expect.objectContaining({ projectRoot: "/project", program: "python3", args: program.args }));
  expect(invoke).not.toHaveBeenCalledWith("terminal_write", expect.anything());
});
it("passes real ordered Channel output and exit values, then removes the reconnect listener", async () => {
  runtime.__LATTICE_HEADLESS_TERMINAL__ = true;
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  const output = vi.fn(), exit = vi.fn();
  await tauriTerminalBackend.open({ projectRoot: "/project", cols: 80, rows: 24, onOutput: output, onExit: exit });
  const channel = (vi.mocked(invoke).mock.calls[0][1] as { onOutput: Channel }).onOutput;
  const callback = callbacks.get(channel.id)!;
  callback({ index: 0, message: Uint8Array.of(65, 66).buffer });
  callback({ index: 1, message: { exit: 0 } });
  callback({ index: 2, end: true });
  expect(output).toHaveBeenCalledWith(Uint8Array.of(65, 66));
  expect(exit).toHaveBeenCalledWith(0);
  expect(unlisten).toHaveBeenCalledOnce();
  expect(callbacks.has(channel.id)).toBe(false);
});

it("closes a started process if its reconnect subscription cannot be installed", async () => {
  runtime.__LATTICE_HEADLESS_TERMINAL__ = true;
  vi.mocked(listen).mockRejectedValue(new Error("Listener failed"));
  await expect(tauriTerminalBackend.open({ projectRoot: "/project", cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() })).rejects.toThrow("Listener failed");
  expect(invoke).toHaveBeenCalledWith("terminal_close", { id: 7 });
});
