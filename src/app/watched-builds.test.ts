import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import type { BuildPreferences } from "../settings/app-settings";
import { useBuildPipeline } from "./use-build-pipeline";
import { WATCHED_BUILD_IDLE_MS } from "./watched-builds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const eventHandlers = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = eventHandlers.get(event) ?? new Set();
    eventHandlers.set(event, handlers);
    handlers.add(handler);
    return () => handlers.delete(handler);
  }),
}));
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
  eventHandlers.clear();
});

const PROJECT = {
  root: "/project",
  manifest: { rootDocuments: [{ path: "main.tex", name: "main", isDefault: true }] },
  files: [],
} as unknown as ProjectSnapshot;

/** What the project watcher (fs_watch.rs) reports after a burst of writes under the project. */
function filesChanged(paths: string[]) {
  act(() => {
    for (const handler of eventHandlers.get("project-fs-changed") ?? []) handler({ payload: { root: PROJECT.root, paths } });
  });
}

const idle = (ms = WATCHED_BUILD_IDLE_MS) => act(() => vi.advanceTimersByTimeAsync(ms));

/**
 * The pipeline over one project with nothing open in the editor, as when the
 * Agent edits files the writer is not looking at. Each `build_project` waits
 * for `finish`, so a test decides when a build ends and what it wrote.
 */
function renderPipeline(autoBuildMode: BuildPreferences["autoBuildMode"] = "automatic") {
  const passes: Array<(value: BuildResult) => void> = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "build_project") return new Promise((resolve) => { passes.push(resolve); });
    throw new Error(`unexpected ${command}`);
  });
  const ref = <T,>(current: T) => ({ current });
  const view = renderHook(() => useBuildPipeline({
    project: PROJECT, projectRef: ref(PROJECT), setProject: vi.fn(), projectGenerationRef: ref(1),
    activeFileRef: ref(""), sourceRef: ref(""), savedSourceRef: ref(""),
    agent: { takePendingCompiles: () => [], reportCompiles: vi.fn() },
    openDiagnosticRef: ref(async () => {}), onMissingTex: vi.fn(), autoBuildModeRef: ref(autoBuildMode),
  }));
  const finish = (pass: number, outputs: string[] = []) => act(async () => {
    passes[pass]({
      success: true, hasPdf: false, log: "", durationMs: 900, diagnostics: [], rootDocument: "main.tex",
      steps: [], pages: null, synctex: null, outputs,
    });
  });
  return { view, passes, finish };
}

describe("builds for edits made outside the editor", () => {
  // Regression: the Agent's edits only rebuilt through Synara's turn
  // checkpoints, which a project without Git never gets, so the PDF stayed
  // old until the writer pressed Build.
  it("builds once after an outside writer's burst of edits pauses", async () => {
    const { passes } = renderPipeline();
    filesChanged(["chapters/intro.tex"]);
    await idle(WATCHED_BUILD_IDLE_MS - 500);
    filesChanged(["main.tex", "chapters/methods.tex"]);
    await idle(WATCHED_BUILD_IDLE_MS - 1);
    expect(passes).toHaveLength(0);
    await idle(1);
    expect(passes).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: PROJECT.root }));
  });

  it("never takes what a build wrote for an edit, even a file only its recorder names", async () => {
    const { passes, finish } = renderPipeline();
    filesChanged(["main.tex"]);
    await idle();
    expect(passes).toHaveLength(1);
    // The comment package rewrites comment.cut on every run.
    await finish(0, ["comment.cut", "main.aux", "main.log", "main.pdf"]);
    filesChanged(["comment.cut", "main.aux", "main.fdb_latexmk", "main.pdf", "main.synctex.gz"]);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(passes).toHaveLength(1);
  });

  it("waits for a running build, then builds once for what changed while it ran", async () => {
    const { view, passes, finish } = renderPipeline();
    let running!: Promise<void>;
    act(() => { running = view.result.current.runBuild(false, { requested: true }); });
    expect(passes).toHaveLength(1);
    filesChanged(["chapters/intro.tex"]);
    await idle();
    filesChanged(["chapters/results.tex"]);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(passes).toHaveLength(1);

    await finish(0, ["comment.cut", "main.pdf"]);
    await act(() => running);
    // The finished build's own writes arrive just after it.
    filesChanged(["comment.cut", "main.pdf"]);
    await idle(WATCHED_BUILD_IDLE_MS - 1);
    expect(passes).toHaveLength(1);
    await idle(1);
    expect(passes).toHaveLength(2);
    await finish(1);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(passes).toHaveLength(2);
  });

  it("leaves a change to a build that started after it", async () => {
    const { view, passes, finish } = renderPipeline();
    filesChanged(["chapters/intro.tex"]);
    act(() => { void view.result.current.runBuild(false, { requested: true }); });
    await finish(0);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(passes).toHaveLength(1);
  });

  it("does not build the echo of the app's own save, which autosave builds itself", async () => {
    const { view, passes } = renderPipeline();
    act(() => view.result.current.markInputsChanged(["main.tex"]));
    filesChanged(["main.tex", ".lattice-0b7e4c1a-9f3d-4e2b-8a6c-5d1f2e3a4b5c.tmp"]);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(passes).toHaveLength(0);
  });

  it("builds nothing on its own with manual builds", async () => {
    const { passes } = renderPipeline("manual");
    filesChanged(["chapters/intro.tex"]);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(passes).toHaveLength(0);
  });
});
