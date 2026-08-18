import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applySourceTransaction,
  benchmarkStructuredCandidate,
  mapSourceCursorAfterRoundTrip,
  parseMarkdownCandidate,
  replaceStructuredJson,
  serializeFragment,
  serializeMarkdownCandidate,
} from "./markdown-structured-crdt-prototype";

const syntaxMatrix: Record<string, string> = {
  "ATX heading": "# Heading\n",
  "setext heading": "Heading\n=======\n",
  marks: "*em* **strong** ~~strike~~\n",
  "nested task lists": "- [ ] one\n  - [x] two\n",
  "table alignment": "| A | B |\n| :--- | ---: |\n| x | y |\n",
  "fenced code": "```ts\nconst x = 1\n```\n",
  "indented code": "    const x = 1\n",
  math: "Inline $x^2$ and $$y$$.\n",
  frontmatter: "---\ntitle: Exact\n---\nBody\n",
  HTML: "<section data-x=\"1\">raw</section>\n",
  comments: "before <!-- exact --> after\n",
  links: "[inline](https://example.com) [ref][id]\n\n[id]: /target \"title\"\n",
  autolinks: "<https://example.com> <a@example.com>\n",
  images: "![alt](plot.png \"title\")\n",
  footnotes: "Text[^1]\n\n[^1]: note\n",
  blockquote: "> quoted\n",
  callout: "> [!NOTE]\n> exact\n",
  component: "```rw-component callout\n{\"title\":\"Exact\"}\n```\n",
  LaTeX: "\\section{Exact}\n\\begin{align}x&=y\\end{align}\n",
  Unicode: "中文 😀 café\n",
  BOM: "\uFEFF# Heading\n",
  CRLF: "# Heading\r\n\r\nBody\r\n",
  whitespace: "line  \nnext\t\n\n",
  "no final newline": "# Heading",
};

function sync(left: Y.Doc, right: Y.Doc) {
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
}

describe("isolated native structured Markdown CRDT evaluation", () => {
  it("measures the required byte-exact syntax matrix without semantic forgiveness", () => {
    const results = Object.entries(syntaxMatrix).map(([name, source]) => ({
      name,
      exact: serializeMarkdownCandidate(parseMarkdownCandidate(source)) === source,
    }));
    expect(results).toHaveLength(24);
    expect(results.some(({ exact }) => !exact)).toBe(true);
    expect(results.find(({ name }) => name === "BOM")?.exact).toBe(false);
    expect(results.find(({ name }) => name === "CRLF")?.exact).toBe(false);
  });

  it("rejects lossy source conversion and preserves the complete recoverable draft", async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("content");
    replaceStructuredJson(fragment, parseMarkdownCandidate("# Existing\n"));
    const before = Y.encodeStateAsUpdate(doc);
    const source = syntaxMatrix.frontmatter!;
    const result = await applySourceTransaction(doc, fragment, source);
    expect(result).toEqual(expect.objectContaining({ ok: false, draft: { source, recoverable: true, reason: expect.any(String) } }));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("handles throw, timeout, partial parse, and serialize faults without writes", async () => {
    for (const faults of [
      { parse: () => { throw new Error("parse fault"); } },
      { afterParse: () => { throw new Error("partial parse fault"); } },
      { serialize: () => { throw new Error("serialize fault"); } },
      { parse: () => new Promise<void>(() => undefined), timeoutMs: 2 },
    ]) {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment("content");
      const result = await applySourceTransaction(doc, fragment, "# Exact\n", faults);
      expect(result.ok).toBe(false);
      expect(fragment.length).toBe(0);
    }
  });

  it("does not let an old conversion overwrite a remote update in the real event order", async () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    const leftFragment = left.getXmlFragment("content");
    const rightFragment = right.getXmlFragment("content");
    replaceStructuredJson(leftFragment, parseMarkdownCandidate("# Base\n"));
    sync(left, right);
    const pending = applySourceTransaction(left, leftFragment, "# Local", {
      afterParse: async () => {
        replaceStructuredJson(rightFragment, parseMarkdownCandidate("# Remote\n"));
        Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
      },
    });
    const result = await pending;
    expect(result).toEqual(expect.objectContaining({ ok: false, stale: true }));
    expect(serializeFragment(leftFragment)).toBe("# Remote");
    expect(result.ok ? "" : result.draft.source).toBe("# Local");
  });

  it("records concurrent replacement convergence evidence without hiding duplication", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    replaceStructuredJson(left.getXmlFragment("content"), parseMarkdownCandidate("# Base\n\nOne\n"));
    sync(left, right);
    replaceStructuredJson(left.getXmlFragment("content"), parseMarkdownCandidate("# Left\n\nOne\n"));
    replaceStructuredJson(right.getXmlFragment("content"), parseMarkdownCandidate("# Base\n\nRight\n"));
    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);
    expect(Y.encodeStateAsUpdate(left)).toEqual(Y.encodeStateAsUpdate(right));
    expect(serializeFragment(left.getXmlFragment("content"))).toBe(serializeFragment(right.getXmlFragment("content")));
    expect(serializeFragment(left.getXmlFragment("content"))).not.toBe("# Left\n\nRight\n");
  });

  it("evaluates at least twenty source/visual cursor boundaries", () => {
    const source = "# H\n\n**bold 😀**\n\n- item\n\n| A |\n| --- |\n| x |\n\n```\ncode\n```\n";
    const boundaries = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 30, 35, 40, source.length];
    expect(boundaries).toHaveLength(23);
    const mappings = boundaries.map((offset) => mapSourceCursorAfterRoundTrip(source, offset));
    expect(mappings.every((value) => value === null)).toBe(true);
  });

  it("computes fixed-fixture benchmark ratios in test code", () => {
    const fixtures = {
      small: "# Small\n\nText\n",
      medium: `${"## Section\n\nParagraph with **marks**.\n\n".repeat(30)}`,
      large: `${"- item one\n  - nested item\n\n".repeat(300)}`,
    };
    const results = benchmarkStructuredCandidate(fixtures, 3);
    expect(results).toHaveLength(3);
    expect(results.every((result) => Number.isFinite(result.timeRatio) && result.byteRatio > 0)).toBe(true);
    console.info("STRUCTURED_MARKDOWN_BENCHMARK", JSON.stringify(results));
  });
});
