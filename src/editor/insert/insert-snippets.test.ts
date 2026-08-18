import { describe, expect, it } from "vitest";
import { INSERT_GROUPS, INSERT_SNIPPETS } from "./insert-snippets";

describe("insert snippets", () => {
  it("covers every advertised group with labeled previews", () => {
    expect(INSERT_SNIPPETS.length).toBeGreaterThan(200);
    for (const group of INSERT_GROUPS) {
      const items = INSERT_SNIPPETS.filter((snippet) => snippet.group === group);
      expect(items.length, group).toBeGreaterThan(0);
      for (const snippet of items) {
        const label = typeof snippet.label === "string" ? snippet.label : snippet.label.message;
        expect(label?.trim(), snippet.id).not.toBe("");
        expect(snippet.detail.message?.trim(), snippet.id).not.toBe("");
        expect(snippet.insert.trim()).not.toBe("");
        expect(Boolean(snippet.glyph || snippet.mathPreview || snippet.codePreview)).toBe(true);
      }
    }
  });

  it("keeps snippet ids unique", () => {
    const ids = INSERT_SNIPPETS.map((snippet) => snippet.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("places the cursor at the first editable position in structured snippets", () => {
    const expectedCursorContexts: Record<string, [string, string]> = {
      "env-itemize": ["\\item ", "\n"],
      "env-enumerate": ["\\item ", "\n"],
      "env-algorithm": ["\\State ", "\n"],
      "env-minipage": ["\n  ", "\n\\end{minipage}"],
      "sec-cite": ["\\citep{", "}"],
      "sec-includegraphics": ["\\includegraphics[width=\\linewidth]{", "}"],
    };

    for (const [id, [before, after]] of Object.entries(expectedCursorContexts)) {
      const snippet = INSERT_SNIPPETS.find((item) => item.id === id);
      expect(snippet, id).toBeDefined();
      expect(snippet?.cursorOffset, id).toBeTypeOf("number");
      const cursor = snippet?.cursorOffset ?? 0;
      expect(snippet?.insert.slice(cursor - before.length, cursor), id).toBe(before);
      expect(snippet?.insert.slice(cursor, cursor + after.length), id).toBe(after);
    }
  });

  it("keeps the Sets group specific to set symbols", () => {
    const setCommands = INSERT_SNIPPETS
      .filter((snippet) => snippet.group === "Sets")
      .map((snippet) => snippet.insert);
    expect(setCommands).toEqual(["\\emptyset", "\\varnothing"]);
  });

  it("uses a baseline LaTeX degree expression instead of an undefined command", () => {
    const degree = INSERT_SNIPPETS.find((snippet) => snippet.id === "symbols-degree");
    expect(degree?.insert).toBe("^{\\circ}");
    expect(degree?.mathPreview).toBe("90^{\\circ}");
  });
});
