import { EditorState, StateEffect } from "@codemirror/state";
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

it("saves it too when the editor's extensions are rebuilt before it settles, as a file rename does", () => {
  vi.useFakeTimers();
  const crashed = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const site = citationSites(SOURCE)[0]!;
  const reason = createCitationReason({ path: "main.tex", source: SOURCE, site, role: "supporting", body: "", authorId: "me", authorName: "Me" })!;
  const onReanchorCitationReasons = vi.fn<(moves: ReadonlyMap<string, Partial<EditorComment>>) => void>();
  const data = { citations: [], citationReasons: [reason], onReanchorCitationReasons } as unknown as LatexEditorLiveData;
  const view = new EditorView({
    state: EditorState.create({ doc: SOURCE, extensions: citationReasons(() => data, "main.tex").extension }),
    parent: document.body,
  });
  try {
    view.dispatch({ changes: { from: SOURCE.indexOf(" agrees."), to: SOURCE.length, insert: " disagrees strongly." } });
    view.dispatch({ effects: StateEffect.reconfigure.of(citationReasons(() => data, "renamed.tex").extension) });
    expect(crashed).not.toHaveBeenCalled();
    expect(onReanchorCitationReasons).toHaveBeenCalledTimes(1);
    expect(onReanchorCitationReasons.mock.calls[0]![0].get(reason.id)).toMatchObject({ suffix: "} disagrees strongly." });
  } finally {
    view.destroy();
    crashed.mockRestore();
  }
});

it("keeps the anchor the write-back saved while the popover was open when the popover saves", () => {
  vi.useFakeTimers();
  const site = citationSites(SOURCE)[0]!;
  const reason = createCitationReason({ path: "main.tex", source: SOURCE, site, role: "supporting", body: "", authorId: "me", authorName: "Me" })!;
  const data = {
    citations: [],
    citationReasons: [reason] as EditorComment[],
    // The store: a write-back replaces the reason's anchor.
    onReanchorCitationReasons: (moves: ReadonlyMap<string, Partial<EditorComment>>) => {
      data.citationReasons = data.citationReasons.map((item) => ({ ...item, ...moves.get(item.id) }));
    },
    onSaveCitationReason: vi.fn<(saved: EditorComment) => void>(),
  };
  const reasons = citationReasons(() => data as unknown as LatexEditorLiveData, "main.tex");
  const view = new EditorView({ state: EditorState.create({ doc: SOURCE, extensions: reasons.extension }), parent: document.body });
  try {
    view.dispatch({ changes: { from: SOURCE.indexOf(" agrees."), to: SOURCE.length, insert: " disagrees strongly." } });
    reasons.api.edit(view, { from: site.from, to: site.to, key: "smith" });
    vi.advanceTimersByTime(1500);
    expect(data.citationReasons[0]!.suffix).toBe("} disagrees strongly.");

    const popover = view.dom.querySelector(".citation-reason-popover")!;
    (popover.querySelector('[data-role="counterexample"]') as HTMLButtonElement).click();
    [...popover.querySelectorAll("button")].find((button) => button.textContent === "Save")!.click();
    expect(data.onSaveCitationReason).toHaveBeenCalledTimes(1);
    expect(data.onSaveCitationReason.mock.calls[0]![0]).toMatchObject({
      id: reason.id, from: site.from, to: site.to, suffix: "} disagrees strongly.", citation: { key: "smith", role: "counterexample" },
    });
  } finally {
    view.destroy();
  }
});
