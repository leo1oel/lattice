import { EditorState } from "@codemirror/state";
import { highlightingFor, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import {
  immediateTextLanguageExtensions,
  loadTextLanguageExtensions,
} from "./editor-languages";

describe("editor languages", () => {
  it("parses and theme-highlights presentation Markdown", async () => {
    const extensions = await loadTextLanguageExtensions("talk.slides.md");
    const state = EditorState.create({
      doc: "# Opening\n\n**Result**\n",
      extensions,
    });

    expect(syntaxTree(state).toString()).toContain("ATXHeading1");
    expect(highlightingFor(state, [tags.heading])).toEqual(expect.any(String));
    expect(immediateTextLanguageExtensions("another.slides.md")).toBe(extensions);
  });
});
