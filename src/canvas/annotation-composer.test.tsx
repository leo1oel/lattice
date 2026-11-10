import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { NoteProgress } from "../editor/comments/editor-comment-data";
import { AnnotationComposer } from "./annotation-composer";
import { useAnnotationDraft } from "./use-annotation-draft";

vi.mock("../app/notify", () => ({ showError: vi.fn() }));
afterEach(cleanup);

const QUOTE = "visual token";
const BODY = "Name the encoder.";

/**
 * The source composer as the canvas wires it: the note held by
 * `useAnnotationDraft`, Save sending it with a report bound to that note, and
 * Esc or a click outside closing it.
 */
function SourceComposer({ send }: { send: (report: (progress: NoteProgress) => void) => void }) {
  const { draft, openDraft, amendDraft, setDraft, reportTo } = useAnnotationDraft();
  useLayoutEffect(() => {
    openDraft({ focus: vi.fn() } as unknown as EditorView, {
      path: "main.tex", from: 0, to: QUOTE.length, quote: QUOTE, prefix: "", suffix: "", line: 1, body: "", error: null,
    });
  }, [openDraft]);
  if (!draft) return null;
  return (
    <AnnotationComposer
      draft={draft} view={null} anchorKey="main.tex" canRevise
      onChange={amendDraft} onCancel={() => setDraft(null)} onSave={() => send(reportTo(draft.id))}
    />
  );
}

// A note sent to Overleaf on a file the live channel let go of waits for the
// file's sync, up to half a minute. The request cannot be called back, so the
// note may neither be sent twice nor closed meanwhile, and a failure keeps
// what was typed beside the reason.
it("holds a note Overleaf is taking, then shows why it failed beside what was typed", () => {
  let report: (progress: NoteProgress) => void = () => {};
  render(<SourceComposer send={(given) => { report = given; }} />);
  const composer = screen.getByRole("dialog", { name: "Annotate" });
  const field = within(composer).getByRole("textbox", { name: "Annotation" });
  fireEvent.change(field, { target: { value: BODY } });
  fireEvent.click(within(composer).getByRole("button", { name: /^Save(?! and)/ }));
  act(() => report({ saving: "Waiting for main.tex to finish syncing with Overleaf…", error: null }));

  expect(within(composer).getByRole("status")).toHaveTextContent("Waiting for main.tex to finish syncing with Overleaf…");
  expect(within(composer).getByRole("button", { name: /^Save(?! and)/ })).toBeDisabled();
  expect(within(composer).getByRole("button", { name: /^Save and revise now/ })).toBeDisabled();
  fireEvent.keyDown(field, { key: "Escape" });
  fireEvent.pointerDown(document.body);
  expect(screen.getByRole("dialog", { name: "Annotate" })).toBe(composer);

  act(() => report({ saving: null, error: "main.tex did not finish syncing with Overleaf, so your comment is not on it yet." }));
  expect(within(composer).getByRole("alert")).toHaveTextContent("main.tex did not finish syncing with Overleaf");
  expect(within(composer).queryByRole("status")).toBeNull();
  expect(field).toHaveValue(BODY);
  expect(within(composer).getByRole("button", { name: /^Save(?! and)/ })).toBeEnabled();

  // Sent again, it lands, and the note closes.
  fireEvent.click(within(composer).getByRole("button", { name: /^Save(?! and)/ }));
  act(() => report(null));
  expect(screen.queryByRole("dialog", { name: "Annotate" })).toBeNull();
});

it("closes on Escape when no save is under way", () => {
  render(<SourceComposer send={() => {}} />);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Annotation" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Annotate" })).toBeNull();
});
