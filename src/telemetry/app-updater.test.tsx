import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAppLog, clearAppLogs } from "./app-log-store";
import { UpdaterProvider, useUpdater, type DownloadEvent, type UpdaterApi } from "./app-updater";
import { ToastStack } from "./toast-stack";

/**
 * The updater reaches Tauri through `import()` at call time, so the seam the
 * tests drive is the modules themselves rather than an injected client.
 *
 * `tauriMissing` throws from the *property read*, which is what a browser/dev
 * build looks like from the updater's side: the lazy import it awaits
 * rejects, and everything downstream has to cope. Making the getter throw
 * (rather than the factory) keeps one mocked module for the whole file, so
 * flipping the flag cannot depend on vitest's module cache.
 */
const plugins = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn(), relaunch: vi.fn(), tauriMissing: false }));

vi.mock("@tauri-apps/plugin-updater", () => ({
  get check() {
    if (plugins.tauriMissing) throw new Error("plugin-updater unavailable");
    return plugins.check;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    if (plugins.tauriMissing) throw new Error("Tauri IPC unavailable");
    return plugins.invoke;
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugins.relaunch }));

// Spied through to the real store, which is cleared before each test, so the
// update's toast renders in the stack and each test can still read exactly
// what the updater recorded.
const realStore = vi.hoisted(() => ({ addAppLog: null as unknown as typeof import("./app-log-store").addAppLog }));
vi.mock("./app-log-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-log-store")>();
  realStore.addAppLog = actual.addAppLog;
  return { ...actual, addAppLog: vi.fn(actual.addAppLog) };
});
vi.mock("./interface-sounds", () => ({ playInterfaceSound: vi.fn(), configureInterfaceSounds: vi.fn() }));

/**
 * Private to app-updater.tsx, pinned here on purpose: renaming the key silently
 * resets the update preference of everyone who already chose one.
 */
const MODE_KEY = "lattice.update.mode.v1";

type FakeUpdate = { version: string; currentVersion: string; downloadAndInstall: ReturnType<typeof vi.fn> };

/** Make the next check resolve with an update (newer than current by default). */
function offerUpdate(overrides?: Partial<FakeUpdate>): FakeUpdate {
  const update = { version: "0.1.230", currentVersion: "0.1.229", downloadAndInstall: vi.fn(async () => undefined), ...overrides };
  plugins.check.mockResolvedValue(update);
  return update;
}

const failingInstall = () => ({ downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")) });

/**
 * A `downloadAndInstall` that stays in flight until the test drives it, so the
 * phases it moves through are observable instead of collapsing into the last one.
 */
function pausedDownload() {
  let emit!: (event: DownloadEvent) => void;
  let finish!: () => void;
  const downloadAndInstall = vi.fn((onEvent?: (event: DownloadEvent) => void) => (
    new Promise<void>((resolve) => {
      emit = (event) => onEvent?.(event);
      finish = resolve;
    })
  ));
  return { downloadAndInstall, emit: (event: DownloadEvent) => act(() => emit(event)), finish: () => finish() };
}

const run = (action: () => Promise<void>) => act(async () => { await action(); });

function renderUpdater(options?: { autoCheck?: boolean; intervalMs?: number }) {
  return renderHook(() => useUpdater(), {
    wrapper: ({ children }) => (
      <UpdaterProvider autoCheck={options?.autoCheck ?? false} intervalMs={options?.intervalMs}>{children}</UpdaterProvider>
    ),
  }).result;
}

/** A provider that has already run one check (silent unless asked otherwise). */
async function renderChecked(silent = true) {
  const result = renderUpdater();
  await run(() => result.current.check(silent));
  return result;
}

/** Offer an update behind a paused download and start installing it. */
async function startPausedInstall() {
  const download = pausedDownload();
  const update = offerUpdate({ downloadAndInstall: download.downloadAndInstall });
  const result = await renderChecked();
  act(() => { void result.current.install(); });
  await waitFor(() => expect(result.current.phase).toBe("downloading"));
  return { download, update, result };
}

/** The toast stack plus a handle on the same provider the update toast comes from. */
function renderToasts() {
  const api: { current: UpdaterApi } = { current: null as unknown as UpdaterApi };
  function Probe() {
    api.current = useUpdater();
    return null;
  }
  render(<UpdaterProvider autoCheck={false}><Probe /><ToastStack /></UpdaterProvider>);
  return api;
}

/** The update's toast, if one is on screen (one leaving is not). */
const updateToast = () => document.querySelector<HTMLElement>("[data-app-toast]:not([data-ending-style])");

// Auto-cleanup only registers under `globals: true`, which this project does
// not set. Unmounting matters here beyond leaked DOM: a mounted provider owns a
// live re-check interval.
afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  plugins.tauriMissing = false;
  plugins.check.mockReset().mockResolvedValue(null);
  plugins.invoke.mockReset().mockResolvedValue(undefined);
  plugins.relaunch.mockReset().mockResolvedValue(undefined);
  clearAppLogs();
  vi.mocked(addAppLog).mockReset().mockImplementation(realStore.addAppLog);
});

describe("useUpdater / check", () => {
  it.each([
    ["nothing", true, null, "idle", null],
    ["nothing", false, null, "up-to-date", null],
    // The server answers with the release it has, which on the newest build is
    // the one already running; only `version !== currentVersion` is an update.
    ["the running version", false, { version: "0.1.229", currentVersion: "0.1.229" }, "up-to-date", null],
    ["a newer version", true, {}, "available", "0.1.230"],
  ] as const)("a check offered %s (silent: %s) ends %s", async (_, silent, offered, phase, version) => {
    if (offered) offerUpdate(offered);
    const result = await renderChecked(silent);

    expect(plugins.check).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe(phase);
    expect(result.current.version).toBe(version);
    expect(result.current.error).toBeNull();
  });

  it("stays silent when there is no Tauri runtime to ask", async () => {
    // A plain web/dev build: the provider is mounted anyway, and a background
    // check must not paint an error banner over someone's editor. The update is
    // offered so that reaching the plugin at all would be visible as
    // "available" — the check has to fail before it ever gets there.
    offerUpdate();
    plugins.tauriMissing = true;
    const result = await renderChecked();

    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(addAppLog).not.toHaveBeenCalled();
  });

  it.each([
    ["the runtime is missing", () => { plugins.tauriMissing = true; }, "plugin-updater unavailable"],
    ["the network fails", () => { plugins.check.mockRejectedValue(new Error("network unreachable")); }, "network unreachable"],
  ])("surfaces a failed check the user asked for (%s), blames the check, and logs it without a toast", async (_, fail, detail) => {
    // Checking and installing share the "error" phase; the kind is what tells
    // a machine that is merely offline from an update that broke on the way in.
    fail();
    const result = await renderChecked(false);

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe(detail);
    expect(result.current.errorKind).toBe("check");
    expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({ level: "error", source: "App updater", toast: false, detail }));
  });

  it.each([
    ["waiting", async () => { offerUpdate(); return renderChecked(); }, "available"],
    ["downloading", async () => (await startPausedInstall()).result, "downloading"],
  ] as const)("does not ask again while an update is %s", async (_, arrange, phase) => {
    const result = await arrange();
    await run(() => result.current.check(false));

    expect(plugins.check).toHaveBeenCalledOnce();
    // The explicit second call must not have downgraded the banner either.
    expect(result.current.phase).toBe(phase);
  });

  it("keeps looking for releases after an install failed", async () => {
    // `check` returns early while an update is held, and a failed install
    // leaves it held. The banner it leaves behind only offers ×, so the check
    // must be released without anyone dismissing it. The guard is only relaxed
    // for a *failed* install: a healthy download still holds it (above).
    offerUpdate(failingInstall());
    const result = await renderChecked();
    await run(() => result.current.install());
    expect(result.current.phase).toBe("error");

    const next = offerUpdate({ version: "0.1.231" });
    await run(() => result.current.check());

    expect(plugins.check).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("available");
    expect(result.current.version).toBe("0.1.231");
    expect(result.current.error).toBeNull();
    expect(result.current.errorKind).toBeNull();
    // The new release replaces the failed one, so installing installs it.
    await run(() => result.current.install());
    expect(next.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("installs the next release automatically after one failed to install", async () => {
    // Automatic mode is where this stranded people: nothing in the UI asks to
    // be dismissed, so the session simply stopped updating itself.
    localStorage.setItem(MODE_KEY, "auto");
    offerUpdate(failingInstall());
    const result = await renderChecked();
    await waitFor(() => expect(result.current.phase).toBe("error"));

    const next = offerUpdate({ version: "0.1.231" });
    await run(() => result.current.check());

    await waitFor(() => expect(next.downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.phase).toBe("ready"));
  });

  it("checks on mount and again on the interval, silently", async () => {
    const result = renderUpdater({ autoCheck: true, intervalMs: 25 });

    await waitFor(() => expect(plugins.check).toHaveBeenCalled());
    await waitFor(() => expect(plugins.check.mock.calls.length).toBeGreaterThan(1));
    expect(result.current.phase).toBe("idle");
  });
});

describe("useUpdater / install", () => {
  it("walks download → install → ready and restarts through the native app", async () => {
    const { download, result } = await startPausedInstall();
    expect(result.current.progress).toBe(0);

    download.emit({ event: "Started", data: { contentLength: 400 } });
    download.emit({ event: "Progress", data: { chunkLength: 100 } });
    expect(result.current.progress).toBe(0.25);
    download.emit({ event: "Progress", data: { chunkLength: 100 } });
    expect(result.current.progress).toBe(0.5);
    expect(result.current.phase).toBe("downloading");

    download.emit({ event: "Finished" });
    expect(result.current.phase).toBe("installing");
    expect(result.current.progress).toBe(1);

    await act(async () => { download.finish(); });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(plugins.invoke).toHaveBeenCalledWith("restart_after_update");
    expect(plugins.relaunch).not.toHaveBeenCalled();
  });

  it("falls back to the process plugin after an older backend installs the new frontend", async () => {
    offerUpdate();
    plugins.invoke.mockRejectedValue("Command restart_after_update not found");
    const result = await renderChecked();

    await run(() => result.current.install());

    expect(plugins.invoke).toHaveBeenCalledWith("restart_after_update");
    expect(plugins.relaunch).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it.each([
    // More arrived than was announced: clamp rather than overflow the bar.
    [{ contentLength: 100 }, 1],
    // Nothing announced: hold at zero rather than painting a NaN-wide bar.
    [undefined, 0],
  ])("bounds progress when the download announced %o", async (data, progress) => {
    const { download, result } = await startPausedInstall();
    download.emit({ event: "Started", data });
    download.emit({ event: "Progress", data: { chunkLength: 250 } });

    expect(result.current.progress).toBe(progress);
  });

  it("reports a failed install, logs it, and lets the user try again", async () => {
    const update = offerUpdate({ downloadAndInstall: vi.fn().mockRejectedValueOnce(new Error("signature mismatch")) });
    const result = await renderChecked();

    await run(() => result.current.install());

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("signature mismatch");
    expect(result.current.errorKind).toBe("install");
    expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({
      level: "error", source: "App updater", title: "Lattice update failed", detail: "signature mismatch", dedupeKey: "app-update",
    }));
    expect(plugins.invoke).not.toHaveBeenCalled();

    // The in-flight guard has to be released on the way out, or "Update now"
    // is dead for the rest of the session after one transient failure.
    update.downloadAndInstall.mockResolvedValueOnce(undefined);
    await run(() => result.current.install());
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("ready");
  });

  it("ignores a second install, and a switch to automatic, while one is in flight", async () => {
    const { result, update } = await startPausedInstall();

    await run(() => result.current.install());
    act(() => result.current.setMode("auto"));

    await waitFor(() => expect(result.current.mode).toBe("auto"));
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("does nothing when nothing is pending", async () => {
    const result = renderUpdater();

    await run(() => result.current.install());

    expect(result.current.phase).toBe("idle");
    expect(plugins.invoke).not.toHaveBeenCalled();
  });
});

describe("useUpdater / mode", () => {
  it.each([["auto", "auto"], ["yes-please", "manual"]])("starts from stored preference %s, then persists each choice", (stored, mode) => {
    localStorage.setItem(MODE_KEY, stored);
    const result = renderUpdater();
    expect(result.current.mode).toBe(mode);

    for (const next of ["auto", "manual"] as const) {
      act(() => result.current.setMode(next));
      expect(localStorage.getItem(MODE_KEY)).toBe(next);
      expect(result.current.mode).toBe(next);
    }
  });

  it("keeps working when storage is unavailable", () => {
    // Private browsing / a locked-down webview: the preference cannot outlive
    // the session, but neither reading nor writing it may throw into React.
    const denied = () => { throw new Error("storage denied"); };
    const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(denied);
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(denied);
    try {
      const result = renderUpdater();
      expect(result.current.mode).toBe("manual");

      act(() => result.current.setMode("auto"));
      expect(result.current.mode).toBe("auto");
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it.each([
    ["manual", "leaves it waiting", 0, "available"],
    ["auto", "installs it", 1, "ready"],
  ] as const)("in %s mode, %s when a check finds an update", async (mode, _, installs, phase) => {
    localStorage.setItem(MODE_KEY, mode);
    const update = offerUpdate();
    const result = await renderChecked();

    await waitFor(() => expect(result.current.phase).toBe(phase));
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(installs);
  });

  it("installs what a check finds after the mode was switched this session", async () => {
    // `check` reads the mode from a ref that is refreshed in a layout effect;
    // if that refresh stops happening, the ref keeps the mode the provider
    // mounted with and automatic mode quietly stops being automatic.
    const result = renderUpdater();
    act(() => result.current.setMode("auto"));
    const update = offerUpdate();

    await run(() => result.current.check());

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
  });

  it("installs an already-offered update when switched to automatic", async () => {
    const update = offerUpdate();
    const result = await renderChecked();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();

    act(() => result.current.setMode("auto"));

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.phase).toBe("ready"));
  });
});

describe("useUpdater / dismiss", () => {
  it("lets a later check offer the same update again", async () => {
    // `check` returns early while an update is held, so a dismissal that kept
    // it would silence every later check for the rest of the session.
    offerUpdate();
    const result = await renderChecked();
    expect(result.current.phase).toBe("available");

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");

    await run(() => result.current.check(false));

    expect(plugins.check).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("available");
    expect(result.current.version).toBe("0.1.230");
  });
});

describe("the update toast", () => {
  it.each([
    ["an up-to-date check", () => {}, "up-to-date"],
    // The only way to reach a non-silent check is the Settings button, and that
    // row reports the outcome itself. Raising "Update failed" in the corner
    // announces an install that never started.
    ["a failed check", () => { plugins.check.mockRejectedValue(new Error("network unreachable")); }, "error"],
  ])("stays out of the way after %s", async (_, arrange, phase) => {
    arrange();
    const api = renderToasts();

    await run(() => api.current.check(false));

    expect(api.current.phase).toBe(phase);
    expect(updateToast()).toBeNull();
  });

  it("offers the update, then carries its download, install and restart in the same toast", async () => {
    const download = pausedDownload();
    offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const api = renderToasts();
    await run(() => api.current.check());

    const offer = updateToast()!;
    expect(offer).toHaveTextContent("New version 0.1.230");
    expect(offer).toHaveTextContent("Ready to install");
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(updateToast()).toHaveTextContent("Downloading update…"));
    expect(updateToast()).toBe(offer);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    download.emit({ event: "Started", data: { contentLength: 400 } });
    download.emit({ event: "Progress", data: { chunkLength: 100 } });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25%")).toBeInTheDocument();
    // The bar moves without a log line per chunk: the phases are the record.
    expect(vi.mocked(addAppLog).mock.calls.map(([entry]) => entry.title)).toEqual(["New version 0.1.230", "Downloading update…"]);

    download.emit({ event: "Finished" });
    expect(updateToast()).toHaveTextContent("Installing…");
    await act(async () => download.finish());
    await waitFor(() => expect(updateToast()).toHaveTextContent("Restarting…"));
    expect(updateToast()).toBe(offer);
  });

  it.each([["offer", false], ["failure", true]])("puts the update away when its %s is dismissed", async (_, installFails) => {
    offerUpdate(installFails ? failingInstall() : undefined);
    const api = renderToasts();
    await run(() => api.current.check());
    if (installFails) {
      await run(() => api.current.install());
      expect(updateToast()).toHaveTextContent("Lattice update failed");
      expect(updateToast()).toHaveTextContent("disk full");
    }

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification", hidden: true }));

    await waitFor(() => expect(updateToast()).toBeNull());
    expect(api.current.phase).toBe("idle");
    expect(api.current.error).toBeNull();
  });
});
