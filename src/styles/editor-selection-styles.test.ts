import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = String(readFileSync("src/styles/editor-workspace.css", "utf8"));
const editorGlobalsCss = String(readFileSync("src/open-knowledge-app/editor-globals.css", "utf8"));

describe("visual editor selection styles", () => {
  it("replaces ProseMirror's list border and WebKit's range paint with the local selection surface", () => {
    expect(css).toContain(".tiptap-editor .tiptap li.ProseMirror-selectednode");
    expect(css).toContain(".tiptap-editor .tiptap li.ProseMirror-selectednode::after { content: none; }");
    expect(css).toContain(
      '.visual-markdown-editor .tiptap[data-node-selection="true"]::selection',
    );
    expect(css).toContain(
      '.visual-markdown-editor .tiptap[data-node-selection="true"] *::selection { background: transparent; }',
    );
    expect(css).not.toContain(".tiptap:has(.ProseMirror-selectednode)");
  });

  it("removes the image halo's baseline gap and matches arXiv's multi-panel figure row alignment", () => {
    expect(editorGlobalsCss).toMatch(/\.ProseMirror \.ok-image-resizable \{[^}]*line-height: 0;/);
    expect(editorGlobalsCss).toContain(
      "grid-template-columns: var(--paper-figure-columns);\n  align-items: end;\n  justify-content: center;",
    );
  });
});
