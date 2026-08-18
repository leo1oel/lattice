import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAppLog } from "./app-log-store";
import { UpdateBanner, UpdaterProvider, useUpdater, type UpdaterApi } from "./app-updater";

/**
 * `loadUpdaterApis` reaches both plugins through `import()` at call time, so the
 * seam the tests drive is the module itself rather than an injected client.
 *
 * `tauriMissing` throws from the *property read*, which is what a browser/dev
 * build looks like from `loadUpdaterApis`'s side: the promise it returns
 * rejects, and everything downstream has to cope. Making the getter throw
 * (rather than the factory) keeps one mocked module for the whole file, so
 * flipping the flag cannot depend on vitest's module cache.
 */
const plugins = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  tauriMissing: false,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  get check() {
    if (plugins.tauriMissing) throw new Error("plugin-updater unavailable");
    return plugins.check;
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  get relaunch() {
    if (plugins.tauriMissing) throw new Error("plugin-process unavailable");
    return plugins.relaunch;
  },
}));

// Stubbed rather than spied: the updater's contract here is "record it, never
// toast it", and a real entry would leak into the shared log store between
// tests. What the store does with an entry is app-log-store.test.ts's business.
vi.mock("./app-log-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-log-store")>()),
  addAppLog: vi.fn(),
}));

/**
 * Private to app-updater.tsx, pinned here on purpose: renaming the key silently
 * resets the update preference of everyone who already chose one.
 */
const MODE_KEY = "lattice.update.mode.v1";

type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

type FakeUpdate = {
  version: string;
  currentVersion: string;
  body?: string | null;
  downloadAndInstall: ReturnType<typeof vi.fn>;
};

/** Make the next check resolve with an update (newer than current by default). */
function offerUpdate(overrides?: Partial<Omit<FakeUpdate, "downloadAndInstall">> & {
  downloadAndInstall?: FakeUpdate["downloadAndInstall"];
}): FakeUpdate {
  const update: FakeUpdate = {
    version: "0.1.230",
    currentVersion: "0.1.229",
    body: "Fixes the outline scroll",
    downloadAndInstall: vi.fn(async () => undefined),
    ...overrides,
  };
  plugins.check.mockResolvedValue(update);
  return update;
}

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
  return {
    downloadAndInstall,
    emit: (event: DownloadEvent) => emit(event),
    finish: () => finish(),
  };
}

function renderUpdater(options?: { autoCheck?: boolean; intervalMs?: number }) {
  return renderHook(() => useUpdater(), {
    wrapper: ({ children }) => (
      <UpdaterProvider autoCheck={options?.autoCheck ?? false} intervalMs={options?.intervalMs}>
        {children}
      </UpdaterProvider>
    ),
  });
}

/** The banner plus a handle on the same provider the banner is reading. */
function renderBanner() {
  const api: { current: UpdaterApi } = { current: null as unknown as UpdaterApi };
  function Probe() {
    api.current = useUpdater();
    return null;
  }
  render(
    <UpdaterProvider autoCheck={false}>
      <Probe />
      <UpdateBanner />
    </UpdaterProvider>,
  );
  return api;
}

// Auto-cleanup only registers under `globals: true`, which this project does
// not set. Unmounting matters here beyond leaked DOM: a mounted provider owns a
// live re-check interval.
afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  plugins.tauriMissing = false;
  plugins.check.mockReset().mockResolvedValue(null);
  plugins.relaunch.mockReset().mockResolvedValue(undefined);
  vi.mocked(addAppLog).mockReset();
});

describe("useUpdater / check", () => {
  it("says nothing when a background check finds no update", async () => {
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(); });

    expect(plugins.check).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("idle");
    expect(result.current.version).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("confirms up-to-date only when the user asked", async () => {
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(false); });

    expect(result.current.phase).toBe("up-to-date");
  });

  it("treats a build matching the running version as up to date", async () => {
    // The server answers with the release it has, which on the newest build is
    // the one already running; only `version !== currentVersion` is an update.
    offerUpdate({ version: "0.1.229", currentVersion: "0.1.229" });
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(false); });

    expect(result.current.phase).toBe("up-to-date");
    expect(result.current.version).toBeNull();
  });

  it("offers a newer version with its release notes", async () => {
    offerUpdate();
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(); });

    expect(result.current.phase).toBe("available");
    expect(result.current.version).toBe("0.1.230");
    expect(result.current.notes).toBe("Fixes the outline scroll");
    expect(result.current.error).toBeNull();
  });

  it("stays silent when there is no Tauri runtime to ask", async () => {
    // A plain web/dev build: the provider is mounted anyway, and a background
    // check must not paint an error banner over someone's editor. The update is
    // offered so that reaching the plugin at all would be visible as
    // "available" — the check has to fail before it ever gets there.
    offerUpdate();
    plugins.tauriMissing = true;
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(); });

    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(addAppLog).not.toHaveBeenCalled();
  });

  it("reports the missing runtime when the user asked", async () => {
    plugins.tauriMissing = true;
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(false); });

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("plugin-updater unavailable");
  });

  it("surfaces a failure the user asked for, and logs it without a toast", async () => {
    plugins.check.mockRejectedValue(new Error("network unreachable"));
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(false); });

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("network unreachable");
    expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      source: "App updater",
      toast: false,
      detail: "network unreachable",
    }));
  });

  it("blames the check, not an install nobody started", async () => {
    // Checking and installing share the "error" phase; the kind is what tells
    // a machine that is merely offline from an update that broke on the way in.
    plugins.check.mockRejectedValue(new Error("network unreachable"));
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(false); });

    expect(result.current.errorKind).toBe("check");
  });

  it("does not ask again while an update is already waiting", async () => {
    offerUpdate();
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(); });
    await act(async () => { await result.current.check(false); });

    expect(plugins.check).toHaveBeenCalledOnce();
    // The explicit second call must not have downgraded the banner either.
    expect(result.current.phase).toBe("available");
  });

  it("keeps looking for releases after an install failed", async () => {
    // Regression, and the other side of the note on `dismiss`: `check` returns
    // early while an update is held, and a failed install left it held. The
    // banner it leaves behind only offers ×, so an automatic install that fell
    // over meant the app noticed no further release until someone found and
    // dismissed it — the six-hourly check and the Settings button alike.
    offerUpdate({ downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")) });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    await act(async () => { await result.current.install(); });
    expect(result.current.phase).toBe("error");

    const next = offerUpdate({ version: "0.1.231" });
    await act(async () => { await result.current.check(); });

    expect(plugins.check).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("available");
    expect(result.current.version).toBe("0.1.231");
    expect(result.current.error).toBeNull();
    expect(result.current.errorKind).toBeNull();
    // The new release replaces the failed one, so installing installs it.
    await act(async () => { await result.current.install(); });
    expect(next.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("still holds off a check while a healthy update is waiting to be retried", async () => {
    // The guard the fix above relaxes is only relaxed for a *failed* install:
    // a download in flight, or an offer nobody has acted on, still suppresses
    // the check that would offer it a second time.
    const download = pausedDownload();
    offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    act(() => { void result.current.install(); });
    await waitFor(() => expect(result.current.phase).toBe("downloading"));

    await act(async () => { await result.current.check(false); });

    expect(plugins.check).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("downloading");
  });

  it("installs the next release automatically after one failed to install", async () => {
    // Automatic mode is where this stranded people: nothing in the UI asks to
    // be dismissed, so the session simply stopped updating itself.
    localStorage.setItem(MODE_KEY, "auto");
    offerUpdate({ downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")) });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    await waitFor(() => expect(result.current.phase).toBe("error"));

    const next = offerUpdate({ version: "0.1.231" });
    await act(async () => { await result.current.check(); });

    await waitFor(() => expect(next.downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.phase).toBe("ready"));
  });

  it("checks on mount and again on the interval, silently", async () => {
    const { result } = renderUpdater({ autoCheck: true, intervalMs: 25 });

    await waitFor(() => expect(plugins.check).toHaveBeenCalled());
    await waitFor(() => expect(plugins.check.mock.calls.length).toBeGreaterThan(1));
    expect(result.current.phase).toBe("idle");
  });
});

describe("useUpdater / install", () => {
  it("walks download → install → ready and relaunches", async () => {
    const download = pausedDownload();
    offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });

    act(() => { void result.current.install(); });
    await waitFor(() => expect(result.current.phase).toBe("downloading"));
    expect(result.current.progress).toBe(0);

    act(() => download.emit({ event: "Started", data: { contentLength: 400 } }));
    act(() => download.emit({ event: "Progress", data: { chunkLength: 100 } }));
    expect(result.current.progress).toBe(0.25);
    act(() => download.emit({ event: "Progress", data: { chunkLength: 100 } }));
    expect(result.current.progress).toBe(0.5);
    expect(result.current.phase).toBe("downloading");

    act(() => download.emit({ event: "Finished" }));
    expect(result.current.phase).toBe("installing");
    expect(result.current.progress).toBe(1);

    await act(async () => { download.finish(); });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(plugins.relaunch).toHaveBeenCalledOnce();
  });

  it("clamps progress at 1 when more arrives than was announced", async () => {
    const download = pausedDownload();
    offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });

    act(() => { void result.current.install(); });
    await waitFor(() => expect(result.current.phase).toBe("downloading"));
    act(() => download.emit({ event: "Started", data: { contentLength: 100 } }));
    act(() => download.emit({ event: "Progress", data: { chunkLength: 250 } }));

    expect(result.current.progress).toBe(1);
  });

  it("holds progress at zero when no content length was announced", async () => {
    // Rather than dividing by zero and painting a NaN-wide bar.
    const download = pausedDownload();
    offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });

    act(() => { void result.current.install(); });
    await waitFor(() => expect(result.current.phase).toBe("downloading"));
    act(() => download.emit({ event: "Started" }));
    act(() => download.emit({ event: "Progress", data: { chunkLength: 250 } }));

    expect(result.current.progress).toBe(0);
  });

  it("reports a failed install, logs it, and lets the user try again", async () => {
    const update = offerUpdate({
      downloadAndInstall: vi.fn().mockRejectedValueOnce(new Error("signature mismatch")),
    });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });

    await act(async () => { await result.current.install(); });

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("signature mismatch");
    expect(result.current.errorKind).toBe("install");
    expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      source: "App updater",
      title: "Lattice update failed",
      toast: false,
    }));
    expect(plugins.relaunch).not.toHaveBeenCalled();

    // The in-flight guard has to be released on the way out, or "Update now"
    // is dead for the rest of the session after one transient failure.
    update.downloadAndInstall.mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.install(); });
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("ready");
  });

  it("ignores a second install while one is in flight", async () => {
    const download = pausedDownload();
    const update = offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });

    act(() => { void result.current.install(); });
    await waitFor(() => expect(result.current.phase).toBe("downloading"));
    await act(async () => { await result.current.install(); });

    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("does nothing when nothing is pending", async () => {
    const { result } = renderUpdater();

    await act(async () => { await result.current.install(); });

    expect(result.current.phase).toBe("idle");
    expect(plugins.relaunch).not.toHaveBeenCalled();
  });
});

describe("useUpdater / mode", () => {
  it("starts from the persisted preference", () => {
    localStorage.setItem(MODE_KEY, "auto");
    expect(renderUpdater().result.current.mode).toBe("auto");
  });

  it("falls back to manual for anything unrecognized", () => {
    localStorage.setItem(MODE_KEY, "yes-please");
    expect(renderUpdater().result.current.mode).toBe("manual");
  });

  it("persists the choice", () => {
    const { result } = renderUpdater();

    act(() => result.current.setMode("auto"));
    expect(localStorage.getItem(MODE_KEY)).toBe("auto");
    expect(result.current.mode).toBe("auto");

    act(() => result.current.setMode("manual"));
    expect(localStorage.getItem(MODE_KEY)).toBe("manual");
    expect(result.current.mode).toBe("manual");
  });

  it("keeps working when storage is unavailable", () => {
    // Private browsing / a locked-down webview: the preference cannot outlive
    // the session, but neither reading nor writing it may throw into React.
    const read = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    try {
      const { result } = renderUpdater();
      expect(result.current.mode).toBe("manual");

      act(() => result.current.setMode("auto"));
      expect(result.current.mode).toBe("auto");
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("leaves the update waiting in manual mode", async () => {
    const update = offerUpdate();
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(); });

    expect(result.current.phase).toBe("available");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("installs what a check finds when the mode is already automatic", async () => {
    localStorage.setItem(MODE_KEY, "auto");
    const update = offerUpdate();
    const { result } = renderUpdater();

    await act(async () => { await result.current.check(); });

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.phase).toBe("ready"));
  });

  it("installs what a check finds after the mode was switched this session", async () => {
    // `check` reads the mode from a ref that is refreshed in a layout effect;
    // if that refresh stops happening, the ref keeps the mode the provider
    // mounted with and automatic mode quietly stops being automatic.
    const { result } = renderUpdater();
    act(() => result.current.setMode("auto"));
    const update = offerUpdate();

    await act(async () => { await result.current.check(); });

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
  });

  it("installs an already-offered update when switched to automatic", async () => {
    const update = offerUpdate();
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    expect(update.downloadAndInstall).not.toHaveBeenCalled();

    act(() => result.current.setMode("auto"));

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.phase).toBe("ready"));
  });

  it("does not start a second install when switched to automatic mid-download", async () => {
    const download = pausedDownload();
    const update = offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    act(() => { void result.current.install(); });
    await waitFor(() => expect(result.current.phase).toBe("downloading"));

    act(() => result.current.setMode("auto"));

    await waitFor(() => expect(result.current.mode).toBe("auto"));
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
  });
});

describe("useUpdater / dismiss", () => {
  it("lets a later check offer the same update again", async () => {
    // Regression: dismissing used to leave the pending update in place, and
    // `check` returns early while one is held — so every later check, the
    // six-hourly one and the Settings button alike, did nothing for the rest
    // of the session while the app claimed it would notify you.
    offerUpdate();
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    expect(result.current.phase).toBe("available");

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");

    await act(async () => { await result.current.check(false); });

    expect(plugins.check).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("available");
    expect(result.current.version).toBe("0.1.230");
  });

  it("clears a failure banner", async () => {
    // The other half of the same regression: dismiss only mapped "available"
    // to "idle", so the × on the failure banner did nothing and the banner sat
    // in the corner until the app was relaunched.
    offerUpdate({ downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")) });
    const { result } = renderUpdater();
    await act(async () => { await result.current.check(); });
    await act(async () => { await result.current.install(); });
    expect(result.current.phase).toBe("error");

    act(() => result.current.dismiss());

    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});

describe("UpdateBanner", () => {
  it("stays out of the way until there is something to say", async () => {
    const api = renderBanner();

    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { await api.current.check(false); });

    expect(api.current.phase).toBe("up-to-date");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers the update, installs it, and shows progress", async () => {
    const download = pausedDownload();
    offerUpdate({ downloadAndInstall: download.downloadAndInstall });
    const api = renderBanner();
    await act(async () => { await api.current.check(); });

    expect(screen.getByText("New version 0.1.230")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(screen.getByText("Downloading update…")).toBeInTheDocument());
    act(() => download.emit({ event: "Started", data: { contentLength: 400 } }));
    act(() => download.emit({ event: "Progress", data: { chunkLength: 100 } }));
    expect(screen.getByText("25%")).toBeInTheDocument();

    act(() => download.emit({ event: "Finished" }));
    expect(screen.getByText("Installing…")).toBeInTheDocument();
  });

  it("does not report a failed check as a failed update", async () => {
    // The only way to reach a non-silent check is the Settings button, and that
    // row reports the outcome itself. Painting "Update failed" in the corner
    // announces an install that never started — and a download that never
    // happened cannot be retried or meaningfully dismissed.
    plugins.check.mockRejectedValue(new Error("network unreachable"));
    const api = renderBanner();

    await act(async () => { await api.current.check(false); });

    expect(api.current.phase).toBe("error");
    expect(screen.queryByText("Update failed")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the offer from the banner", async () => {
    offerUpdate();
    const api = renderBanner();
    await act(async () => { await api.current.check(); });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the failure banner from the banner", async () => {
    offerUpdate({ downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")) });
    const api = renderBanner();
    await act(async () => { await api.current.check(); });
    await act(async () => { await api.current.install(); });
    expect(screen.getByText("Update failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("status")).toBeNull();
  });
});
