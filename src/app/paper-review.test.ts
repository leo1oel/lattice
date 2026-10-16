import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { notifyInfo } from "../telemetry/app-notify";
import { annotationRounds, type AnnotationRoundsDeps } from "./annotation-rounds";
import { PaperReviews, reviewId, type PaperReviewDeps } from "./paper-review";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const notifyMock = vi.mocked(notifyInfo);

const MAIN = "\\section{Intro}\nWe claim a causal link.\n\\input{method}\n";
const METHOD = "\\section{Method}\nThe example cannot be checked.\n";
const REPORT = {
  readiness: "needs-work",
  verdict: "One claim has no source.",
  strengths: ["Short."],
  findings: [
    { kind: "citation", severity: "major", title: "Uncited claim", reason: "Cite it.", quote: "We claim a causal link.", file: "main.tex", section: "§1", search: "causal attention" },
    { kind: "key", severity: "minor", title: "Unchecked example", reason: "Give the numbers.", quote: "The example cannot be checked.", file: "method.tex", section: "§2" },
    { kind: "clarity", severity: "minor", title: "Invented", quote: "Not in the paper at all." },
  ],
};

let files: Record<string, string>;
let annotations: EditorComment[];
let review: PaperReviews;
let deps: PaperReviewDeps;
let completeTask: (text: string) => void;

function attach() {
  const root = { current: "/p" as string | null };
  const roundsDeps = {
    store: { stateRef: { current: { annotations, rounds: [] } } },
    projectRootRef: root,
    activeFileRef: { current: "" },
    sourceRef: { current: "" },
    openPanel: vi.fn(),
  } as unknown as AnnotationRoundsDeps;
  annotationRounds.attach(roundsDeps);
  deps = {
    store: {
      stateRef: { current: { annotations, rounds: [] } } as unknown as PaperReviewDeps["store"]["stateRef"],
      create: vi.fn((comment: EditorComment) => {
        const created = { ...comment, number: annotations.length + 1 };
        annotations.push(created);
        return created;
      }),
      openComment: vi.fn(),
    },
    projectRootRef: root,
    manuscript: () => ({ root: "main.tex", paths: ["main.tex", "method.tex"], venue: "neurips" }),
    openProjectFile: vi.fn(async () => {}),
    author: { id: "me", name: "Ada" },
    searchLiterature: vi.fn(),
  };
  review.attach(deps);
}

beforeEach(() => {
  files = { "main.tex": MAIN, "method.tex": METHOD };
  annotations = [];
  review = new PaperReviews();
  let reply = "";
  let done = false;
  completeTask = (text) => {
    reply = text;
    done = true;
  };
  invokeMock.mockImplementation(async (command, args) => {
    const request = args as Record<string, unknown>;
    if (command === "read_project_file") return files[String(request.path)];
    if (command === "read_paper_review") return null;
    if (command === "save_paper_review") return null;
    if (command === "agent_text_task") {
      if (request.action === "start") return { taskId: "t1" };
      return done ? { status: "completed", text: reply } : { status: "running" };
    }
    throw new Error(`unexpected ${command}`);
  });
  attach();
});

afterEach(() => {
  invokeMock.mockReset();
  notifyMock.mockReset();
  vi.useRealTimers();
});

async function finishedReview() {
  vi.useFakeTimers();
  const started = review.start();
  await vi.advanceTimersByTimeAsync(0);
  completeTask(`<review>${JSON.stringify(REPORT)}</review>`);
  await vi.advanceTimersByTimeAsync(1_000);
  await started;
  vi.useRealTimers();
  return review.getSnapshot().report!;
}

describe("PaperReviews", () => {
  it("reads every file the root reaches, shows its progress, and keeps the pinned report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T02:42:05.123Z"));
    const started = review.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(review.getSnapshot().run).toMatchObject({ stage: "reviewing", files: 2, stats: { sections: 2, figures: 0, tables: 0, references: 0 } });
    const start = invokeMock.mock.calls.find(([command]) => command === "agent_text_task");
    const prompt = String((start?.[1] as { prompt?: string } | undefined)?.prompt);
    expect(prompt).toContain("as a NeurIPS reviewer");
    expect(prompt).toContain("<file path=\"method.tex\">");
    completeTask(`<review>${JSON.stringify(REPORT)}</review>`);
    await vi.advanceTimersByTimeAsync(1_000);
    await started;

    const { run, report } = review.getSnapshot();
    expect(run).toBeNull();
    expect(report).toMatchObject({ id: "2026-10-16T02-42-05Z", venue: "neurips", readiness: "needs-work", dropped: 1 });
    expect(report?.findings.map((finding) => [finding.path, finding.line, finding.kind])).toEqual([
      ["main.tex", 2, "citation"],
      ["method.tex", 2, "key"],
    ]);
    expect(invokeMock).toHaveBeenCalledWith("save_paper_review", { projectRoot: "/p", review: report });
  });

  it("names an included file it could not read instead of passing the rest off as the whole paper", async () => {
    const answer = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_project_file" && (args as { path?: string }).path === "method.tex") throw new Error("Input/output error");
      return answer(command, args);
    });
    const partial = await finishedReview();
    expect(partial.unread).toEqual(["method.tex"]);
    const start = invokeMock.mock.calls.find(([command]) => command === "agent_text_task");
    const prompt = String((start?.[1] as { prompt?: string } | undefined)?.prompt);
    expect(prompt).toContain("could not be read and are not below: \"method.tex\"");
    expect(prompt).not.toContain("<file path=\"method.tex\">");
    expect(invokeMock).toHaveBeenCalledWith("save_paper_review", { projectRoot: "/p", review: expect.objectContaining({ unread: ["method.tex"] }) });

    // Readable again: the next review covers the whole paper and says nothing of the gap.
    invokeMock.mockImplementation(answer);
    const whole = await finishedReview();
    expect(whole.unread).toBeUndefined();
  });

  it("names the review by its UTC start, to the second, safe as a file name", () => {
    expect(reviewId(Date.parse("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03-04-05Z");
  });

  it("makes a finding an annotation on the passage as it reads now, asking for what the finding needs", async () => {
    await finishedReview();
    files["main.tex"] = `% a new first line\n${MAIN}`;
    await review.annotate("f1");
    expect(deps.store.create).toHaveBeenCalledWith(expect.objectContaining({
      path: "main.tex", quote: "We claim a causal link.", from: files["main.tex"].indexOf("We claim"), intent: "cite", body: "Uncited claim\nCite it.", authorName: "Ada",
    }));
    expect(review.getSnapshot().report?.findings[0]).toMatchObject({ state: "added", annotation: 1 });
    expect(invokeMock).toHaveBeenLastCalledWith("save_paper_review", expect.objectContaining({
      review: expect.objectContaining({ findings: expect.arrayContaining([expect.objectContaining({ id: "f1", state: "added" })]) }),
    }));
    // The round asks only about the annotations the review made.
    expect(review.revisableIds(annotations, new Set())).toEqual([annotations[0].id]);
    expect(review.revisableIds(annotations, new Set([annotations[0].id]))).toEqual([]);
  });

  it("makes one annotation for a double click, and none for a review replaced meanwhile", async () => {
    await finishedReview();
    await Promise.all([review.annotate("f1"), review.annotate("f1")]);
    expect(deps.store.create).toHaveBeenCalledTimes(1);

    const first = review.getSnapshot().report!;
    const base = invokeMock.getMockImplementation()!;
    let release = () => {};
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_paper_review") return { ...first, id: "next" };
      if (command === "read_project_file") await new Promise<void>((resolve) => { release = resolve; });
      return base(command, args);
    });
    const pending = review.annotate("f2");
    review.reset();
    await review.load();
    release();
    await pending;
    expect(review.getSnapshot().report?.id).toBe("next");
    expect(deps.store.create).toHaveBeenCalledTimes(1);
    expect(review.getSnapshot().report?.findings[1].state).toBeUndefined();
  });

  it("leaves a point to retry when its Overleaf thread is refused or fails", async () => {
    await finishedReview();
    vi.mocked(deps.store.create).mockReturnValueOnce(null).mockReturnValueOnce(Promise.resolve(false));
    await review.annotate("f1");
    await review.annotate("f1");
    expect(review.getSnapshot().report?.findings[0].state).toBeUndefined();
    vi.mocked(deps.store.create).mockReturnValueOnce(Promise.resolve(true));
    await review.annotate("f1");
    expect(review.getSnapshot().report?.findings[0]).toMatchObject({ state: "added" });
    expect(review.getSnapshot().report?.findings[0]).not.toHaveProperty("annotation");
  });

  it("takes no Dismiss while a point is being added, and frees it once added", async () => {
    await finishedReview();
    let made = (_made: boolean) => {};
    vi.mocked(deps.store.create).mockReturnValueOnce(new Promise<boolean>((resolve) => { made = resolve; }));
    const pending = review.annotate("f1");
    await vi.waitFor(() => expect(deps.store.create).toHaveBeenCalled());
    expect(review.getSnapshot().annotating.has("f1")).toBe(true);
    review.dismiss("f1");
    expect(review.getSnapshot().report?.findings[0].state).toBeUndefined();
    made(true);
    await pending;
    expect(review.getSnapshot().report?.findings[0].state).toBe("added");
    expect(review.getSnapshot().annotating.size).toBe(0);
  });

  it("saves one decision at a time, in the order they were made", async () => {
    await finishedReview();
    let release = () => {};
    const saved: string[] = [];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      if (command !== "save_paper_review") return base(command, args);
      const { findings } = (args as { review: { findings: Array<{ state?: string }> } }).review;
      saved.push(findings[1].state ?? "open");
      if (saved.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return null;
    });
    review.dismiss("f2");
    notifyMock.mock.calls.at(-1)?.[2]?.primaryAction?.onClick();
    await vi.waitFor(() => expect(saved).toEqual(["dismissed"]));
    release();
    await vi.waitFor(() => expect(saved).toEqual(["dismissed", "open"]));
  });

  it("says so, and makes nothing, when the quoted passage has gone", async () => {
    await finishedReview();
    files["main.tex"] = "\\section{Intro}\nWe now claim something else.\n";
    await review.annotate("f1");
    expect(deps.store.create).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalled();
    expect(review.getSnapshot().report?.findings[0].state).toBeUndefined();
  });

  it("dismisses a finding with an Undo, and searches the literature for its keywords", async () => {
    await finishedReview();
    review.dismiss("f2");
    expect(review.getSnapshot().report?.findings[1].state).toBe("dismissed");
    notifyMock.mock.calls[0][2]?.primaryAction?.onClick();
    expect(review.getSnapshot().report?.findings[1]).not.toHaveProperty("state");
    review.findSupport("f1");
    expect(deps.searchLiterature).toHaveBeenCalledWith("causal attention");
  });

  it("opens the passage where it is now", async () => {
    await finishedReview();
    files["method.tex"] = `\n\n${METHOD}`;
    await review.reveal("f2");
    expect(deps.openProjectFile).toHaveBeenCalledWith("method.tex", { line: 4 });
  });

  it("drops a review that finishes after the project changed, and loads the next project's own", async () => {
    vi.useFakeTimers();
    const started = review.start();
    await vi.advanceTimersByTimeAsync(0);
    review.reset();
    completeTask(`<review>${JSON.stringify(REPORT)}</review>`);
    await vi.advanceTimersByTimeAsync(1_000);
    await started;
    expect(review.getSnapshot()).toMatchObject({ loaded: false, report: null, run: null, error: null });
    vi.useRealTimers();

    invokeMock.mockImplementation(async (command) => (
      command === "read_paper_review" ? { version: 1, id: "old", findings: [], verdict: "Kept." } : null
    ));
    await review.load();
    await review.load();
    expect(review.getSnapshot().report?.verdict).toBe("Kept.");
    expect(invokeMock.mock.calls.filter(([command]) => command === "read_paper_review")).toHaveLength(1);
  });

  it("never starts a review for the next project when the last one's lookup answers late", async () => {
    const stored = { version: 1, id: "old", findings: [], verdict: "Kept." };
    const answerFirst = invokeMock.getMockImplementation()!;
    const root = deps.projectRootRef as { current: string | null };
    for (const [switches, answer] of [[["/b"], null], [["/b"], stored], [["/b", "/p"], null], [["/b", "/p"], stored]] as const) {
      root.current = "/p";
      review.reset();
      let release: (value: unknown) => void = () => undefined;
      const lookup = new Promise((done) => { release = done; });
      invokeMock.mockImplementation(async (command, args) => (command === "read_paper_review" ? lookup : answerFirst(command, args)));
      const asked = review.startIfNone();
      for (const next of switches) {
        review.reset();
        root.current = next;
      }
      release(answer);
      await asked;
      const commands = invokeMock.mock.calls.map(([command]) => command);
      expect(commands).not.toContain("agent_text_task");
      expect(commands).not.toContain("save_paper_review");
      expect(review.getSnapshot()).toMatchObject({ loaded: false, report: null, run: null });
    }
  });

  it("starts exactly one review in the project it was asked in when it has none yet", async () => {
    vi.useFakeTimers();
    const asked = review.startIfNone();
    await vi.advanceTimersByTimeAsync(0);
    const starts = invokeMock.mock.calls.filter(([command, args]) => (
      command === "agent_text_task" && (args as { action: string }).action === "start"
    ));
    expect(starts).toEqual([["agent_text_task", expect.objectContaining({ projectRoot: "/p" })]]);
    review.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    await asked;
  });

  it("words a failure, and a stop leaves no error", async () => {
    vi.useFakeTimers();
    const failed = review.start();
    await vi.advanceTimersByTimeAsync(0);
    completeTask("I could not decide.");
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(review.getSnapshot().error).toMatch(/could not be read/);

    completeTask("");
    const stopped = review.start();
    await vi.advanceTimersByTimeAsync(0);
    review.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(review.getSnapshot()).toMatchObject({ run: null, error: null });
  });
});
