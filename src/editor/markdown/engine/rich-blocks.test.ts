/**
 * Rich blocks in the round-trip core: components, footnotes, LaTeX math,
 * merged table cells, HTML images and fences, read and written without the
 * editor (spec R-BLK, R-FMT, R-RT-20/21).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Fragment, Slice, type Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { engineSchema } from "./engine-schema";
import { openMarkdown, semanticKey, serializeMarkdown, type OpenedMarkdown, type OpenOptions } from "./markdown-document";

const schema = engineSchema();
const PAPER: OpenOptions = { paperSpans: true };

function open(text: string, options: OpenOptions = {}): OpenedMarkdown {
  const opened = openMarkdown(text, schema, options);
  if ("unavailable" in opened) throw new Error(`unavailable: ${opened.unavailable}`);
  return opened;
}

/** Position and node of the first descendant matching `match`. */
function find(doc: PmNode, match: (node: PmNode) => boolean): { node: PmNode; pos: number } {
  let found: { node: PmNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (!found && match(node)) found = { node, pos };
    return !found;
  });
  if (!found) throw new Error("no such node");
  return found;
}

const textNode = (value: string) => (node: PmNode) => node.isText && node.text === value;

/** Open `text`, apply `edit` to its document, and write it back. */
function edited(text: string, edit: (doc: PmNode) => PmNode, options: OpenOptions = {}): string {
  const { doc, baseline } = open(text, options);
  const next = edit(doc);
  const written = serializeMarkdown(next, baseline);
  expect(written.verified).toBe(true);
  expect(semanticKey(open(written.text, options).doc.children)).toBe(semanticKey(next.children));
  return written.text;
}

/** Insert `insert` at the start of the text node reading `at`. */
const insertBefore = (at: string, insert: string) => (doc: PmNode) => {
  const { node, pos } = find(doc, textNode(at));
  return doc.replace(pos, pos, new Slice(Fragment.from(schema.text(insert, node.marks)), 0, 0));
};

const setAttrs = (match: (node: PmNode) => boolean, attrs: Record<string, unknown>) => (doc: PmNode) => {
  const { node, pos } = find(doc, match);
  const replacement = node.type.create({ ...node.attrs, ...attrs }, node.content, node.marks);
  return doc.replace(pos, pos + node.nodeSize, new Slice(Fragment.from(replacement), 0, 0));
};

const isType = (name: string) => (node: PmNode) => node.type.name === name;

describe("components (R-BLK-1, R-BLK-2, R-FMT-5, R-FMT-6)", () => {
  it("reads a Callout's body as Markdown and keeps its bytes until it changes", () => {
    const text = "<Callout title=\"Exact\">\nText with **bold**.\n</Callout>";
    const { doc, baseline } = open(text);
    const callout = doc.child(0);
    expect(callout.type.name).toBe("latticeComponent");
    expect(callout.attrs.name).toBe("Callout");
    expect(callout.attrs.props).toEqual([{ name: "title", kind: "string", value: "Exact" }]);
    expect(find(doc, textNode("bold")).node.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(edited(text, insertBefore("Text with ", "Edited "))).toBe("<Callout title=\"Exact\">\nEdited Text with **bold**.\n</Callout>");
  });

  it("writes a changed property, and a string with & or quotes as a JSX expression", () => {
    const text = "<Callout title=\"Exact\">\nText with **bold**.\n</Callout>";
    const changed = edited(text, setAttrs(isType("latticeComponent"), {
      props: [{ name: "title", kind: "string", value: "Changed & quoted \"title\"" }],
    }));
    expect(changed).toBe("<Callout title={\"Changed & quoted \\\"title\\\"\"}>\nText with **bold**.\n</Callout>");
    expect(open(changed).doc.child(0).attrs.props).toEqual([{ name: "title", kind: "string", value: "Changed & quoted \"title\"" }]);
  });

  it("writes the slash Callout exactly (R-FMT-2)", () => {
    const { baseline } = open("");
    const callout = schema.nodes.latticeComponent!.create({
      name: "Callout",
      props: [
        { name: "type", kind: "string", value: "note" },
        { name: "collapsible", kind: "boolean", value: false },
        { name: "defaultOpen", kind: "boolean", value: true },
      ],
    }, schema.nodes.paragraph!.create());
    const written = serializeMarkdown(schema.nodes.doc!.create(null, callout), baseline).text;
    expect(written).toBe("<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>");
    expect(open(written).doc.child(0).attrs.name).toBe("Callout");
  });

  it("reads an Accordion with a list and code in its body", () => {
    const text = "<Accordion title=\"Details\" defaultOpen>\nA paragraph with **formatted text**.\n\n- First item\n- Second item\n\n```ts\nconst scale = Math.sqrt(64);\n```\n</Accordion>";
    const { doc, baseline } = open(text);
    const accordion = doc.child(0);
    expect(accordion.attrs.name).toBe("Accordion");
    expect(accordion.children.map((node) => node.type.name)).toEqual(["paragraph", "bulletList", "codeBlock"]);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(edited(text, insertBefore("First item", "The "))).toBe(text.replace("- First item", "- The First item"));
  });

  it("keeps the tutorial's components and a nested component byte for byte", () => {
    const text = [
      "<Callout type=\"important\" title=\"Attention maps need validation\">",
      "Attention weights show routing patterns, but they do not establish causality.",
      "</Callout>",
      "",
      "<Accordion title=\"Why scale attention scores?\" defaultOpen>",
      "Scaling keeps the softmax distribution and its gradients well behaved.",
      "",
      "<Callout type=\"note\">",
      "",
      "Nested *note*.",
      "",
      "</Callout>",
      "</Accordion>",
      "",
    ].join("\n");
    const { doc, baseline } = open(text);
    expect(doc.children.map((node) => node.attrs.name)).toEqual(["Callout", "Accordion"]);
    expect(doc.child(1).lastChild?.attrs.name).toBe("Callout");
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(edited(text, insertBefore("Nested ", "A "))).toBe(text.replace("Nested *note*", "A Nested *note*"));
  });

  it("keeps unknown and expression-carrying components as their exact source (R-RT-17)", () => {
    const text = "<UnknownOne>\nFirst body.\n</UnknownOne>\n\n<UnknownTwo mode=\"wide\">\nSecond body.\n</UnknownTwo>\n\n<UnknownThree />\n\n<Callout title={props.title}>\nBody\n</Callout>\n\nFollowing bytes stay here.\n";
    const { doc, baseline } = open(text);
    expect(doc.children.map((node) => (node.type.name === "latticeRawBlock" ? String(node.attrs.kind) : node.type.name)))
      .toEqual(["component", "component", "component", "component", "paragraph"]);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it("migrates a legacy callout fence to MDX only once it is edited (R-FMT-6)", () => {
    const text = "```rw-component callout\n{\"title\":\"Legacy\",\"content\":\"Kept\"}\n```";
    const { doc, baseline } = open(text);
    expect(doc.child(0).attrs).toMatchObject({ name: "Callout", props: [{ name: "title", kind: "string", value: "Legacy" }] });
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    const migrated = edited(text, setAttrs(isType("latticeComponent"), { props: [{ name: "title", kind: "string", value: "Migrated" }] }));
    expect(migrated).toBe("<Callout title=\"Migrated\">\n\nKept\n\n</Callout>");
  });

  it("keeps a legacy fence that is not a JSON object as a code block", () => {
    const { doc } = open("```rw-component callout\nnot json\n```");
    expect(doc.child(0).type.name).toBe("codeBlock");
  });

  it("reads converter paper figures and keeps the structure when a caption is edited (R-BLK-15)", () => {
    const text = [
      "<PaperFigure id=\"S2.F1\">", "", "<PaperFigureRow columns=\"3 3 3\">", "",
      "<PaperFigurePanel id=\"S2.F1.placeholder\">", "</PaperFigurePanel>", "",
      "<PaperFigurePanel id=\"S2.F1.sf1\">", "", "![First panel](paper_assets/first.webp)", "", "*(a) Swiss Roll*", "", "</PaperFigurePanel>", "",
      "</PaperFigureRow>", "", "*Figure 1: Manifold examples.*", "", "</PaperFigure>",
    ].join("\n");
    const { doc, baseline } = open(text);
    const figure = doc.child(0);
    expect(figure.attrs.name).toBe("PaperFigure");
    const row = figure.child(0);
    expect(row.attrs.name).toBe("PaperFigureRow");
    expect(row.children.map((node) => node.attrs.name)).toEqual(["PaperFigurePanel", "PaperFigurePanel"]);
    expect(row.child(0).childCount).toBe(0);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(edited(text, insertBefore("(a) Swiss Roll", "Updated "))).toBe(text.replace("*(a) Swiss Roll*", "*Updated (a) Swiss Roll*"));
  });
});

describe("footnotes (R-BLK-6, R-RT-20)", () => {
  it("edits a multi-paragraph definition in place and keeps its indentation", () => {
    const text = "Evidence[^source].\n\n[^source]: Supporting **result**.\n\n    Second **paragraph**.";
    const { doc } = open(text);
    expect(find(doc, isType("latticeFootnoteReference")).node.attrs.label).toBe("source");
    const definition = find(doc, isType("latticeFootnote")).node;
    expect(definition.childCount).toBe(2);
    expect(edited(text, insertBefore("Supporting ", "Extra "))).toBe("Evidence[^source].\n\n[^source]: Extra Supporting **result**.\n\n    Second **paragraph**.");
  });

  it("keeps a double space in an untouched definition next to an edit (R-RT-13)", () => {
    const text = "Editable paragraph\n\nThe value is $x + y$.\n\n```MerMaid\ngraph TD; A-->B\n```\n\n[^note]: Keep  two spaces";
    expect(edited(text, insertBefore("Editable paragraph", "Updated "))).toBe(`Updated ${text}`);
  });
});

describe("LaTeX math (R-RT-21, R-FMT-12)", () => {
  it("reads display and inline LaTeX delimiters as formulas with their exact source", () => {
    const text = "Before text.\n\n\\[\n\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k\n\\]\n\nAfter \\(f_S^{\\ell}\\) math.\n";
    const { doc, baseline } = open(text);
    expect(doc.children.map((node) => node.type.name)).toEqual(["paragraph", "latticeMathBlock", "paragraph"]);
    expect(doc.child(1).attrs.tex).toBe("\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k");
    expect(find(doc, isType("latticeMath")).node.attrs.tex).toBe("f_S^{\\ell}");
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(edited(text, insertBefore("Before text.", "Updated "))).toBe(`Updated ${text}`);
  });

  it("reads a single-line \\[…\\] paragraph as a formula and keeps it", () => {
    const { doc, baseline } = open("\\[E=mc^2\\]\n");
    expect(find(doc, isType("latticeMath")).node.attrs.tex).toBe("E=mc^2");
    expect(serializeMarkdown(doc, baseline).text).toBe("\\[E=mc^2\\]\n");
  });

  it("keeps escaped-bracket prose with a \\] inside it as prose", () => {
    const text = "\\[1\\] Smith et al., see also \\[2\\]\n";
    const { doc, baseline } = open(text);
    expect(() => find(doc, isType("latticeMath"))).toThrow();
    expect(doc.textContent).toBe("[1] Smith et al., see also [2]");
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it("pairs several inline spans across what would read as emphasis", () => {
    const text = "\\(\\mathrm{supp}_{\\mathrm{par}}\\) 问的是「**哪些权重被编辑**」；\\(\\mathrm{supp}_{\\mathrm{tea}}\\) 问的是「**哪些特征被监督**」。\n";
    const { doc, baseline } = open(text);
    const formulas: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === "latticeMath") formulas.push(String(node.attrs.tex));
    });
    expect(formulas).toEqual(["\\mathrm{supp}_{\\mathrm{par}}", "\\mathrm{supp}_{\\mathrm{tea}}"]);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    expect(edited(text, insertBefore(" 问的是「", "!"))).toBe(text.replace("\\) 问的是「**哪些权重", "\\)! 问的是「**哪些权重"));
  });

  it("keeps LaTeX delimiters inside a code fence as code", () => {
    const { doc } = open("```latex\n\\[\nE=mc^2\n\\]\n```\n");
    expect(doc.children.map((node) => node.type.name)).toEqual(["codeBlock"]);
  });

  it("writes an edited inline formula with dollars, whatever it was written with", () => {
    for (const source of ["The result is $x^2$.", "The result is \\(x^2\\)."]) {
      expect(edited(source, setAttrs(isType("latticeMath"), { tex: "y^3" }))).toBe("The result is $y^3$.");
    }
  });

  it("writes an edited display formula as display math in its own delimiters", () => {
    expect(edited("Intro\n\n\\[\nx^2\n\\]\n", setAttrs(isType("latticeMathBlock"), { tex: "y^3" }))).toBe("Intro\n\n\\[\ny^3\n\\]\n");
    expect(edited("Intro\n\n$$\nx^2\n$$\n", setAttrs(isType("latticeMathBlock"), { tex: "y^3" }))).toBe("Intro\n\n$$\ny^3\n$$\n");
    expect(edited("\\[x\\]\n", setAttrs(isType("latticeMath"), { tex: "y" }))).toBe("\\[y\\]\n");
  });

  it("writes an edited single-line \\[…\\] formula that no longer fits one line as a display block", () => {
    const { doc, baseline } = open("\\[x\\]\n");
    const written = serializeMarkdown(setAttrs(isType("latticeMath"), { tex: "a\\]b" })(doc), baseline).text;
    expect(written).toBe("$$\na\\]b\n$$\n");
    expect(open(written).doc.child(0).type.name).toBe("latticeMathBlock");
  });

  it("keeps a backslash-escaped parenthesis as prose", () => {
    const { doc } = open("Use \\\\(x\\\\) literally.\n");
    expect(doc.textContent).toBe("Use \\(x\\) literally.");
  });
});

describe("merged table cells (R-BLK-11, R-FMT-10, R-FMT-11, R-FMT-13)", () => {
  const rowLengths = (table: PmNode) => table.children.map((row) => row.childCount);
  const firstTable = (doc: PmNode) => find(doc, isType("table")).node;
  const INFERRED = "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n| Other | Variant | 2 |";
  const MERGED = "<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->\n\n| Group | Group | Metric |\n| --- | --- | --- |\n| A | B | 1 |";
  const RADIO = [
    "|  | Model | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "|  | Model | metaclip_nps | sa1b_nps | crowded | fg_food | fg_sports_equipment | attributes | wiki_common | Avg |",
    "| C-RADIOv4 | SO400M-VDT8 | 43.0 | 44.5 | 54.9 | 38.4 | 38.4 | 40.3 | 22.2 | 40.3 |",
    "| C-RADIOv4 | SO400M-G | 43.8 | 45.7 | 55.9 | 40.1 | 39.8 | 41.6 | 23.1 | 41.4 |",
  ].join("\n");

  it.each([
    ["infers a combined row and column span", INFERRED, PAPER, [2, 1, 3], 0, { colspan: 2, rowspan: 2 }],
    ["honors an explicit layout", MERGED, {}, [2, 3], 0, { colspan: 2 }],
    ["lets an explicit empty layout suppress inference", `<!-- lattice-table-layout:v1 {"spans":[]} -->\n\n${INFERRED}`, PAPER, [3, 3, 3], 0],
    ["keeps an invalid layout as its own block", "<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,3]]} -->\n\n| A | B |\n| --- | --- |\n| C | D |", {}, [2, 2], 1],
    ["leaves repeated data unmerged", "| Run | Status | Flag A | Flag B | Score |\n| --- | --- | --- | --- | --- |\n| A | Passed | Yes | Yes | 1 |\n| B | Passed | No | No | 2 |", PAPER, [5, 5, 5], 0],
    ["leaves an ambiguous intersection unmerged", "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Variant | 1 |", PAPER, [3, 3], 0],
    ["leaves single-level duplicate headers unmerged", "| Run | Score | Score |\n| --- | --- | --- |\n| A | 1 | 2 |", PAPER, [3, 3], 0],
    ["leaves single-stub duplicates unmerged", "| State | Score |\n| --- | --- |\n| Active | 1 |\n| Active | 2 |", PAPER, [2, 2, 2], 0],
    ["does not infer outside paper mode", INFERRED, {}, [3, 3, 3], 0],
  ] as const)("%s and round-trips the exact source", (_label, text, options, rows, index, origin?: object) => {
    const { doc, baseline } = open(text, options);
    expect(doc.child(index).type.name).toBe("table");
    expect(rowLengths(doc.child(index))).toEqual(rows);
    if (origin) expect(doc.child(index).child(0).child(0).attrs).toMatchObject(origin);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    // Rewritten from scratch, the table reads back with the same cells.
    const rewritten = serializeMarkdown(doc, { ...baseline, entries: [] });
    expect(rewritten.verified).toBe(true);
    expect(rowLengths(open(rewritten.text, options).doc.child(index))).toEqual(rows);
  });

  it("merges the RADIO table's labels in paper mode and expands an edited label on save", () => {
    const { doc } = open(RADIO, PAPER);
    const table = firstTable(doc);
    expect(rowLengths(table)).toEqual([3, 9, 10, 9]);
    expect(table.child(0).child(1).attrs).toMatchObject({ rowspan: 2 });
    expect(table.child(0).child(2).attrs).toMatchObject({ colspan: 8 });
    expect(table.child(2).child(0).attrs).toMatchObject({ rowspan: 2 });
    const written = edited(RADIO, insertBefore("C-RADIOv4", "Updated "), PAPER);
    expect(written.match(/\| Updated C-RADIOv4 \|/g)).toHaveLength(2);
    expect(written).not.toContain("lattice-table-layout");
  });

  it("round-trips an explicit layout nested in a blockquote", () => {
    const text = MERGED.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
    const { doc, baseline } = open(text);
    expect(firstTable(doc).child(0).child(0).attrs.colspan).toBe(2);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
    const rewritten = serializeMarkdown(doc, { ...baseline, entries: [] }).text;
    expect(rewritten).toContain("> <!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->");
  });

  it("writes a merge as a layout comment and keeps column alignment", () => {
    const text = "| Group | Group | Metric |\n| :--- | ---: | :---: |\n| A | B | 1 |";
    const written = edited(text, (doc) => {
      const table = firstTable(doc);
      const header = table.child(0);
      const merged = header.child(0).type.create({ ...header.child(0).attrs, colspan: 2 }, header.child(0).content);
      const row = header.copy(header.content.replaceChild(0, merged).cut(0, merged.nodeSize).append(header.content.cut(header.child(0).nodeSize + header.child(1).nodeSize)));
      return doc.copy(doc.content.replaceChild(0, table.copy(table.content.replaceChild(0, row))));
    });
    expect(written).toContain("<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->");
    expect(written).toContain("| Group | Group | Metric |");
    expect(written).toMatch(/\| :-+ \| -+: \| :-+: \|/);
  });

  it("refuses to write spans that do not fit the table", () => {
    const { doc, baseline } = open("| A | B |\n| --- | --- |\n| C | D |");
    const broken = setAttrs(isType("tableHeader"), { rowspan: 3 })(doc);
    expect(() => serializeMarkdown(broken, { ...baseline, entries: [] })).toThrow("Cannot serialize malformed table spans");
  });
});

describe("images (R-BLK-3, R-FMT-7, R-RT-12k)", () => {
  it("reads an HTML image as an image and keeps its bytes", () => {
    const text = "<img src=\"figures/plot.png\" alt=\"Plot\" width={223} />\n";
    const { doc, baseline } = open(text);
    expect(find(doc, isType("image")).node.attrs).toMatchObject({ src: "figures/plot.png", alt: "Plot", width: 223 });
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it("writes a resized Markdown image as an HTML image without a height", () => {
    const written = edited("![Plot](figures/plot.png \"Results\")", setAttrs(isType("image"), { width: 400 }));
    expect(written).toBe("<img src=\"figures/plot.png\" alt=\"Plot\" title=\"Results\" width={400} />");
  });

  it("writes an aligned image with its alignment", () => {
    expect(edited("![Plot](figures/plot.png)", setAttrs(isType("image"), { align: "right" })))
      .toBe("<img src=\"figures/plot.png\" alt=\"Plot\" align=\"right\" />");
  });

  it("keeps an image's source-sensitive syntax when its paragraph is edited", () => {
    const text = "Before ![Plot](<../figures/my plot.png> \"Results\") after";
    expect(edited(text, insertBefore("Before ", "Updated "))).toBe(`Updated ${text}`);
  });

  it("keeps an image with attributes Lattice does not write as HTML source", () => {
    const { doc } = open("<img src=\"a.png\" style=\"border: 0\" />");
    expect(doc.child(0).type.name).toBe("latticeRawBlock");
  });
});

describe("code fences (R-FMT-8, R-RT-12)", () => {
  it("keeps a longer closing fence when the code is edited", () => {
    const text = "````mermaid title=flow\ngraph TD; A-->B\n`````";
    expect(edited(text, insertBefore("graph TD; A-->B", "%% c\n"))).toBe("````mermaid title=flow\n%% c\ngraph TD; A-->B\n`````");
  });

  it("changes only the language token of the info string", () => {
    expect(edited("```ts title=\"Example with spaces\"\nconst answer = 42;\n```", setAttrs(isType("codeBlock"), { language: "python" })))
      .toBe("```python title=\"Example with spaces\"\nconst answer = 42;\n```");
  });
});
