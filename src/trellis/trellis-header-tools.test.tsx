import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrellisController, documentTools, type TrellisDocToolsState, type TrellisTabKind } from "./trellis-controller";
import { FileHeaderTools } from "./trellis-header-tools";

const viewKey = vi.hoisted(() => ({ current: "" }));
vi.mock("@danfessler/trellis-react", () => ({ useView: () => ({ params: { key: viewKey.current }, panelId: "panel-1" }) }));

afterEach(cleanup);

/** Every kind of document a document panel can hold, with the tools its header carries. */
const DOCUMENTS: Array<{ name: string; key: string; kind: TrellisTabKind; tools: ReturnType<typeof documentTools> }> = [
  { name: "LaTeX", key: "chapters/ch01.tex", kind: "file", tools: "build" },
  { name: "Markdown", key: "notes/idea.md", kind: "file", tools: "views" },
  { name: "HTML", key: "site/index.html", kind: "file", tools: "views" },
  { name: "Paper", key: ".research/papers/1706.03762v7/paper.md", kind: "paper", tools: "paper" },
  { name: "BibTeX", key: "references.bib", kind: "file", tools: null },
  { name: "plain text", key: "README.txt", kind: "file", tools: null },
  { name: "board", key: "sketch.tldr", kind: "file", tools: null },
  { name: "spreadsheet", key: "data/results.csv", kind: "file", tools: null },
  { name: "slide deck", key: "talk/slides.deck.json", kind: "file", tools: null },
  { name: "image asset", key: "figures/plot.png", kind: "asset", tools: null },
  { name: "PDF asset", key: "reference.pdf", kind: "asset", tools: null },
];

/** The header tools' footprint: which controls are laid out and how many segments each has, live or reserved. */
function footprint(container: HTMLElement) {
  return [...container.querySelectorAll(".trellis-build-button, .trellis-view-switcher")].map((element) =>
    element.classList.contains("trellis-build-button") ? "build" : `switch:${element.querySelectorAll("[role='tab'], button").length}`);
}

function renderTools(document: (typeof DOCUMENTS)[number], app: { active: boolean }, tools: Partial<TrellisDocToolsState>) {
  const controller = new TrellisController();
  controller.setBridge({ tabKind: () => document.kind } as unknown as Parameters<TrellisController["setBridge"]>[0]);
  controller.app.set({ activeKey: app.active ? document.key : "other.tex" });
  controller.docTools.set(tools);
  viewKey.current = document.key;
  return { controller, ...render(<FileHeaderTools controller={controller} />) };
}

describe("document panel header tools", () => {
  it.each(DOCUMENTS)("classifies a $name document", ({ key, kind, tools }) => {
    expect(documentTools(kind, key)).toBe(tools);
  });

  // The Trellis patch reserves the header's action cell from its measured
  // width, and every view of a panel shares that cell. Tabs keep their width
  // (and stay clear of the actions) only if each document's tools take the
  // same room whether they are live, loading or belong to an unselected tab.
  it.each(DOCUMENTS)("keeps the $name document's tools the same width in every state", (document) => {
    const states: Array<{ active: boolean; tools: Partial<TrellisDocToolsState> }> = [
      { active: false, tools: {} },
      // Selected, before App has reported the document's views or the Paper's texts.
      { active: true, tools: { viewModes: null, paperView: null, paperViews: false } },
      // Selected and fully loaded (a Paper with both its blog and its full text).
      { active: true, tools: { viewModes: document.key.endsWith(".html") ? "html" : "markdown", paperView: "blog", paperViews: true } },
      // A Paper with only one of its texts: nothing to switch, the same room kept.
      { active: true, tools: { viewModes: null, paperView: "fulltext", paperViews: false } },
      { active: true, tools: { building: true } },
    ];
    const footprints = states.map(({ active, tools }) => {
      const { container, unmount } = renderTools(document, { active }, tools);
      const result = footprint(container);
      unmount();
      return result;
    });
    const expected = document.tools ? { build: ["build"], views: ["switch:3"], paper: ["switch:2"] }[document.tools] : [];
    for (const result of footprints) expect(result).toEqual(expected);
  });

  it("reserves unselected or not-yet-live tools inert and hidden from assistive tech", () => {
    const paper = DOCUMENTS.find((document) => document.kind === "paper")!;
    const { container, controller } = renderTools(paper, { active: true }, { paperView: "fulltext", paperViews: false });
    expect(container.querySelector(".trellis-tools-reserve")).toHaveAttribute("inert");
    expect(container.querySelector(".trellis-tools-reserve")).toHaveAttribute("aria-hidden", "true");
    act(() => controller.docTools.set({ paperView: "blog", paperViews: true }));
    expect(container.querySelector(".trellis-tools-reserve")).toBeNull();
    expect(container.querySelector(".trellis-view-switcher")).toHaveAttribute("aria-label", "Paper content");
  });
});
