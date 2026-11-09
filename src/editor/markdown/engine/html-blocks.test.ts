/**
 * HTML split across CommonMark blocks reads as one raw HTML block, and the
 * file is written back byte for byte (R-BLK-16, R-RT-17).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { describe, expect, it } from "vitest";
import { engineSchema } from "./engine-schema";
import { openMarkdown, serializeMarkdown, type OpenedMarkdown } from "./markdown-document";

const schema = engineSchema();

function open(text: string): OpenedMarkdown {
  const opened = openMarkdown(text, schema);
  if ("unavailable" in opened) throw new Error(`unavailable: ${opened.unavailable}`);
  return opened;
}

const blocks = (text: string) => open(text).doc.children.map((node) => (
  node.type.name === "latticeRawBlock" ? `raw:${String(node.attrs.kind)}` : node.type.name
));

/** The diagram from the report: an SVG figure wrapped in a <div>, blank lines around it. */
const FIGURE = `Fig. 1 shows the pipeline.

<div>

<svg xmlns="http://www.w3.org/2000/svg" width="790" height="312" viewBox="0 0 790 312" font-family="Helvetica, Arial, sans-serif">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#333"/></marker>
  </defs>
  <rect x="20" y="40" width="180" height="80" rx="8" fill="#eef4ff" stroke="#3b6fd8"/>
  <text x="110" y="85" text-anchor="middle" font-size="16">Encoder</text>
  <line x1="200" y1="80" x2="300" y2="80" stroke="#333" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="300" y="40" width="180" height="80" rx="8" fill="#fff4e5" stroke="#d8893b"/>
  <text x="390" y="85" text-anchor="middle" font-size="16">Decoder</text>
</svg>

</div>

After the figure.
`;

describe("HTML across blocks", () => {
  it("reads a <div> around an SVG, blank lines and all, as one HTML block", () => {
    const { doc } = open(FIGURE);
    expect(blocks(FIGURE)).toEqual(["paragraph", "raw:html", "paragraph"]);
    const html = doc.child(1).textContent;
    expect(html.startsWith("<div>\n\n<svg")).toBe(true);
    expect(html.endsWith("</svg>\n\n</div>")).toBe(true);
  });

  it("writes the file back byte for byte, untouched and after an edit elsewhere", () => {
    const { doc, baseline } = open(FIGURE);
    expect(serializeMarkdown(doc, baseline).text).toBe(FIGURE);
    const last = doc.childCount - 1;
    const edited = doc.copy(doc.content.replaceChild(last, doc.child(last).type.create(null, schema.text("After the drawing."))));
    expect(serializeMarkdown(edited, baseline).text).toBe(FIGURE.replace("After the figure.", "After the drawing."));
  });

  it("keeps an edited HTML block's source exactly as typed", () => {
    const { doc, baseline } = open(FIGURE);
    const block = doc.child(1);
    const source = block.textContent.replace("Encoder", "Tokenizer");
    const edited = doc.copy(doc.content.replaceChild(1, block.type.create(block.attrs, schema.text(source))));
    expect(serializeMarkdown(edited, baseline).text).toBe(FIGURE.replace("Encoder", "Tokenizer"));
  });

  it.each([
    ["a one-line SVG in a <div>", "<div>\n\n<svg width=\"9\" height=\"9\"><rect width=\"5\" height=\"5\"/><text x=\"1\" y=\"8\">A</text></svg>\n\n</div>\n"],
    ["nested <div>s", "<div>\n\n<div>\n\n<svg width=\"9\" height=\"9\"></svg>\n\n</div>\n\n</div>\n"],
    ["an attribute holding >", "<div title=\"a > b\">\n\n<svg width=\"9\" height=\"9\"></svg>\n\n</div>\n"],
  ])("takes %s whole", (_label, text) => {
    expect(blocks(text)).toEqual(["raw:html"]);
    const { doc, baseline } = open(text);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it("reads a paragraph that is one SVG element as HTML, not inline chips", () => {
    const text = "<svg width=\"20\" height=\"20\"><circle cx=\"10\" cy=\"10\" r=\"8\"/></svg>\n";
    expect(blocks(text)).toEqual(["raw:html"]);
    const { doc, baseline } = open(text);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it.each([
    ["Markdown between the tags", "<div>\n\n**Bold** prose.\n\n</div>\n", ["raw:html", "paragraph", "raw:html"]],
    ["an unclosed element", "<div>\n\nText after.\n", ["raw:html", "paragraph"]],
    ["inline HTML in prose", "Press <kbd>Ctrl</kbd> + <kbd>C</kbd>.\n", ["paragraph"]],
    ["an SVG followed by prose", "<svg width=\"9\" height=\"9\"></svg> and text\n", ["paragraph"]],
    ["a closing tag mid-line", "<div>\n\n<svg width=\"9\" height=\"9\"></svg>\n\n</div> trailing\n", ["raw:html", "raw:html", "raw:html"]],
  ])("leaves %s as separate blocks", (_label, text, expected) => {
    expect(blocks(text)).toEqual(expected);
    const { doc, baseline } = open(text);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });
});
