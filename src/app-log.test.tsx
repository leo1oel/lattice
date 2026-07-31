import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAppLog,
  AppToastStack,
  clearAppLogs,
  updateAppLog,
} from "./app-log";

describe("AppToastStack", () => {
  beforeEach(() => {
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
});
