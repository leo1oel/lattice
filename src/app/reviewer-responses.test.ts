import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorComment, nextAnnotationNumber, type EditorComment } from "../editor/comments/editor-comment-data";
import { responseLetter } from "../project/reviewer-responses";
import { notifyInfo } from "../telemetry/app-notify";
import { placeAnnotations, ReviewerResponsesStore, type ReviewerResponsesDeps } from "./reviewer-responses";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const notifyMock = vi.mocked(notifyInfo);

let root: { current: string | null };
let store: ReviewerResponsesStore;
let stored: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  stored = null;
  root = { current: "/a" };
  invokeMock.mockReset();
  notifyMock.mockReset();
  invokeMock.mockImplementation(async (command) => (command === "read_reviewer_responses" ? stored : null));
  store = new ReviewerResponsesStore();
  store.attach({
    store: { stateRef: { current: { annotations: [], rounds: [] } }, openComment: vi.fn() } as unknown as ReviewerResponsesDeps["store"],
    projectRootRef: root,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function saves() {
  return invokeMock.mock.calls.filter(([command]) => command === "save_reviewer_responses");
}

describe("ReviewerResponsesStore", () => {
  it("saves once typing pauses, to the project the change was made in", async () => {
    await store.load();
    store.add([{ reviewer: 1, comments: ["Add a baseline."] }]);
    const id = store.getSnapshot().responses.comments[0].id;
    store.update(id, { reply: "W" });
    store.update(id, { reply: "We added it." });
    expect(saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1]).toMatchObject({
      projectRoot: "/a",
      responses: { comments: [{ reviewer: 1, number: 1, reply: "We added it." }] },
    });
  });

  it("settles a flush once the pending save is on disk, so a project switch can wait for it", async () => {
    await store.load();
    store.add([{ reviewer: 1, comments: ["Typo."] }]);
    let written: () => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { written = () => resolve(null); }));
    let settled = false;
    const flushing = store.flush().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(saves()).toHaveLength(1);
    expect(settled).toBe(false);
    written();
    await flushing;
    expect(saves()[0][1]).toMatchObject({ projectRoot: "/a" });
    root.current = "/b";
    store.reset();
    await vi.runAllTimersAsync();
    expect(saves()).toHaveLength(1);
  });

  it("writes what is pending before a project change forgets it", async () => {
    await store.load();
    store.add([{ reviewer: 2, comments: ["Typo."] }]);
    root.current = "/b";
    store.reset();
    await vi.runAllTimersAsync();
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1]).toMatchObject({ projectRoot: "/a" });
    expect(store.getSnapshot()).toMatchObject({ loaded: false, responses: { comments: [] } });
  });

  it("drops a read that outlived its project", async () => {
    let answer: (value: unknown) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const loading = store.load();
    store.reset();
    answer({ version: 1, reviewers: {}, last: {}, comments: [{ id: "x", reviewer: 1, number: 1, comment: "old" }] });
    await loading;
    expect(store.getSnapshot().loaded).toBe(false);
  });

  it("changes nothing before the project's responses are read", () => {
    store.add([{ reviewer: 1, comments: ["Lost?"] }]);
    expect(store.getSnapshot().responses.comments).toEqual([]);
  });

  it("removes a comment with an Undo that puts it back in place", async () => {
    await store.load();
    store.add([{ reviewer: 1, comments: ["a", "b", "c"] }]);
    const [, second] = store.getSnapshot().responses.comments;
    store.remove(second.id);
    expect(store.getSnapshot().responses.comments.map((comment) => comment.comment)).toEqual(["a", "c"]);
    const undo = notifyMock.mock.calls[0][2]?.primaryAction?.onClick;
    undo?.();
    expect(store.getSnapshot().responses.comments.map((comment) => comment.comment)).toEqual(["a", "b", "c"]);
  });

  it("links an annotation once and unlinks it", async () => {
    await store.load();
    store.add([{ reviewer: 1, comments: ["a"] }]);
    const { id } = store.getSnapshot().responses.comments[0];
    store.link(id, "note-3");
    store.link(id, "note-3");
    store.link(id, "note-5");
    expect(store.getSnapshot().responses.comments[0].annotationIds).toEqual(["note-3", "note-5"]);
    store.unlink(id, "note-3");
    expect(store.getSnapshot().responses.comments[0].annotationIds).toEqual(["note-5"]);
  });
});

describe("placeAnnotations", () => {
  function annotation(number: number, path: string, source: string, quote: string): EditorComment {
    const from = source.indexOf(quote);
    return { ...createEditorComment({ path, source, from, to: from + quote.length, body: "", authorId: "me", authorName: "Ada" })!, number };
  }

  it("places each linked passage, and says when one was rewritten or deleted", async () => {
    const before = "\\section{Method}\nWe use 50% sparsity.\nOld sentence here.\n";
    const now = "\\section{Method}\nWe use 50% sparsity.\nA new sentence.\n";
    const annotations = [annotation(1, "main.tex", before, "We use 50% sparsity."), annotation(2, "main.tex", before, "Old sentence here.")];
    const readSource = vi.fn(async () => now);
    const places = await placeAnnotations([annotations[0].id, annotations[1].id, "gone"], annotations, readSource);
    expect(places.get(annotations[0].id)).toEqual({ state: "placed", path: "main.tex", line: 2, quote: "We use 50% sparsity." });
    expect(places.get(annotations[1].id)).toEqual({ state: "moved", path: "main.tex", quote: "Old sentence here." });
    expect(places.get("gone")).toEqual({ state: "missing" });
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it("keeps a deleted annotation's link deleted when a new annotation takes its pin number", async () => {
    const source = "Intro.\nWe use 50% sparsity.\nAn unrelated passage.\n";
    const readSource = async () => source;
    await store.load();
    store.add([{ reviewer: 1, comments: ["Report the sparsity."] }]);
    const { id } = store.getSnapshot().responses.comments[0];
    const linked = annotation(5, "main.tex", source, "We use 50% sparsity.");
    store.link(id, linked.id);
    store.update(id, { reply: "Reported.", replyChecked: true, change: "done" });
    const remaining = [annotation(4, "main.tex", source, "Intro.")];
    const reannotated = annotation(nextAnnotationNumber(remaining), "main.tex", source, "An unrelated passage.");
    expect(reannotated.number).toBe(5);
    const annotations = [...remaining, reannotated];

    const { responses } = store.getSnapshot();
    const places = await placeAnnotations(responses.comments[0].annotationIds, annotations, readSource);
    expect(places.get(linked.id)).toEqual({ state: "missing" });
    const letter = responseLetter(responses, "markdown", (annotationId) => places.get(annotationId) ?? { state: "missing" });
    expect(letter).toContain("**Changes.** Annotation deleted.");
    expect(letter).not.toContain("An unrelated passage.");
    store.update(id, { change: "todo" });
    expect(store.revisableIds(annotations, new Set())).toEqual([]);
  });
});
