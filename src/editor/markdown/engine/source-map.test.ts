/**
 * The visual engine's source map (spec R-SRC-1–4, R-SRC-11): editor positions
 * against the host's text, both ways, from the R-SRC fixtures.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { engineSchema } from "./engine-schema";
import { openMarkdown, type OpenOptions } from "./markdown-document";
import { corpus } from "./corpus-test-utils";
import { SourceMap } from "./source-map";

const schema = engineSchema();

function mapOf(text: string, options: OpenOptions = {}) {
  const opened = openMarkdown(text, schema, options);
  if ("unavailable" in opened) throw new Error(opened.unavailable);
  return new SourceMap(opened.doc, opened.baseline, text);
}

/** The position `offset` characters into the first text node that is (or starts with) `text`. */
function inText(doc: PmNode, text: string, offset: number): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.startsWith(text)) found = pos + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

/** The innermost element-free description of where a position lands: its parent node and the text before it there. */
function landing(map: SourceMap, pos: number | null) {
  if (pos == null) return null;
  const $pos = map.doc.resolve(pos);
  return { parent: $pos.parent.type.name, before: $pos.parent.textBetween(0, $pos.parentOffset, "", "@") };
}

describe("caret to source (R-SRC-1)", () => {
  it.each([
    ["# Hello", "Hello", 2, [0, 4]],
    ["**bold**", "bold", 2, [0, 4]],
    ["**bold**\n\n- one\n- two 😀", "two 😀", "two 😀".length, [3, 8]],
    ["A\r\n\r\nB\r\n", "B", 1, [2, 1]],
    ['<Callout title="Exact">\n  Body\n</Callout>', "Body", 2, [1, 4]],
    ["> quoted **strong** text", "strong", 3, [0, 14]],
    ["1. first\n2. second item", "second", 3, [1, 6]],
    ["Escaped \\_under\\_ score", "Escaped _under_ score", 17, [0, 19]],
    ["Fish &amp; chips", "Fish & chips", 7, [0, 11]],
    ["```js\nconst value = 1\n```", "const", 5, [1, 5]],
  ] as const)("maps a caret in %j", (text, node, offset, expected) => {
    const map = mapOf(text);
    expect(map.positionToRowColumn(inText(map.doc, node, offset))).toEqual(expected);
  });

  it("gives offsets in the host's text, after a byte-order mark and in CRLF", () => {
    const text = "﻿Title\r\n\r\nSecond line";
    const map = mapOf(text);
    const offset = map.positionToOffset(inText(map.doc, "Second", 3));
    expect(offset).toBe(text.indexOf("Second") + 3);
    expect(map.offsetToPosition(offset!)).toBe(inText(map.doc, "Second", 3));
  });

  it("maps through escapes, and has no place inside an escape or an atom", () => {
    const text = "A \\*star\\* and $x^2$ here";
    const map = mapOf(text);
    const run = inText(map.doc, "A *star*", 0);
    expect(map.positionToOffset(run + 2)).toBe(2);
    expect(map.positionToOffset(run + 3)).toBe(4);
    expect(map.offsetToPosition(3)).toBeNull();
    expect(map.offsetToPosition(3, "forward")).toBe(run + 3);
    const math = text.indexOf("$x^2$");
    expect(map.offsetToPosition(math)).toBe(inText(map.doc, "A *star*", "A *star* and ".length));
    expect(map.offsetToPosition(math + 2)).toBeNull();
  });
});

describe("source to position (R-SRC-2, R-SRC-3)", () => {
  it("lands a heading cursor after the visible hash, not the heading's own marker", () => {
    const map = mapOf("# # Title");
    expect(landing(map, map.rowColumnToPosition(0, 3))).toEqual({ parent: "heading", before: "#" });
  });

  it("lands inside code, but never on a fence line", () => {
    const map = mapOf("```js\nconst value = 1\n```");
    expect(landing(map, map.rowColumnToPosition(1, 5))).toEqual({ parent: "codeBlock", before: "const" });
    expect(landing(map, map.rowColumnToPosition(1, 11))).toEqual({ parent: "codeBlock", before: "const value" });
    expect(map.rowColumnToPosition(0, 1)).toBeNull();
    expect(map.rowColumnToPosition(2, 1)).toBeNull();
  });

  it("never places a cursor inside an image atom", () => {
    expect(mapOf("![Alt](image.png)").rowColumnToPosition(0, 10)).toBeNull();
  });

  it("stays aligned after an inferred paper table and omits cells the inference merged", () => {
    const map = mapOf("| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n\nAfter table", { paperSpans: true });
    expect(landing(map, map.rowColumnToPosition(4, 5))).toEqual({ parent: "paragraph", before: "After" });
    expect(map.rowColumnToPosition(2, 12)).toBeNull();
  });

  it("maps list, quote and component content through their prefixes", () => {
    const map = mapOf("- one\n- two\n\n> quoted\n> more\n\n<Callout>\nInside\n</Callout>");
    expect(landing(map, map.rowColumnToPosition(1, 4))).toEqual({ parent: "paragraph", before: "tw" });
    expect(landing(map, map.rowColumnToPosition(4, 4))).toEqual({ parent: "paragraph", before: "quoted@mo" });
    expect(landing(map, map.rowColumnToPosition(7, 3))).toEqual({ parent: "paragraph", before: "Ins" });
    expect(map.rowColumnToPosition(6, 3)).toBeNull();
  });

  it("snaps a range end that falls on syntax to the nearest content when asked", () => {
    const map = mapOf("Some **bold** text");
    const star = "Some ".length;
    expect(map.offsetToPosition(star)).toBe(inText(map.doc, "Some ", 5));
    expect(map.offsetToPosition(star + 1)).toBeNull();
    expect(map.offsetToPosition(star + 1, "forward")).toBe(inText(map.doc, "bold", 0));
    expect(map.offsetToPosition(star + 1, "backward")).toBe(inText(map.doc, "Some ", 5));
  });
});

describe("table coordinates (R-SRC-4)", () => {
  const SIMPLE = "| Left | Right |\n| --- | --- |\n| A | B |";
  const cellAt = (map: SourceMap, row: number, column: number) => {
    const pos = map.rowColumnToPosition(row, column);
    if (pos == null) return null;
    const $pos = map.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth);
      if (String(node.type.spec.tableRole).includes("cell")) return { type: node.type.name, text: node.textContent, colspan: node.attrs.colspan as number };
    }
    return null;
  };

  it.each([
    ["the cell under a body cursor", SIMPLE, 2, 3, { type: "tableCell", text: "A" }],
    ["the header cell for a delimiter-row cursor", SIMPLE, 1, 3, { type: "tableHeader", text: "Left" }],
    ["the header cell below an escaped-pipe header", "| A \\| B | C |\n| --- | --- |\n| x | y |", 1, 3, { type: "tableHeader", text: "A | B" }],
    ["the header cell below an empty header", "| | Right |\n| --- | --- |\n| x | y |", 1, 3, { type: "tableHeader", text: "" }],
    ["the header cell of a one-column table", "| Only |\n| --- |\n| x |", 1, 3, { type: "tableHeader", text: "Only" }],
    ["a dash-only body row as a body row", "| Left | Right |\n| --- | --- |\n| --- | --- |", 2, 3, { type: "tableCell", text: "---" }],
  ])("anchors %s", (_label, text, row, column, expected) => {
    expect(cellAt(mapOf(text), row, column)).toMatchObject(expected);
  });

  it.each([3, 11])("maps an explicitly merged cell's source column %i to its origin", (column) => {
    const text = ['<!-- lattice-table-layout:v1 {"spans":[[0,0,1,2]]} -->', "", "| Group | Group | Metric |", "| --- | --- | --- |", "| A | B | 1 |"].join("\n");
    expect(cellAt(mapOf(text), 2, column)).toEqual({ type: "tableHeader", text: "Group", colspan: 2 });
  });

  it("maps a caret in a cell back to its source column", () => {
    const map = mapOf(SIMPLE);
    expect(map.positionToRowColumn(inText(map.doc, "B", 1))).toEqual([2, 7]);
    expect(map.positionToRowColumn(inText(map.doc, "Right", 2))).toEqual([0, 11]);
  });
});

describe("block labels (R-SRC-11)", () => {
  it("gives each block its 1-based line and text range", () => {
    const text = "# Heading\n\nFirst paragraph.\n\nTarget paragraph.";
    expect(mapOf(text).labels().map(({ line, from, to }) => ({ line, from, to }))).toEqual([
      { line: 1, from: 0, to: 9 },
      { line: 3, from: 11, to: 27 },
      { line: 5, from: text.indexOf("Target"), to: text.length },
    ]);
  });
});

describe("the corpus", () => {
  it.each(corpus)("places every mapped caret of %s on its own character, both ways", (name, text) => {
    const opened = openMarkdown(text, schema, { paperSpans: name.includes("paper") });
    if ("unavailable" in opened) return;
    const map = new SourceMap(opened.doc, opened.baseline, text);
    let mapped = 0;
    let checked = 0;
    opened.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const value = node.text ?? "";
      // Every position of short runs; a sample of long ones keeps the corpus fast.
      const step = Math.max(1, Math.floor(value.length / 24));
      for (let index = 0; index < value.length; index += step) {
        // Between the halves of a surrogate pair is no caret position.
        if (index > 0 && /[\uD800-\uDBFF]/.test(value[index - 1]!)) continue;
        checked += 1;
        const offset = map.positionToOffset(pos + index);
        if (offset == null) continue;
        mapped += 1;
        const char = text[offset];
        // The source shows the character itself, or the escape or reference that writes it.
        if (char !== value[index] && char !== "\\" && char !== "&" && !(value[index] === " " && /\s/.test(char ?? ""))) {
          throw new Error(`${name}: position ${pos + index} (${JSON.stringify(value.slice(index, index + 12))}) maps to ${JSON.stringify(text.slice(offset, offset + 12))}`);
        }
        expect(map.offsetToPosition(offset)).toBe(pos + index);
      }
    });
    // Almost all visible text has an exact place.
    if (checked > 50) expect(mapped / checked).toBeGreaterThan(0.9);
  });
});
