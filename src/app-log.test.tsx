import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAppLog,
  clearAppLogs,
  dismissAppToast,
  formatAppLogs,
  updateAppLog,
} from "./app-log-store";
import { AppToastStack } from "./app-log";

describe("AppToastStack", () => {
  beforeEach(() => {
    // Auto-cleanup only registers under `globals: true`, which this project
    // does not set, so each test unmounts the previous tree itself.
    cleanup();
    clearAppLogs();
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
});
