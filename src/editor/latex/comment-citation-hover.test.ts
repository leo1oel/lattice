import { EditorState } from "@codemirror/state";
import { EditorView, type Rect } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorComment } from "../comments/editor-comment-data";
import { CommentCardHosts, editorCommentsExtension } from "../comments/editor-comments";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationTooltips } from "./latex-hover-cards";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));

/*
 * CodeMirror decides a hover card's lifetime from geometry jsdom does not lay
 * out, so the editor here is a fixed grid: 10px columns, 20px rows, 50 columns
 * to a row before the line wraps, its text starting at (100, 100). A hover
 * popover is 300 × 120 wherever CodeMirror puts it.
 */
const COLUMN = 10, ROW = 20, COLUMNS = 50, LEFT = 100, TOP = 100, CARD = { width: 300, height: 120 };

/** The text before the commented paragraph fills two rows, so there is room above it. */
const INTRO = "%".repeat(COLUMNS * 2 - 1);
/** The cite sits on the paragraph's third row, past the right edge of a card that hangs from where the comment starts. */
const PARAGRAPH = `${"word ".repeat(26)}and \\cite{lee2026} for sparse inputs.`;
const DOC = `${INTRO}\n${PARAGRAPH}`;

/** Each line starts a new row, then wraps every `COLUMNS` characters. */
function rowsOf(doc: string) {
  const rows: { from: number; to: number }[] = [];
  let at = 0;
  for (const line of doc.split("\n")) {
    for (let start = 0; start === 0 || start < line.length; start += COLUMNS) {
      rows.push({ from: at + start, to: at + Math.min(line.length, start + COLUMNS) });
    }
    at += line.length + 1;
  }
  return rows;
}

function coordsAt(pos: number): Rect {
  const rows = rowsOf(DOC);
  let row = 0;
  while (row + 1 < rows.length && rows[row + 1].from <= pos) row += 1;
  const left = LEFT + (pos - rows[row].from) * COLUMN;
  return { left, right: left + COLUMN, top: TOP + row * ROW, bottom: TOP + (row + 1) * ROW };
}

function posAt({ x, y }: { x: number; y: number }): number {
  const rows = rowsOf(DOC);
  const row = rows[Math.max(0, Math.min(rows.length - 1, Math.floor((y - TOP) / ROW)))];
  return Math.max(row.from, Math.min(row.to, row.from + Math.floor((x - LEFT) / COLUMN)));
}

const views: EditorView[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  // A hover popover's box follows where CodeMirror placed it; everything else spans the window.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains("cm-tooltip-hover")) {
      const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
      return DOMRect.fromRect({ x: left, y: top, ...CARD });
    }
    return DOMRect.fromRect({ x: 0, y: 0, width: 1024, height: 768 });
  });
  // CodeMirror keeps a popover inside the window, which it reads from these.
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
});

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function openEditor() {
  const from = DOC.indexOf(PARAGRAPH);
  const comment = createEditorComment({
    path: "main.tex", source: DOC, from, to: from + PARAGRAPH.length, body: "Check this claim.", authorId: "a", authorName: "Ann", number: 1,
  });
  if (!comment) throw new Error("no comment");
  const data: LatexEditorLiveData = {
    citationKeys: ["lee2026"], citations: [{ key: "lee2026", title: "A Study of Collaborative Writing", authors: "Lee, Alice", year: "2026", venue: "CHI" }],
    references: [], unusedLabels: [], unusedCitations: [], localMacros: [], graphicsRoots: [], projectPaths: [], spellingWords: [],
  };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        editorCommentsExtension("main.tex", { getComments: () => [comment], cards: new CommentCardHosts() }),
        citationTooltips(() => data),
      ],
    }),
  });
  views.push(view);
  Object.assign(view, { coordsAtPos: coordsAt, posAtCoords: posAt });
  Object.defineProperties(view, {
    documentTop: { value: TOP },
    documentPadding: { value: { top: 0, bottom: 0 } },
    contentHeight: { value: rowsOf(DOC).length * ROW },
  });
  return view;
}

/** Moves the pointer over the editor, then lets hover delays and measuring run. */
function pointAt(view: EditorView, x: number, y: number) {
  const target = view.contentDOM.querySelector(".cm-line") ?? view.contentDOM;
  target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
  // Past the hover delay, and the animation frame in which CodeMirror places the popover.
  vi.advanceTimersByTime(500);
}

const popover = () => document.querySelector<HTMLElement>(".cm-tooltip-hover");
const parts = () => ({
  comment: !!popover()?.querySelector(".cm-editor-comment-card-host"),
  citation: !!popover()?.querySelector(".citation-hover-card"),
});

describe("a citation inside a commented passage", () => {
  it("keeps the comment and the citation card while the pointer travels from the key into the popover", () => {
    const view = openEditor();
    const key = coordsAt(DOC.indexOf("lee2026") + 3);
    const startY = (key.top + key.bottom) / 2;
    pointAt(view, key.left, startY);
    expect(parts()).toEqual({ comment: true, citation: true });

    // Straight up from the key and into the popover, which rises from it.
    const box = popover()!.getBoundingClientRect();
    for (let y = startY; y >= box.bottom - 10; y -= 4) {
      pointAt(view, key.left, y);
      expect(parts(), `pointer at y=${y}`).toEqual({ comment: true, citation: true });
    }
    expect(box.left).toBeLessThanOrEqual(key.left);
    expect(box.right).toBeGreaterThanOrEqual(key.right);
    // Resting anywhere on it keeps both.
    pointAt(view, box.left + 20, box.top + 20);
    pointAt(view, box.right - 20, box.top + 60);
    expect(parts()).toEqual({ comment: true, citation: true });
  });

  it("closes both once the pointer leaves the passage and the popover", () => {
    const view = openEditor();
    const key = coordsAt(DOC.indexOf("lee2026") + 3);
    pointAt(view, key.left, (key.top + key.bottom) / 2);
    expect(parts()).toEqual({ comment: true, citation: true });

    // Below the document's last row, away from the popover.
    pointAt(view, 900, 700);
    expect(popover()).toBeNull();
  });
});
