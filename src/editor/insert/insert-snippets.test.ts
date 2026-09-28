import { describe, expect, it } from "vitest";
import { INSERT_GROUPS, INSERT_SNIPPETS } from "./insert-snippets";

describe("insert snippets", () => {
  it("covers every advertised group with uniquely identified, labeled previews", () => {
    expect(INSERT_SNIPPETS.length).toBeGreaterThan(200);
    const ids = INSERT_SNIPPETS.map((snippet) => snippet.id);
    expect(new Set(ids).size).toBe(ids.length);
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

  it("places the cursor at the first editable position in structured snippets", () => {
    const expectedCursorContexts: Record<string, [string, string]> = {
      "env-itemize": ["\\item ", "\n"],
      "env-enumerate": ["\\item ", "\n"],
      "env-algorithm": ["\\State ", "\n"],
      "env-minipage": ["\n  ", "\n\\end{minipage}"],
      "sec-cite": ["\\citep{", "}"],
      "sec-includegraphics": ["\\includegraphics[width=\\linewidth]{", "}"],
      "accents-hat{}": ["\\hat{", "}"],
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

  it("keeps the Sets group to set symbols and the degree symbol a baseline LaTeX expression", () => {
    const setCommands = INSERT_SNIPPETS
      .filter((snippet) => snippet.group === "Sets")
      .map((snippet) => snippet.insert);
    expect(setCommands).toEqual(["\\emptyset", "\\varnothing"]);
    // Not an undefined command.
    const degree = INSERT_SNIPPETS.find((snippet) => snippet.glyph === "°");
    expect(degree).toMatchObject({ group: "Symbols", insert: "^{\\circ}", mathPreview: "90^{\\circ}" });
  });
});
