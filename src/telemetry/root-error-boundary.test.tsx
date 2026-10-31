import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCrashEdits } from "./crash-save";
import { RootErrorBoundary, RootErrorFallback } from "./root-error-boundary";

const relaunch = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderFallback(onRestart = vi.fn(), onCopyDetails = vi.fn()) {
  render(<RootErrorFallback error={new Error("renderer failed")} onRestart={onRestart} onCopyDetails={onCopyDetails} />);
  return { onRestart, onCopyDetails };
}

describe("RootErrorFallback", () => {
  it("keeps technical details collapsed, then restarts and copies the captured error", async () => {
    const { onRestart, onCopyDetails } = renderFallback(vi.fn(), vi.fn().mockResolvedValue(undefined));
    expect(screen.getByRole("alert")).toHaveAccessibleName("Lattice couldn’t open this window");
    expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "Restart Lattice" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));

    expect(onRestart).toHaveBeenCalledOnce();
    await waitFor(() => expect(onCopyDetails).toHaveBeenCalledWith(expect.stringContaining("renderer failed")));
    expect(await screen.findByRole("button", { name: "Error details copied" })).toBeInTheDocument();
  });

  it("explains how to recover when automatic actions fail", async () => {
    renderFallback(vi.fn().mockRejectedValue(new Error("restart denied")), vi.fn().mockRejectedValue(new Error("clipboard denied")));

    fireEvent.click(screen.getByRole("button", { name: "Restart Lattice" }));
    expect(await screen.findByText("Lattice couldn’t restart automatically. Quit and reopen it manually.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));
    expect(await screen.findByText("Couldn’t copy the details. Expand Technical details and copy them manually.")).toBeInTheDocument();
  });
});

function Crashing(): never {
  throw new Error("App render failed");
}

describe("RootErrorBoundary", () => {
  it("starts writing the open edits as the crash page replaces the window, and Restart waits for the write", async () => {
    // React reports the caught render error on the console; this test causes it on purpose.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const order: string[] = [];
    let finishSave!: (saved: boolean) => void;
    const unregister = registerCrashEdits({
      flush: () => { order.push("flush"); return true; },
      save: () => new Promise<boolean>((resolve) => { finishSave = resolve; }).then((saved) => { order.push("written"); return saved; }),
    });
    relaunch.mockImplementation(async () => { order.push("relaunch"); });

    render(<RootErrorBoundary><Crashing /></RootErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveAccessibleName("Lattice couldn’t open this window");
    // Before the fix the crash page unmounted App with the last edits only in memory.
    expect(order).toEqual(["flush"]);

    fireEvent.click(screen.getByRole("button", { name: "Restart Lattice" }));
    await act(async () => { await Promise.resolve(); });
    expect(relaunch).not.toHaveBeenCalled();
    act(() => finishSave(true));
    await waitFor(() => expect(order).toEqual(["flush", "written", "relaunch"]));
    unregister();
  });
});
