import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  buildPresenceCursorDecorations,
  overleafCursorsExtension,
  posForRowColumn,
  setOverleafCursorsEffect,
  type PresenceCursor,
} from "./overleaf-cursors";

function cursor(overrides: Partial<PresenceCursor> = {}): PresenceCursor {
  return { name: "Ada Lovelace", hue: 200, row: 0, column: 0, ...overrides };
}

describe("posForRowColumn", () => {
  const doc = EditorState.create({ doc: "alpha\nbeta\ngamma" }).doc;

  it("finds a position on an interior line", () => {
    expect(posForRowColumn(doc, 1, 2)).toBe(doc.line(2).from + 2);
  });

  it("clamps a column past the end of its line", () => {
    expect(posForRowColumn(doc, 0, 99)).toBe(doc.line(1).to);
  });

  it("clamps a row past the end of the document to the last line", () => {
    expect(posForRowColumn(doc, 99, 0)).toBe(doc.line(3).from);
  });

  it("clamps a negative row or column to the start", () => {
    expect(posForRowColumn(doc, -1, -1)).toBe(doc.line(1).from);
  });
});

describe("buildPresenceCursorDecorations", () => {
  const doc = EditorState.create({ doc: "alpha\nbeta\ngamma" }).doc;

  it("is empty with no cursors", () => {
    expect(buildPresenceCursorDecorations(doc, []).size).toBe(0);
  });

  it("places one widget per cursor", () => {
    const decorations = buildPresenceCursorDecorations(doc, [
      cursor({ row: 0, column: 1 }),
      cursor({ row: 2, column: 0, name: "Grace Hopper" }),
    ]);
    const positions: number[] = [];
    decorations.between(0, doc.length, (from) => {
      positions.push(from);
    });
    expect(positions).toEqual([doc.line(1).from + 1, doc.line(3).from]);
  });
});

describe("overleafCursorsExtension", () => {
  it("starts empty and draws a caret once the effect dispatches a roster", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "alpha\nbeta", extensions: overleafCursorsExtension() }),
    });
    expect(view.dom.querySelector(".cm-overleaf-caret")).toBeNull();

    view.dispatch({ effects: setOverleafCursorsEffect.of([cursor({ row: 1, column: 1 })]) });
    const label = view.dom.querySelector(".cm-overleaf-caret-label");
    expect(label?.textContent).toBe("Ada Lovelace");
    view.destroy();
  });

  it("re-reads a live getter after a reconfigure, instead of starting empty", () => {
    let cursors: PresenceCursor[] = [cursor({ row: 0, column: 0 })];
    const extensions = overleafCursorsExtension({ getCursors: () => cursors });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "alpha\nbeta", extensions }),
    });
    expect(view.dom.querySelector(".cm-overleaf-caret")).not.toBeNull();

    // Fresh state (same as a reconfigure wipe) should still show a caret via
    // the getter rather than a state a bare `create()` would leave empty.
    cursors = [cursor({ row: 0, column: 0 })];
    view.setState(EditorState.create({ doc: "alpha\nbeta", extensions }));
    expect(view.dom.querySelector(".cm-overleaf-caret")).not.toBeNull();

    cursors = [];
    view.setState(EditorState.create({ doc: "alpha\nbeta", extensions }));
    expect(view.dom.querySelector(".cm-overleaf-caret")).toBeNull();
    view.destroy();
  });
});
