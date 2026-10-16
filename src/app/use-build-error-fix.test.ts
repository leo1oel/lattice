import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanvasRequests } from "../app-types";
import { showError } from "./notify";
import { useBuildErrorFix, type BuildErrorFixDeps } from "./use-build-error-fix";

vi.mock("./notify", () => ({
  showError: vi.fn(),
  showingErrors: (action: () => Promise<unknown>) => action().catch((reason: unknown) => vi.mocked(showError)(String(reason))),
}));
afterEach(() => {
  cleanup();
  vi.mocked(showError).mockReset();
});

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The fix in project A, with `other.tex` open. `open` stands for openFile:
 * resolved, it opens its file unless the window moved on meanwhile, as the
 * real one quietly gives up then.
 */
function renderFix() {
  const window = { root: "/A", generation: 0, intent: 0, file: "other.tex", asset: null as string | null, saves: [] as string[], builds: [] as string[] };
  let replace: CanvasRequests["replace"] = null;
  let opening = deferred();
  const captureProjectScope = () => {
    const { root, generation } = window;
    return () => window.root === root && window.generation === generation;
  };
  const deps: BuildErrorFixDeps = {
    captureProjectScope,
    openFile: vi.fn(async (path: string) => {
      const owns = captureProjectScope();
      const intent = ++window.intent;
      await opening.promise;
      if (owns() && window.intent === intent) window.file = path;
    }),
    fileRef: { get current() { return window.file; } },
    assetRef: { get current() { return window.asset; } },
    updateCanvasRequest: (kind, update) => {
      expect(kind).toBe("replace");
      replace = typeof update === "function" ? update(replace as never) as typeof replace : update as typeof replace;
    },
    flush: () => true,
    save: vi.fn(async () => { window.saves.push(window.root); return true; }),
    compile: vi.fn(async () => { window.builds.push(window.root); }),
  };
  const view = renderHook(() => useBuildErrorFix(deps));
  const openProject = (root: string) => {
    window.generation += 1;
    window.intent += 1;
    window.root = root;
    window.file = "main.tex";
  };
  return {
    view, window, deps, openProject,
    request: () => replace,
    hold: () => { opening = deferred(); return opening; },
  };
}

it("hands the canvas the fix once its file is open, then saves and builds that project", async () => {
  const fix = renderFix();
  fix.hold().resolve();
  await act(() => fix.view.result.current.replaceToken("main.tex", 13, "\\cietp", "\\citep"));
  const request = fix.request();
  expect(request).toMatchObject({ path: "main.tex", line: 13, token: "\\cietp", replacement: "\\citep" });
  await act(async () => fix.view.result.current.settled(request!.id));
  expect(fix.window.saves).toEqual(["/A"]);
  expect(fix.window.builds).toEqual(["/A"]);
});

it("edits, saves and builds nothing in the next project when the last one's fix opens late", async () => {
  for (const switches of [["/B"], ["/B", "/A"]]) {
    const fix = renderFix();
    const opening = fix.hold();
    let running: Promise<void> = Promise.resolve();
    act(() => { running = fix.view.result.current.replaceToken("main.tex", 13, "\\cietp", "\\citep"); });
    switches.forEach(fix.openProject);
    await act(async () => {
      opening.resolve();
      await running;
    });
    expect(fix.request()).toBeNull();
    expect(fix.window).toMatchObject({ saves: [], builds: [] });
    cleanup();
  }
});

it("drops the fix when a newer file was chosen or the open failed in the same project", async () => {
  const fix = renderFix();
  const opening = fix.hold();
  let running: Promise<void> = Promise.resolve();
  act(() => { running = fix.view.result.current.replaceToken("main.tex", 13, "\\cietp", "\\citep"); });
  fix.window.intent += 1;
  fix.window.file = "intro.tex";
  await act(async () => {
    opening.resolve();
    await running;
  });
  expect(fix.request()).toBeNull();

  vi.mocked(fix.deps.openFile).mockRejectedValueOnce(new Error("main.tex is not readable"));
  await act(() => fix.view.result.current.replaceToken("main.tex", 13, "\\cietp", "\\citep"));
  expect(fix.request()).toBeNull();
  expect(showError).toHaveBeenCalledTimes(1);
});

it("withdraws a fix the canvas has not applied when the project changes, and ignores its late answer", async () => {
  const fix = renderFix();
  fix.hold().resolve();
  await act(() => fix.view.result.current.replaceToken("main.tex", 13, "\\cietp", "\\citep"));
  const request = fix.request()!;
  fix.openProject("/B");
  act(() => fix.view.result.current.reset());
  expect(fix.request()).toBeNull();
  await act(async () => fix.view.result.current.settled(request.id));
  expect(fix.window).toMatchObject({ saves: [], builds: [] });
});

it("saves but does not build when the project changes during the save", async () => {
  const fix = renderFix();
  fix.hold().resolve();
  await act(() => fix.view.result.current.replaceToken("main.tex", 13, "\\cietp", "\\citep"));
  const saving = deferred<boolean>();
  vi.mocked(fix.deps.save).mockReturnValueOnce(saving.promise);
  act(() => fix.view.result.current.settled(fix.request()!.id));
  fix.openProject("/B");
  await act(async () => saving.resolve(true));
  expect(fix.deps.save).toHaveBeenCalledTimes(1);
  expect(fix.window.builds).toEqual([]);
});
