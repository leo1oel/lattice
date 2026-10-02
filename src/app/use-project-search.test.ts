import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import type { ProjectFindHit } from "../project/project-find-dialog";
import { setNotice } from "./notify";
import { useProjectSearch } from "./use-project-search";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./notify", () => ({ setNotice: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(setNotice).mockReset();
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
  expect(view.result.current.find).toEqual({ open: false, busy: false, error: null, hits: [] });
});

it("writes unsaved edits before replacing, then reloads the project and reports the count", async () => {
  vi.mocked(invoke).mockResolvedValue({ replacements: 3, filesChanged: ["a.tex", "b.tex"] });
  const { view, deps } = renderSearch({ unsaved: true });
  act(() => view.result.current.openReplace());
  await act(() => view.result.current.applyReplace("x", "y", { matchCase: false, useRegex: false }));
  expect(deps.save).toHaveBeenCalledBefore(vi.mocked(invoke));
  expect(invoke).toHaveBeenCalledWith("replace_in_project", { query: "x", replacement: "y", paths: null, matchCase: false, useRegex: false });
  expect(deps.afterReplace).toHaveBeenCalled();
  expect(view.result.current.replace).toMatchObject({ open: false, busy: false, preview: null });
  expect(setNotice).toHaveBeenCalledWith("Replaced 3 occurrences in 2 files.");
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
