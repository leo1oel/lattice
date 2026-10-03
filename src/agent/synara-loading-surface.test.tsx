import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { EMPTY_SYNARA_RUNTIME, type SynaraRuntimeInfo } from "./synara-runtime";
import { SynaraLoadingSurface } from "./synara-loading-surface";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const stopped = (message: string | null): SynaraRuntimeInfo => ({ ...EMPTY_SYNARA_RUNTIME, state: "stopped", message });

describe("SynaraLoadingSurface", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(writeText).mockReset();
  });

  it("leads with a calm headline and folds the exact runtime message under Details", async () => {
    const message = "The built-in agent stopped during startup with status 1.\nStartup log: Error: token=abc123 rejected | listen EADDRINUSE";
    const onRetry = vi.fn();
    render(<SynaraLoadingSurface runtime={stopped(message)} onRetry={onRetry} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Agent unavailable");
    expect(alert).toHaveTextContent("The bundled Agent service could not start");
    const details = alert.querySelector("details")!;
    expect(details.open).toBe(false);
    // Exact, line breaks included: nothing is rewritten into a diagnosis.
    expect(details.querySelector("pre")!.textContent).toBe(message);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy details" })); });
    const copied = vi.mocked(writeText).mock.calls[0][0];
    expect(copied).toContain("listen EADDRINUSE");
    expect(copied).toContain("token=[redacted]");
    expect(copied).not.toContain("abc123");
  });

  it("opens the sidecar logs through the backend and says so when there are none", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("The agent has not written any logs yet.").mockResolvedValueOnce(undefined);
    render(<SynaraLoadingSurface runtime={stopped("Synara did not start.")} onRetry={vi.fn()} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open logs" })); });
    expect(invoke).toHaveBeenCalledWith("synara_open_log_folder");
    expect(screen.getByRole("status")).toHaveTextContent("No Agent logs yet");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open logs" })); });
    expect(screen.queryByText("No Agent logs yet")).not.toBeInTheDocument();
  });

  it("offers no empty disclosure when the runtime gave no message", () => {
    render(<SynaraLoadingSurface runtime={stopped(null)} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The bundled Agent service could not start");
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });

  it("shows no failure actions while starting", () => {
    render(<SynaraLoadingSurface runtime={EMPTY_SYNARA_RUNTIME} onRetry={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Starting Agent");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
