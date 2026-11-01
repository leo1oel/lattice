import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AnnotationRounds, AnnotationRoundsSnapshot } from "../app/annotation-rounds";
import { annotationReviewExtension } from "../editor/annotation-review-anchor";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { createAnnotationReviewBridge } from "./annotation-review-bridge";
import { AnnotationReviewLayer } from "./annotation-review";

const source = "We train the model on a large corpus.\n";
const quote = "a large corpus";
const from = source.indexOf(quote);

const annotation: EditorComment = {
  id: "a1",
  number: 1,
  path: "main.tex",
  from,
  to: from + quote.length,
  quote,
  prefix: "",
  suffix: "",
  body: "Name the corpus",
  revision: { round: 1, state: "proposed", original: quote, text: "the Pile" },
  authorId: "me",
  authorName: "Me",
  resolved: false,
  replies: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** The review controller as the card reads it: one request, nothing running. */
function fakeRounds() {
  const snapshot = { running: new Set<string>(), review: { id: "a1", nonce: "n1" } } as unknown as AnnotationRoundsSnapshot;
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    closeReview: vi.fn(),
    retry: vi.fn(),
    accepted: vi.fn(),
    rejected: vi.fn(),
    navigate: vi.fn(),
  };
}

function renderReview() {
  const view = new EditorView({
    state: EditorState.create({ doc: source, extensions: annotationReviewExtension({ accept: () => false, dismiss: () => false }) }),
    parent: document.body,
  });
  const viewRef = createRef<EditorView | null>() as { current: EditorView | null };
  viewRef.current = view;
  const rounds = fakeRounds();
  render(
    <AnnotationReviewLayer
      bridge={createAnnotationReviewBridge()}
      activeFile="main.tex"
      editorKey="main.tex"
      editable
      viewRef={viewRef}
      annotations={[annotation]}
      rounds={rounds as unknown as AnnotationRounds}
    />,
  );
  return { view, rounds };
}

describe("AnnotationReviewLayer / Try again under an input method", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("keeps the half-written guidance through the composition's Enter and Escape, and sends it after", () => {
    vi.useFakeTimers();
    const { rounds } = renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Try again…" }));
    const guidance = screen.getByRole("textbox", { name: "What should the agent change?" });
    fireEvent.change(guidance, { target: { value: "用 Pile" } });
    fireEvent.compositionStart(guidance);
    // Enter puts the pinyin down as letters; Escape drops the candidates.
    fireEvent.keyDown(guidance, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.keyDown(guidance, { key: "Escape", keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(guidance);
    // WebKit sends compositionend just before the Enter that accepted the candidate.
    fireEvent.keyDown(guidance, { key: "Enter", keyCode: 13 });
    expect(rounds.retry).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "What should the agent change?" })).toHaveValue("用 Pile");

    act(() => vi.runAllTimers());
    fireEvent.keyDown(guidance, { key: "Enter", keyCode: 13 });
    expect(rounds.retry).toHaveBeenCalledWith("a1", "用 Pile");
  });

  it("closes the guidance on a plain Escape without closing the card", () => {
    renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Try again…" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "What should the agent change?" }), { key: "Escape", keyCode: 27 });
    expect(screen.queryByRole("textbox", { name: "What should the agent change?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again…" })).toBeInTheDocument();
  });
});
