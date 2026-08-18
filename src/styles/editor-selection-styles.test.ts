import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = String(readFileSync("src/styles/editor-workspace.css", "utf8"));
const editorGlobalsCss = String(readFileSync("src/open-knowledge-app/editor-globals.css", "utf8"));

describe("visual editor selection styles", () => {
  it("replaces ProseMirror's blue selected-list border with the local selection surface", () => {
    expect(css).toContain(".tiptap-editor .tiptap li.ProseMirror-selectednode");
    expect(css).toContain(".tiptap-editor .tiptap li.ProseMirror-selectednode::after { content: none; }");
  });

  it("hides WebKit's native range paint behind the local block-selection surface", () => {
    expect(css).toContain(
      ".visual-markdown-editor .tiptap:has(.ProseMirror-selectednode)::selection",
    );
    expect(css).toContain(
      ".visual-markdown-editor .tiptap:has(.ProseMirror-selectednode) *::selection { background: transparent; }",
    );
  });

  it("removes the image baseline gap from the block-selection halo", () => {
    expect(editorGlobalsCss).toMatch(/\.ProseMirror \.ok-image-resizable \{[^}]*line-height: 0;/);
  });
});
