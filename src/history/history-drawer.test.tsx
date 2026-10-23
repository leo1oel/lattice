/**
 * The Project history drawer holds three separate records of the same project
 * in one stream, and only two of them always exist. These cover the views
 * over it and the gating around the third: Overleaf's server-side history is
 * offered only when the project is linked, and the remembered view has to
 * survive opening a project that isn't. Activity's multi-file review runs
 * against a stubbed Pierre CodeView;
 * versions-timeline.test.tsx exercises the real renderer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { GitLogEntry } from "../app-types";
import { mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";
import { HistoryDrawer } from "./history-drawer";
import { pierreView } from "./pierre-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@pierre/diffs", async () => (await import("./pierre-test-mocks")).pierreDiffsMock);
vi.mock("@pierre/diffs/react", async () => ({ CodeView: (await import("./pierre-test-mocks")).MockCodeView }));
vi.mock("./pierre-diff", async (importOriginal) => ({
  ...await importOriginal<object>(),
  usePierreResources: (await import("./pierre-test-mocks")).readyPierreResources,
}));
vi.mock("./file-diff-view", async (importOriginal) => ({
  ...await importOriginal<object>(),
  HistoryDiff: ({ change }: { change: { path: string } }) => <div data-testid="single-file-diff" data-path={change.path} />,
}));

function mockBackend(extra: CommandTable = {}) {
  mockInvoke({
    git_status: { repository: true, dirty: false, files: [] },
    git_log: [],
    overleaf_history_updates: { updates: [], nextBefore: null },
    ...extra,
  });
}

const required = {
  history: [],
  onClose: () => undefined,
  onRevert: () => undefined,
  onDelete: () => undefined,
  overleafProjectRoot: "/tmp/project",
};

/** A `get_history_entry` record touching `paths`, each with an old/new body. */
const transaction = (id: string, label: string, paths: string[]) => ({
  id, label, timestamp: "2026-08-04T12:00:00Z",
  changes: paths.map((path) => ({ path, before: `old ${path}`, after: `new ${path}` })),
});
const smoothScrollTo = (id: string) => ({ type: "item", id, align: "start", behavior: "smooth" });

/** The pill that shows one record, or all of them, in the timeline. */
const view = (name: string) => within(screen.getByRole("group", { name: "Show in history" })).getByRole("button", { name });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pierreView.reset();
});

describe("HistoryDrawer", () => {
  const historyItem = { id: "t1", label: "Edit main.tex", timestamp: "2026-07-16T00:00:00Z", files: ["main.tex"] };

  // These two run first and in this order: the module-level last-used-view
  // memory must still hold its Everything default for the first, which ends
  // by re-selecting Everything.
  it("opens on one stream of versions and activity, and keeps each record across view switches", async () => {
    const commit: GitLogEntry = {
      hash: "aaa111", shortHash: "aaa111", authorName: "Robin",
      timestamp: "2026-07-24T00:00:00Z", message: "Tighten the abstract", files: [],
    };
    mockBackend({ git_status: { available: true, repository: true, branch: "main", files: [] }, git_log: [commit] });
    render(<HistoryDrawer {...required} history={[historyItem]} />);

    // Everything is the default view: the version and the activity side by side in time.
    expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();
    expect(screen.getByText("Edit main.tex")).toBeInTheDocument();
    expect(view("Everything")).toHaveAttribute("aria-pressed", "true");
    // Narrowing to one record and back, twice, still shows the same rows.
    for (let pass = 0; pass < 2; pass += 1) {
      fireEvent.click(view("Activity"));
      expect(screen.getByText("Edit main.tex")).toBeInTheDocument();
      expect(screen.queryByText("Tighten the abstract")).not.toBeInTheDocument();
      fireEvent.click(view("Versions"));
      expect(await screen.findByText("Tighten the abstract")).toBeInTheDocument();
      expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument();
    }
    fireEvent.click(view("Everything"));
  });

  it("keeps the activity in view when the git backend is unreachable", async () => {
    mockInvoke({});
    render(<HistoryDrawer {...required} history={[historyItem]} />);

    expect(await screen.findByText("Edit main.tex")).toBeInTheDocument();
    expect(await screen.findByText(/Version history is unavailable/)).toBeInTheDocument();
    expect(view("Everything")).toHaveAttribute("aria-pressed", "true");
  });

  it("offers Overleaf's history only when the project is linked", () => {
    mockBackend();
    const { rerender } = render(<HistoryDrawer {...required} />);
    expect(screen.queryByRole("button", { name: "Overleaf" })).not.toBeInTheDocument();

    rerender(<HistoryDrawer {...required} overleafLinked />);
    expect(view("Overleaf")).toBeInTheDocument();
  });

  it("shows Overleaf's own timeline in its view, not the git one", async () => {
    mockBackend();
    render(<HistoryDrawer {...required} overleafLinked />);

    fireEvent.click(view("Overleaf"));
    expect(await screen.findByText("No Overleaf history yet")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("overleaf_history_updates", { projectRoot: "/tmp/project", count: 20 });
  });

  it("keeps the header outside the shared scroll area when changing views", () => {
    mockBackend();
    render(<HistoryDrawer {...required} />);
    const header = screen.getByText("Project history").closest<HTMLElement>('[data-slot="panel-header"]');
    const viewport = screen.getByLabelText("Project history content");

    expect(viewport).not.toContainElement(header);
    expect(viewport.closest('[data-slot="scroll-area"]')).toHaveClass("project-history-scroll");

    fireEvent.click(view("Versions"));
    expect(screen.getByText("Project history").closest('[data-slot="panel-header"]')).toBe(header);
  });

  it("marks the shown view on its pill", () => {
    mockBackend();
    render(<HistoryDrawer {...required} />);

    fireEvent.click(view("Activity"));
    expect(view("Activity")).toHaveAttribute("aria-pressed", "true");
    expect(view("Everything")).toHaveAttribute("aria-pressed", "false");
  });

  it("falls back off the remembered Overleaf view for an unlinked project", () => {
    mockBackend();
    // The view is remembered across opens for the session, so pick it here
    // and then reopen as an unlinked project.
    const first = render(<HistoryDrawer {...required} overleafLinked />);
    fireEvent.click(view("Overleaf"));
    first.unmount();

    render(<HistoryDrawer {...required} />);
    expect(view("Everything")).toHaveAttribute("aria-pressed", "true");
  });

  it("filters semantic Agent changes and restores them through their checkpoint", () => {
    mockBackend();
    const onRevert = vi.fn();
    const agentEntry = {
      id: "agent:thread-1:turn-1", label: "Agent: Revise the introduction", timestamp: "2026-07-29T12:00:00Z",
      files: ["main.tex"], actor: "agent", kind: "agent-checkpoint", source: "agent-checkpoint",
      threadId: "thread-1", threadTitle: "Introduction revision", checkpointRef: "refs/lattice/checkpoints/one",
      turnCount: 1, restoreAvailable: true,
      fileSummaries: [{ path: "main.tex", kind: "modified", additions: 4, deletions: 2 }],
    };
    const localEntry = { id: "local-1", label: "Edit methods.tex", timestamp: "2026-07-29T11:00:00Z", files: ["methods.tex"], actor: "user" };
    render(<HistoryDrawer {...required} history={[localEntry, agentEntry]} onRevert={onRevert} />);

    fireEvent.click(view("Activity"));
    const filters = within(screen.getByRole("group", { name: "Filter project changes" }));
    expect(filters.getByRole("button", { name: "All" })).toHaveClass("ui-segmented-tab");
    expect(filters.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(filters.getByRole("button", { name: "Agent" }));
    expect(filters.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
    expect(filters.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Agent: Revise the introduction")).toBeInTheDocument();
    expect(screen.queryByText("Edit methods.tex")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Agent: Revise the introduction/ }));
    expect(screen.getByText("Introduction revision")).toBeInTheDocument();
    expect(screen.getByText("modified · +4 −2")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Undo this Agent turn's file changes"));
    expect(onRevert).toHaveBeenCalledWith(agentEntry);
    expect(screen.queryByTitle("Delete this history entry")).not.toBeInTheDocument();
  });
});

describe("HistoryDrawer multi-file review", () => {
  it("reviews one transaction in CodeView and keeps navigation and per-file restore", async () => {
    mockBackend({ get_history_entry: transaction("tx-1", "Update two files", ["main.tex", "methods.tex"]) });
    const onClose = vi.fn();
    const onOpenFile = vi.fn();
    const onRevertFile = vi.fn();
    render(
      <HistoryDrawer
        {...required}
        history={[{ id: "tx-1", label: "Update two files", timestamp: "2026-08-04T12:00:00Z", files: ["main.tex", "methods.tex"] }]}
        onClose={onClose}
        onRevertFile={onRevertFile}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(view("Activity"));
    fireEvent.click(screen.getByRole("button", { name: /Update two files/ }));
    expect(await screen.findByTestId("code-view")).toBeInTheDocument();
    expect(screen.getAllByTestId("code-view-item").map((item) => item.dataset.path)).toEqual(["main.tex", "methods.tex"]);
    expect(screen.queryByTestId("single-file-diff")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "methods.tex" }));
    expect(pierreView.scrollTo).toHaveBeenCalledWith(smoothScrollTo("history:tx-1:1"));
    fireEvent.click(screen.getByTitle("Restore only methods.tex"));
    expect(onRevertFile).toHaveBeenCalledWith("tx-1", "methods.tex");

    fireEvent.click(screen.getByRole("button", { name: "main.tex" }));
    expect(screen.getByRole("button", { name: "main.tex" })).toHaveAttribute("aria-pressed", "true");
    pierreView.itemTops.set("history:tx-1:0", 0);
    pierreView.itemTops.set("history:tx-1:1", 80);
    pierreView.scrollTop = 81;
    fireEvent.scroll(screen.getByTestId("code-view"));
    expect(screen.getByRole("button", { name: "methods.tex" })).toHaveAttribute("aria-pressed", "true");

    pierreView.scrollTo.mockClear();
    fireEvent.click(view("Versions"));
    fireEvent.click(view("Activity"));
    await waitFor(() => expect(pierreView.scrollTo).toHaveBeenCalledWith(smoothScrollTo("history:tx-1:1")));

    fireEvent.click(screen.getAllByTestId("code-view-item")[1]!);
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("methods.tex", 7));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores an older transaction request that resolves after the current one", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    mockBackend({
      get_history_entry: ({ transactionId }: { transactionId: string }) => new Promise((resolve) => {
        resolvers.set(transactionId, resolve);
      }),
    });
    render(
      <HistoryDrawer
        {...required}
        history={[
          { id: "tx-a", label: "First transaction", timestamp: "2026-08-04T12:00:00Z", files: ["a.tex"] },
          { id: "tx-b", label: "Second transaction", timestamp: "2026-08-04T12:01:00Z", files: ["b.tex"] },
        ]}
        onRevertFile={vi.fn()}
      />,
    );

    fireEvent.click(view("Activity"));
    fireEvent.click(screen.getByRole("button", { name: /First transaction/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second transaction/ }));
    await act(async () => resolvers.get("tx-b")!(transaction("tx-b", "Second transaction", ["b.tex"])));
    expect(await screen.findByTestId("single-file-diff")).toBeInTheDocument();

    await act(async () => resolvers.get("tx-a")!(transaction("tx-a", "First transaction", ["a.tex"])));
    expect(screen.getByTestId("single-file-diff")).toHaveAttribute("data-path", "b.tex");
  });
});
