import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import type { CompileDiagnostic } from "../build/compile-diagnostics";
import { useBuildPipeline } from "./use-build-pipeline";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const PROJECT = {
  root: "/project",
  manifest: { rootDocuments: [{ path: "main.tex", name: "main", isDefault: true }] },
  files: [
    { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
    { name: "chapters", path: "chapters", kind: "directory", children: [
      { name: "intro.tex", path: "chapters/intro.tex", kind: "tex", children: [] },
    ] },
  ],
} as unknown as ProjectSnapshot;

/** What the project's files hold on disk. */
const DISK: Record<string, string> = { "main.tex": "\\documentclass{article}", "chapters/intro.tex": "Intro\n\\foo" };

function result(overrides: Partial<BuildResult> = {}): BuildResult {
  return { success: true, hasPdf: false, log: "", durationMs: 3_200, diagnostics: [], rootDocument: "main.tex", ...overrides };
}

/** The pipeline over one project, with `build_project` answered by `answer`. */
function renderPipeline(
  answer: () => Promise<BuildResult>,
  { openDiagnostic = async () => {}, activeFile = "main.tex" }: {
    openDiagnostic?: (diagnostic: CompileDiagnostic) => Promise<void>;
    activeFile?: string;
  } = {},
) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "build_project") return answer();
    if (command === "read_project_file") return DISK[(args as { path: string }).path];
    if (command === "abort_build") return true;
    if (command === "clean_project") return undefined;
    throw new Error(`unexpected ${command}`);
  });
  const ref = <T,>(current: T) => ({ current });
  return renderHook(() => useBuildPipeline({
    project: PROJECT, projectRef: ref(PROJECT), setProject: vi.fn(), projectGenerationRef: ref(1),
    activeFileRef: ref(activeFile), sourceRef: ref("\\documentclass{article}"), savedSourceRef: ref("\\documentclass{article}"),
    agent: { takePendingCompiles: () => [], reportCompiles: vi.fn() },
    openDiagnosticRef: ref(openDiagnostic), onMissingTex: vi.fn(),
  }));
}

describe("the build outcome the Build button reports", () => {
  it("reports a success with its time once the build ends", async () => {
    const view = renderPipeline(async () => result());
    expect(view.result.current.outcome).toBeNull();
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toMatchObject({ status: "succeeded", seconds: 3.2, counts: { error: 0, warning: 0, info: 0 } });
  });

  it("reports a success with warnings as a success that counts them", async () => {
    const view = renderPipeline(async () => result({
      rootDocument: "thesis.tex",
      diagnostics: [
        { level: "warning", message: "There were undefined references." },
        { level: "warning", message: "Overfull \\hbox" },
        { level: "info", message: "Output written." },
      ],
    }));
    const before = Date.now();
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({
      status: "succeeded", counts: { error: 0, warning: 2, info: 1 }, rootDocument: "thesis.tex",
    });
    expect(view.result.current.outcome?.finishedAt).toBeGreaterThanOrEqual(before);
  });

  it("reports a failed build, and forgets it as soon as the next build starts", async () => {
    let answer = result({ success: false, diagnostics: [{ level: "error", message: "Undefined control sequence." }] });
    let release!: () => void;
    let gate: Promise<void> = Promise.resolve();
    const view = renderPipeline(async () => { await gate; return answer; });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({ status: "failed", counts: { error: 1, warning: 0, info: 0 } });

    answer = result({ durationMs: 1_000 });
    gate = new Promise((resolve) => { release = resolve; });
    let second!: Promise<void>;
    act(() => { second = view.result.current.runBuild(false, { requested: true }); });
    expect(view.result.current.building).toBe(true);
    expect(view.result.current.outcome).toBeNull();
    await act(async () => { release(); await second; });
    expect(view.result.current.outcome).toMatchObject({ status: "succeeded", seconds: 1 });
  });

  // A press while a build runs queues another pass. The button keeps
  // spinning through it and then reports the pass that ran last, not the one
  // it replaced.
  it("reports the queued rebuild's result once it ends, not the pass before it", async () => {
    const passes: Array<(value: BuildResult) => void> = [];
    const view = renderPipeline(() => new Promise((resolve) => { passes.push(resolve); }));
    let running!: Promise<void>;
    act(() => { running = view.result.current.runBuild(false, { requested: true }); });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(passes).toHaveLength(1);

    await act(async () => { passes[0](result({ success: false, diagnostics: [{ level: "error", message: "Undefined control sequence." }] })); });
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    expect(view.result.current.building).toBe(true);
    await act(async () => {
      passes[1](result({ durationMs: 1_500, diagnostics: [{ level: "warning", message: "Overfull \\hbox" }] }));
      await running;
    });
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toMatchObject({ status: "succeeded", seconds: 1.5, counts: { error: 0, warning: 1 } });
  });

  it("reports a build the backend rejected as failed", async () => {
    const view = renderPipeline(async () => { throw new Error("latexmk could not start"); });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.building).toBe(false);
    expect(view.result.current.outcome).toMatchObject({ status: "failed", rootDocument: null });
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

describe("cleaning build files", () => {
  // Every file a clean removes is one the next build writes again, so there is
  // nothing to confirm: it runs at once.
  it("cleans without asking first", async () => {
    const view = renderPipeline(async () => result());
    await act(() => view.result.current.cleanProject());
    expect(invoke).toHaveBeenCalledWith("clean_project");
    expect(view.result.current.cleaning).toBe(false);
  });
});

describe("the diagnostics a build hands the editor", () => {
  const diagnostics: CompileDiagnostic[] = [
    { level: "error", message: "Undefined control sequence.", file: "/project/./chapters/intro.tex", line: 2 },
    { level: "warning", message: "There were undefined references.", file: "main.tex", line: 1 },
    { level: "warning", message: "Font shape undefined.", file: "/usr/local/texlive/article.cls", line: 9 },
  ];

  it("keeps the text of every project file they name, not only the open one", async () => {
    const view = renderPipeline(async () => result({ success: false, diagnostics }));
    await act(() => view.result.current.runBuild(false));
    expect(Object.fromEntries(view.result.current.compiledSources)).toEqual({
      "main.tex": "\\documentclass{article}",
      "chapters/intro.tex": "Intro\n\\foo",
    });
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", expect.objectContaining({ path: "main.tex" }));
  });

  it("reads the open file from disk too when the build started before any file was open", async () => {
    const view = renderPipeline(async () => result({ success: false, diagnostics }), { activeFile: "" });
    await act(() => view.result.current.runBuild(false));
    expect(view.result.current.compiledSources.get("main.tex")).toBe(DISK["main.tex"]);
  });

  it("starts F8 at the first diagnostic the panel lists, and Shift-F8 at the last", async () => {
    const opened: CompileDiagnostic[] = [];
    const openDiagnostic = async (diagnostic: CompileDiagnostic) => { opened.push(diagnostic); };
    const view = renderPipeline(async () => result({ success: false, diagnostics }), { openDiagnostic });
    await act(() => view.result.current.runBuild(false));
    act(() => view.result.current.cycleDiagnostic(1));
    act(() => view.result.current.cycleDiagnostic(1));
    expect(opened.map((item) => item.message)).toEqual(["Undefined control sequence.", "Font shape undefined."]);

    await act(() => view.result.current.runBuild(false));
    opened.length = 0;
    act(() => view.result.current.cycleDiagnostic(-1));
    expect(opened.map((item) => item.message)).toEqual(["There were undefined references."]);
  });
});
