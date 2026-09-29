/**
 * Differential harness: the same corpus through the vendored visual editor
 * and the Lattice engine, compared on what a reader sees and whether they may
 * edit. The vendored editor is used strictly as a black box through the host
 * contract both engines implement (visual-editor-props.ts): text in, the
 * editable surface and the document it shows out. Nothing of its code is read.
 *
 * Quarantined: it exists only while both engines ship, and is deleted with
 * the vendored editor (plan phase 3).
 *
 * Checked for every document:
 * - one the old editor lets the reader edit, the new engine opens editable
 *   and writes back byte for byte (spec R-ELIG-1, deliberate differences in
 *   Part I aside);
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
import { engineSchema } from "./engine-schema";
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

/** The old editor, mounted as the host mounts it. */
async function observeOld(text: string) {
  const onChange = vi.fn(() => true);
  render(<VisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={onChange} onUndo={() => false} onRedo={() => false} />);
  const surface = screen.getByRole("textbox") as HTMLElement & { editor: Editor };
  // R-ELIG-3: nothing is published once a document has been open for 50 ms.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const observed = {
    editable: surface.getAttribute("contenteditable") === "true",
    published: onChange.mock.calls.length,
    outline: outline(surface.editor.state.doc, oldFormula),
  };
  cleanup();
  return observed;
}

function observeNew(text: string) {
  const opened = openMarkdown(text, engineSchema());
  if ("unavailable" in opened) return { editable: false, exact: false, outline: null };
  return {
    editable: true,
    exact: serializeMarkdown(opened.doc, opened.baseline).text === text,
    outline: outline(opened.doc, newFormula),
  };
}

afterEach(() => cleanup());

const compared = { documents: 0, editable: 0, headings: 0, code: 0, formulas: 0 };

describe("differential: vendored editor vs Lattice engine", () => {
  it.each(corpus)("agrees on %s", async (_name, text) => {
    const before = observeOld(text);
    const next = observeNew(text);
    const old = await before;
    compared.documents += 1;
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
