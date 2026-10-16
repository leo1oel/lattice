import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import type { ProjectFindHit } from "../project/project-find-dialog";
import { showNotice } from "./notify";
import { useProjectSearch } from "./use-project-search";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./notify", () => ({ showNotice: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(showNotice).mockReset();
});

const hit = (path: string) => ({ path, line: 1, text: path }) as unknown as ProjectFindHit;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderSearch({ unsaved = false, save = async () => true } = {}) {
  const scope = { current: true };
  const deps = {
    projectRef: { current: { root: "/project" } as ProjectSnapshot | null },
    captureProjectScope: () => {
      scope.current = true;
      return () => scope.current;
    },
    unsavedEdits: () => unsaved,
    save: vi.fn(save),
    afterReplace: vi.fn(async () => undefined),
  };
  const view = renderHook(() => useProjectSearch(deps));
  return { view, deps, scope };
}

it("shows only the newest query's hits, even when an older search answers last", async () => {
  const slow = deferred<ProjectFindHit[]>();
  vi.mocked(invoke).mockImplementation(async (_command, args) => (
    (args as { query: string }).query === "old" ? slow.promise : [hit("new.tex")]
  ));
  const { view } = renderSearch();
  act(() => view.result.current.openFind());
  let first: Promise<void> = Promise.resolve();
  act(() => { first = view.result.current.search("old"); });
  expect(view.result.current.find.busy).toBe(true);
  await act(() => view.result.current.search("new"));
  await act(async () => {
    slow.resolve([hit("old.tex")]);
    await first;
  });
  expect(view.result.current.find).toMatchObject({ open: true, busy: false, hits: [hit("new.tex")] });
});

it("drops a search that answers after the project changed or the dialog closed", async () => {
  const pending = deferred<ProjectFindHit[]>();
  vi.mocked(invoke).mockReturnValue(pending.promise);
  const { view, scope } = renderSearch();
  act(() => view.result.current.openFind());
  let running: Promise<void> = Promise.resolve();
  act(() => { running = view.result.current.search("alpha"); });
  scope.current = false;
  await act(async () => {
    pending.resolve([hit("a.tex")]);
    await running;
  });
  expect(view.result.current.find.hits).toEqual([]);

  vi.mocked(invoke).mockResolvedValue([hit("b.tex")]);
  act(() => { running = view.result.current.search("beta"); });
  act(() => view.result.current.closeFind());
  await act(() => running);
  expect(view.result.current.find).toEqual({ open: false, busy: false, error: null, hits: [], seed: null });
});

it("writes unsaved edits before replacing, then reloads the project and reports the count", async () => {
  vi.mocked(invoke).mockResolvedValue({ replacements: 3, filesChanged: ["a.tex", "b.tex"] });
  const { view, deps } = renderSearch({ unsaved: true });
  act(() => view.result.current.openReplace());
  await act(() => view.result.current.applyReplace("x", "y", { matchCase: false, useRegex: false }));
  expect(deps.save).toHaveBeenCalledBefore(vi.mocked(invoke));
  expect(invoke).toHaveBeenCalledWith("replace_in_project", { projectRoot: "/project", query: "x", replacement: "y", paths: null, matchCase: false, useRegex: false });
  expect(deps.afterReplace).toHaveBeenCalled();
  expect(view.result.current.replace).toMatchObject({ open: false, busy: false, preview: null });
  expect(showNotice).toHaveBeenCalledWith("Replaced 3 occurrences in 2 files.");
});

it("replaces nothing when the unsaved edits cannot be written", async () => {
  const { view, deps } = renderSearch({ unsaved: true, save: async () => false });
  act(() => view.result.current.openReplace());
  await act(() => view.result.current.previewReplace("x", { matchCase: true, useRegex: false }));
  expect(deps.save).toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(view.result.current.replace).toMatchObject({ open: true, busy: false, error: null });
});

it("shows a failed preview as the dialog's error", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("bad regex"));
  const { view, deps } = renderSearch();
  act(() => view.result.current.openReplace());
  await act(() => view.result.current.previewReplace("(", { matchCase: false, useRegex: true }));
  expect(deps.save).not.toHaveBeenCalled();
  expect(view.result.current.replace).toMatchObject({ open: true, busy: false, error: "bad regex", preview: null });
});

it("never replaces in a project opened while its save was writing, nor after its dialog closed", async () => {
  for (const leave of ["switch", "close", "close and switch"] as const) {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ replacements: 1, filesChanged: ["main.tex"] });
    const saving = deferred<boolean>();
    const { view, deps, scope } = renderSearch({ unsaved: true, save: () => saving.promise });
    act(() => view.result.current.openReplace());
    let running: Promise<void> = Promise.resolve();
    act(() => { running = view.result.current.applyReplace("alpha", "beta", { matchCase: true, useRegex: false }); });
    act(() => {
      if (leave !== "switch") view.result.current.closeReplace();
      if (leave !== "close") {
        deps.projectRef.current = { root: "/next" } as ProjectSnapshot;
        scope.current = false;
      }
    });
    await act(async () => {
      saving.resolve(true);
      await running;
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(deps.afterReplace).not.toHaveBeenCalled();
    expect(showNotice).not.toHaveBeenCalled();
    view.unmount();
  }
});

it("still reloads what a replace rewrote when its dialog closed while it ran", async () => {
  const replacing = deferred<{ replacements: number; filesChanged: string[] }>();
  vi.mocked(invoke).mockReturnValue(replacing.promise);
  const { view, deps } = renderSearch();
  act(() => view.result.current.openReplace());
  let running: Promise<void> = Promise.resolve();
  act(() => { running = view.result.current.applyReplace("alpha", "beta", { matchCase: true, useRegex: false }); });
  act(() => view.result.current.closeReplace());
  expect(view.result.current.replace).toEqual({ open: false, busy: false, error: null, preview: null });
  await act(async () => {
    replacing.resolve({ replacements: 2, filesChanged: ["main.tex"] });
    await running;
  });
  expect(deps.afterReplace).toHaveBeenCalled();
  expect(showNotice).toHaveBeenCalledWith("Replaced 2 occurrences in 1 file.");
});

it("shows only the newest preview, and none from a project closed since", async () => {
  const older = deferred<unknown>();
  vi.mocked(invoke).mockImplementation(async (_command, args) => (
    (args as { query: string }).query === "old" ? older.promise : { replacements: 1, files: 1, matches: [] }
  ));
  const { view, scope } = renderSearch();
  act(() => view.result.current.openReplace());
  let first: Promise<void> = Promise.resolve();
  act(() => { first = view.result.current.previewReplace("old", { matchCase: true, useRegex: false }); });
  await act(() => view.result.current.previewReplace("new", { matchCase: true, useRegex: false }));
  await act(async () => {
    older.resolve({ replacements: 9, files: 3, matches: [] });
    await first;
  });
  expect(view.result.current.replace).toMatchObject({ busy: false, preview: { replacements: 1 } });

  const stale = deferred<unknown>();
  vi.mocked(invoke).mockReturnValue(stale.promise);
  act(() => { first = view.result.current.previewReplace("other", { matchCase: true, useRegex: false }); });
  scope.current = false;
  await act(async () => {
    stale.resolve({ replacements: 7, files: 2, matches: [] });
    await first;
  });
  expect(view.result.current.replace.preview).toMatchObject({ replacements: 1 });
});
