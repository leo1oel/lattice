// @ts-expect-error no Node types in this project
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = String(readFileSync("src/styles/editor-workspace.css", "utf8"));

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
});
