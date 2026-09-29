/**
 * Differential harness: the same corpus through the Lattice engine, the
 * default visual editor, and the vendored visual editor it replaced, compared
 * on what a reader sees and whether they may edit. Both are mounted as the
 * host mounts them, through the shared props contract (visual-editor-props.ts).
 * The vendored editor is the oracle and is used strictly as a black box: text
 * in, the editable surface and the document it shows out. Nothing of its code
 * is read.
 *
 * Quarantined: it exists only while the vendored editor remains as a hidden
 * fallback, and is deleted with it (plan phase 3).
 *
 * Checked for every document:
 * - the engine opens editable every document the old editor let the reader
 *   edit, and writes it back byte for byte (spec R-ELIG-1, deliberate
 *   differences in Part I aside);
 * - neither publishes anything on open (R-RT-1);
 * - both show the same headings, code, and formulas.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisualMarkdownEditor } from "../visual-markdown-editor";
import { corpus } from "./corpus-test-utils";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";
import { openMarkdown, serializeMarkdown } from "./markdown-document";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(async () => ""), writeText: vi.fn(async () => undefined) }));

/**
 * What a reader sees that both engines must agree on: headings, the text of
 * code blocks, and formulas. Read from each engine's document by observable
 * shape: a heading, a code block, and the TeX a formula renders.
 */
type Outline = { headings: string[]; code: string[]; formulas: string[] };

function outline(doc: PmNode, formulaOf: (node: PmNode) => string | null): Outline {
  const result: Outline = { headings: [], code: [], formulas: [] };
  doc.descendants((node) => {
    if (node.type.name === "heading") result.headings.push(`${String(node.attrs.level)} ${node.textContent.trim()}`);
    else if (node.type.name === "codeBlock") result.code.push(node.textContent);
    const formula = formulaOf(node);
    if (formula != null) result.formulas.push(formula.trim());
  });
  return result;
}

/** The vendored editor's formulas, as its documents expose them to the host's tests. */
function oldFormula(node: PmNode): string | null {
  if (node.type.name === "mathInline") return String(node.attrs.formula ?? "");
  const props = node.attrs.props as { formula?: unknown } | undefined;
  if (node.type.name === "jsxComponent" && node.attrs.componentName === "DollarMath") return String(props?.formula ?? "");
  return null;
}

function newFormula(node: PmNode): string | null {
  return node.type.name === "latticeMath" || node.type.name === "latticeMathBlock" ? String(node.attrs.tex) : null;
}

/**
 * An editor mounted as the host mounts it: whether the reader may edit, what
 * it published on open, and the document it shows.
 */
async function observe(Component: typeof VisualMarkdownEditor, text: string) {
  const onChange = vi.fn(() => true);
  render(<Component text={text} activePath="notes.md" onChangeMarkdown={onChange} onUndo={() => false} onRedo={() => false} />);
  const surface = await screen.findByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
  // R-ELIG-3: nothing is published once a document has been open for 50 ms.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const observed = {
    editable: surface.getAttribute("contenteditable") === "true",
    published: onChange.mock.calls.length,
    doc: surface.editor.state.doc,
  };
  cleanup();
  return observed;
}

/** The engine, mounted, plus whether its own reading of `text` writes back byte for byte. */
async function observeEngine(text: string) {
  const mounted = await observe(LatticeVisualMarkdownEditor, text);
  const opened = openMarkdown(text, mounted.doc.type.schema);
  const exact = !("unavailable" in opened) && serializeMarkdown(opened.doc, opened.baseline).text === text;
  return { ...mounted, exact, outline: mounted.editable ? outline(mounted.doc, newFormula) : null };
}

async function observeOracle(text: string) {
  const mounted = await observe(VisualMarkdownEditor, text);
  return { ...mounted, outline: outline(mounted.doc, oldFormula) };
}

afterEach(() => cleanup());

const compared = { documents: 0, editable: 0, headings: 0, code: 0, formulas: 0 };

describe("differential: Lattice engine vs the vendored fallback", () => {
  it.each(corpus)("agrees on %s", async (_name, text) => {
    const next = await observeEngine(text);
    const old = await observeOracle(text);
    compared.documents += 1;
    expect(next.published, "the engine wrote on open").toBe(0);
    expect(old.published, "the vendored editor wrote on open").toBe(0);
    if (old.editable) {
      compared.editable += 1;
      expect(next.editable, "editable before, declined now").toBe(true);
      expect(next.exact, "not written back byte for byte").toBe(true);
    }
    if (next.outline) {
      expect(next.outline).toEqual(old.outline);
      compared.headings += old.outline.headings.length;
      compared.code += old.outline.code.length;
      compared.formulas += old.outline.formulas.length;
    }
  }, 30_000);

  it("compared a substantial corpus", () => {
    expect(compared.documents).toBe(corpus.length);
    expect(compared.editable).toBeGreaterThan(100);
    expect(compared.headings).toBeGreaterThan(500);
    expect(compared.code).toBeGreaterThan(50);
    expect(compared.formulas).toBeGreaterThan(20);
  });
});
