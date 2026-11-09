import { act, cleanup, renderHook } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import type { CompileDiagnostic } from "../build/compile-diagnostics";
import { clearAppLogs, getAppLogEntry, getAppToastOptions, getVisibleAppToastIds } from "../telemetry/app-log-store";
import { useBuildPipeline } from "./use-build-pipeline";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../project/first-pages", () => ({ scheduleFirstPage: vi.fn() }));
afterEach(() => {
  cleanup();
  clearAppLogs();
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
  return {
    success: true, hasPdf: false, log: "", durationMs: 3_200, diagnostics: [], rootDocument: "main.tex",
    steps: [], pages: null, synctex: null, ...overrides,
  };
}

/** What a stopped build comes back as. */
const stoppedResult = () => result({
  success: false, durationMs: 2_500,
  diagnostics: [{ level: "error", message: "Build stopped.", code: "build-cancelled", params: { seconds: "2.5" } }],
});
const invokeCount = (command: string) => vi.mocked(invoke).mock.calls.filter(([called]) => called === command).length;

/** Each PDF a build reads back is a new one. */
let pdfWrites = 0;

/** The pipeline over one project, with `build_project` answered by `answer`. */
function renderPipeline(
  answer: () => Promise<BuildResult>,
  { openDiagnostic = async () => {}, activeFile = "main.tex", setProject = vi.fn() }: {
    openDiagnostic?: (diagnostic: CompileDiagnostic) => Promise<void>;
    activeFile?: string;
    setProject?: Mock<Dispatch<SetStateAction<ProjectSnapshot | null>>>;
  } = {},
) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "build_project") return answer();
    if (command === "read_compiled_pdf") return new TextEncoder().encode(`%PDF-1.5 ${++pdfWrites}`).buffer;
    if (command === "read_project_file") return DISK[(args as { path: string }).path];
    if (command === "abort_build") return true;
    if (command === "clean_project") return undefined;
    throw new Error(`unexpected ${command}`);
  });
  const ref = <T,>(current: T) => ({ current });
  return renderHook(() => useBuildPipeline({
    project: PROJECT, projectRef: ref(PROJECT), setProject, projectGenerationRef: ref(1),
    activeFileRef: ref(activeFile), sourceRef: ref("\\documentclass{article}"), savedSourceRef: ref("\\documentclass{article}"),
    agent: { takePendingCompiles: () => [], reportCompiles: vi.fn() },
    openDiagnosticRef: ref(openDiagnostic), onMissingTex: vi.fn(), autoBuildModeRef: ref("automatic" as const),
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

  // TeX carries on past errors, so a failed build can still write the PDF
  // the preview then shows; one stopped by a fatal error writes none.
  it("says whether a failed build wrote the PDF on screen", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf");
    let answer = result({ success: false, hasPdf: true, diagnostics: [{ level: "error", message: "Undefined control sequence." }] });
    const view = renderPipeline(async () => answer);
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({ status: "failed", wrotePdf: true });
    expect(view.result.current.pdfUrl).toBe("blob:pdf");

    answer = result({ success: false, hasPdf: false, diagnostics: [{ level: "error", message: "Emergency stop." }] });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({ status: "failed", wrotePdf: false });
    expect(view.result.current.pdfUrl).toBe("blob:pdf");
  });

  // A build that leaves no PDF gets the last one put back on disk, and a
  // later build that stops before its first page leaves those bytes in place.
  it("does not credit a failed build with the PDF an earlier build wrote", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf");
    let answer = result({ hasPdf: true });
    const view = renderPipeline(async () => answer);
    const answerCommand = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => command === "read_compiled_pdf"
      ? new TextEncoder().encode("%PDF-1.5 shown").buffer
      : answerCommand(command, args));
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({ status: "succeeded" });

    answer = result({ success: false, hasPdf: false, diagnostics: [{ level: "error", message: "File `chapter.tex' not found." }] });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({ status: "failed", wrotePdf: false });

    answer = result({ success: false, hasPdf: true, diagnostics: [{ level: "error", message: "File `foo.sty' not found." }] });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(view.result.current.outcome).toMatchObject({ status: "failed", wrotePdf: false });
    expect(view.result.current.pdfUrl).toBe("blob:pdf");
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

  // A stalled build would stall again on the same inputs: autosave and the
  // watcher wait for any input to change, whichever file it is in.
  it("holds automatic builds after a stall until an input changes", async () => {
    let answer = result({ success: false, diagnostics: [{ level: "error", message: "Stalled.", code: "build-stalled", params: { seconds: "120" } }] });
    const view = renderPipeline(async () => answer);
    await act(() => view.result.current.runBuild(false, { automatic: true }));
    answer = result();
    await act(() => view.result.current.runBuild(false, { automatic: true }));
    expect(invokeCount("build_project")).toBe(1);
    await act(() => view.result.current.runBuild(false, { requested: true }));
    expect(invokeCount("build_project")).toBe(2);
    answer = result({ success: false, diagnostics: [{ level: "error", message: "Stalled.", code: "build-stalled", params: { seconds: "120" } }] });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    act(() => view.result.current.markInputsChanged(["chapters/intro.tex"]));
    await act(() => view.result.current.runBuild(false, { automatic: true }));
    expect(invokeCount("build_project")).toBe(4);
  });

  // S8 in the implicit-state audit: autosave queued a pass behind the stuck
  // build, and Stop started it the moment the stopped one came back.
  it("stops the pass queued behind a stuck build too", async () => {
    const finishes: Array<(value: BuildResult) => void> = [];
    const view = renderPipeline(() => new Promise((resolve) => { finishes.push(resolve); }));
    let running!: Promise<void>;
    act(() => { running = view.result.current.runBuild(false, { requested: true }); });
    await act(() => view.result.current.runBuild(false, { automatic: true }));
    await act(() => view.result.current.abortBuild());
    await act(async () => {
      finishes[0]!(stoppedResult());
      await running;
    });
    expect(invokeCount("build_project")).toBe(1);
    expect(view.result.current.building).toBe(false);
  });

  // A pass that has run for ten minutes may be stuck, or may be a large
  // document: the writer is told and offered Stop, and nothing is stopped for them.
  const TEN_MINUTES = 10 * 60_000;
  const slowNotice = () => getVisibleAppToastIds()
    .map((id) => ({ entry: getAppLogEntry(id), options: getAppToastOptions(id) }))
    .find(({ entry }) => entry?.title.startsWith("Still building after 10 minutes"));

  it("offers Stop on a pass still running after ten minutes, which stops it and what is queued behind it", async () => {
    vi.useFakeTimers();
    try {
      const finishes: Array<(value: BuildResult) => void> = [];
      const view = renderPipeline(() => new Promise((resolve) => { finishes.push(resolve); }));
      let running!: Promise<void>;
      act(() => { running = view.result.current.runBuild(false, { requested: true }); });
      await act(() => view.result.current.runBuild(false, { automatic: true }));
      await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES - 1_000));
      expect(slowNotice()).toBeUndefined();
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      const notice = slowNotice();
      expect(notice?.entry?.level).toBe("warning");
      expect(invokeCount("abort_build")).toBe(0);
      await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES));
      expect(invokeCount("abort_build")).toBe(0);
      expect(view.result.current.building).toBe(true);
      expect(notice?.options?.primaryAction?.label).toBe("Stop");
      await act(async () => { await notice?.options?.primaryAction?.onClick(); });
      expect(invokeCount("abort_build")).toBe(1);
      await act(async () => {
        finishes[0]!(stoppedResult());
        await running;
      });
      expect(invokeCount("build_project")).toBe(1);
      expect(view.result.current.building).toBe(false);
      expect(view.result.current.outcome).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes a slow pass that finishes after ten minutes, and takes the notice down", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: BuildResult) => void;
      const view = renderPipeline(() => new Promise((resolve) => { finish = resolve; }));
      let running!: Promise<void>;
      act(() => { running = view.result.current.runBuild(false, { requested: true }); });
      await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES + 60_000));
      expect(slowNotice()).toBeDefined();
      await act(async () => {
        finish(result({ durationMs: TEN_MINUTES + 60_000 }));
        await running;
      });
      expect(invokeCount("abort_build")).toBe(0);
      expect(slowNotice()).toBeUndefined();
      expect(view.result.current.outcome).toMatchObject({ status: "succeeded", seconds: 660 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the last outcome when the workspace moves to another project", async () => {
    const view = renderPipeline(async () => result());
    await act(() => view.result.current.runBuild(false, { requested: true }));
    vi.mocked(invoke).mockImplementation(async () => { throw new Error("no cached PDF"); });
    act(() => view.result.current.resetForProject("/other"));
    expect(view.result.current.outcome).toBeNull();
  });
});

describe("the root document a build compiled", () => {
  const defaultsAfter = async (built: Partial<BuildResult>, activeFile: string) => {
    const setProject = vi.fn<Dispatch<SetStateAction<ProjectSnapshot | null>>>();
    const view = renderPipeline(async () => result({ hasPdf: true, ...built }), { activeFile, setProject });
    await act(() => view.result.current.runBuild(false, { requested: true }));
    const project = setProject.mock.calls.reduce<ProjectSnapshot | null>(
      (current, [update]) => (typeof update === "function" ? update(current) : update), PROJECT,
    );
    return { view, defaults: project?.manifest.rootDocuments.filter((document) => document.isDefault).map(({ path }) => path) };
  };

  it("adopts a root the backend recorded as the default", async () => {
    expect((await defaultsAfter({ rootDocument: "thesis.tex" }, "thesis.tex")).defaults).toEqual(["thesis.tex"]);
  });

  // A standalone figure compiled once must not become the root that every
  // later build, the outline and SyncTeX follow.
  it("keeps the root document after a one-off build of a standalone figure", async () => {
    const { view, defaults } = await defaultsAfter({ rootDocument: "figures/plot.tex", oneOff: true }, "figures/plot.tex");
    expect(defaults).toEqual(["main.tex"]);
    // Its PDF answers for the figure while it stays open: no rebuild first.
    const builds = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "build_project").length;
    await act(async () => expect(await view.result.current.ensureCompiled()).toBe(true));
    expect(builds()).toBe(1);
  });
});

describe("cleaning build files", () => {
  // Every file a clean removes is one the next build writes again, so there is
  // nothing to confirm: it runs at once.
  it("cleans before the queued pass when Clean and rebuild comes during a build", async () => {
    const passes: Array<(value: BuildResult) => void> = [];
    const view = renderPipeline(() => new Promise((resolve) => { passes.push(resolve); }));
    let running!: Promise<void>;
    act(() => { running = view.result.current.runBuild(false, { automatic: true }); });
    await act(() => view.result.current.cleanAndRebuild());
    // Never cleaned out from under the build that holds the pipeline.
    expect(invoke).not.toHaveBeenCalledWith("clean_project");
    await act(async () => { passes[0](result()); });
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command).filter((command) => command !== "read_compiled_pdf");
    expect(commands).toEqual(["build_project", "clean_project", "build_project"]);
    await act(async () => {
      passes[1](result());
      await running;
    });
  });

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
