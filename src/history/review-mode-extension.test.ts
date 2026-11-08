import { afterEach, describe, expect, it, vi } from "vitest";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  acceptAll, decideAtCaret, decideHunk, moveToChange, rejectAll, reviewModeExtension, reviewOf,
} from "./review-mode-extension";
import { createReviewModeStore } from "./review-mode-store";

const BASE = "\\section{Intro}\nAttention lets a decoder look at encoder states.\n\\begin{equation}\nE = mc^2\n\\end{equation}\n\\caption{Old results.}\n";

/** A store over a fake host, with review mode on and `BASE` as main.tex's base. */
async function reviewing(files: Record<string, string> = { "main.tex": BASE }) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let starts = 0;
  const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args: args ?? {} });
    if (command === "review_mode_load") return null;
    // Each time review mode is turned on is a new one, named by when.
    if (command === "review_mode_start") return { startedAt: `2026-11-08T00:00:0${starts++}Z`, bases: files };
    return null;
  });
  const store = createReviewModeStore(call as never);
  await store.load("/project");
  await store.start();
  return { store, calls };
}

const views: EditorView[] = [];
/** An editor of `path` reviewed against `store`, never the window's own. */
function editor(store: ReturnType<typeof createReviewModeStore>, doc: string, path = "main.tex") {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), reviewModeExtension(path, store)] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
const type = (view: EditorView, from: number, to: number, insert: string) =>
  view.dispatch({ changes: { from, to, insert }, userEvent: "input.type" });
const texts = (view: EditorView) => reviewOf(view)?.changes.map((change) => `${change.deletion ? "-" : "+"}${change.text}`) ?? null;

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

describe("review mode in the source editor", () => {
  it("snapshots a base when turned on and marks every edit against it as it is typed", async () => {
    const { store, calls } = await reviewing();
    expect(calls.map((entry) => entry.command)).toEqual(["review_mode_load", "review_mode_start"]);
    const view = editor(store, BASE);
    expect(texts(view)).toEqual([]);

    // Text, an equation and a figure caption, edited as usual.
    type(view, BASE.indexOf("look at"), BASE.indexOf("look at") + 7, "retrieve");
    let doc = view.state.doc.toString();
    type(view, doc.indexOf("mc^2") + 3, doc.indexOf("mc^2") + 4, "3");
    doc = view.state.doc.toString();
    type(view, doc.indexOf("Old"), doc.indexOf("Old") + 3, "New");
    expect(texts(view)).toEqual(["-look at", "+retrieve", "-2", "+3", "-Old", "+New"]);
    expect(view.dom.querySelectorAll(".cm-tracked-change-insert").length).toBe(3);
    expect(view.dom.querySelectorAll(".cm-tracked-change-delete").length).toBe(3);
    // The file holds the edits; the base stays as it was.
    expect(store.baseFor("main.tex")).toBe(BASE);
  });

  it("accepts one change into the base and rejects another out of the text", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve").replace("Old", "New"));
    expect(reviewOf(view)?.hunks).toHaveLength(2);

    expect(decideHunk(view, 0, true)).toBe(true);
    expect(texts(view)).toEqual(["-Old", "+New"]);
    expect(store.baseFor("main.tex")).toBe(BASE.replace("look at", "retrieve"));
    // Accept moves on to the next change.
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("New");

    expect(decideAtCaret(view, false)).toBe(true);
    expect(texts(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(BASE.replace("look at", "retrieve"));
  });

  it("accepts all and rejects all in one step each", async () => {
    const { store } = await reviewing();
    const edited = BASE.replace("look at", "retrieve").replace("mc^2", "mc^3");
    const view = editor(store, edited);
    expect(rejectAll(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(BASE);
    undo(view);
    expect(view.state.doc.toString()).toBe(edited);

    expect(acceptAll(view)).toBe(true);
    expect(texts(view)).toEqual([]);
    expect(store.baseFor("main.tex")).toBe(edited);
    expect(view.state.doc.toString()).toBe(edited);
  });

  it("takes an accept back with undo and puts it again with redo", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve"));
    decideHunk(view, 0, true);
    expect(texts(view)).toEqual([]);
    expect(undo(view)).toBe(true);
    expect(texts(view)).toEqual(["-look at", "+retrieve"]);
    expect(store.baseFor("main.tex")).toBe(BASE);
    expect(redo(view)).toBe(true);
    expect(texts(view)).toEqual([]);
    // Undoing a reject brings the change back too.
    type(view, 0, 0, "% note\n");
    decideHunk(view, 0, false);
    expect(view.state.doc.toString()).toBe(BASE.replace("look at", "retrieve"));
    undo(view);
    expect(texts(view)).toEqual(["+% note\n"]);
  });

  it("does not bring review mode back when an accept is undone after it was turned off", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve"));
    decideHunk(view, 0, true);
    await store.stop();
    undo(view);
    expect(reviewOf(view)).toBeNull();
    expect(view.dom.querySelector(".cm-review-bar")).toBeNull();
    redo(view);
    expect(reviewOf(view)).toBeNull();
    expect(store.get().active).toBe(false);
  });

  it("keeps an earlier review mode's accept out of the one turned on since", async () => {
    vi.useFakeTimers();
    const { store, calls } = await reviewing();
    const edited = BASE.replace("look at", "retrieve");
    const view = editor(store, edited);
    decideHunk(view, 0, true);
    await store.stop();
    await store.start({ path: "main.tex", text: edited });
    expect(texts(view)).toEqual([]);
    undo(view);
    // The earlier base is neither shown nor saved as this review mode's.
    expect(texts(view)).toEqual([]);
    expect(store.baseFor("main.tex")).toBe(edited);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.filter((entry) => entry.command === "review_mode_save_base").map((entry) => entry.args.base)).not.toContain(BASE);
  });

  it("does not put back a base a co-author's edit has moved on from when an accept is undone", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve"));
    decideHunk(view, 0, true);
    const doc = view.state.doc.toString();
    const remote = `${doc}Their line.\n`;
    store.noteCoauthorText("main.tex", remote);
    view.dispatch({ changes: { from: doc.length, insert: "Their line.\n" }, annotations: Transaction.addToHistory.of(false) });
    expect(texts(view)).toEqual([]);
    undo(view);
    // The co-author's line is never marked as the writer's insertion, nor its base saved over.
    expect(texts(view)).toEqual([]);
    expect(store.baseFor("main.tex")).toBe(remote);
    redo(view);
    expect(texts(view)).toEqual([]);
    expect(store.baseFor("main.tex")).toBe(remote);
  });

  it("takes back two accepts one at a time", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve").replace("Old", "New"));
    decideHunk(view, 0, true, false);
    decideHunk(view, 0, true, false);
    expect(texts(view)).toEqual([]);
    undo(view);
    expect(texts(view)).toEqual(["-Old", "+New"]);
    undo(view);
    expect(texts(view)).toEqual(["-look at", "+retrieve", "-Old", "+New"]);
    expect(store.baseFor("main.tex")).toBe(BASE);
  });

  it("moves the base forward with a co-author's edit instead of marking it as the writer's", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve"));
    const doc = view.state.doc.toString();
    const remote = doc.replace("Old results", "Older results");
    store.noteCoauthorText("main.tex", remote);
    view.dispatch({ changes: { from: doc.indexOf("Old"), to: doc.indexOf("Old") + 3, insert: "Older" } });
    expect(texts(view)).toEqual(["-look at", "+retrieve"]);
    expect(store.baseFor("main.tex")).toBe(BASE.replace("Old results", "Older results"));
    // The writer's own next edit is tracked as usual.
    type(view, 0, 0, "%\n");
    expect(texts(view)).toEqual(["+%\n", "-look at", "+retrieve"]);
  });

  it("goes from change to change, wrapping at the end", async () => {
    const { store } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve").replace("Old", "New"));
    const selected = () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    moveToChange(view, 1);
    expect(selected()).toBe("retrieve");
    moveToChange(view, 1);
    expect(selected()).toBe("New");
    moveToChange(view, 1);
    expect(selected()).toBe("retrieve");
    moveToChange(view, -1);
    expect(selected()).toBe("New");
  });

  it("drops the marks and keeps the text when review mode is turned off", async () => {
    const { store, calls } = await reviewing();
    const edited = BASE.replace("look at", "retrieve");
    const view = editor(store, edited);
    expect(view.dom.querySelector(".cm-review-bar")).not.toBeNull();
    await store.stop();
    expect(reviewOf(view)).toBeNull();
    expect(view.state.doc.toString()).toBe(edited);
    expect(view.dom.querySelector(".cm-review-bar")).toBeNull();
    expect(calls.at(-1)?.command).toBe("review_mode_stop");
  });

  it("writes an accepted base to the host a moment later", async () => {
    vi.useFakeTimers();
    const { store, calls } = await reviewing();
    const view = editor(store, BASE.replace("look at", "retrieve"));
    acceptAll(view);
    expect(calls.some((entry) => entry.command === "review_mode_save_base")).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.find((entry) => entry.command === "review_mode_save_base")?.args).toEqual({
      projectRoot: "/project", path: "main.tex", base: BASE.replace("look at", "retrieve"),
    });
  });

  it("tracks a file made after review mode was turned on as all inserted", async () => {
    const { store } = await reviewing();
    const view = editor(store, "New chapter.\n", "chapter.tex");
    expect(texts(view)).toEqual(["+New chapter.\n"]);
    // A file review mode does not track has no marks.
    const figure = editor(store, "plot data\n", "data.csv");
    expect(reviewOf(figure)).toBeNull();
  });
});
