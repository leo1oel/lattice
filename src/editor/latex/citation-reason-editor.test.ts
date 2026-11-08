import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorComment } from "../comments/editor-comment-data";
import { citationReasons } from "./citation-reason-editor";
import { citationSites, createCitationReason } from "./citation-reasons";
import type { LatexEditorLiveData } from "./latex-editor";

afterEach(() => { vi.useRealTimers(); });

const SOURCE = "Prior work~\\cite{smith} agrees.";

it("saves the anchor of an edit around a cite when the editor closes before it settles", () => {
  vi.useFakeTimers();
  const site = citationSites(SOURCE)[0]!;
  const reason = createCitationReason({ path: "main.tex", source: SOURCE, site, role: "supporting", body: "", authorId: "me", authorName: "Me" })!;
  const onReanchorCitationReasons = vi.fn<(moves: ReadonlyMap<string, Partial<EditorComment>>) => void>();
  const data = { citations: [], citationReasons: [reason], onReanchorCitationReasons } as unknown as LatexEditorLiveData;
  const view = new EditorView({
    state: EditorState.create({ doc: SOURCE, extensions: citationReasons(() => data, "main.tex").extension }),
    parent: document.body,
  });
  const after = SOURCE.indexOf(" agrees.");
  view.dispatch({ changes: { from: after, to: SOURCE.length, insert: " disagrees strongly." } });
  vi.advanceTimersByTime(200);
  expect(onReanchorCitationReasons).not.toHaveBeenCalled();

  // Switching files destroys the view well within the settle time.
  view.destroy();
  expect(onReanchorCitationReasons).toHaveBeenCalledTimes(1);
  const move = onReanchorCitationReasons.mock.calls[0]![0].get(reason.id);
  expect(move).toMatchObject({ from: site.from, to: site.to, quote: "smith", suffix: "} disagrees strongly." });
  vi.advanceTimersByTime(2000);
  expect(onReanchorCitationReasons).toHaveBeenCalledTimes(1);
});
