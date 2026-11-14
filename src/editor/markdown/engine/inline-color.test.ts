import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import { engineSchema } from "./engine-schema";
import { openMarkdown, serializeMarkdown } from "./markdown-document";

const schema = engineSchema();

function open(text: string) {
  const result = openMarkdown(text, schema);
  if ("unavailable" in result) throw new Error(result.unavailable);
  return result;
}

function render(doc: ReturnType<typeof open>["doc"]) {
  const element = document.createElement("div");
  element.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return element;
}

describe("editable Markdown text colors", () => {
  it.each([
    "RebeccaPurple", "#66339988", "RGB(50% 0% 3% / .4)", "rgba(31, 42, 53, .25)", "hsl(40 80% 75%)",
    "hsla(20, 50%, 15%, .4)", "oklch(65% 0.2 240)", "color(display-p3 0.8 0.1 0.2)",
    "color-mix(in srgb, red 35%, blue)", "hsl(from red h s calc(l - 10))", "currentColor", "transparent",
  ])("renders and round-trips the CSS color %s", (value) => {
    const source = `A <span style='color: ${value};'>review</span>.`;
    const { doc, baseline } = open(source);
    const expected = document.createElement("span").style;
    expected.color = value;
    expect(expected.color).not.toBe("");
    expect(render(doc).querySelector<HTMLElement>("p span")?.style.color).toBe(expected.color);
    const written = serializeMarkdown(EditorState.create({ doc }).tr.insertText("!", 5).doc, baseline);
    expect(written.verified).toBe(true);
    expect(written.text).toBe(source.replace("review", "re!view"));
  });

  it("keeps color spans as raw Markdown when no DOM color parser is available", () => {
    const source = 'A <span style="color: rebeccapurple">review</span>.';
    vi.stubGlobal("document", undefined);
    try {
      const { doc, baseline } = open(source);
      expect(doc.child(0).children.filter((node) => node.type.name === "latticeRawInline")).toHaveLength(2);
      expect(serializeMarkdown(doc, baseline).text).toBe(source);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads a case-insensitive colored span at the start of a paragraph as editable text", () => {
    const { doc } = open('<SPAN STYLE="COLOR: RED">Review</SPAN>');
    expect(render(doc).querySelector<HTMLElement>("p span")?.style.color).toBe("red");
  });

  it("renders color around styled text, links and math, and saves an edit inside the color", () => {
    const source = 'A <span style="color: blue">*label* and ~~old~~ [link](page) $x$</span> <span style="color: red;">note</span>.';
    const { doc, baseline } = open(source);
    const dom = render(doc);
    const colors = dom.querySelectorAll<HTMLElement>("span[style]");
    const colorAt = (selector: string) => {
      const node = dom.querySelector(selector);
      return (node?.closest<HTMLElement>("span[style]") ?? node?.querySelector<HTMLElement>("span[style]"))?.style.color;
    };
    expect(colorAt("em")).toBe("blue");
    expect(colorAt("s")).toBe("blue");
    expect(colorAt("a")).toBe("blue");
    expect(Array.from(colors).some((span) => span.style.color === "red" && span.textContent === "note")).toBe(true);
    const math = doc.child(0).children.find((node) => node.type.name === "latticeMath");
    expect(math?.marks.some((mark) => mark.attrs.color === "blue")).toBe(true);
    expect(serializeMarkdown(doc, baseline).text).toBe(source);
    const changed = EditorState.create({ doc }).tr.insertText("New ", 4).doc;
    const written = serializeMarkdown(changed, baseline);
    expect(written.verified).toBe(true);
    expect(written.text).toBe(source.replace("label", "lNew abel"));
    expect(render(open(written.text).doc).querySelector("em")?.textContent).toBe("lNew abel");
  });

  it("retains adjacent colors, spaces and tag spelling after DOM re-read and editing", () => {
    const source = "A <SPAN STYLE=' COLOR : #09F ; '> first </SPAN><span style='color:red'>next</span>.";
    const { doc, baseline } = open(source);
    const reread = DOMParser.fromSchema(schema).parse(render(doc), { preserveWhitespace: "full" });
    expect(reread.eq(doc)).toBe(true);
    const changed = EditorState.create({ doc: reread }).tr.insertText("!", 6).doc;
    const written = serializeMarkdown(changed, baseline);
    expect(written.verified).toBe(true);
    expect(written.text).toBe(source.replace("first", "fi!rst"));
  });

  it("preserves whitespace before the last closing span in an edited paragraph", () => {
    const source = 'A <span style="color: red">one </span>';
    const { doc, baseline } = open(source);
    const changed = EditorState.create({ doc }).tr.insertText("!", 2).doc;
    expect(serializeMarkdown(changed, baseline).text).toBe(source.replace("A ", "A! "));
  });

  it.each(["~~strike~~", "http://example.com"])("preserves colored %s when its neighbor changes", (content) => {
    const source = `Q <span style="color: red">${content}</span>post tail`;
    const { doc, baseline } = open(source);
    const changed = EditorState.create({ doc }).tr.insertText("!", 2).doc;
    const written = serializeMarkdown(changed, baseline);
    expect(written.verified).toBe(true);
    expect(written.text).toBe(source.replace("Q ", "Q! "));
  });

  it.each([
    '~~<span style="color:red"> foo</span>~~', '==<span style="color:red">bar </span>==',
    '*<span style="color:red">http://example.com</span>*',
  ])("preserves authored formatting around a colored run: %s", (content) => {
    const source = `Q ${content} tail`;
    const { doc, baseline } = open(source);
    const changed = EditorState.create({ doc }).tr.insertText("!", 2).doc;
    const written = serializeMarkdown(changed, baseline);
    expect(written.verified).toBe(true);
    expect(written.text).toBe(source.replace("Q ", "Q! "));
  });

  it("restores the outer color after a nested color", () => {
    const { doc, baseline } = open('Left <span style="color: blue">one<span style="color: red">two</span>three</span> right');
    const changed = EditorState.create({ doc }).tr.insertText("!", 8).doc;
    const written = serializeMarkdown(changed, baseline);
    expect(written.verified).toBe(true);
    const dom = render(open(written.text).doc);
    const texts = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
    const colored = [];
    while (texts.nextNode()) {
      const color = texts.currentNode.parentElement?.closest<HTMLElement>("span[style]")?.style.color;
      if (color) colored.push([texts.currentNode.textContent, color]);
    }
    expect(colored).toEqual([["on!e", "blue"], ["two", "red"], ["three", "blue"]]);
  });

  it.each(["currentColor", "color-mix(in srgb, currentColor 50%, blue)"])("keeps the inherited color context of %s", (color) => {
    const source = `A <span style="color:red">outer <span style="color:${color}">inner</span> end</span>.`;
    const { doc, baseline } = open(source);
    const dom = render(doc);
    expect(dom.querySelector("span[style] span[style]")?.textContent).toBe("inner");
    expect(DOMParser.fromSchema(schema).parse(dom).eq(doc)).toBe(true);
    const written = serializeMarkdown(EditorState.create({ doc }).tr.insertText("!", 2).doc, baseline);
    expect(written.verified).toBe(true);
    expect(written.text).toBe(source.replace("A ", "A! "));
  });

  it.each([
    '<span style="color: red; display: none">', '<span style="color: var(--x)">',
    '<span class="review" style="color: blue">', '<span style="color: url(image)">',
    '<span style="color: red" onclick="review()">', '<span style="color: #12345">',
    '<span style="color: not-a-color">', '<span style="color: inherit">', '<span style="color: red !important">',
  ])("keeps unsupported tags as raw source through editing: %s", (tag) => {
    const { doc, baseline } = open(`A ${tag}original</span>.`);
    expect(doc.child(0).children.filter((node) => node.type.name === "latticeRawInline")).toHaveLength(2);
    const changed = EditorState.create({ doc }).tr.insertText("B", 2).doc;
    expect(serializeMarkdown(changed, baseline).text).toBe(`AB ${tag}original</span>.`);
  });
});
