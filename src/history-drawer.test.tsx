/**
 * The Project history drawer holds three separate records of the same project,
 * and only two of them always exist. These cover the gating around the third:
 * Overleaf's server-side history is offered only when the project is linked,
 * and the remembered tab has to survive opening a project that isn't.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { HistoryDrawer } from "./history-drawer";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function mockBackend() {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "git_status") return { repository: true, dirty: false, files: [] };
    if (command === "git_log") return [];
    if (command === "overleaf_history_updates") return { updates: [], nextBefore: null };
    if (command === "overleaf_history_labels") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
}

const required = {
  history: [],
  onClose: () => undefined,
  onRevert: () => undefined,
  onDelete: () => undefined,
};

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("HistoryDrawer", () => {
  it("offers Overleaf's history only when the project is linked", () => {
    mockBackend();
    const { rerender } = render(<HistoryDrawer {...required} />);
    expect(screen.queryByRole("tab", { name: "Overleaf" })).not.toBeInTheDocument();

    rerender(<HistoryDrawer {...required} overleafLinked />);
    expect(screen.getByRole("tab", { name: "Overleaf" })).toBeInTheDocument();
  });

  it("shows Overleaf's own timeline on that tab, not the git one", async () => {
    mockBackend();
    render(<HistoryDrawer {...required} overleafLinked />);

    fireEvent.click(screen.getByRole("tab", { name: "Overleaf" }));
    expect(await screen.findByText(/Overleaf's own record of this project/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_history_updates", { count: 20 });
  });

  it("falls back off the remembered Overleaf tab for an unlinked project", () => {
    mockBackend();
    // The tab choice is remembered across opens for the session, so pick it
    // here and then reopen as an unlinked project.
    const first = render(<HistoryDrawer {...required} overleafLinked />);
    fireEvent.click(screen.getByRole("tab", { name: "Overleaf" }));
    first.unmount();

    render(<HistoryDrawer {...required} />);
    expect(screen.getByRole("tab", { name: "Versions" })).toHaveAttribute("aria-selected", "true");
  });
});
