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
  overleafProjectRoot: "/tmp/project",
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
    expect(invoke).toHaveBeenCalledWith("overleaf_history_updates", {
      projectRoot: "/tmp/project",
      count: 20,
    });
  });

  it("keeps the header outside the shared scroll area when changing views", () => {
    mockBackend();
    render(<HistoryDrawer {...required} />);
    const title = screen.getByText("Project history");
    const header = title.closest<HTMLElement>('[data-slot="panel-header"]');
    const viewport = screen.getByLabelText("Project history content");

    expect(viewport).not.toContainElement(header);
    expect(viewport.closest('[data-slot="scroll-area"]'))
      .toHaveClass("project-history-scroll");

    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(screen.getByText("Project history").closest('[data-slot="panel-header"]'))
      .toBe(header);
  });

  it("uses the shared flat drawer tabs rather than button-like selected controls", () => {
    mockBackend();
    const { container } = render(<HistoryDrawer {...required} />);

    expect(container.querySelector(".versions-tabs")).toHaveClass("drawer-view-tabs");
    expect(container.querySelector(".versions-tabs")).toHaveStyle({
      paddingBottom: "var(--space-3)",
    });
    expect(container.querySelector(".sliding-tab-underline")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(container.querySelector(".sliding-tab-underline")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveClass("drawer-view-tab", "active");
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

  it("filters semantic Agent changes and restores them through their checkpoint", () => {
    mockBackend();
    const onRevert = vi.fn();
    const agentEntry = {
      id: "agent:thread-1:turn-1",
      label: "Agent: Revise the introduction",
      timestamp: "2026-07-29T12:00:00Z",
      files: ["main.tex"],
      actor: "agent",
      kind: "agent-checkpoint",
      source: "agent-checkpoint",
      threadId: "thread-1",
      threadTitle: "Introduction revision",
      checkpointRef: "refs/lattice/checkpoints/one",
      turnCount: 1,
      restoreAvailable: true,
      fileSummaries: [
        { path: "main.tex", kind: "modified", additions: 4, deletions: 2 },
      ],
    };
    render(
      <HistoryDrawer
        {...required}
        history={[
          {
            id: "local-1",
            label: "Edit methods.tex",
            timestamp: "2026-07-29T11:00:00Z",
            files: ["methods.tex"],
            actor: "user",
          },
          agentEntry,
        ]}
        onRevert={onRevert}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByText("Agent: Revise the introduction")).toBeInTheDocument();
    expect(screen.queryByText("Edit methods.tex")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Agent: Revise the introduction/ }));
    expect(screen.getByText("Agent task: Introduction revision")).toBeInTheDocument();
    expect(screen.getByText("modified · +4 −2")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Undo this Agent turn's file changes"));
    expect(onRevert).toHaveBeenCalledWith(agentEntry);
    expect(screen.queryByTitle("Delete this history entry")).not.toBeInTheDocument();
  });
});
