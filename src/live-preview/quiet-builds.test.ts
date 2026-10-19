import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import { useBuildPipeline } from "../app/use-build-pipeline";
import { createQuietBuilds, QUIET_BUILD_IDLE_MS, QUIET_BUILD_MAX_WAIT_MS } from "./quiet-builds";
import type { LivePreviewBuildHooks } from "./use-live-preview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
});

const ref = <T,>(current: T) => ({ current });

/** The session's side of the pipeline, live (or not) on main.tex. */
function liveHooks(phase: "live" | "paused" = "live") {
  return {
    noteSaved: vi.fn(),
    buildStarted: vi.fn((_quiet?: boolean) => 0),
    buildFinished: vi.fn(),
    baseLoading: vi.fn(),
    baseShown: vi.fn(),
    basePageCount: vi.fn(),
    getSnapshot: () => ({ phase, layoutPending: false, detail: null, rebuilding: false }),
  } satisfies LivePreviewBuildHooks;
}

describe("autosave builds while the live preview is live", () => {
  function schedule(hooks: LivePreviewBuildHooks | null, file = "main.tex") {
    const source = ref("saved");
    const run = vi.fn<(quiet: boolean) => void>();
    const quiet = createQuietBuilds();
    quiet.connect({ livePreview: ref(hooks), activeFileRef: ref(file), sourceRef: source, savedSourceRef: ref("saved"), run });
    return { quiet, run, source };
  }

  it("build at once without a live preview, or for a file rtex does not draw", () => {
    for (const { quiet, run } of [schedule(null), schedule(liveHooks("paused")), schedule(liveHooks(), "refs.bib")]) {
      expect(quiet.defer()).toBe(false);
      vi.runAllTimers();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("wait for a pause in typing, then build quietly once for every save made meanwhile", () => {
    const { quiet, run } = schedule(liveHooks());
    expect(quiet.defer()).toBe(true);
    vi.advanceTimersByTime(QUIET_BUILD_IDLE_MS - 1);
    expect(quiet.defer()).toBe(true);
    vi.advanceTimersByTime(QUIET_BUILD_IDLE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("keep waiting while the writer types on, but never past the longest wait", () => {
    const { quiet, run, source } = schedule(liveHooks());
    quiet.defer();
    source.current = "typed since the save";
    vi.advanceTimersByTime(QUIET_BUILD_MAX_WAIT_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(QUIET_BUILD_IDLE_MS);
    expect(run).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("build at a save once the longest wait has passed, even with no pause", () => {
    const { quiet, run } = schedule(liveHooks());
    quiet.defer();
    for (let elapsed = 0; elapsed < QUIET_BUILD_MAX_WAIT_MS; elapsed += QUIET_BUILD_IDLE_MS / 2) {
      vi.advanceTimersByTime(QUIET_BUILD_IDLE_MS / 2);
      quiet.defer();
    }
    expect(run).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("drop the waiting build when another build takes its place", () => {
    const { quiet, run } = schedule(liveHooks());
    quiet.defer();
    quiet.cancel();
    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
  });
});

const PROJECT = {
  root: "/project",
  manifest: { rootDocuments: [{ path: "main.tex", name: "main", isDefault: true }] },
  files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
} as unknown as ProjectSnapshot;

function result(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    success: true, hasPdf: false, log: "", durationMs: 2_000, diagnostics: [], rootDocument: "main.tex",
    steps: [], pages: null, synctex: null, ...overrides,
  };
}

describe("a quiet build in the build pipeline", () => {
  function renderPipeline(hooks: LivePreviewBuildHooks | null) {
    const passes: Array<(value: BuildResult) => void> = [];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "build_project") return new Promise((resolve) => { passes.push(resolve); });
      throw new Error(`unexpected ${command}`);
    });
    const view = renderHook(() => useBuildPipeline({
      project: PROJECT, projectRef: ref(PROJECT), setProject: vi.fn(), projectGenerationRef: ref(1),
      activeFileRef: ref("main.tex"), sourceRef: ref("text"), savedSourceRef: ref("text"),
      agent: { takePendingCompiles: () => [], reportCompiles: vi.fn() },
      openDiagnosticRef: ref(async () => {}), onMissingTex: vi.fn(), livePreview: ref(hooks),
    }));
    const finish = (pass: number, value = result()) => act(async () => { passes[pass](value); });
    return { view, passes, finish };
  }

  it("runs after the pause without the Build button's spinner, keeping the last result on it", async () => {
    const hooks = liveHooks();
    const { view, passes, finish } = renderPipeline(hooks);
    await act(async () => { void view.result.current.runBuild(false, { requested: true }); });
    await finish(0);
    const shown = view.result.current.outcome;
    expect(shown).toMatchObject({ status: "succeeded" });

    await act(async () => { void view.result.current.runBuild(false, { automatic: true }); });
    expect(passes).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUIET_BUILD_IDLE_MS); });
    expect(passes).toHaveLength(2);
    expect(hooks.buildStarted).toHaveBeenLastCalledWith(true);
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toBe(shown);

    await finish(1, result({ durationMs: 1_000 }));
    expect(view.result.current.outcome).toMatchObject({ status: "succeeded", seconds: 1, quiet: true });
    expect(hooks.buildFinished).toHaveBeenCalled();
  });

  it("still reports a quiet build's failure as any build's", async () => {
    const { view, finish } = renderPipeline(liveHooks());
    await act(async () => { void view.result.current.runBuild(false, { automatic: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(QUIET_BUILD_IDLE_MS); });
    await finish(0, result({ success: false, diagnostics: [{ level: "error", message: "Undefined control sequence." }] }));
    expect(view.result.current.outcome).toMatchObject({ status: "failed", counts: { error: 1 } });
    expect(view.result.current.outcome).not.toHaveProperty("quiet");
    expect(view.result.current.diagnosticsExpanded).toBe(true);
  });

  it("shows the build once the writer presses Build while a quiet one runs", async () => {
    const { view, passes, finish } = renderPipeline(liveHooks());
    await act(async () => { void view.result.current.runBuild(false, { automatic: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(QUIET_BUILD_IDLE_MS); });
    expect(view.result.current.building).toBe(false);
    await act(async () => { void view.result.current.runBuild(false, { requested: true }); });
    expect(view.result.current.building).toBe(true);
    await finish(0);
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    await finish(1);
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).not.toHaveProperty("quiet");
  });

  it("builds an autosave at once, and visibly, without a live preview", async () => {
    const { view, passes } = renderPipeline(liveHooks("paused"));
    await act(async () => { void view.result.current.runBuild(false, { automatic: true }); });
    expect(passes).toHaveLength(1);
    expect(view.result.current.building).toBe(true);
  });
});
