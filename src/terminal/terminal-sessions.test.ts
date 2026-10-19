import { describe, expect, it, vi } from "vitest";
import { TerminalSessions, type TerminalBackend, type TerminalScreen } from "./terminal-sessions";

type Opened = Parameters<TerminalBackend["open"]>[0] & { resolve: (id: number) => void; reject: (reason: Error) => void };

/** A host that starts shells only when the test says so, and records every call. */
function fakeBackend() {
  const opened: Opened[] = [];
  const calls: string[] = [];
  const running = new Map<number, string | null>();
  const backend: TerminalBackend = {
    open: (request) => new Promise((resolve, reject) => {
      opened.push({ ...request, resolve: (id) => resolve({ id, shell: "zsh" }), reject });
    }),
    write: async (id, data) => { calls.push(`write ${id} ${JSON.stringify(data)}`); },
    resize: async (id, cols, rows) => { calls.push(`resize ${id} ${cols}x${rows}`); },
    ack: async (id, bytes) => { calls.push(`ack ${id} ${bytes}`); },
    runningCommand: async (id) => running.get(id) ?? null,
    close: async (id) => { calls.push(`close ${id}`); },
  };
  return { backend, opened, calls, running };
}

type FakeScreen = TerminalScreen & { type: (data: string) => void; resizeTo: (cols: number, rows: number) => void; disposed: boolean };

function fakeScreen(): FakeScreen {
  let input = (_data: string) => {};
  let resize = (_cols: number, _rows: number) => {};
  let size = { cols: 80, rows: 24 };
  const screen: FakeScreen = {
    element: document.createElement("div"),
    cols: () => size.cols,
    rows: () => size.rows,
    write: (_data, done) => done(),
    note: () => {},
    onInput: (listener) => { input = listener; },
    onResize: (listener) => { resize = listener; },
    dispose: () => { screen.disposed = true; },
    type: (data) => input(data),
    resizeTo: (cols, rows) => {
      size = { cols, rows };
      resize(cols, rows);
    },
    disposed: false,
  };
  return screen;
}

function setup(root = "/projects/thesis") {
  const host = fakeBackend();
  const sessions = new TerminalSessions<FakeScreen>(host.backend, fakeScreen);
  sessions.setProject(root);
  return { ...host, sessions };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("terminal sessions", () => {
  it("starts a shell in the project folder at the screen's size, and types what was typed while it started", async () => {
    const { sessions, opened, calls } = setup();
    const session = sessions.open()!;
    expect(opened[0]).toMatchObject({ projectRoot: "/projects/thesis", cols: 80, rows: 24 });
    session.screen.type("ls\r");
    session.screen.resizeTo(120, 30);
    expect(calls).toEqual([]);
    opened[0].resolve(7);
    await settle();
    expect(sessions.get().sessions[0]).toMatchObject({ shell: "zsh", state: { kind: "running" } });
    // The size it has now, then what was typed, in order.
    expect(calls).toEqual(["resize 7 120x30", 'write 7 "ls\\r"']);
    session.screen.type("x");
    await settle();
    expect(calls.at(-1)).toBe('write 7 "x"');
  });

  it("starts nothing without a project", () => {
    const { sessions, opened } = setup("");
    expect(sessions.open()).toBeNull();
    expect(opened).toHaveLength(0);
  });

  it("numbers tabs with the lowest free number, and keeps a name until it is cleared", () => {
    const { sessions } = setup();
    const [one, two, three] = [sessions.open()!, sessions.open()!, sessions.open()!];
    expect(sessions.get().sessions.map((session) => session.number)).toEqual([1, 2, 3]);
    expect(sessions.get().active).toBe(three.key);
    sessions.close(two.key);
    expect(sessions.open()!.number).toBe(2);
    sessions.rename(one.key, "  build  ");
    expect(sessions.get().sessions[0].name).toBe("build");
    sessions.rename(one.key, "   ");
    expect(sessions.get().sessions[0].name).toBeNull();
  });

  it("closing the tab in front brings its right neighbour forward, else its left, and ends the shell", async () => {
    const { sessions, opened, calls } = setup();
    const [a, b, c] = [sessions.open()!, sessions.open()!, sessions.open()!];
    opened.forEach((request, index) => request.resolve(index + 1));
    await settle();
    sessions.select(b.key);
    sessions.close(b.key);
    expect(sessions.get().active).toBe(c.key);
    sessions.close(c.key);
    expect(sessions.get().active).toBe(a.key);
    expect(calls.filter((call) => call.startsWith("close"))).toEqual(["close 2", "close 3"]);
    expect(b.screen.disposed && c.screen.disposed).toBe(true);
    expect(a.screen.disposed).toBe(false);
  });

  it("ends every shell of the last project when the window's project changes", async () => {
    const { sessions, opened, calls } = setup();
    sessions.open();
    sessions.open();
    opened[0].resolve(1);
    await settle();
    sessions.setProject("/projects/other");
    expect(sessions.get().sessions).toEqual([]);
    // The shell still starting is closed the moment it reports in.
    opened[1].resolve(2);
    await settle();
    expect(calls.filter((call) => call.startsWith("close"))).toEqual(["close 1", "close 2"]);
    sessions.open();
    expect(opened[2].projectRoot).toBe("/projects/other");
  });

  it("a clean exit closes the tab; any other keeps it and says how the shell ended", async () => {
    const { sessions, opened, calls } = setup();
    sessions.open();
    sessions.open();
    opened[0].resolve(1);
    opened[1].resolve(2);
    await settle();
    opened[0].onExit(0);
    expect(sessions.get().sessions).toHaveLength(1);
    expect(calls).toContain("close 1");
    opened[1].onExit(127);
    expect(sessions.get().sessions[0].state).toEqual({ kind: "exited", code: 127 });
  });

  it("a shell that exited before the host answered stays exited, and gets none of the queued input", async () => {
    const { sessions, opened, calls } = setup();
    const session = sessions.open()!;
    session.screen.type("ls\r");
    opened[0].onExit(1);
    opened[0].resolve(5);
    await settle();
    expect(sessions.get().sessions[0]).toMatchObject({ shell: "zsh", state: { kind: "exited", code: 1 } });
    expect(calls).toEqual([]);
    sessions.close(session.key);
    expect(calls).toEqual(["close 5"]);
  });

  it("keeps a tab whose shell did not start, with the reason", async () => {
    const { sessions, opened } = setup();
    sessions.open();
    opened[0].reject(new Error("Could not start a shell: No such file"));
    await settle();
    expect(sessions.get().sessions[0].state).toEqual({ kind: "failed", message: "Could not start a shell: No such file" });
  });

  it("tells the host what it has drawn, every 64 KB", async () => {
    const { sessions, opened, calls } = setup();
    sessions.open();
    opened[0].resolve(3);
    await settle();
    const chunk = new Uint8Array(40 * 1024);
    opened[0].onOutput(chunk);
    expect(calls.filter((call) => call.startsWith("ack"))).toEqual([]);
    opened[0].onOutput(chunk);
    expect(calls.filter((call) => call.startsWith("ack"))).toEqual([`ack 3 ${80 * 1024}`]);
  });

  it("reports what closing would stop, only for terminals that run something", async () => {
    const { sessions, opened, running } = setup();
    const [a, b] = [sessions.open()!, sessions.open()!];
    opened[0].resolve(1);
    opened[1].resolve(2);
    await settle();
    running.set(2, "latexmk");
    expect(await sessions.running()).toEqual(["latexmk"]);
    expect(await sessions.running([a.key])).toEqual([]);
    expect(await sessions.running([b.key])).toEqual(["latexmk"]);
  });

  it("notifies subscribers on every change, and drops output for a closed tab", async () => {
    const { sessions, opened } = setup();
    const listener = vi.fn();
    sessions.subscribe(listener);
    const session = sessions.open()!;
    const write = vi.spyOn(session.screen, "write");
    opened[0].resolve(1);
    await settle();
    sessions.endAll();
    opened[0].onOutput(new Uint8Array([65]));
    expect(write).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
