import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TexPackageUpdatesReport } from "../build/tex-package-updates";
import { TexPackageUpdatesActions, TexPackageUpdatesCheck } from "../settings/tex-package-updates-row";
import { useTexPackageUpdates } from "./use-tex-package-updates";

type Channel = { onmessage: ((message: unknown) => void) | null };
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channel: null as Channel | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;

    constructor() {
      tauri.channel = this;
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const LINENO = { name: "lineno", installed: "5.7", available: "5.9" };
const outdated = (managed: boolean): TexPackageUpdatesReport => ({ managed, packages: [LINENO] });
const CURRENT: TexPackageUpdatesReport = { managed: true, packages: [] };

afterEach(cleanup);
beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.channel = null;
});

describe("useTexPackageUpdates", () => {
  it("reports the check, and an unreachable repository as an error rather than a failure", async () => {
    tauri.invoke.mockResolvedValueOnce(outdated(true)).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useTexPackageUpdates());
    await act(() => result.current.check());
    expect(tauri.invoke).toHaveBeenCalledWith("check_tex_package_updates");
    expect(result.current.report).toEqual(outdated(true));
    await act(() => result.current.check());
    expect(result.current.report).toEqual({ managed: false, packages: [], error: "offline" });
    expect(result.current.checking).toBe(false);
  });

  it("relays update progress, then checks again for what is left", async () => {
    const install = deferred<void>();
    tauri.invoke.mockImplementation((command: string) =>
      command === "start_tex_package_update" ? install.promise : Promise.resolve(outdated(true)));
    const { result } = renderHook(() => useTexPackageUpdates());
    await act(() => result.current.check());

    tauri.invoke.mockImplementation((command: string) =>
      command === "start_tex_package_update" ? install.promise : Promise.resolve(CURRENT));
    let finished!: Promise<void>;
    act(() => { finished = result.current.update(); });
    expect(result.current.run).toEqual({ progress: { stage: "authorizing", progress: 0 }, running: true, error: null });
    // A second click and a recheck while it runs do nothing.
    await act(() => result.current.update());
    await act(() => result.current.check());
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "start_tex_package_update")).toHaveLength(1);
    expect(result.current.report).toEqual(outdated(true));

    act(() => tauri.channel?.onmessage?.({ stage: "updating-packages", progress: 0.55 }));
    expect(result.current.run?.progress).toEqual({ stage: "updating-packages", progress: 0.55 });

    install.resolve();
    await act(() => finished);
    expect(result.current.run).toEqual({ progress: { stage: "complete", progress: 1 }, running: false, error: null });
    expect(result.current.report).toEqual(CURRENT);
  });

  it("keeps a failed update's message and the report it started from", async () => {
    tauri.invoke.mockImplementation((command: string) => command === "start_tex_package_update"
      ? Promise.reject(new Error("Administrator approval was cancelled, so nothing was updated."))
      : Promise.resolve(outdated(true)));
    const { result } = renderHook(() => useTexPackageUpdates());
    await act(() => result.current.check());
    await act(() => result.current.update());
    expect(result.current.run).toMatchObject({ running: false, error: "Administrator approval was cancelled, so nothing was updated." });
    expect(result.current.report).toEqual(outdated(true));
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "check_tex_package_updates")).toHaveLength(1);
  });

  it("drops a check that was still running when the update started", async () => {
    const staleCheck = deferred<TexPackageUpdatesReport>();
    tauri.invoke.mockReturnValueOnce(staleCheck.promise).mockResolvedValueOnce(undefined).mockResolvedValueOnce(CURRENT);
    const { result } = renderHook(() => useTexPackageUpdates());
    let checking!: Promise<void>;
    act(() => { checking = result.current.check(); });
    await act(() => result.current.update());
    staleCheck.resolve(outdated(true));
    await act(() => checking);
    expect(result.current.report).toEqual(CURRENT);
  });
});

describe("TeX packages check", () => {
  function renderRow(report: TexPackageUpdatesReport) {
    tauri.invoke.mockResolvedValue(report);
    function Row() {
      const updates = useTexPackageUpdates();
      return (
        <>
          <ul><TexPackageUpdatesCheck updates={updates} /></ul>
          <TexPackageUpdatesActions updates={updates} disabled={false} />
        </>
      );
    }
    return render(<Row />);
  }

  it("offers the one-click update for the BasicTeX Lattice manages", async () => {
    renderRow(outdated(true));
    expect(await screen.findByText("Updates available (1): lineno 5.7 → 5.9")).toBeTruthy();
    expect(screen.queryByText("sudo tlmgr update --self --all")).toBeNull();
    tauri.invoke.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Update TeX packages" }));
    expect(await screen.findByRole("progressbar", { name: "TeX package update progress" })).toBeTruthy();
    // Still a problem while it runs: only the recheck after it says otherwise.
    expect(screen.getByText("TeX packages").closest("li")).toHaveClass("warn");
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_package_update", { onProgress: expect.anything() });
  });

  it("gives the command for a TeX the writer installed", async () => {
    renderRow(outdated(false));
    expect(await screen.findByText("sudo tlmgr update --self --all")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update TeX packages" })).toBeNull();
  });

  it("says when packages are current or the repository could not be reached", async () => {
    renderRow(CURRENT);
    expect((await screen.findByText("TeX packages")).closest("li")).toHaveClass("ok");
    expect(screen.getByText("Up to date")).toHaveClass("doctor-check-result");
    cleanup();
    renderRow({ managed: true, packages: [], error: "The TeX Live repository did not answer within 45 seconds." });
    expect(await screen.findByText(/Couldn’t check for updates/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update TeX packages" })).toBeNull();
  });
});
