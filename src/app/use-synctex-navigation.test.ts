import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { SyncTexTarget } from "../app-types";
import { showError } from "./notify";
import { useSyncTexNavigation, type SyncTexNavigationDeps } from "./use-synctex-navigation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./notify", () => ({ showError: vi.fn(), showWarning: vi.fn(), showingErrors: (action: () => Promise<unknown>) => action() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(showError).mockReset();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * The hook in project A with `main.tex` open. `window` is what the app shows:
 * opening a file is a newer document intent, opening a project a newer
 * project generation.
 */
function renderNavigation() {
  const window = { root: "/A", generation: 0, intent: 0, file: "main.tex", pdfUrl: "A.pdf" };
  const opened: { root: string; path: string; line?: number }[] = [];
  const reveal = vi.fn();
  const captureProjectScope = () => {
    const { root, generation } = window;
    return () => window.root === root && window.generation === generation;
  };
  const openFile = vi.fn(async (path: string, options?: { line?: number }) => {
    window.intent += 1;
    window.file = path;
    opened.push({ root: window.root, path, line: options?.line });
  });
  const fileRef = { get current() { return window.file; } };
  const deps = () => ({
    documents: {
      file: window.file, asset: null, text: "", savedText: "", live: { file: fileRef }, openFile,
      save: async () => true, reveal,
      scope: () => {
        const ownsProject = captureProjectScope();
        const intent = window.intent;
        return () => ownsProject() && window.intent === intent;
      },
    },
    captureProjectScope, editorPosition: null, editorPositionRef: { current: null },
    build: { pdfUrl: window.pdfUrl, ensureCompiled: async () => true }, trellis: { ws: null },
  }) as unknown as SyncTexNavigationDeps;
  const view = renderHook(() => useSyncTexNavigation(deps()));
  const openProject = (root: string) => {
    window.generation += 1;
    window.root = root;
    window.intent += 1;
    view.rerender();
  };
  return { view, window, opened, reveal, openFile, openProject };
}

it("opens a double-click's source line in the project it was made in", async () => {
  vi.mocked(invoke).mockResolvedValue({ path: "intro.tex", line: 12 } satisfies SyncTexTarget);
  const { view, opened, reveal } = renderNavigation();
  await act(() => view.result.current.revealPdfSource(3, 10, 10));
  expect(opened).toEqual([{ root: "/A", path: "intro.tex", line: 12 }]);
  expect(reveal).toHaveBeenCalledWith("editor");
});

it("opens nothing in the next project when a double-click in the last one's PDF answers late", async () => {
  for (const switches of [["/B"], ["/B", "/A"]]) {
    const answer = deferred<SyncTexTarget>();
    vi.mocked(invoke).mockReturnValue(answer.promise);
    const { view, opened, reveal, openProject } = renderNavigation();
    let running: Promise<void> = Promise.resolve();
    act(() => { running = view.result.current.revealPdfSource(3, 10, 10); });
    act(() => switches.forEach(openProject));
    await act(async () => {
      answer.resolve({ path: "main.tex", line: 88 });
      await running;
    });
    expect(opened).toEqual([]);
    expect(reveal).not.toHaveBeenCalled();
    cleanup();
  }
});

it("drops a double-click overtaken by a newer one, a file chosen meanwhile, or a rebuilt PDF", async () => {
  const older = deferred<SyncTexTarget>();
  const newer = deferred<SyncTexTarget>();
  vi.mocked(invoke).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const navigation = renderNavigation();
  let first: Promise<void> = Promise.resolve();
  let second: Promise<void> = Promise.resolve();
  act(() => { first = navigation.view.result.current.revealPdfSource(1, 1, 1); });
  act(() => { second = navigation.view.result.current.revealPdfSource(2, 2, 2); });
  await act(async () => {
    newer.resolve({ path: "results.tex", line: 4 });
    await second;
    older.resolve({ path: "intro.tex", line: 9 });
    await first;
  });
  expect(navigation.opened).toEqual([{ root: "/A", path: "results.tex", line: 4 }]);

  const chosen = deferred<SyncTexTarget>();
  vi.mocked(invoke).mockReturnValueOnce(chosen.promise);
  act(() => { first = navigation.view.result.current.revealPdfSource(1, 1, 1); });
  await act(() => navigation.openFile("notes.tex"));
  await act(async () => {
    chosen.resolve({ path: "intro.tex", line: 9 });
    await first;
  });
  expect(navigation.opened.map(({ path }) => path)).toEqual(["results.tex", "notes.tex"]);

  const rebuilt = deferred<SyncTexTarget>();
  vi.mocked(invoke).mockReturnValueOnce(rebuilt.promise);
  act(() => { first = navigation.view.result.current.revealPdfSource(1, 1, 1); });
  navigation.window.pdfUrl = "A-rebuilt.pdf";
  navigation.view.rerender();
  await act(async () => {
    rebuilt.reject(new Error("No SyncTeX map for this PDF."));
    await first;
  });
  expect(navigation.opened.map(({ path }) => path)).toEqual(["results.tex", "notes.tex"]);
  expect(showError).not.toHaveBeenCalled();
});
