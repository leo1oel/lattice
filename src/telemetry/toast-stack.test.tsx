import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAppLog,
  clearAppLogs,
  dismissAppToast,
  formatAppLogs,
  getVisibleAppToastIds,
  updateAppLog,
  updateAppToastProgress,
  useAppToastsSnapshot,
  type AppLogEntry,
} from "./app-log-store";
import { playInterfaceSound } from "./interface-sounds";
import { configureToastPosition } from "./toast-position";
import { ToastStack } from "./toast-stack";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("./interface-sounds", () => ({ playInterfaceSound: vi.fn(), configureInterfaceSounds: vi.fn() }));

type LogInput = Parameters<typeof addAppLog>[0];

function show(entry: LogInput) {
  let created!: AppLogEntry;
  act(() => { created = addAppLog(entry); });
  return created;
}

/** Cards on screen, leaving out any still playing its exit. */
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-app-toast]:not([data-ending-style])")];
const card = (title: string) => {
  const found = cards().find((element) => element.textContent?.includes(title));
  if (!found) throw new Error(`No toast titled ${title}`);
  return within(found);
};

/**
 * A toast's button. An urgent (error) toast stays `aria-hidden` until keyboard
 * focus reaches it, because Base UI announces its title and description
 * through an alert region instead; so the query has to look past that.
 */
const button = (name: string) => screen.getByRole("button", { name, hidden: true });

/** A bridged Synara notification whose Cancel is later swapped for Retry. */
const updatingPi = (onClick: () => void): LogInput => ({
  level: "info", source: "Synara settings", title: "Updating Pi…",
  toastOptions: { timeoutMs: 0, progress: "indeterminate", primaryAction: { label: "Cancel", onClick } },
});
const failPiUpdate = (id: string, patch: Parameters<typeof updateAppLog>[1], onClick: () => void) =>
  act(() => { updateAppLog(id, { level: "error", ...patch }, { timeoutMs: 0, primaryAction: { label: "Retry", onClick } }); });

describe("ToastStack", () => {
  beforeEach(() => {
    // Auto-cleanup only registers under `globals: true`, which this project
    // does not set, so each test unmounts the previous tree itself.
    cleanup();
    clearAppLogs();
    configureToastPosition("top-right");
    vi.mocked(playInterfaceSound).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("mounts nothing until there is something to say", () => {
    const { container } = render(<ToastStack />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region")).toBeNull();

    show({ level: "info", source: "Build", title: "Built" });
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveAttribute("data-position", "top-right");
  });

  it("updates a bridged notification in place and keeps its actions", () => {
    const onAction = vi.fn();
    render(<ToastStack />);
    const entry = show(updatingPi(onAction));

    expect(card("Updating Pi…").getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    failPiUpdate(entry.id, { title: "Could not update Pi", detail: "NotFound: ChildProcess.spawn (pi update)" }, onAction);

    expect(screen.queryByText("Updating Pi…")).toBeNull();
    expect(cards()).toHaveLength(1);
    expect(card("Could not update Pi").queryByRole("progressbar")).toBeNull();
    // The settled outcome of an operation the writer watched is the one toast that speaks.
    expect(playInterfaceSound).toHaveBeenCalledExactlyOnceWith("error");
    fireEvent.click(button("Retry"));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("collapses a repeat into the toast already showing it, rewiring its buttons and not only its text", () => {
    const showLog = vi.fn();
    const retry = vi.fn();
    const failure = { level: "error", source: "Build", title: "Build failed", dedupeKey: "build" } as const;
    render(<ToastStack />);
    show({ ...failure, detail: "first", toastOptions: { timeoutMs: 0, primaryAction: { label: "Show log", onClick: showLog } } });
    show({ ...failure, detail: "second" });
    show({ ...failure, detail: "third\n#8c4c85", toastOptions: { timeoutMs: 0, primaryAction: { label: "Retry", onClick: retry } } });

    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toHaveTextContent("third");
    // Every occurrence still reaches the log — collapsing is a display rule,
    // not a record of what happened. Action correlation ids stay in the log too,
    // without being shown to the user.
    expect(formatAppLogs()).toContain("third");
    expect(cards()[0]).not.toHaveTextContent("#8c4c85");
    expect(formatAppLogs()).toContain("#8c4c85");
    expect(screen.queryByRole("button", { name: "Show log", hidden: true })).toBeNull();
    fireEvent.click(button("Retry"));
    expect(retry).toHaveBeenCalledOnce();
    expect(showLog).not.toHaveBeenCalled();
  });

  // The store is what has to make the swap observable. A toast reading its
  // actions out of a module map during render is correct only for as long as
  // something else happens to re-render it: the id does not move when the
  // actions are replaced, so any memo keyed on the entry keeps the old buttons.
  it("moves the toast snapshot when only the actions change, and holds it still for an entry nobody is shown", () => {
    const { result } = renderHook(() => useAppToastsSnapshot());
    const entry = show(updatingPi(vi.fn()));
    const first = result.current;
    expect(first.map((toast) => toast.options?.primaryAction?.label)).toEqual(["Cancel"]);
    show({ level: "info", source: "Build", title: "Cached", toast: false });
    expect(result.current).toBe(first);

    failPiUpdate(entry.id, { title: "Could not update Pi" }, vi.fn());

    expect(result.current[0].entry.id).toBe(entry.id);
    expect(result.current).not.toBe(first);
    expect(result.current[0].options?.primaryAction?.label).toBe("Retry");
  });

  it("refuses focus on press and reports a dismissal from its close button", async () => {
    const onDismiss = vi.fn();
    render(<ToastStack />);
    show({ level: "warning", source: "PDF", title: "No matching position in the PDF.", toastOptions: { onDismiss } });

    const toast = cards()[0];
    // preventDefault on mousedown reports back as a `false` return, which is
    // what keeps the editor's selection where the writer left it.
    expect(fireEvent.mouseDown(toast)).toBe(false);
    fireEvent.click(within(toast).getByRole("button", { name: "Dismiss notification" }));

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(getVisibleAppToastIds()).toEqual([]);
    await waitFor(() => expect(toast).not.toBeInTheDocument());
  });

  it("closes a toast the store retracted without reporting a dismissal", async () => {
    const onDismiss = vi.fn();
    render(<ToastStack />);
    const entry = show({ level: "error", source: "Build", title: "Build failed", toastOptions: { onDismiss } });

    act(() => dismissAppToast(entry.id, false));

    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // An Undo or Resume is the answer to the toast, so the toast goes with it,
  // without also reporting a dismissal. A toast with a choice left keeps open.
  it("takes a toast down once its action runs, unless the action keeps it open", async () => {
    render(<ToastStack />);
    const undo = vi.fn();
    const onDismiss = vi.fn();
    show({ level: "info", source: "Comments", title: "Comment deleted", toastOptions: { primaryAction: { label: "Undo", onClick: undo }, onDismiss } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(onDismiss).not.toHaveBeenCalled();

    const copy = vi.fn();
    show({ level: "error", source: "Editor", title: "Draft kept", toastOptions: { timeoutMs: 0, primaryAction: { label: "Copy draft", onClick: copy, keepOpen: true } } });
    fireEvent.click(button("Copy draft"));
    expect(copy).toHaveBeenCalledOnce();
    expect(card("Draft kept").getByRole("button", { name: "Copy draft", hidden: true })).toBeInTheDocument();
  });

  it("stops collapsing once the toast it was folding into is gone", async () => {
    const synced = { level: "info", source: "Overleaf", title: "Synced", dedupeKey: "sync" } as const;
    render(<ToastStack />);
    const first = show(synced);
    act(() => dismissAppToast(first.id));
    show(synced);

    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveAttribute("data-app-toast");
  });

  it("stacks the newest in front and keeps at most four", () => {
    render(<ToastStack />);
    for (const title of ["One", "Two", "Three", "Four", "Five"]) show({ level: "info", source: "Test", title, dedupeKey: title });

    const titles = cards().map((element) => element.querySelector(".app-toast-title")?.textContent);
    expect(titles).toEqual(["Five", "Four", "Three", "Two"]);
    expect(cards().map((element) => element.style.getPropertyValue("--toast-index"))).toEqual(["0", "1", "2", "3"]);
  });

  it("draws determinate progress without logging each step, and never times a running toast out", () => {
    vi.useFakeTimers();
    render(<ToastStack />);
    show({ level: "info", source: "App updater", title: "Downloading update…", dedupeKey: "update", toastOptions: { progress: 0 } });
    const logged = formatAppLogs();

    act(() => updateAppToastProgress("update", 0.25));
    const bar = card("Downloading update…").getByRole("progressbar", { name: "Downloading update…" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(card("Downloading update…").getByText("25%")).toBeInTheDocument();
    expect(formatAppLogs()).toBe(logged);

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(cards()).toHaveLength(1);
  });

  it("dismisses a finished notification on its clock and reports it", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<ToastStack />);
    show({ level: "success", source: "Build", title: "PDF built", toastOptions: { timeoutMs: 2_000, onDismiss } });

    act(() => { vi.advanceTimersByTime(1_900); });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(getVisibleAppToastIds()).toEqual([]);
  });

  it("announces an urgent failure and stands where Settings put it", () => {
    render(<ToastStack />);
    show({ level: "error", source: "Overleaf", title: "Couldn’t sync with Overleaf", detail: "Overleaf answered 503." });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t sync with Overleaf");
    act(() => configureToastPosition("bottom-center"));
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveAttribute("data-position", "bottom-center");
  });
});
