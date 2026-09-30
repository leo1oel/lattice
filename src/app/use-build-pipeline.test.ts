import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import { useBuildPipeline } from "./use-build-pipeline";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const PROJECT = {
  root: "/project",
  manifest: { rootDocuments: [{ path: "main.tex", name: "main", isDefault: true }] },
} as unknown as ProjectSnapshot;

function result(overrides: Partial<BuildResult> = {}): BuildResult {
  return { success: true, hasPdf: false, log: "", durationMs: 3_200, diagnostics: [], rootDocument: "main.tex", ...overrides };
}

/** The pipeline over one project, with `build_project` answered by `answer`. */
function renderPipeline(answer: () => Promise<BuildResult>) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "build_project") return answer();
    if (command === "abort_build") return true;
    throw new Error(`unexpected ${command}`);
  });
  const ref = <T,>(current: T) => ({ current });
  return renderHook(() => useBuildPipeline({
    project: PROJECT, projectRef: ref(PROJECT), setProject: vi.fn(), projectGenerationRef: ref(1),
    activeFileRef: ref("main.tex"), sourceRef: ref("\\documentclass{article}"), savedSourceRef: ref("\\documentclass{article}"),
    agent: { takePendingCompiles: () => [], reportCompiles: vi.fn() },
    openDiagnosticRef: ref(async () => {}), onMissingTex: vi.fn(),
  }));
}

describe("the build outcome the Build button reports", () => {
  it("reports a success with its time once the build ends", async () => {
    const view = renderPipeline(async () => result());
    expect(view.result.current.outcome).toBeNull();
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toEqual({ status: "succeeded", seconds: 3.2 });
  });

  it("reports a failed build, and forgets it as soon as the next build starts", async () => {
    let answer = result({ success: false, diagnostics: [{ level: "error", message: "Undefined control sequence." }] });
    let release!: () => void;
    let gate: Promise<void> = Promise.resolve();
    const view = renderPipeline(async () => { await gate; return answer; });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toEqual({ status: "failed" });

    answer = result({ durationMs: 1_000 });
    gate = new Promise((resolve) => { release = resolve; });
    let second!: Promise<void>;
    act(() => { second = view.result.current.runBuild(false, { requested: true }); });
    expect(view.result.current.building).toBe(true);
    expect(view.result.current.outcome).toBeNull();
    await act(async () => { release(); await second; });
    expect(view.result.current.outcome).toEqual({ status: "succeeded", seconds: 1 });
  });

  it("reports a build the backend rejected as failed", async () => {
    const view = renderPipeline(async () => { throw new Error("latexmk could not start"); });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toEqual({ status: "failed" });
  });

  it("reports nothing for a build the writer stopped, so the button reads Build again", async () => {
    let finish!: (value: BuildResult) => void;
    const view = renderPipeline(() => new Promise((resolve) => { finish = resolve; }));
    let running!: Promise<void>;
    act(() => { running = view.result.current.runBuild(false, { requested: true }); });
    await act(() => view.result.current.abortBuild());
    expect(invoke).toHaveBeenCalledWith("abort_build");
    await act(async () => {
      finish(result({
        success: false, durationMs: 2_500,
        diagnostics: [{ level: "error", message: "Build stopped.", code: "build-cancelled", params: { seconds: "2.5" } }],
      }));
      await running;
    });
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toBeNull();
  });

  it("forgets the last outcome when the workspace moves to another project", async () => {
    const view = renderPipeline(async () => result());
    await act(() => view.result.current.runBuild(false, { requested: true }));
    vi.mocked(invoke).mockImplementation(async () => { throw new Error("no cached PDF"); });
    act(() => view.result.current.resetForProject("/other"));
    expect(view.result.current.outcome).toBeNull();
  });
});
