// @ts-expect-error no Node types in this project
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VISUAL_FIXED_CARET_HEIGHT_PX,
  visualCaretScrollRefresh,
  visualFixedCaretPlacement,
} from "./visual-fixed-caret";

describe("visualFixedCaretPlacement", () => {
  it("keeps a fixed height centered inside a tall heading line box", () => {
    expect(visualFixedCaretPlacement(
      { top: 100, bottom: 140, left: 48 },
      { top: 80, left: 16 },
    )).toEqual({
      top: 29,
      left: 32,
      height: VISUAL_FIXED_CARET_HEIGHT_PX,
    });
  });

  it("does not exceed a short body line box", () => {
    expect(visualFixedCaretPlacement(
      { top: 10, bottom: 28, left: 20 },
      { top: 0, left: 0 },
      22,
    )).toEqual({
      top: 10,
      left: 20,
      height: 18,
    });
  });
});

describe("visualCaretScrollRefresh", () => {
  it("defers ancestor scrolling but follows nested overflow on the next frame", () => {
    const viewport = document.createElement("div");
    const editor = document.createElement("div");
    const tableScroller = document.createElement("div");
    viewport.append(editor);
    editor.append(tableScroller);

    expect(visualCaretScrollRefresh(editor, viewport)).toBe("settle");
    expect(visualCaretScrollRefresh(editor, document)).toBe("settle");
    expect(visualCaretScrollRefresh(editor, tableScroller)).toBe("frame");
  });
});

describe("visual fixed caret styles", () => {
  it("hides the native caret for the boolean data-fixed-caret attribute", () => {
    // toggleAttribute("data-fixed-caret", true) sets an empty attribute, not
    // data-fixed-caret="true". The selector must match that form or both
    // carets paint at once.
    const css = String(readFileSync("src/styles/editor-workspace.css", "utf8"));
    expect(css).toContain(".ProseMirror[data-fixed-caret]");
    expect(css).toContain(".ProseMirror[data-fixed-caret] *");
    expect(css).not.toContain('[data-fixed-caret="true"]');
  });

  it("replaces ProseMirror's blue selected-list border with the local selection surface", () => {
    const css = String(readFileSync("src/styles/editor-workspace.css", "utf8"));
    expect(css).toContain(".tiptap-editor .tiptap li.ProseMirror-selectednode");
    expect(css).toContain(".tiptap-editor .tiptap li.ProseMirror-selectednode::after { content: none; }");
  });

  it("hides WebKit's native range paint behind the local block-selection surface", () => {
    const css = String(readFileSync("src/styles/editor-workspace.css", "utf8"));
    expect(css).toContain(
      ".visual-markdown-editor .tiptap:has(.ProseMirror-selectednode)::selection",
    );
    expect(css).toContain(
      ".visual-markdown-editor .tiptap:has(.ProseMirror-selectednode) *::selection { background: transparent; }",
    );
  });
});
