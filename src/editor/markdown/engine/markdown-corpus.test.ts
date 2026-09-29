/**
 * Corpus tests for the visual engine's round trip: Lattice's own documents
 * (README, docs, the tutorial template, embedded skills) plus the saved-file
 * formats catalogued in docs/visual-editor-spec.md §11, as byte-exact fixtures.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Node as PmNode } from "@tiptap/pm/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { engineSchema } from "./engine-schema";
import { openMarkdown, semanticKey, serializeMarkdown, type OpenedMarkdown } from "./markdown-document";
import formatFixtures from "./fixtures/lattice-formats.json";

const schema = engineSchema();

function markdownFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

const repositoryDocuments = [
  "README.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "THIRD_PARTY_NOTICES.md",
  "literature-worker/README.md",
  "src-tauri/templates/tutorial/notes.md",
  ...markdownFiles("docs"),
  ...markdownFiles("src-tauri/src/embedded_skills"),
  ...markdownFiles(".github"),
]
  // The vendoring log describes the code this engine replaces; it is not corpus.
  .filter((path) => !path.endsWith("open-knowledge-updates.md"))
  .map((path) => [path, readFileSync(path, "utf8")] as const);

const formats = Object.entries(formatFixtures as Record<string, string>);
const corpus = [...repositoryDocuments, ...formats.map(([name, text]) => [`format: ${name}`, text] as const)];

function open(text: string): OpenedMarkdown {
  const opened = openMarkdown(text, schema);
  if ("unavailable" in opened) throw new Error(`unavailable: ${opened.unavailable}`);
  return opened;
}

const kindOf = (node: PmNode) => (node.type.name === "latticeRawBlock" ? `raw:${String(node.attrs.kind)}` : node.type.name);

describe("visual engine corpus", () => {
  it("covers a real corpus", () => {
    expect(repositoryDocuments.length).toBeGreaterThan(20);
    expect(formats.length).toBeGreaterThan(60);
  });

  it.each(corpus)("reproduces %s byte for byte when untouched", (_name, text) => {
    const { doc, baseline } = open(text);
    expect(serializeMarkdown(doc, baseline).text).toBe(text);
  });

  it.each(corpus)("writes every block of %s so that it reads back as shown", (_name, text) => {
    const { doc, baseline } = open(text);
    // An empty baseline makes every block "changed": the whole document goes
    // through the serializer, as if the reader had edited each block.
    const rewritten = serializeMarkdown(doc, { ...baseline, entries: [] });
    expect(rewritten.verified).toBe(true);
    const reopened = open(rewritten.text);
    expect(semanticKey(reopened.doc.children)).toBe(semanticKey(doc.children));
  });

  it.each(corpus.filter(([, text]) => !/\r/.test(text)))("changes only the edited block of %s", (_name, text) => {
    const { doc, baseline } = open(text);
    const editable = doc.children
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => (node.type.name === "paragraph" || node.type.name === "heading") && node.textContent.length > 0);
    if (!editable.length) return;
    fc.assert(fc.property(
      fc.constantFrom(...editable),
      fc.nat(),
      fc.stringMatching(/^[A-Za-z]{1,8}$/),
      ({ node, index }, offsetSeed, word) => {
        const at = offsetSeed % (node.content.size + 1);
        const inserted = schema.text(word, node.resolve(at).marks());
        const block = node.copy(node.content.cut(0, at).addToEnd(inserted).append(node.content.cut(at)));
        const { text: written } = serializeMarkdown(doc.copy(doc.content.replaceChild(index, block)), baseline);
        const body = text.replace(/^\uFEFF/, "");
        const writtenBody = written.replace(/^\uFEFF/, "");
        const entry = baseline.entries[index]!;
        const blockStart = baseline.entries.slice(0, index).reduce((sum, item) => sum + item.gapBefore.length + item.source.length, 0)
          + entry.gapBefore.length;
        const blockEnd = blockStart + entry.source.length;
        // Everything before the gap preceding the block, and after the gap following it, is untouched.
        const before = body.slice(0, blockStart - entry.gapBefore.length);
        const next = baseline.entries[index + 1];
        const after = next ? body.slice(blockEnd + next.gapBefore.length) : baseline.trailing;
        expect(writtenBody.startsWith(before)).toBe(true);
        expect(writtenBody.endsWith(after)).toBe(true);
        // Read back through the parser: the serializer may spell the word as a
        // character reference where plain letters would break a delimiter run.
        expect(open(writtenBody.slice(before.length, writtenBody.length - after.length)).doc.textContent).toContain(word);
      },
    ), { numRuns: 25 });
  });

  it("models most of Lattice's own documents instead of keeping them raw", () => {
    const counts = new Map<string, number>();
    let blocks = 0;
    for (const [, text] of repositoryDocuments) {
      for (const node of open(text).doc.children) {
        blocks += 1;
        counts.set(kindOf(node), (counts.get(kindOf(node)) ?? 0) + 1);
      }
    }
    const unsupported = counts.get("raw:unsupported") ?? 0;
    expect(blocks).toBeGreaterThan(1_000);
    // Unmodelled constructs are kept verbatim, but they should stay rare.
    expect(unsupported / blocks).toBeLessThan(0.02);
  });
});
