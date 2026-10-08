import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAppLog,
  clearAppLogs,
  type AppLogEntry,
} from "./app-log-store";
import { AppLogsSettings } from "./app-log";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

type LogInput = Parameters<typeof addAppLog>[0];

function show(entry: LogInput) {
  let created!: AppLogEntry;
  act(() => { created = addAppLog(entry); });
  return created;
}

/** A log-only entry: the Logs pane reads these without any toast on screen. */
const record = (entry: Partial<LogInput>) => show({ level: "info", source: "Build", title: "Built", toast: false, ...entry });

const searchLogs = (value: string) =>
  fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value } });

const actionRow = () => within(document.querySelector<HTMLElement>(".app-log-action-row")!);

function mockClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

/** Holds `collect_diagnostic_logs` open until the test settles it. */
function deferRuntimeLogs() {
  const pending = {} as { resolve: (value: unknown) => void; reject: (error: Error) => void };
  vi.mocked(invoke).mockImplementation(async (command) => command === "collect_diagnostic_logs"
    ? new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }))
    : "/tmp/lattice-logs");
  return pending;
}

/** Open the export dialog for every visible entry and return its runtime-log consent box. */
function openRuntimeExport() {
  render(<AppLogsSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  return screen.getByRole("checkbox", { name: /Include app and Agent runtime logs/ });
}

describe("AppLogsSettings", () => {
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

  it("keeps aligned search and action rows without optional failure or slow filters", async () => {
    record({});
    render(<AppLogsSettings />);

    const filter = screen.getByRole("combobox", { name: "Log level filter" });
    const queryRow = document.querySelector(".app-log-query-row");
    expect(actionRow().getByRole("button", { name: "Export…" })).toBeEnabled();
    expect(queryRow).toContainElement(screen.getByRole("searchbox", { name: "Search logs" }));
    expect(queryRow).toContainElement(filter);
    expect(screen.queryByLabelText("Only failures")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Only slow (over 2000 ms)")).not.toBeInTheDocument();
    expect(filter).toHaveClass("app-log-level-filter");
    expect(screen.queryByText("/tmp/lattice-logs")).not.toBeInTheDocument();
    expect(screen.getByText("The last 300 entries")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open log folder" })).toBeEnabled());
  });

  it("renders chronological event rows with expandable details and search", () => {
    record({ level: "warning", source: "PDF", title: "First event", detail: "Line one\nLine two" });
    record({ level: "success", title: "Second event" });
    render(<AppLogsSettings />);

    const rows = [...document.querySelectorAll("[data-log-entry]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("First event");
    expect(rows[1]).toHaveTextContent("Second event");
    expect(rows[0].querySelector(".app-log-severity")).toHaveTextContent("WARN");
    expect(rows[1].querySelector(".app-log-severity")).toHaveTextContent("OK");
    expect(rows[0].querySelector("summary time")?.textContent).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(rows[0].querySelector("summary .app-log-inline-fields")).toHaveTextContent("source=PDF");
    expect(rows[0]).not.toHaveAttribute("open");
    fireEvent.click(rows[0].querySelector("summary")!);
    expect(rows[0]).toHaveAttribute("open");
    expect(rows[0]).toHaveTextContent("Line one Line two");

    searchLogs("build");
    expect(screen.queryByText("First event")).toBeNull();
    expect(screen.getAllByText("Second event")[0]).toBeInTheDocument();
  });

  it("surfaces the captured diagnostic while preserving the original console event", () => {
    record({ level: "warning", source: "App", title: "console.warn", detail: "Preview unavailable\nRetry scheduled" });
    render(<AppLogsSettings />);
    const summary = document.querySelector("[data-log-entry] summary")!;
    expect(summary).toHaveTextContent("Preview unavailable");
    expect(summary).not.toHaveTextContent("console.warn");
    fireEvent.click(summary);
    expect(document.querySelector(".app-log-message")).toHaveTextContent("console.warn Preview unavailable Retry scheduled");
  });

  it("keeps per-entry export inside details and previews exactly the selected entry", () => {
    record({ level: "error", source: "private source", title: "secret title", detail: "secret detail" });
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
    record({
      level: "success", title: "Compiled", detail: "#abcdef",
      context: {
        operation_id: "abcdef12-3456-7890-abcd-123456789012", operation: "Build",
        phase: "completed", outcome: "success", duration_ms: 1200, metrics: { diagnostics: 0 },
      },
    });
    render(<AppLogsSettings />);
    expect(screen.getAllByText("1200 ms")[0]).toBeInTheDocument();
    expect(screen.getAllByTitle("abcdef12-3456-7890-abcd-123456789012")[0]).toHaveTextContent("abcdef12");
    expect(screen.queryByText("#abcdef")).toBeNull();
    searchLogs("123456789012");
    expect(screen.getAllByText("Compiled")[0]).toBeInTheDocument();
    searchLogs("missing-operation");
    expect(screen.getByText("No matching logs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear log search" }));
    expect(screen.getAllByText("Compiled")[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("No logs yet")).toBeInTheDocument();
  });

  it("opens at the newest entry without interrupting someone reading older logs", () => {
    let scrollHeight = 600;
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-slot='scroll-area-viewport']") ? scrollHeight : 0;
    });
    try {
      record({});
      render(<AppLogsSettings />);

      const viewport = document.querySelector<HTMLDivElement>(".app-log-scroll [data-slot='scroll-area-viewport']")!;
      expect(viewport.scrollTop).toBe(600);

      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
      viewport.scrollTop = 100;
      scrollHeight = 700;
      record({ title: "Built again" });
      expect(viewport.scrollTop).toBe(100);
    } finally {
      height.mockRestore();
    }
  });

  it("groups an operation around its terminal summary and expands the complete timeline", () => {
    const context = { operation_id: "123e4567-e89b-42d3-a456-426614174000", operation: "Build", metrics: {} } as const;
    record({ title: "Started build", context: { ...context, phase: "started" } });
    record({ level: "error", title: "Build failed", context: { ...context, phase: "completed", outcome: "error", duration_ms: 2501 } });
    record({ title: "Cleanup breadcrumb", context: { ...context, phase: "progress" } });
    record({
      level: "success", source: "Diagnostics", title: "Late request succeeded",
      context: { ...context, request_id: crypto.randomUUID(), phase: "completed", outcome: "success" },
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

  it("exports backend logs without frontend entries, only after consent, and copies the preview", async () => {
    const bundle = { platform: "macos", arch: "aarch64", files: [
      { name: "sidecar-error.log", content: "sandbox-exec: sandbox_apply: Operation not permitted", truncated: true },
      { name: "server.log", content: "", truncated: false, error: "not found" },
    ] };
    const runtimeLogs = deferRuntimeLogs();
    const writeText = mockClipboard();
    const consent = openRuntimeExport();
    expect(consent).not.toBeChecked();
    expect(invoke).not.toHaveBeenCalledWith("collect_diagnostic_logs");
    fireEvent.click(consent);
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeDisabled();
    await act(async () => runtimeLogs.resolve(bundle));
    const preview = screen.getByLabelText("Export preview");
    expect(JSON.parse(preview.textContent!).runtime_logs).toEqual(bundle);
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(writeText).toHaveBeenCalledWith(preview.textContent);
    fireEvent.click(consent);
    expect(JSON.parse(preview.textContent!)).not.toHaveProperty("runtime_logs");
  });

  it("does not include a late collection after consent is withdrawn and can retry failures", async () => {
    const failed = deferRuntimeLogs();
    const consent = openRuntimeExport();
    fireEvent.click(consent);
    await act(async () => failed.reject(new Error("Unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeDisabled();
    const retried = deferRuntimeLogs();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(consent);
    await act(async () => retried.resolve({ files: [{ name: "server.log", content: "late diagnostic" }] }));
    expect(screen.getByLabelText("Export preview")).not.toHaveTextContent("late diagnostic");
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeEnabled();
  });

  it("previews and copies a safe stable export, requiring consent for raw text", () => {
    const writeText = mockClipboard();
    record({ level: "error", source: "/private/alice", title: "secret title", detail: "document body" });
    render(<AppLogsSettings />);
    const exportButton = actionRow().getByRole("button", { name: "Export…" });
    fireEvent.click(exportButton);
    const preview = screen.getByLabelText("Export preview");
    expect(preview).not.toHaveTextContent("document body");
    const original = preview.textContent;
    record({ source: "App", title: "New event" });
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
