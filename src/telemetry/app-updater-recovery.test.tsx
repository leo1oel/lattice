import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAppLogs, writeLogFileLine } from "./app-log-store";
import { UpdaterProvider, useUpdater, type DownloadEvent, type UpdaterApi } from "./app-updater";
import { ToastStack } from "./toast-stack";
import { setNativeUpdateMenu } from "../app/native-locale";

/**
 * Issue #730: what the updater does after a check or a download fails —
 * quiet retries, the failure toast's actions, and Lattice ▸ Check for
 * Updates…. The install/check basics are in app-updater.test.tsx.
 */
const tauri = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  openUrl: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  /** The waits between attempts; none, unless a test needs to act during one. */
  delays: [0, 0] as number[],
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = tauri.listeners.get(name) ?? new Set();
    handlers.add(handler);
    tauri.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl }));
vi.mock("./interface-sounds", () => ({ playInterfaceSound: vi.fn(), configureInterfaceSounds: vi.fn() }));
vi.mock("./app-log-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("./app-log-store")>(),
  writeLogFileLine: vi.fn(),
}));
vi.mock("../app/native-locale", () => ({ setNativeUpdateMenu: vi.fn() }));
vi.mock("./update-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-recovery")>();
  return {
    ...actual,
    retryTransient: (...[first, attempt, options]: Parameters<typeof actual.retryTransient>) => (
      actual.retryTransient(first, attempt, { ...options, delaysMs: tauri.delays })
    ),
  };
});

const DOWNLOAD_504 = "Download request failed with status: 504 Gateway Timeout";
const UPDATE = { version: "0.16.1", currentVersion: "0.15.8", rid: 1 };

/** The backend: each `install_update` takes the next outcome (default: success). */
function backend(installs: (Error | null)[] = []) {
  tauri.invoke.mockImplementation(async (command: string, args?: { onEvent?: { onmessage: (event: DownloadEvent) => void } }) => {
    if (command === "claim_update_install") return "claimed";
    if (command === "restart_impact") return null;
    if (command === "install_update") {
      const outcome = installs.shift() ?? null;
      if (outcome) throw outcome;
      args?.onEvent?.onmessage({ event: "Started", data: { contentLength: 10 } });
      args?.onEvent?.onmessage({ event: "Progress", data: { chunkLength: 10 } });
      args?.onEvent?.onmessage({ event: "Finished" });
    }
    return undefined;
  });
}

type Settle = { resolve: (update: typeof UPDATE) => void; reject: (reason: Error) => void };

const commands = (name: string) => tauri.invoke.mock.calls.filter(([command]) => command === name).length;

function renderUpdater() {
  const api: { current: UpdaterApi } = { current: null as unknown as UpdaterApi };
  function Probe() {
    api.current = useUpdater();
    return null;
  }
  render(<UpdaterProvider autoCheck={false}><Probe /><ToastStack /></UpdaterProvider>);
  return api;
}

const run = (action: () => Promise<void>) => act(async () => { await action(); });
const toast = () => document.querySelector<HTMLElement>("[data-app-toast]:not([data-ending-style])");
/** The install's `lattice::event` line, once written. */
const installEvent = () => vi.mocked(writeLogFileLine).mock.calls
  .map(([line]) => JSON.parse(line) as Record<string, unknown>)
  .find((line) => line.event === "app.update_install");

async function offered(installs: (Error | null)[] = []) {
  backend(installs);
  tauri.check.mockResolvedValue(UPDATE);
  const api = renderUpdater();
  await run(() => api.current.check());
  return api;
}

function chooseFromMenu(name: string) {
  return act(async () => {
    for (const handler of tauri.listeners.get(name) ?? []) handler({ payload: "" });
    await Promise.resolve();
  });
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  clearAppLogs();
  tauri.check.mockReset().mockResolvedValue(null);
  tauri.invoke.mockReset();
  tauri.openUrl.mockReset();
  tauri.listeners.clear();
  tauri.delays = [0, 0];
  vi.mocked(writeLogFileLine).mockClear();
  vi.mocked(setNativeUpdateMenu).mockClear();
  backend();
});

describe("a download that fails", () => {
  it("is tried again quietly after a 504, taking the claim again each time", async () => {
    const api = await offered([new Error(DOWNLOAD_504), new Error(DOWNLOAD_504)]);
    await run(() => api.current.install());

    await waitFor(() => expect(api.current.phase).toBe("restarting"));
    expect(commands("install_update")).toBe(3);
    expect(commands("claim_update_install")).toBe(3);
    await waitFor(() => expect(installEvent()).toMatchObject({ outcome: "success", attempts: 3, bytes: 10, to_version: "0.16.1" }));
  });

  it("gives up after three attempts and offers Try again and the releases page", async () => {
    const api = await offered([new Error(DOWNLOAD_504), new Error(DOWNLOAD_504), new Error(DOWNLOAD_504)]);
    await run(() => api.current.install());

    await waitFor(() => expect(toast()).toHaveTextContent("GitHub’s download server timed out (504)"));
    expect(commands("install_update")).toBe(3);
    await waitFor(() => expect(installEvent()).toMatchObject({ outcome: "error", attempts: 3, http_status: 504, error_kind: "update_server" }));

    fireEvent.click(screen.getByRole("button", { name: "Open releases page", hidden: true }));
    expect(tauri.openUrl).toHaveBeenCalledWith("https://github.com/leo1oel/lattice/releases/tag/v0.16.1");

    // The update is still held: Try again installs it.
    fireEvent.click(screen.getByRole("button", { name: "Try again", hidden: true }));
    await waitFor(() => expect(api.current.phase).toBe("restarting"));
    expect(commands("install_update")).toBe(4);
  });

  it("is not tried again after a 404", async () => {
    const api = await offered([new Error("Download request failed with status: 404 Not Found")]);
    await run(() => api.current.install());

    await waitFor(() => expect(toast()).toHaveTextContent("(404)"));
    expect(commands("install_update")).toBe(1);
    expect(screen.queryByRole("button", { name: "Try again", hidden: true })).toBeNull();
  });

  it("stops retrying when Cancel is pressed during the wait", async () => {
    tauri.delays = [60_000, 60_000];
    const api = await offered([new Error(DOWNLOAD_504)]);
    act(() => { void api.current.install(); });

    await waitFor(() => expect(toast()).toHaveTextContent("Trying again (2 of 3)…"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));

    await waitFor(() => expect(toast()).toHaveTextContent("Lattice update failed"));
    expect(commands("install_update")).toBe(1);
    // The second download never started.
    await waitFor(() => expect(installEvent()).toMatchObject({ outcome: "cancelled", attempts: 1 }));
  });
});

describe("a check that settles after an install started", () => {
  it.each([
    ["finds the update", (check: Settle) => check.resolve(UPDATE)],
    ["fails", (check: Settle) => check.reject(new Error("network unreachable"))],
  ])("leaves the download's toast alone when it %s", async (_, settle) => {
    const api = await offered([new Error("disk full")]);
    await run(() => api.current.install());
    await waitFor(() => expect(toast()).toHaveTextContent("Lattice update failed"));

    let check!: Settle;
    tauri.check.mockReturnValueOnce(new Promise((resolve, reject) => { check = { resolve, reject }; }));
    let checking!: Promise<void>;
    act(() => { checking = api.current.check(false); });
    await waitFor(() => expect(api.current.phase).toBe("checking"));

    let finishDownload!: () => void;
    const answer = tauri.invoke.getMockImplementation()!;
    tauri.invoke.mockImplementation((command: string, args?: unknown) => (
      command === "install_update" ? new Promise<void>((resolve) => { finishDownload = resolve; }) : answer(command, args)
    ));
    fireEvent.click(screen.getByRole("button", { name: "Try again", hidden: true }));
    await waitFor(() => expect(api.current.phase).toBe("downloading"));

    await act(async () => {
      settle(check);
      await checking;
    });
    expect(api.current.phase).toBe("downloading");
    expect(toast()).toHaveTextContent("Downloading update…");

    await act(async () => { finishDownload(); });
    await waitFor(() => expect(api.current.phase).toBe("restarting"));
  });
});

describe("a check that fails", () => {
  it("is tried again quietly when the endpoint does not answer with success", async () => {
    tauri.check
      .mockRejectedValueOnce(new Error("Could not fetch a valid release JSON from the remote"))
      .mockResolvedValueOnce(UPDATE);
    const api = renderUpdater();
    await run(() => api.current.check());

    await waitFor(() => expect(api.current.phase).toBe("available"));
    expect(tauri.check).toHaveBeenCalledTimes(2);
  });
});

describe("Lattice ▸ Check for Updates…", () => {
  it("checks and says when Lattice is up to date", async () => {
    renderUpdater();
    await chooseFromMenu("check-for-updates");

    await waitFor(() => expect(toast()).toHaveTextContent("Lattice is up to date"));
    expect(tauri.check).toHaveBeenCalledOnce();
  });

  it("says when the check failed", async () => {
    tauri.check.mockRejectedValue(new Error("network unreachable"));
    renderUpdater();
    await chooseFromMenu("check-for-updates");

    await waitFor(() => expect(toast()).toHaveTextContent("Couldn’t check for Lattice updates"));
  });

  it("offers Update now again for an update held after a failed install", async () => {
    const api = await offered([new Error("disk full")]);
    await run(() => api.current.install());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification", hidden: true }));
    await waitFor(() => expect(toast()).toBeNull());

    await chooseFromMenu("check-for-updates");

    await waitFor(() => expect(toast()).toHaveTextContent("New version 0.16.1"));
    expect(tauri.check).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Update now", hidden: true }));
    await waitFor(() => expect(api.current.phase).toBe("restarting"));
  });

  it("reads Restart to Update… once an update is installed, and restarts", async () => {
    localStorage.setItem("lattice.update.mode.v1", "auto");
    const api = await offered();
    await waitFor(() => expect(api.current.phase).toBe("ready"));
    expect(setNativeUpdateMenu).toHaveBeenLastCalledWith("restart");

    await chooseFromMenu("check-for-updates");

    await waitFor(() => expect(commands("restart_lattice")).toBe(1));
  });
});
