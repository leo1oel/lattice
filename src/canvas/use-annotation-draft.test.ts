import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { showError } from "../app/notify";
import { useAnnotationDraft } from "./use-annotation-draft";

vi.mock("../app/notify", () => ({ showError: vi.fn() }));
afterEach(() => vi.mocked(showError).mockReset());

const note = (quote: string, body: string) => ({
  path: "main.tex", from: 0, to: quote.length, quote, prefix: "", suffix: "", line: 1, body, error: null,
});
const view = () => ({ focus: vi.fn() }) as unknown as EditorView;

// A note sent to Overleaf on a file the live channel let go of can wait up
// to half a minute for the file's sync. What the writer typed must survive
// that wait: the caret leaving the selection, or a second note, must not
// close it, and its failure must land on it, or say so if it is gone.
it("holds a note being saved until it lands, and puts a failure on it with what was typed", () => {
  const { result } = renderHook(() => useAnnotationDraft());
  const editor = view();
  act(() => result.current.openDraft(editor, note("visual token", "Name the encoder.")));
  const sent = result.current.draft!;
  const report = result.current.reportTo(sent.id);
  act(() => report({ saving: "Waiting for main.tex to finish syncing with Overleaf…", error: null }));

  act(() => result.current.releaseDraft());
  act(() => result.current.openDraft(view(), note("other words", "")));
  expect(result.current.draft).toMatchObject({ id: sent.id, body: "Name the encoder.", saving: "Waiting for main.tex to finish syncing with Overleaf…" });

  act(() => report({ saving: null, error: "Overleaf could not be reached." }));
  expect(result.current.draft).toMatchObject({ id: sent.id, body: "Name the encoder.", saving: null, error: "Overleaf could not be reached." });
  expect(showError).not.toHaveBeenCalled();
  // Sent again, it lands: the note closes and the editor has the focus back.
  act(() => report(null));
  expect(result.current.draft).toBeNull();
  expect(editor.focus).toHaveBeenCalled();
});

it("answers only the note that was sent: a late failure for a note gone says so in a toast and leaves the next note alone", () => {
  const { result } = renderHook(() => useAnnotationDraft());
  act(() => result.current.openDraft(view(), note("visual token", "Name the encoder.")));
  const report = result.current.reportTo(result.current.draft!.id);
  act(() => result.current.setDraft(null));
  act(() => result.current.openDraft(view(), note("other words", "Unsent")));
  const next = result.current.draft;

  act(() => report(null));
  act(() => report({ saving: null, error: "Your comment on main.tex did not reach Overleaf: Overleaf could not be reached." }));
  expect(result.current.draft).toBe(next);
  expect(showError).toHaveBeenCalledWith("Your comment on main.tex did not reach Overleaf: Overleaf could not be reached.");
  // Without a save under way, the caret leaving the selection closes a note.
  act(() => result.current.releaseDraft());
  expect(result.current.draft).toBeNull();
});
