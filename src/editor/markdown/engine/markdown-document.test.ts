/** Clean implementation for Lattice; spec: docs/visual-editor-spec.md */
import { Fragment, Slice, type Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { engineSchema } from "./engine-schema";
import { openMarkdown, semanticKey, serializeMarkdown, type OpenedMarkdown } from "./markdown-document";

const schema = engineSchema();

function open(text: string): OpenedMarkdown {
  const opened = openMarkdown(text, schema);
  if ("unavailable" in opened) throw new Error(`unavailable: ${opened.unavailable}`);
  return opened;
}

/** Replace the text of top-level block `index` (a textblock) and serialize. */
function editBlockText(text: string, index: number, edit: (content: string) => string): string {
  const { doc, baseline } = open(text);
  const block = doc.child(index);
  const replacement = block.type.create(block.attrs, schema.text(edit(block.textContent)), block.marks);
  const next = doc.copy(doc.content.replaceChild(index, replacement));
  return serializeMarkdown(next, baseline).text;
}

const blockTypes = (doc: PmNode) => doc.children.map((node) => (
  node.type.name === "latticeRawBlock" ? `raw:${String(node.attrs.kind)}` : node.type.name
));

describe("Markdown round-trip core", () => {
  it.each([
    ["empty", ""],
    ["only newlines", "\n\n\n"],
    ["prose", "Hello *world*.\n"],
    ["no final newline", "# Title\n\nBody"],
    ["tight heading and list", "## Contents\n- one\n- two\n"],
    ["many blank lines", "a\n\n\n\nb\n\n\n"],
    ["escapes and references", "snake\\_case &amp; 5 \\* 3 &copy;\n"],
    ["setext and closed atx", "Title\n=====\n\n## Sub ##\n"],
    ["lists", "* a\n* b\n\n1) x\n2) y\n\n- [ ] task\n- [x] done\n"],
    ["code", "```ts title=\"a.ts\"\nconst a = 1;\n```\n\n~~~~\nraw\n~~~~\n\n    indented\n"],
    ["math", "Inline $x^2$ and $$y$$.\n\n$$\n\\int f\n$$\n"],
    ["tables", "| a | b |\n|:--|--:|\n| 1 | 2 |\n"],
    ["html and components", "<div>\nhi\n</div>\n\n<Callout type=\"note\" title=\"T\">\n\nBody\n\n</Callout>\n"],
    ["frontmatter", "---\ntitle: x\n---\n\n# Doc\n"],
    ["definitions", "See [the docs][d] and [^1].\n\n[d]: https://example.com\n[^1]: A note.\n"],
  ])("reproduces an untouched document exactly: %s", (_name, text) => {
    const { doc, baseline } = open(text);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it("keeps the BOM and CRLF envelope", () => {
    const text = "\uFEFF# Title\r\n\r\nBody\r\n";
    const { doc, baseline } = open(text);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(editBlockText(text, 1, () => "Changed")).toBe("\uFEFF# Title\r\n\r\nChanged\r\n");
  });

  it("declines mixed line endings instead of normalizing them", () => {
    expect(openMarkdown("a\r\nb\nc", schema)).toEqual({ unavailable: "mixed-line-endings" });
    expect(openMarkdown("a\rb", schema)).toEqual({ unavailable: "mixed-line-endings" });
  });

  it("models common blocks and keeps the rest raw", () => {
    const { doc } = open([
      "---\ntitle: x\n---",
      "# H",
      "Para",
      "> quote",
      "- a",
      "1. b",
      "- [ ] c",
      "```js\nx\n```",
      "***",
      "| a |\n|---|\n| 1 |",
      "$$\nx\n$$",
      "<div>html</div>",
      "<Callout>\n\nBody\n\n</Callout>",
      "[d]: https://example.com",
      "[^1]: note",
      "- [ ] mixed\n- plain",
    ].join("\n\n"));
    expect(blockTypes(doc)).toEqual([
      "raw:frontmatter", "heading", "paragraph", "blockquote", "bulletList", "orderedList", "taskList", "codeBlock",
      "horizontalRule", "table", "latticeMathBlock", "raw:html", "latticeComponent", "raw:definition", "latticeFootnote",
      "bulletList",
    ]);
  });

  it("models components written without blank lines, keeps unknown ones raw, and keeps converter anchors as invisible targets", () => {
    const { doc } = open("<Callout type=\"note\">\nBody\n</Callout>\n\n<Unknown>\nBody\n</Unknown>\n\n<a id=\"S3.F1\"></a>\n\n<div>x</div>\n");
    expect(blockTypes(doc)).toEqual(["latticeComponent", "raw:component", "raw:anchor", "raw:html"]);
  });

  it("re-serializes only the edited block and keeps tight neighbours tight", () => {
    const text = "## Contents\n- one\n- two\n\nTail paragraph\n";
    expect(editBlockText(text, 2, () => "Changed tail")).toBe("## Contents\n- one\n- two\n\nChanged tail\n");
    // An edited block next to a tight boundary gets a blank line: it must not merge.
    expect(editBlockText(text, 0, () => "Overview")).toBe("## Overview\n\n- one\n- two\n\nTail paragraph\n");
  });

  it("keeps authored escapes and markers in the unchanged runs of an edited paragraph", () => {
    const text = "Keep snake\\_case, _emphasis_ and __strong__ here.\n";
    const { doc, baseline } = open(text);
    const paragraph = doc.child(0);
    // Append text at the end of the paragraph, leaving the earlier runs untouched.
    const edited = paragraph.copy(paragraph.content.addToEnd(schema.text(" More.")));
    const next = doc.copy(doc.content.replaceChild(0, edited));
    expect(serializeMarkdown(next, baseline).text).toBe("Keep snake\\_case, _emphasis_ and __strong__ here. More.\n");
  });

  it.each([
    ["a link destination", "[a](https://x.test/?t=abc==)"],
    ["a link title", "[a](https://x.test \"x==y\")"],
  ])("keeps == and [[ unescaped in %s of an edited paragraph", (_name, source) => {
    const { doc, baseline } = open(`${source}\n`);
    const paragraph = doc.child(0);
    const edited = paragraph.copy(paragraph.content.addToEnd(schema.text(" More.")));
    const next = doc.copy(doc.content.replaceChild(0, edited));
    expect(serializeMarkdown(next, baseline).text).toBe(`${source} More.\n`);
  });

  it("keeps == unescaped in the alt text of a rewritten image", () => {
    const { doc, baseline } = open("![a==b](plot.png) tail\n");
    const paragraph = doc.child(0);
    const image = paragraph.child(0);
    const moved = image.type.create({ ...image.attrs, src: "figures/plot.png" }, null, image.marks);
    const next = doc.copy(doc.content.replaceChild(0, paragraph.copy(paragraph.content.replaceChild(0, moved))));
    expect(serializeMarkdown(next, baseline).text).toBe("![a==b](figures/plot.png) tail\n");
  });

  it("escapes new text that would otherwise read back as syntax", () => {
    expect(editBlockText("Plain\n", 0, () => "*not emphasis*")).toBe("\\*not emphasis\\*\n");
    expect(editBlockText("Plain\n", 0, () => "# not a heading")).toBe("\\# not a heading\n");
    expect(editBlockText("Plain\n", 0, () => "snake_case stays")).toBe("snake_case stays\n");
  });

  it("keeps prices as prose rather than inline math", () => {
    const { doc } = open("It costs $5 and $10 today.\n");
    expect(doc.child(0).textContent).toBe("It costs $5 and $10 today.");
  });

  it("writes an inserted block with a blank line and a deleted block without leftovers", () => {
    const text = "First\n\nSecond\n\nThird\n";
    const { doc, baseline } = open(text);
    const inserted = doc.copy(doc.content.addToEnd(schema.nodes.paragraph!.create(null, schema.text("Fourth"))));
    expect(serializeMarkdown(inserted, baseline).text).toBe("First\n\nSecond\n\nThird\n\nFourth\n");
    const removed = doc.copy(doc.content.cut(0, doc.child(0).nodeSize).append(doc.content.cut(doc.child(0).nodeSize + doc.child(1).nodeSize)));
    expect(serializeMarkdown(removed, baseline).text).toBe("First\n\nThird\n");
  });

  it("chains baselines across successive edits", () => {
    const text = "Alpha\n\n\n\nBeta\n";
    const first = open(text);
    const edited = first.doc.copy(first.doc.content.replaceChild(0, schema.nodes.paragraph!.create(null, schema.text("Alpha!"))));
    const once = serializeMarkdown(edited, first.baseline);
    expect(once.text).toBe("Alpha!\n\n\n\nBeta\n");
    expect(serializeMarkdown(edited, once.baseline).text).toBe(once.text);
  });
});

describe("bare URLs typed into the visual editor", () => {
  const urls = [
    "https://example.com",
    "http://example.com/path",
    "https://example.com/search?q=a+b&lang=en#top",
    "https://en.wikipedia.org/wiki/Set_(mathematics)",
    "https://example.com/a_b*c*~d~",
    "www.example.com",
    "mailto:someone@example.com",
    "someone@example.com",
  ];
  const surroundings = [
    ["alone", (url: string) => url],
    ["inside prose", (url: string) => `See ${url} for details`],
    ["in parentheses", (url: string) => `(see ${url})`],
    ["before a full stop", (url: string) => `Visit ${url}.`],
    ["before a comma and a question mark", (url: string) => `Is it ${url}, or ${url}?`],
  ] as const;

  /** Type `typed` as plain text into block `index` of `text` (a textblock, or a list/table holding one) and save. */
  function typeInto(text: string, typed: string) {
    const { doc, baseline } = open(text);
    let next = doc;
    doc.descendants((node, position) => {
      if (next !== doc || !node.isTextblock || node.textContent !== "x") return;
      next = doc.replace(position + 1, position + node.nodeSize - 1, new Slice(Fragment.from(schema.text(typed)), 0, 0));
    });
    expect(next).not.toBe(doc);
    return { edited: next, written: serializeMarkdown(next, baseline) };
  }

  describe.each(surroundings)("%s", (_name, around) => {
    it.each(urls)("writes %s as typed and reopens it as normal text", (url) => {
      const typed = around(url);
      for (const [container, text, expected] of [
        ["paragraph", "x\n", `${typed}\n`],
        ["list item", "- x\n", `- ${typed}\n`],
        ["table cell", "| a |\n| --- |\n| x |\n", `| a |\n| --- |\n| ${typed} |\n`],
      ] as const) {
        const { edited, written } = typeInto(text, typed);
        expect(written.text, container).toBe(expected);
        expect(written.verified, container).toBe(true);
        const reopened = open(written.text);
        expect(blockTypes(reopened.doc), container).toEqual(blockTypes(edited));
        expect(reopened.doc.textContent, container).toBe(edited.textContent);
        expect(semanticKey(reopened.doc.children), container).toBe(semanticKey(edited.children));
        // Reopened, the URL is a GFM autolink; saving it again changes nothing.
        expect(serializeMarkdown(reopened.doc, reopened.baseline).text, container).toBe(written.text);
      }
    });
  });

  it("keeps a reopened autolink's bytes when the paragraph around it is edited", () => {
    const text = "See https://example.com/a_b and someone@example.com\n";
    expect(editBlockText(text, 0, (content) => `${content}.`)).toBe("See https://example.com/a_b and someone@example.com.\n");
    const { doc, baseline } = open(text);
    const paragraph = doc.child(0);
    const edited = paragraph.copy(paragraph.content.addToEnd(schema.text(" More.")));
    expect(serializeMarkdown(doc.copy(doc.content.replaceChild(0, edited)), baseline).text).toBe("See https://example.com/a_b and someone@example.com More.\n");
  });

  it.each([
    ["emphasis", "*star* https://example.com/a_b", "\\*star\\* https://example.com/a_b"],
    ["a heading marker", "# https://example.com/a_b", "\\# https://example.com/a_b"],
    ["a wiki link", "[[Page]] then www.example.com/x_y", "\\[\\[Page]] then www.example.com/x_y"],
    ["an email", "*a* someone@example.com", "\\*a\\* someone@example.com"],
  ])("escapes %s beside a URL without escaping the URL", (_name, typed, expected) => {
    const { written } = typeInto("x\n", typed);
    expect(written.text).toBe(`${expected}\n`);
    expect(written.verified).toBe(true);
    expect(open(written.text).doc.textContent).toBe(typed);
  });

  it.each([
    ["a pipe in a table cell", "| a |\n| --- |\n| x |\n", "https://a.com/x|y"],
    ["two URLs split by a pipe in a table cell", "| a |\n| --- |\n| x |\n", "https://a.com|https://b.com"],
    ["a character reference", "x\n", "https://a.com/?a=1&copy;x"],
    ["a backslash before punctuation", "x\n", "https://a.com/\\*x"],
    ["a closing bracket in a paragraph", "x\n", "https://a.com/a]b"],
  ])("escapes %s inside a URL so it reads back as shown", (_name, text, typed) => {
    const { edited, written } = typeInto(text, typed);
    expect(written.verified).toBe(true);
    const reopened = open(written.text);
    expect(blockTypes(reopened.doc)).toEqual(blockTypes(edited));
    expect(reopened.doc.textContent).toBe(edited.textContent);
  });

  it("escapes a closing bracket of a URL typed as link text", () => {
    const { doc, baseline } = open("x\n");
    const typed = "https://x.com/a]";
    const link = schema.text(typed, [schema.marks.link!.create({ href: "https://example.org" })]);
    const next = doc.copy(doc.content.replaceChild(0, schema.nodes.paragraph!.create(null, link)));
    const written = serializeMarkdown(next, baseline);
    expect(written.verified).toBe(true);
    expect(open(written.text).doc.textContent).toBe(typed);
  });

  it("still escapes text that only looks like a URL", () => {
    // Not an autolink start: GFM needs whitespace, `*`, `_`, `~` or `(` before it.
    expect(editBlockText("Plain\n", 0, () => "*x*https://example.com")).toBe("\\*x\\*https://example.com\n");
    expect(editBlockText("Plain\n", 0, () => "snake_case https://example.com")).toBe("snake_case https://example.com\n");
  });
});

describe("files saved with escaped bare URLs", () => {
  const linkOf = (node: PmNode) => {
    const links: { text: string; href: unknown }[] = [];
    node.descendants((child) => {
      const link = child.marks.find((mark) => mark.type.name === "link");
      if (child.isText && link) links.push({ text: child.text!, href: link.attrs.href });
    });
    return links;
  };

  it.each([
    ["a paragraph", "See https\\://example.com/a\\_b now\n", "paragraph", "See https://example.com/a_b now", "https://example.com/a_b"],
    ["a heading", "# Go to https\\://example.com\n", "heading", "Go to https://example.com", "https://example.com"],
    ["a list item", "- mail foo\\@example.com\n", "bulletList", "mail foo@example.com", "mailto:foo@example.com"],
    ["a blockquote", "> *x* www\\.example.com.\n", "blockquote", "x www.example.com.", "http://www.example.com"],
    ["a table cell", "| a |\n| --- |\n| https\\://example.com?q=1 |\n", "table", "ahttps://example.com?q=1", "https://example.com?q=1"],
  ])("opens %s as visual text with a link and keeps it byte for byte", (_name, text, kind, shown, href) => {
    const { doc, baseline } = open(text);
    expect(blockTypes(doc)).toEqual([kind]);
    expect(doc.textContent).toBe(shown);
    expect(linkOf(doc).map((link) => link.href)).toEqual([href]);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it("writes an edited paragraph without the stray backslashes", () => {
    const text = "Keep\n\nSee https\\://example.com and foo\\@example.com\n";
    const written = editBlockText(text, 1, (content) => `${content} now`);
    expect(written).toBe("Keep\n\nSee https://example.com and foo@example.com now\n");
    const reopened = open(written);
    expect(linkOf(reopened.doc).map((link) => link.href)).toEqual(["https://example.com", "mailto:foo@example.com"]);
    expect(serializeMarkdown(reopened.doc, reopened.baseline).text).toBe(written);
  });

  it("keeps other authored escapes in the unchanged runs of that paragraph", () => {
    const { doc, baseline } = open("snake\\_case https\\://example.com\n");
    const paragraph = doc.child(0);
    const edited = paragraph.copy(paragraph.content.addToEnd(schema.text(" More.")));
    expect(serializeMarkdown(doc.copy(doc.content.replaceChild(0, edited)), baseline).text).toBe("snake\\_case https://example.com More.\n");
  });
});

describe("seams next to an edit", () => {
  const bulletList = (...items: string[]) => schema.nodes.bulletList!.create(null, items.map((item) => (
    schema.nodes.listItem!.create(null, schema.nodes.paragraph!.create(null, schema.text(item)))
  )));

  /** Serialize `next`, then check it reads back as the blocks the editor shows. */
  function expectReadsBackAsShown(next: PmNode, baseline: OpenedMarkdown["baseline"]): string {
    const written = serializeMarkdown(next, baseline);
    expect(written.verified).toBe(true);
    expect(semanticKey(open(written.text).doc.children)).toBe(semanticKey(next.children));
    return written.text;
  }

  it("keeps two lists apart when the paragraph between them is deleted", () => {
    const { doc, baseline } = open("- a\n\nPara\n\n- b\n");
    const next = doc.copy(doc.content.cut(0, doc.child(0).nodeSize).append(doc.content.cut(doc.child(0).nodeSize + doc.child(1).nodeSize)));
    expect(blockTypes(open(expectReadsBackAsShown(next, baseline)).doc)).toEqual(["bulletList", "bulletList"]);
  });

  it("keeps an untouched tight list apart from a list inserted above it", () => {
    const { doc, baseline } = open("Intro\n\n- x\n- y\n");
    const next = doc.copy(doc.content.cut(0, doc.child(0).nodeSize).addToEnd(bulletList("new")).append(doc.content.cut(doc.child(0).nodeSize)));
    const text = expectReadsBackAsShown(next, baseline);
    expect(text.startsWith("Intro\n\n")).toBe(true);
    expect(blockTypes(open(text).doc)).toEqual(["paragraph", "bulletList", "bulletList"]);
  });

  it("keeps an untouched indented code block out of a list it now follows", () => {
    const { doc, baseline } = open("Para\n\n    code\n");
    const next = doc.copy(doc.content.replaceChild(0, bulletList("Para")));
    expect(blockTypes(open(expectReadsBackAsShown(next, baseline)).doc)).toEqual(["bulletList", "codeBlock"]);
  });

  it.each([
    ["two lists", "- a\n\nPara\n- b\n", ["bulletList", "paragraph", "bulletList"]],
    ["an HTML block and a heading", "<div>x</div>\n\nPara\n# H\n", ["raw:html", "paragraph", "heading"]],
  ])("keeps %s apart when the paragraph between them is emptied", (_name, text, kinds) => {
    const { doc, baseline } = open(text);
    expect(blockTypes(doc)).toEqual(kinds);
    const next = doc.copy(doc.content.replaceChild(1, schema.nodes.paragraph!.create()));
    const written = expectReadsBackAsShown(next, baseline);
    expect(blockTypes(open(written).doc)).toEqual([kinds[0], kinds[2]]);
  });

  it("keeps every byte when an empty paragraph is inserted", () => {
    const text = "## Contents\n- one\n";
    const { doc, baseline } = open(text);
    const next = doc.copy(doc.content.cut(0, doc.child(0).nodeSize).addToEnd(schema.nodes.paragraph!.create()).append(doc.content.cut(doc.child(0).nodeSize)));
    expect(serializeMarkdown(next, baseline).text).toBe(text);
  });

  it("keeps the authored bytes of neighbours a seam does not merge", () => {
    const text = "# Title\n\nFirst\n\nSecond\n";
    const { doc, baseline } = open(text);
    const next = doc.copy(doc.content.cut(0, doc.child(0).nodeSize).append(doc.content.cut(doc.child(0).nodeSize + doc.child(1).nodeSize)));
    expect(serializeMarkdown(next, baseline).text).toBe("# Title\n\nSecond\n");
  });
});

describe("syntax next to an edit (spec R-RT-12)", () => {
  it.each([
    "Editable\n\n````text\n```\n````",
    "Editable\n\n~~~text\n```\n~~~",
    "Editable\n\n~~~~MerMaid\ngraph TD; A-->B\n~~~~~",
    "Editable\n\n````mermaid title=flow\ngraph TD; A-->B\n`````",
    "Editable paragraph\n\nRead [Results][paper].\n\n[paper]: results.md \"Title\"",
    "Editable paragraph\n\nPress <kbd class=\"key\">&copy;</kbd> now.",
    "Editable paragraph\n\nCode <script>a && b</script> after.",
    "Editable paragraph\n\nCopyright &copy; 2026.",
    "Editable paragraph\n\n<aside data-kind=\"note\">Exact HTML</aside>",
    "Editable\n\nBefore\n<kbd>Ctrl</kbd>\nAfter",
    "Before ![Plot](<../figures/my plot.png> \"Results\") after",
    "Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$ here.",
    "Intro paragraph.\n\n\\[\nE=mc^2\n\\]\n\nInline \\(x_i\\) math.",
    "Editable\n\nThe result is \\(x^2\\).",
    "Editable\n\n\\[\nx^2 + y^2\n\\]",
    "Editable paragraph\n\nThe value is $x + y$.\n\n```MerMaid\ngraph TD; A-->B\n```\n\n[^note]: Keep  two spaces",
  ])("keeps %j exactly when its first paragraph is edited", (text) => {
    const { doc, baseline } = open(text);
    const first = doc.child(0);
    const edited = first.copy(first.content.addToStart(schema.text("Updated ")));
    expect(serializeMarkdown(doc.copy(doc.content.replaceChild(0, edited)), baseline).text).toBe(`Updated ${text}`);
  });
});
