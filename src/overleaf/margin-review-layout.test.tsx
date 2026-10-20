import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, lineNumbers } from "@codemirror/view";
import { AppOverleafMarginReview } from "../app/app-overleaf-drawer";
import type { useOverleafWorkspace } from "../app/use-overleaf-workspace";
import { DocumentSkeleton } from "../canvas/document-skeleton";
import { CARD_GAP, CARD_WIDTH, marginLayoutFor } from "./margin-review-layout";
import { publishMarginReviewComments } from "./margin-review-files";
import { setMarginReviewMode } from "./margin-review-mode";

/** The editor's face at its default size: 88 columns of 8px and the line's padding; four digits, padding and the fold column. */
const MEASURE = 88 * 8 + 8;
const GUTTER = 62;
/** Gutter, measure, a card beside it and the rail's clearance. */
const WIDE_ENOUGH = GUTTER + MEASURE + CARD_GAP + CARD_WIDTH + 36;

describe("margin review's layout", () => {
  const layout = (width: number, wantWide = true) =>
    marginLayoutFor({ wantWide, width, gutters: GUTTER, measure: MEASURE, textWidth: width - GUTTER - 36 });

  it("is wide once the pane holds the measure and a card beside it", () => {
    expect(layout(WIDE_ENOUGH)).toEqual({ kind: "wide", narrow: false });
    expect(layout(WIDE_ENOUGH - 1)).toEqual({ kind: "markers", narrow: false });
  });

  it("is markers when the window asks for them or focus mode is on, however wide", () => {
    expect(layout(WIDE_ENOUGH * 2, false).kind).toBe("markers");
  });

  it("opens the rail rather than a card when the text is too narrow for one", () => {
    expect(layout(GUTTER + 36 + 479)).toEqual({ kind: "markers", narrow: true });
    expect(layout(GUTTER + 36 + 480)).toEqual({ kind: "markers", narrow: false });
  });
});

// jsdom lays nothing out: the panes and probes report the widths a window would.
let paneWidth = 0;
beforeEach(() => {
  setMarginReviewMode("auto");
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".cm-scroller, .document-skeleton-source") ? paneWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const part = this.dataset.part;
    const width = part === "measure" ? MEASURE : part === "gutter" ? GUTTER : this.matches(".cm-gutters") ? GUTTER : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  publishMarginReviewComments("", []);
  setMarginReviewMode("auto");
});

/** A linked project with one open thread in each of `paths`. */
function overleafWith(paths: string[]) {
  return {
    overleafComments: {
      threads: paths.map((_, index) => ({ id: `t-${index}`, resolved: false, messages: [] })),
      anchors: new Map(paths.map((_, index) => [`t-${index}`, { docId: "doc-main", position: 0, quote: "x" }])),
    },
    overleafEditorComments: paths.map((path, index) => ({ id: `overleaf:t-${index}`, path, from: 0, to: 1, quote: "x", resolved: false })),
    overleafRealtime: { docId: null, changes: [], canWrite: true },
    overleafDocPaths: new Map(),
    overleafTrackChanges: { authorName: () => "", busy: null },
    overleafPresence: { peers: [] },
  } as unknown as ReturnType<typeof useOverleafWorkspace>;
}

/** The source pane with its editor, and the margin review App mounts beside it, in one commit. */
function openSource(paths: string[], { focusMode = false } = {}) {
  const pane = document.createElement("div");
  pane.className = "source-editor";
  document.body.append(pane);
  const view = new EditorView({ doc: "x\n", extensions: lineNumbers(), parent: pane });
  render(<AppOverleafMarginReview overleaf={overleafWith(paths)} view={view} path="main.tex" focusMode={focusMode} />);
  return { pane, view };
}

describe("a source opening with margin review beside it", () => {
  // Deciding a frame late drew the text at full width and then rewrapped
  // every line into the measure: the pane must say so when it first paints.
  it("is laid out wide when it first paints, with room for the cards", () => {
    paneWidth = WIDE_ENOUGH;
    const { pane, view } = openSource(["main.tex"]);
    expect(pane.getAttribute("data-margin-review")).toBe("wide");
    view.destroy();
  });

  it("keeps full-width text, with markers, when the pane is narrower", () => {
    paneWidth = WIDE_ENOUGH - 1;
    const { pane, view } = openSource(["main.tex"]);
    expect(pane.getAttribute("data-margin-review")).toBe("markers");
    view.destroy();
  });

  it("keeps markers in focus mode", () => {
    paneWidth = WIDE_ENOUGH;
    const { pane, view } = openSource(["main.tex"], { focusMode: true });
    expect(pane.getAttribute("data-margin-review")).toBe("markers");
    view.destroy();
  });

  it("leaves a file without review, or a window with review off, as it was", () => {
    paneWidth = WIDE_ENOUGH;
    const other = openSource(["chapter.tex"]);
    expect(other.pane.hasAttribute("data-margin-review")).toBe(false);
    other.view.destroy();
    cleanup();
    act(() => setMarginReviewMode("off"));
    const off = openSource(["main.tex"]);
    expect(off.pane.hasAttribute("data-margin-review")).toBe(false);
    off.view.destroy();
  });
});

describe("a source skeleton for a file with review beside it", () => {
  it("ends its lines at the measure when the editor replacing it will", () => {
    paneWidth = WIDE_ENOUGH;
    const { container } = render(<DocumentSkeleton shape="source" label="Opening" marginReview />);
    expect(container.querySelector(".document-skeleton-source")?.getAttribute("data-margin")).toBe("wide");
  });

  it("keeps full-width lines when it is narrower, or the file has none", () => {
    paneWidth = WIDE_ENOUGH - 1;
    const narrow = render(<DocumentSkeleton shape="source" label="Opening" marginReview />);
    expect(narrow.container.querySelector(".document-skeleton-source")?.hasAttribute("data-margin")).toBe(false);
    paneWidth = WIDE_ENOUGH;
    const plain = render(<DocumentSkeleton shape="source" label="Opening" />);
    expect(plain.container.querySelector(".document-skeleton-source")?.hasAttribute("data-margin")).toBe(false);
  });
});
