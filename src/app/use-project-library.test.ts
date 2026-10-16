import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import type { HistoryItem } from "../history/history-drawer";
import { useProjectLibrary } from "./use-project-library";
import { useProjectState } from "./use-project-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const snapshot = (root: string) => ({ root }) as unknown as ProjectSnapshot;
const historyRow = (label: string): HistoryItem => ({ id: label, label, timestamp: "2026-10-16T00:00:00Z", files: [] });

/** Each `list_history` call waits until the test answers it. */
function holdHistoryReads() {
  const pending: ((rows: HistoryItem[]) => void)[] = [];
  vi.mocked(invoke).mockImplementation((command) => (
    command === "list_history" ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve([])
  ));
  return pending;
}

function renderLibrary() {
  return renderHook(() => {
    const state = useProjectState();
    return { state, library: useProjectLibrary(state) };
  });
}

/** What enterProject does to the project identity before it scans. */
function enter(view: ReturnType<typeof renderLibrary>, root: string) {
  const { state } = view.result.current;
  act(() => {
    state.beginTransition();
    state.projectRef.current = snapshot(root);
    state.setProject(snapshot(root));
  });
}

it("drops a history read that lands after the next project opened", async () => {
  const reads = holdHistoryReads();
  const view = renderLibrary();
  enter(view, "/a");
  const aScan = view.result.current.library.loadHistory();
  enter(view, "/b");
  const bScan = view.result.current.library.loadHistory();
  await act(async () => {
    reads[1]([historyRow("B current")]);
    await bScan;
  });
  await act(async () => {
    reads[0]([historyRow("A stale")]);
    await aScan;
  });
  expect(view.result.current.library.history.map((row) => row.label)).toEqual(["B current"]);
});

it("drops a read from before leaving and reopening the same project", async () => {
  const reads = holdHistoryReads();
  const view = renderLibrary();
  enter(view, "/a");
  const firstVisit = view.result.current.library.loadHistory();
  enter(view, "/b");
  enter(view, "/a");
  await act(async () => {
    reads[0]([historyRow("first visit")]);
    await firstVisit;
  });
  expect(view.result.current.library.history).toEqual([]);
});

it("keeps the newer of two reads in one project", async () => {
  const reads = holdHistoryReads();
  const view = renderLibrary();
  enter(view, "/a");
  const older = view.result.current.library.loadHistory();
  const newer = view.result.current.library.loadHistory();
  await act(async () => {
    reads[1]([historyRow("newer")]);
    await newer;
    reads[0]([historyRow("older")]);
    await older;
  });
  expect(view.result.current.library.history.map((row) => row.label)).toEqual(["newer"]);
});

it("drops late todo, word-count and unused-symbol reads from the outgoing project", async () => {
  const pending: (() => void)[] = [];
  const replies: Record<string, unknown> = {
    list_todos: [{ path: "a.tex", line: 1, text: "A todo" }],
    count_project_words: { words: 1 },
    list_unused_symbols: { labels: ["a"], citations: [] },
  };
  vi.mocked(invoke).mockImplementation((command) => new Promise((resolve) => pending.push(() => resolve(replies[command]))));
  const view = renderLibrary();
  enter(view, "/a");
  const { library } = view.result.current;
  const scans = Promise.all([library.loadTodos(), library.loadWordCount(), library.refreshUnusedSymbols()]);
  enter(view, "/b");
  await act(async () => {
    pending.forEach((resolve) => resolve());
    await scans;
  });
  expect(view.result.current.library.diskTodos).toEqual([]);
  expect(view.result.current.library.projectWordCount).toBeNull();
  expect(view.result.current.library.unusedSymbols).toEqual({ labels: [], citations: [] });
});
