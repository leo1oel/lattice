import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAppLog,
  clearAppLogs,
  dismissAppToast,
  formatAppLogs,
  updateAppLog,
  useAppToastsSnapshot,
} from "./app-log-store";
import { AppLogsSettings, AppToastStack } from "./app-log";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

describe("AppToastStack", () => {
  beforeEach(() => {
    // Auto-cleanup only registers under `globals: true`, which this project
    // does not set, so each test unmounts the previous tree itself.
    cleanup();
    clearAppLogs();
    vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
      if (command === "get_app_log_dir") return "/tmp/lattice-logs";
      if (command === "open_app_log_dir") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("updates a bridged notification in place and keeps its actions", () => {
    const onAction = vi.fn();
    render(<AppToastStack />);
    let entry!: ReturnType<typeof addAppLog>;
    act(() => {
      entry = addAppLog({
        level: "info",
        source: "Synara settings",
        title: "Updating Pi…",
        toastOptions: {
          timeoutMs: 0,
          primaryAction: { label: "Cancel", onClick: onAction },
        },
      });
    });

    expect(screen.getByText("Updating Pi…")).toBeInTheDocument();
    act(() => {
      updateAppLog(
        entry.id,
        {
          level: "error",
          title: "Could not update Pi",
          detail: "NotFound: ChildProcess.spawn (pi update)",
        },
        {
          timeoutMs: 0,
          primaryAction: { label: "Retry", onClick: onAction },
        },
      );
    });

    expect(screen.queryByText("Updating Pi…")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not update Pi");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("rewires a deduped repeat's buttons and not only its text", () => {
    const showLog = vi.fn();
    const retry = vi.fn();
    render(<AppToastStack />);
    act(() => {
      addAppLog({
        level: "error",
        source: "Build",
        title: "Build failed",
        dedupeKey: "build",
        toastOptions: { timeoutMs: 0, primaryAction: { label: "Show log", onClick: showLog } },
      });
    });
    act(() => {
      addAppLog({
        level: "error",
        source: "Build",
        title: "Build failed",
        detail: "Undefined control sequence",
        dedupeKey: "build",
        toastOptions: { timeoutMs: 0, primaryAction: { label: "Retry", onClick: retry } },
      });
    });

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show log" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(showLog).not.toHaveBeenCalled();
  });

  // The store is what has to make the swap observable. A toast reading its
  // actions out of a module map during render is correct only for as long as
  // something else happens to re-render it: the id does not move when the
  // actions are replaced, so any memo keyed on the entry keeps the old buttons.
  it("moves the toast snapshot when only the actions change", () => {
    const { result } = renderHook(() => useAppToastsSnapshot());
    let entry!: ReturnType<typeof addAppLog>;
    act(() => {
      entry = addAppLog({
        level: "info",
        source: "Synara settings",
        title: "Updating Pi…",
        toastOptions: { timeoutMs: 0, primaryAction: { label: "Cancel", onClick: vi.fn() } },
      });
    });
    const first = result.current;
    expect(first.map((toast) => toast.options?.primaryAction?.label)).toEqual(["Cancel"]);

    act(() => {
      updateAppLog(
        entry.id,
        { level: "error", title: "Could not update Pi" },
        { timeoutMs: 0, primaryAction: { label: "Retry", onClick: vi.fn() } },
      );
    });

    expect(result.current[0].entry.id).toBe(entry.id);
    expect(result.current).not.toBe(first);
    expect(result.current[0].options?.primaryAction?.label).toBe("Retry");
  });

  it("holds the toast snapshot still for an entry nobody is shown", () => {
    const { result } = renderHook(() => useAppToastsSnapshot());
    act(() => {
      addAppLog({ level: "info", source: "Build", title: "Built", toastOptions: { timeoutMs: 0 } });
    });
    const first = result.current;
    act(() => {
      addAppLog({ level: "info", source: "Build", title: "Cached", toast: false });
    });

    expect(result.current).toBe(first);
  });

  it("refuses focus so dismissing one does not move the caret out of the editor", () => {
    render(<AppToastStack />);
    act(() => {
      addAppLog({ level: "warning", source: "PDF", title: "No matching position in the PDF." });
    });

    const toast = screen.getByRole("status");
    // preventDefault on mousedown reports back as a `false` return, which is
    // what keeps the editor's selection where the writer left it.
    expect(fireEvent.mouseDown(toast)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("collapses a repeat into the toast already showing it", () => {
    render(<AppToastStack />);
    act(() => {
      addAppLog({ level: "error", source: "Build", title: "Build failed", detail: "first", dedupeKey: "build" });
      addAppLog({ level: "error", source: "Build", title: "Build failed", detail: "second", dedupeKey: "build" });
      addAppLog({ level: "error", source: "Build", title: "Build failed", detail: "third", dedupeKey: "build" });
    });

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("third");
    // Every occurrence still reaches the log — collapsing is a display rule,
    // not a record of what happened.
    expect(formatAppLogs()).toContain("third");
  });

  it("keeps action correlation ids in the log without showing them to the user", () => {
    render(<AppToastStack />);
    act(() => {
      addAppLog({
        level: "error",
        source: "Build",
        title: "Build failed",
        detail: "Undefined control sequence\n#8c4c85",
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Undefined control sequence");
    expect(screen.getByRole("alert")).not.toHaveTextContent("#8c4c85");
    expect(formatAppLogs()).toContain("#8c4c85");
  });

  it("stops collapsing once the toast it was folding into is gone", () => {
    render(<AppToastStack />);
    let first!: ReturnType<typeof addAppLog>;
    act(() => {
      first = addAppLog({ level: "info", source: "Overleaf", title: "Synced", dedupeKey: "sync" });
    });
    act(() => dismissAppToast(first.id));
    act(() => {
      addAppLog({ level: "info", source: "Overleaf", title: "Synced", dedupeKey: "sync" });
    });

    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps aligned search and action rows without optional failure or slow filters", async () => {
    act(() => {
      addAppLog({ level: "info", source: "Build", title: "Built", toast: false });
    });
    render(<AppLogsSettings />);

    const filter = screen.getByRole("combobox", { name: "Log level filter" });
    expect(within(document.querySelector(".app-log-action-row")! as HTMLElement).getByRole("button", { name: "Export…" })).toBeEnabled();
    expect(document.querySelector(".app-log-query-row")).toContainElement(screen.getByRole("searchbox", { name: "Search logs" }));
    expect(document.querySelector(".app-log-query-row")).toContainElement(filter);
    expect(screen.queryByLabelText("Only failures")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Only slow (over 2000 ms)")).not.toBeInTheDocument();
    expect(filter).toHaveClass("app-log-level-filter");
    expect(screen.queryByText("/tmp/lattice-logs")).not.toBeInTheDocument();
    expect(screen.getByText("Shows 300 recent entries; disk logs rotate"))
      .toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open log folder" })).toBeEnabled());
  });

  it("renders chronological event rows with expandable details and search", () => {
    act(() => {
      addAppLog({
        level: "warning",
        source: "PDF",
        title: "First event",
        detail: "Line one\nLine two",
        toast: false,
      });
      addAppLog({ level: "success", source: "Build", title: "Second event", toast: false });
    });
    render(<AppLogsSettings />);

    const rows = [...document.querySelectorAll("[data-log-entry]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("First event");
    expect(rows[1]).toHaveTextContent("Second event");
    expect(rows[0].querySelector(".app-log-severity")).toHaveTextContent("WARN");
    expect(rows[1].querySelector(".app-log-severity")).toHaveTextContent("OK");
    expect(rows[0].querySelector("summary time")?.textContent).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(rows[0].querySelector("summary .app-log-inline-fields")).toHaveTextContent("source=PDF");
    const details = rows[0];
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(details.querySelector("summary")!);
    expect(details).toHaveAttribute("open");
    expect(details).toHaveTextContent("Line one Line two");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), {
      target: { value: "build" },
    });
    expect(screen.queryByText("First event")).toBeNull();
    expect(screen.getAllByText("Second event")[0]).toBeInTheDocument();
  });

  it("surfaces the captured diagnostic while preserving the original console event", () => {
    addAppLog({ level: "warning", source: "App", title: "console.warn", detail: "Preview unavailable\nRetry scheduled", toast: false });
    render(<AppLogsSettings />);
    const row = document.querySelector("[data-log-entry]")!;
    expect(row.querySelector("summary")).toHaveTextContent("Preview unavailable");
    expect(row.querySelector("summary")).not.toHaveTextContent("console.warn");
    fireEvent.click(row.querySelector("summary")!);
    expect(row.querySelector(".app-log-message")).toHaveTextContent("console.warn Preview unavailable Retry scheduled");
  });

  it("keeps per-entry export inside details and previews exactly the selected entry", () => {
    act(() => {
      addAppLog({ level: "error", source: "private source", title: "secret title", detail: "secret detail", toast: false });
    });
    render(<AppLogsSettings />);

    expect(screen.queryByRole("button", { name: "Copy redacted log" })).not.toBeInTheDocument();
    const entry = document.querySelector("[data-log-entry]")!;
    expect(entry).not.toHaveAttribute("open");
    expect(entry.querySelector("summary button")).toBeNull();
    fireEvent.click(entry.querySelector("summary")!);
    fireEvent.click(entry.querySelector("button")!);
    const preview = screen.getByLabelText("Export preview");
    expect(JSON.parse(preview.textContent!).entries).toHaveLength(1);
    expect(preview).not.toHaveTextContent("secret detail");
    fireEvent.click(screen.getByRole("checkbox", { name: /Include raw diagnostic text/ }));
    expect(preview).toHaveTextContent("secret detail");
  });

  it("searches full operation ids and shows readable metadata without duplicate tags", () => {
    addAppLog({
      level: "success", source: "Build", title: "Compiled", detail: "#abcdef", toast: false,
      context: {
        operation_id: "abcdef12-3456-7890-abcd-123456789012", operation: "Build",
        phase: "completed", outcome: "success", duration_ms: 1200, metrics: { diagnostics: 0 },
      },
    });
    render(<AppLogsSettings />);
    expect(screen.getAllByText("1200 ms")[0]).toBeInTheDocument();
    expect(screen.getAllByTitle("abcdef12-3456-7890-abcd-123456789012")[0]).toHaveTextContent("abcdef12");
    expect(screen.queryByText("#abcdef")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value: "123456789012" } });
    expect(screen.getAllByText("Compiled")[0]).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value: "missing-operation" } });
    expect(screen.getByText("No matching logs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear log search" }));
    expect(screen.getAllByText("Compiled")[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("No logs yet")).toBeInTheDocument();
  });

  it("opens at the newest entry without interrupting someone reading older logs", () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    let scrollHeight = 600;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.matches("[data-slot='scroll-area-viewport']")
          ? scrollHeight
          : 0;
      },
    });
    try {
      act(() => {
        addAppLog({ level: "info", source: "Build", title: "Built", toast: false });
      });
      render(<AppLogsSettings />);

      const viewport = document.querySelector(".app-log-scroll [data-slot='scroll-area-viewport']") as HTMLDivElement;
      expect(viewport.scrollTop).toBe(600);

      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
      viewport.scrollTop = 100;
      scrollHeight = 700;
      act(() => {
        addAppLog({ level: "info", source: "Build", title: "Built again", toast: false });
      });
      expect(viewport.scrollTop).toBe(100);
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      }
    }
  });

  it("groups an operation around its terminal summary and expands the complete timeline", () => {
    const operationId = "123e4567-e89b-42d3-a456-426614174000";
    const context = { operation_id: operationId, operation: "Build", metrics: {} } as const;
    act(() => {
      addAppLog({ level: "info", source: "Build", title: "Started build", toast: false,
        context: { ...context, phase: "started" } });
      addAppLog({ level: "error", source: "Build", title: "Build failed", toast: false,
        context: { ...context, phase: "completed", outcome: "error", duration_ms: 2501 } });
      addAppLog({ level: "info", source: "Build", title: "Cleanup breadcrumb", toast: false,
        context: { ...context, phase: "progress" } });
      addAppLog({ level: "success", source: "Diagnostics", title: "Late request succeeded", toast: false,
        context: { ...context, request_id: crypto.randomUUID(), phase: "completed", outcome: "success" } });
    });
    render(<AppLogsSettings />);

    const group = document.querySelector("[data-log-operation]")!;
    expect(group).toHaveTextContent("Build failed");
    expect(group.querySelector("summary")).not.toHaveTextContent("Cleanup breadcrumb");
    expect(group.querySelector("summary")).not.toHaveTextContent("Late request succeeded");
    fireEvent.click(group.querySelector("summary")!);
    expect(group).toHaveAttribute("open");
    const rows = [...group.querySelectorAll("[data-log-entry]")];
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Started build"), expect.stringContaining("Build failed"), expect.stringContaining("Cleanup breadcrumb"),
    ]));
    expect(document.querySelectorAll("[data-log-operation]")).toHaveLength(1);
  });

  it("previews and copies a safe stable export, requiring consent for raw text", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    act(() => { addAppLog({ level: "error", source: "/private/alice", title: "secret title", detail: "document body", toast: false }); });
    render(<AppLogsSettings />);
    const exportButton = within(document.querySelector(".app-log-action-row")! as HTMLElement).getByRole("button", { name: "Export…" });
    fireEvent.click(exportButton);
    const preview = screen.getByLabelText("Export preview");
    expect(preview).not.toHaveTextContent("document body");
    const original = preview.textContent;
    act(() => { addAppLog({ level: "info", source: "App", title: "New event", toast: false }); });
    expect(preview.textContent).toBe(original);
    fireEvent.click(screen.getByRole("checkbox", { name: /Include raw diagnostic text/ }));
    expect(preview).toHaveTextContent("document body");
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(writeText).toHaveBeenCalledWith(preview.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(exportButton);
    expect(screen.getByRole("checkbox", { name: /Include raw diagnostic text/ })).not.toBeChecked();
  });
});
