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
      { active: true, tools: { lastBuild: { status: "succeeded", seconds: 3.2 } } },
      { active: true, tools: { lastBuild: { status: "failed" } } },
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

describe("the Build button's report of the last build", () => {
  const tex = DOCUMENTS[0];
  /** What the live button shows: its state class and the one visible label. */
  const shown = (container: HTMLElement) => {
    const button = container.querySelector(".trellis-build-button")!;
    const label = [...button.querySelectorAll(".trellis-build-label > span")].find((span) => !span.classList.contains("trellis-build-label-off"));
    return { state: [...button.classList].find((name) => name.startsWith("is-")) ?? "idle", label: label?.textContent, busy: button.getAttribute("aria-busy") };
  };

  it("reads Build before any build, spins while one runs, then shows a check and the time", () => {
    const { container, controller } = renderTools(tex, { active: true }, {});
    expect(shown(container)).toEqual({ state: "idle", label: "Build", busy: null });
    act(() => controller.docTools.set({ building: true }));
    expect(shown(container)).toEqual({ state: "is-building", label: "Build", busy: "true" });
    act(() => controller.docTools.set({ building: false, lastBuild: { status: "succeeded", seconds: 3.24 } }));
    expect(shown(container)).toEqual({ state: "is-succeeded", label: "3.2s", busy: null });
    expect(container.querySelector(".trellis-build-status")).not.toBeNull();
  });

  it("shows a failed build, and returns to Build when the next one starts or it was stopped", () => {
    const { container, controller } = renderTools(tex, { active: true }, { lastBuild: { status: "failed" } });
    expect(shown(container)).toEqual({ state: "is-failed", label: "Failed", busy: null });
    act(() => controller.docTools.set({ building: true, lastBuild: null }));
    expect(shown(container)).toEqual({ state: "is-building", label: "Build", busy: "true" });
    // A stopped build reports nothing.
    act(() => controller.docTools.set({ building: false }));
    expect(shown(container)).toEqual({ state: "idle", label: "Build", busy: null });
  });

  // The flourish belongs to the moment a build ends. A panel that remounts
  // later (another tab, another panel) shows the result without replaying it.
  it("celebrates a finished build once, not again when its panel remounts", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const succeeded = { status: "succeeded", seconds: 2 } as const;
    const first = renderTools(tex, { active: true }, { lastBuild: succeeded });
    expect(first.container.querySelector(".trellis-build-button")).toHaveClass("is-fresh");
    expect(first.container.querySelector(".trellis-build-status")).toHaveAttribute("data-fresh");
    expect(first.container.querySelector(".trellis-build-burst")).not.toBeNull();
    first.unmount();
    now.mockReturnValue(5_000);
    const later = renderTools(tex, { active: true }, { lastBuild: succeeded });
    expect(later.container.querySelector(".trellis-build-button")).not.toHaveClass("is-fresh");
    expect(later.container.querySelector(".trellis-build-status")).not.toHaveAttribute("data-fresh");
    expect(later.container.querySelector(".trellis-build-burst")).toBeNull();
    later.unmount();
    // A failure shakes rather than bursts.
    const failed = renderTools(tex, { active: true }, { lastBuild: { status: "failed" } });
    expect(failed.container.querySelector(".trellis-build-status")).toHaveAttribute("data-fresh");
    expect(failed.container.querySelector(".trellis-build-burst")).toBeNull();
    now.mockRestore();
  });

  // One project build serves every .tex panel: the store is shared, so a
  // panel that was hidden or unselected when the build ended shows its result
  // the moment its document is the active one again.
  it("shows the result in whichever .tex panel becomes active after the build ended", () => {
    const { container, controller } = renderTools(tex, { active: false }, { building: true });
    expect(container.querySelector(".trellis-tools-reserve .trellis-build-button")).not.toHaveClass("is-building");
    act(() => controller.docTools.set({ building: false, lastBuild: { status: "succeeded", seconds: 12 } }));
    act(() => controller.app.set({ activeKey: tex.key }));
    expect(container.querySelector(".trellis-tools-reserve")).toBeNull();
    expect(shown(container)).toEqual({ state: "is-succeeded", label: "12.0s", busy: null });
  });
});
