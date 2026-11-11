import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAppLog, clearAppLogs } from "./app-log-store";
import { UpdaterProvider, useUpdater, type DownloadEvent, type UpdaterApi } from "./app-updater";
import { ToastStack } from "./toast-stack";

/**
 * Several releases can land within the hours an update offer waits. Whoever
 * accepts it should get the newest one, not the release the offer was made
 * for and then a second offer after the restart. The install/check basics
 * are in app-updater.test.tsx.
 */
const tauri = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn() }));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));
vi.mock("./interface-sounds", () => ({ playInterfaceSound: vi.fn(), configureInterfaceSounds: vi.fn() }));
vi.mock("./app-log-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-log-store")>();
  return { ...actual, addAppLog: vi.fn(actual.addAppLog) };
});

const RUNNING = "0.16.11";

/** A release a check found, as the backend holds it under `rid`. */
function release(version: string, rid: number) {
  return { version, currentVersion: RUNNING, rid, close: vi.fn(async () => undefined) };
}

/**
 * The backend. `installed` is a release another window already installed:
 * its claim answers "installed", as app_restart.rs does for that exact version.
 */
function backend(installed?: string) {
  tauri.invoke.mockImplementation(async (command: string, args?: { version?: string; onEvent?: { onmessage: (event: DownloadEvent) => void } }) => {
    if (command === "claim_update_install") return args?.version === installed ? "installed" : "claimed";
    if (command === "restart_impact") return null;
    if (command === "install_update") args?.onEvent?.onmessage({ event: "Finished" });
    return undefined;
  });
}

/** The releases `install_update` was asked to install, by version. */
const installs = () => tauri.invoke.mock.calls
  .filter(([command]) => command === "install_update")
  .map(([, args]) => (args as { version: string; rid: number }));

/** Every offer the toast made, by its title. */
const offers = () => vi.mocked(addAppLog).mock.calls
  .map(([entry]) => entry.title)
  .filter((title) => title.startsWith("New version"));

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

/** A window whose check, hours ago, offered 0.16.12; the server now has 0.16.13. */
async function staleOffer() {
  const held = release("0.16.12", 1);
  const newest = release("0.16.13", 2);
  tauri.check.mockResolvedValueOnce(held).mockResolvedValue(newest);
  const api = renderUpdater();
  await run(() => api.current.check());
  await waitFor(() => expect(toast()).toHaveTextContent("New version 0.16.12"));
  return { api, held, newest };
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  clearAppLogs();
  vi.mocked(addAppLog).mockClear();
  tauri.check.mockReset().mockResolvedValue(null);
  tauri.invoke.mockReset();
  backend();
});

describe("an offer that waited while newer releases came out", () => {
  it("installs the newest release when Update now is pressed, with no second offer", async () => {
    const { api, held } = await staleOffer();

    fireEvent.click(screen.getByRole("button", { name: "Update now", hidden: true }));

    await waitFor(() => expect(api.current.phase).toBe("restarting"));
    expect(installs()).toEqual([expect.objectContaining({ version: "0.16.13", rid: 2 })]);
    expect(api.current.version).toBe("0.16.13");
    expect(toast()).toHaveTextContent("Version 0.16.13");
    // The release it replaced is let go, not left held by the backend.
    expect(held.close).toHaveBeenCalledOnce();
    expect(offers()).toEqual(["New version 0.16.12"]);
  });

  it("installs the offered release when the last look for a newer one fails", async () => {
    const { api, held } = await staleOffer();
    tauri.check.mockRejectedValue(new Error("network unreachable"));

    await run(() => api.current.install());

    expect(installs()).toEqual([expect.objectContaining({ version: "0.16.12", rid: 1 })]);
    expect(api.current.phase).toBe("restarting");
    expect(held.close).not.toHaveBeenCalled();
  });

  it("is replaced by a newer release that a later check finds", async () => {
    const { api, held, newest } = await staleOffer();

    await run(() => api.current.check());

    expect(api.current.phase).toBe("available");
    expect(api.current.version).toBe("0.16.13");
    await waitFor(() => expect(toast()).toHaveTextContent("New version 0.16.13"));
    expect(held.close).toHaveBeenCalledOnce();

    // The same release found again is not offered twice; the copy is let go.
    const again = release("0.16.13", 3);
    tauri.check.mockResolvedValue(again);
    await run(() => api.current.check());
    expect(offers()).toEqual(["New version 0.16.12", "New version 0.16.13"]);
    expect(again.close).toHaveBeenCalledOnce();
    expect(newest.close).not.toHaveBeenCalled();
  });

  it("installs the newest release when switched to automatic", async () => {
    const { api } = await staleOffer();

    act(() => api.current.setMode("auto"));

    await waitFor(() => expect(api.current.phase).toBe("ready"));
    expect(installs()).toEqual([expect.objectContaining({ version: "0.16.13" })]);
  });

  it("restarts into the newest release another window already installed, instead of installing the older one", async () => {
    backend("0.16.13");
    const { api } = await staleOffer();

    await run(() => api.current.install());

    expect(installs()).toEqual([]);
    expect(api.current.phase).toBe("restarting");
    expect(tauri.invoke).toHaveBeenCalledWith("restart_lattice");
  });
});

describe("automatic mode", () => {
  it("installs what its check just found without asking again", async () => {
    localStorage.setItem("lattice.update.mode.v1", "auto");
    tauri.check.mockResolvedValue(release("0.16.13", 1));
    const api = renderUpdater();

    await run(() => api.current.check());

    await waitFor(() => expect(api.current.phase).toBe("ready"));
    expect(tauri.check).toHaveBeenCalledOnce();
    expect(installs()).toEqual([expect.objectContaining({ version: "0.16.13" })]);
  });
});
