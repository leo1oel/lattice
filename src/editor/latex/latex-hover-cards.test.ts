import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationCardAtCursor, citationTooltips } from "./latex-hover-cards";
import type { DefinitionTarget } from "./latex-text";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));

const ENTRIES = [
  { key: "vaswani2017", title: "Attention Is All You Need", authors: "Vaswani, Ashish", year: "2017", venue: "NeurIPS" },
  { key: "lee2026", title: "A Study of Collaborative Writing", authors: "Lee, Alice", year: "2026", venue: "CHI" },
];

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

/** Opens the card ⌥⌘K would open for the key under the caret in `doc`. */
function openCard(doc: string, key: string, live: Partial<LatexEditorLiveData>, onGotoDefinition = vi.fn<(target: DefinitionTarget) => void>()) {
  const data: LatexEditorLiveData = {
    citationKeys: ENTRIES.map((entry) => entry.key), citations: ENTRIES, references: [], unusedLabels: [], unusedCitations: [],
    localMacros: [], graphicsRoots: [], projectPaths: [], spellingWords: [], ...live,
  };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: doc.indexOf(key) + 1 }, extensions: citationTooltips(() => data, onGotoDefinition) }),
  });
  views.push(view);
  expect(citationCardAtCursor(() => data, onGotoDefinition)(view)).toBe(true);
  const card = view.dom.querySelector<HTMLElement>(".citation-hover-card");
  if (!card) throw new Error("no citation card");
  return { card, onGotoDefinition };
}

describe("citation card title", () => {
  it.each([
    ["\\citep", "\\citep{vaswani2017}", "vaswani2017"],
    ["\\citet", "\\citet{vaswani2017}", "vaswani2017"],
    ["\\cite", "\\cite{vaswani2017}", "vaswani2017"],
    ["the second key of a \\citep", "\\citep{vaswani2017,lee2026}", "lee2026"],
  ])("opens the paper from its title in %s, as Open paper does", (_name, doc, key) => {
    const onOpenCitation = vi.fn();
    const { card, onGotoDefinition } = openCard(doc, key, { canOpenCitation: () => true, onOpenCitation });
    const title = card.querySelector<HTMLButtonElement>("button.citation-card-title");
    expect(title?.textContent).toBe(ENTRIES.find((entry) => entry.key === key)?.title);
    expect(card.querySelector(".citation-card-actions button")?.textContent).toContain("Open paper");

    fireEvent.click(title!);
    expect(onOpenCitation).toHaveBeenCalledExactlyOnceWith(key);
    expect(onGotoDefinition).not.toHaveBeenCalled();
    expect(card.isConnected).toBe(false);
  });

  it("goes to the .bib entry from its title when there is no paper to open", () => {
    const onOpenCitation = vi.fn();
    const { card, onGotoDefinition } = openCard("\\citep{vaswani2017}", "vaswani2017", { canOpenCitation: () => false, onOpenCitation });
    expect(card.querySelector(".citation-card-actions")?.textContent).not.toContain("Open paper");

    fireEvent.click(card.querySelector<HTMLButtonElement>("button.citation-card-title")!);
    expect(onGotoDefinition).toHaveBeenCalledExactlyOnceWith({ kind: "citation", key: "vaswani2017" });
    expect(onOpenCitation).not.toHaveBeenCalled();
  });

  it("keeps the lead action, not the title, focused when opened from the keyboard", () => {
    const { card } = openCard("\\citep{vaswani2017}", "vaswani2017", { canOpenCitation: () => true, onOpenCitation: vi.fn() });
    expect(document.activeElement).toBe(card.querySelector(".citation-card-actions button"));
  });
});
