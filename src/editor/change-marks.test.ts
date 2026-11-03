import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_MARK_MS, changeMarksExtension, markAcceptedEdits } from "./change-marks";
import { noteLandedText } from "./landed-text";

let view: EditorView;

function mount(doc: string) {
  view = new EditorView({ state: EditorState.create({ doc, extensions: changeMarksExtension() }), parent: document.body });
  return view;
}

const landedLines = () => [...view.contentDOM.querySelectorAll(".cm-landed-line")].map((line) => line.textContent);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  view?.destroy();
  vi.useRealTimers();
});

describe("change marks", () => {
  it("shows an accepted edit's old words folding away before its new ones, and drops both when the moment ends", () => {
    mount("We utilize a method.");
    view.dispatch({
      changes: { from: 3, to: 10, insert: "use" },
      effects: markAcceptedEdits.of([{ from: 3, to: 6, removed: "utilize" }]),
    });
    expect(view.state.doc.toString()).toBe("We use a method.");
    const ghost = view.contentDOM.querySelector(".cm-accept-ghost");
    expect(ghost).toHaveTextContent("utilize");
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    // The picture sits before the new words, which carry the settle and wash.
    const inserted = view.contentDOM.querySelector(".cm-accept-insert")!;
    expect(inserted).toHaveTextContent("use");
    expect(ghost!.compareDocumentPosition(inserted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    vi.advanceTimersByTime(CHANGE_MARK_MS);
    expect(view.contentDOM.querySelector(".cm-accept-ghost, .cm-accept-insert")).toBeNull();
    expect(view.state.doc.toString()).toBe("We use a method.");
  });

  it("brings a suggestion's edits in turn, the later ones all together", () => {
    mount("a b c d e f g h i j k");
    const edits = Array.from({ length: 11 }, (_, index) => ({ from: index * 2, to: index * 2 + 1, removed: "x" }));
    view.dispatch({ effects: markAcceptedEdits.of(edits) });
    const orders = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-accept-insert")]
      .map((mark) => mark.style.getPropertyValue("--change-mark-order"));
    expect(orders).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "8", "8"]);
  });

  it("leaves a long or multi-line passage without a picture of its old words", () => {
    mount("New text.");
    view.dispatch({
      effects: markAcceptedEdits.of([
        { from: 0, to: 3, removed: "Old\nwords" },
        { from: 4, to: 8, removed: "x".repeat(200) },
      ]),
    });
    expect(view.contentDOM.querySelector(".cm-accept-ghost")).toBeNull();
    expect(view.contentDOM.querySelectorAll(".cm-accept-insert")).toHaveLength(2);
  });

  it("washes only the lines an outside edit wrote, once", () => {
    mount("one\ntwo\nthree\nfour");
    const next = "one\nTWO\nthree\nfour\nfive";
    noteLandedText(next);
    // The editor takes outside text as one span from the first difference to the last.
    view.dispatch({ changes: { from: 4, to: 18, insert: "TWO\nthree\nfour\nfive" } });
    expect(landedLines()).toEqual(["TWO", "five"]);

    // The writer's own next edit is not the noted text.
    view.dispatch({ changes: { from: 0, insert: "zero " } });
    vi.advanceTimersByTime(CHANGE_MARK_MS);
    expect(landedLines()).toEqual([]);
    view.dispatch({ changes: { from: 0, to: 5 } });
    expect(landedLines()).toEqual([]);
  });

  it("marks nothing for a change that does not end in the noted text", () => {
    mount("alpha");
    noteLandedText("beta");
    view.dispatch({ changes: { from: 0, to: 5, insert: "gamma" } });
    expect(landedLines()).toEqual([]);
  });
});
