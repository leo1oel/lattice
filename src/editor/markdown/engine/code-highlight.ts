/**
 * Syntax highlighting for the visual engine's code blocks: lowlight (MIT)
 * tokens as ProseMirror inline decorations over the code text (spec R-BLK-7).
 *
 * A decorated span never contains a line ending: WebKit cannot move the caret
 * across a newline that sits inside an inline element, so token ranges are
 * cut at every newline. Only the code blocks a transaction touched are
 * highlighted again; the rest of the decorations are mapped.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import latex from "highlight.js/lib/languages/latex";
import { common, createLowlight } from "lowlight";
import { resolveCodeLanguage } from "./code-languages";

const lowlight = createLowlight(common);
lowlight.register("latex", latex);

type Token = { from: number; to: number; className: string };
type HastNode = { type: string; value?: string; properties?: { className?: string[] }; children?: HastNode[] };

/** Token ranges (relative to the code's start) for `code` in `grammar`. */
export function highlightTokens(code: string, grammar: string): Token[] {
  if (!lowlight.registered(grammar)) return [];
  let tree: HastNode;
  try {
    tree = lowlight.highlight(grammar, code) as unknown as HastNode;
  } catch {
    return [];
  }
  const tokens: Token[] = [];
  let offset = 0;
  const walk = (node: HastNode, classes: string[]) => {
    if (node.type === "text") {
      const value = node.value ?? "";
      if (classes.length) {
        // Cut at every line ending so no span holds a newline.
        let start = 0;
        for (let index = 0; index <= value.length; index += 1) {
          if (index === value.length || value[index] === "\n") {
            if (index > start) tokens.push({ from: offset + start, to: offset + index, className: classes.join(" ") });
            start = index + 1;
          }
        }
      }
      offset += value.length;
      return;
    }
    const own = node.properties?.className ?? [];
    for (const child of node.children ?? []) walk(child, [...classes, ...own]);
  };
  walk(tree, []);
  return tokens;
}

function blockDecorations(node: PmNode, position: number): Decoration[] {
  const grammar = resolveCodeLanguage(node.attrs.language as string | null)?.grammar;
  if (!grammar || !node.textContent) return [];
  return highlightTokens(node.textContent, grammar).map((token) => (
    Decoration.inline(position + 1 + token.from, position + 1 + token.to, { class: token.className })
  ));
}

function highlightAll(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === "codeBlock") {
      decorations.push(...blockDecorations(node, position));
      return false;
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
}

/** Map the old decorations and re-highlight only the code blocks the transaction changed. */
function highlightChanges(set: DecorationSet, transaction: Transaction): DecorationSet {
  let next = set.map(transaction.mapping, transaction.doc);
  const touched = new Map<number, PmNode>();
  transaction.mapping.maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = transaction.mapping.slice(index + 1);
      const from = Math.min(rest.map(newStart, -1), transaction.doc.content.size);
      const to = Math.min(rest.map(newEnd, 1), transaction.doc.content.size);
      transaction.doc.nodesBetween(from, Math.max(from, to), (node, position) => {
        if (node.type.name === "codeBlock") {
          touched.set(position, node);
          return false;
        }
        return !node.isTextblock;
      });
    });
  });
  // Attribute-only changes (a language switch) map no ranges; find their blocks too.
  transaction.steps.forEach((step, index) => {
    const position = (step as unknown as { pos?: number }).pos;
    if (typeof position !== "number") return;
    const mapped = transaction.mapping.slice(index + 1).map(position);
    const node = transaction.doc.nodeAt(mapped);
    if (node?.type.name === "codeBlock") touched.set(mapped, node);
  });
  for (const [position, node] of touched) {
    next = next.remove(next.find(position, position + node.nodeSize));
    next = next.add(transaction.doc, blockDecorations(node, position));
  }
  return next;
}

const key = new PluginKey<DecorationSet>("latticeCodeHighlight");

export const CodeHighlight = Extension.create({
  name: "latticeCodeHighlight",
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => highlightAll(state.doc),
      apply: (transaction, set) => (transaction.docChanged ? highlightChanges(set, transaction) : set),
    },
    props: { decorations: (state) => key.getState(state) },
  })],
});
