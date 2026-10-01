/**
 * What a document means, independent of how its Markdown was written: the
 * comparison the round-trip core uses to tell an edited block from an
 * untouched one, and to verify that written Markdown reads back as shown.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { STYLE_ATTRIBUTES } from "./engine-schema";

/**
 * What a sequence of nodes means, ignoring how it was written: style
 * attributes, authored-source marks, text-node boundaries, and empty
 * paragraphs (which have no Markdown) are dropped. A GFM literal autolink is
 * its text: typed bare URLs, `www.` hosts and email addresses read back as
 * autolinks, and no escape keeps them plain, so the two are one reading.
 */
export function semanticKey(nodes: readonly PmNode[]): string {
  return JSON.stringify(nodes.map((node) => semanticJSON(node.toJSON() as JSONContent)).filter(Boolean));
}

function semanticJSON(node: JSONContent): unknown {
  if (node.type === "paragraph" && !node.content?.length) return null;
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {})
      .filter(([name]) => !STYLE_ATTRIBUTES.has(name))
      .map(([name, value]) => [name, value === "" ? null : value]),
  );
  const marks = (node.marks ?? [])
    .filter((mark) => mark.type !== "latticeSource" && !(node.type === "text" && literalAutolink(mark, node.text ?? "")))
    .map((mark) => [mark.type, Object.fromEntries(Object.entries(mark.attrs ?? {}).filter(([name]) => !STYLE_ATTRIBUTES.has(name)))]);
  if (node.type === "text") return { text: node.text, marks };
  const content: unknown[] = [];
  for (const child of node.content ?? []) {
    const value = semanticJSON(child) as { text?: string; marks?: unknown } | null;
    if (!value) continue;
    const previous = content[content.length - 1] as { text?: string; marks?: unknown } | undefined;
    if (value.text != null && previous?.text != null && JSON.stringify(previous.marks) === JSON.stringify(value.marks)) {
      content[content.length - 1] = { ...previous, text: previous.text + value.text };
    } else {
      content.push(value);
    }
  }
  // A block's trailing whitespace has no Markdown form (R-ELIG-2).
  const last = content[content.length - 1] as { text?: string } | undefined;
  if (TEXTBLOCKS.has(node.type ?? "") && last?.text != null) {
    const text = last.text.replace(/[ \t]+$/, "");
    if (text) content[content.length - 1] = { ...last, text };
    else content.pop();
  }
  if (node.type === "paragraph" && !content.length) return null;
  return { type: node.type, attrs, marks, content };
}

const TEXTBLOCKS = new Set(["paragraph", "heading"]);

type MarkJSON = NonNullable<JSONContent["marks"]>[number];

/** A link GFM makes of bare text: written as its own text, pointing where GFM points it. */
function literalAutolink(mark: MarkJSON, text: string): boolean {
  const attrs = (mark.attrs ?? {}) as Record<string, unknown>;
  if (mark.type !== "link" || attrs.autolink !== "literal" || attrs.title) return false;
  return attrs.href === text || attrs.href === `http://${text}` || attrs.href === `mailto:${text}`;
}
