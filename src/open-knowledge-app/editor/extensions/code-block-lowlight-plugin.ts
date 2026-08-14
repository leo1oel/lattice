/**
 * Lowlight-based ProseMirror decoration plugin for fenced code blocks.
 *
 * Mirrors @tiptap/extension-code-block-lowlight's plugin so we can extend the
 * existing core CodeBlockFidelity (which carries the fence-fidelity attrs)
 * without forking the schema. Only redraws decorations on doc mutations that
 * affect a code block — selection-only transactions reuse the cached set.
 */

import { findChildren } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface HastTextNode {
  type: 'text';
  value: string;
}

interface HastElementNode {
  type: 'element';
  tagName?: string;
  properties?: { className?: string[] };
  children: Array<HastTextNode | HastElementNode>;
}

type HastNode = HastTextNode | HastElementNode;

interface LowlightTree {
  children?: HastNode[];
}

interface CodeBlockMatch {
  node: PmNode;
  pos: number;
}

interface PositionRange {
  from: number;
  to: number;
}

export interface LowlightLike {
  highlight(language: string, value: string): LowlightTree;
  highlightAuto(value: string): LowlightTree;
  listLanguages(): string[];
  registered?(name: string): boolean;
}

function parseNodes(
  nodes: HastNode[],
  classes: string[] = [],
): Array<{ text: string; classes: string[] }> {
  return nodes.flatMap((node) => {
    if (node.type === 'text') {
      return [{ text: node.value, classes }];
    }
    const nextClasses = [...classes, ...(node.properties?.className ?? [])];
    return parseNodes(node.children, nextClasses);
  });
}

function getBlockDecorations(opts: {
  block: CodeBlockMatch;
  name: string;
  lowlight: LowlightLike;
  defaultLanguage: string | null;
  registeredLanguages: string[];
}): Decoration[] {
  const { block, name, lowlight, defaultLanguage, registeredLanguages } = opts;
  const decorations: Decoration[] = [];
  if (block.node.type.name !== name) return decorations;
  let from = block.pos + 1;
  const lang = (block.node.attrs.language || defaultLanguage) as string | null;
  // Plain text path — `language === null` is the picker's explicit "no
  // highlighting" choice. Skip lowlight entirely so we (a) honour the user's
  // intent and (b) avoid the per-keystroke ~38-grammar `highlightAuto` scan.
  if (!lang) return decorations;
  const supported = registeredLanguages.includes(lang) || (lowlight.registered?.(lang) ?? false);
  if (!supported) return decorations;
  let tree: LowlightTree;
  try {
    tree = lowlight.highlight(lang, block.node.textContent);
  } catch {
    return decorations;
  }
  const children = (tree.children ?? []) as HastNode[];
  for (const segment of parseNodes(children)) {
    const to = from + segment.text.length;
    if (segment.classes.length > 0) {
      // Keep newline characters outside highlight spans. WebKit can draw a
      // collapsed caret on the preceding visual line when it sits at the
      // end of an inline decoration that also contains the newline. The
      // document still receives the newline, so the code surface grows,
      // but the caret appears stuck until another character is inserted.
      // Decorating each non-newline run preserves highlighting while giving
      // ProseMirror's trailing <br> a plain-text caret boundary.
      for (const run of segment.text.matchAll(/[^\r\n]+/g)) {
        const runFrom = from + (run.index ?? 0);
        decorations.push(
          Decoration.inline(runFrom, runFrom + run[0].length, {
            class: segment.classes.join(' '),
          }),
        );
      }
    }
    from = to;
  }

  return decorations;
}

function getDecorations(opts: {
  doc: PmNode;
  name: string;
  lowlight: LowlightLike;
  defaultLanguage: string | null;
}): DecorationSet {
  const { doc, name, lowlight, defaultLanguage } = opts;
  const decorations: Decoration[] = [];
  // `listLanguages()` allocates a fresh array per call — hoist outside the
  // per-block loop so we pay O(1) array materializations per transaction.
  const registeredLanguages = lowlight.listLanguages();

  findChildren(doc, (node) => node.type.name === name).forEach((block) => {
    decorations.push(...getBlockDecorations({
      block,
      name,
      lowlight,
      defaultLanguage,
      registeredLanguages,
    }));
  });

  return DecorationSet.create(doc, decorations);
}

function codeBlocksTouchedByRange(
  doc: PmNode,
  name: string,
  from: number,
  to: number,
): CodeBlockMatch[] {
  const matches = new Map<number, PmNode>();
  const addResolvedAncestor = (position: number) => {
    const $position = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
    for (let depth = 1; depth <= $position.depth; depth += 1) {
      const node = $position.node(depth);
      if (node.type.name === name) matches.set($position.before(depth), node);
    }
  };

  if (from === to) {
    // An insertion only affects a code block when the insertion point resolves
    // inside it. A sibling insertion at the block boundary resolves in the
    // parent and therefore leaves the existing block mapped but unhighlighted.
    addResolvedAncestor(from);
  } else {
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === name) matches.set(pos, node);
    });
    addResolvedAncestor(from);
    addResolvedAncestor(to - 1);
  }

  return [...matches].map(([pos, node]) => ({ pos, node }));
}

function updateDecorations(opts: {
  transaction: Transaction;
  decorationSet: DecorationSet;
  name: string;
  lowlight: LowlightLike;
  defaultLanguage: string | null;
}): DecorationSet {
  const { transaction, name, lowlight, defaultLanguage } = opts;
  let decorationSet = opts.decorationSet.map(transaction.mapping, transaction.doc);
  const staleRanges: PositionRange[] = [];
  const changedBlocks = new Map<number, PmNode>();

  const rememberOldBlock = (block: CodeBlockMatch, stepIndex: number) => {
    const mapping = transaction.mapping.slice(stepIndex);
    staleRanges.push({
      from: mapping.map(block.pos + 1, -1),
      to: mapping.map(block.pos + block.node.nodeSize - 1, 1),
    });
  };
  const rememberNewBlock = (block: CodeBlockMatch, stepIndex: number) => {
    const mapping = transaction.mapping.slice(stepIndex + 1);
    const mapped = mapping.mapResult(block.pos, 1);
    if (mapped.deleted) return;
    const finalNode = transaction.doc.nodeAt(mapped.pos);
    if (finalNode?.type.name === name) changedBlocks.set(mapped.pos, finalNode);
  };

  transaction.steps.forEach((step, stepIndex) => {
    const oldDoc = transaction.docs[stepIndex];
    const newDoc = transaction.docs[stepIndex + 1] ?? transaction.doc;
    const stepMap = step.getMap();
    let hasChangedRange = false;
    stepMap.forEach((oldFrom, oldTo, newFrom, newTo) => {
      hasChangedRange = true;
      for (const block of codeBlocksTouchedByRange(oldDoc, name, oldFrom, oldTo)) {
        rememberOldBlock(block, stepIndex);
      }
      for (const block of codeBlocksTouchedByRange(newDoc, name, newFrom, newTo)) {
        rememberNewBlock(block, stepIndex);
      }
    });

    if (!hasChangedRange) {
      // AttrStep (used by updateAttributes for language changes) has an empty
      // StepMap even though it changes the document. Inspect its target node
      // directly; unrelated paragraph/node attributes remain highlight-free.
      const position = (step as unknown as { pos?: unknown }).pos;
      if (typeof position !== 'number') return;
      const oldNode = oldDoc.nodeAt(position);
      if (oldNode?.type.name === name) {
        rememberOldBlock({ node: oldNode, pos: position }, stepIndex);
      }
      const newNode = newDoc.nodeAt(position);
      if (newNode?.type.name === name) {
        rememberNewBlock({ node: newNode, pos: position }, stepIndex);
      }
    }
  });

  for (const [pos, node] of changedBlocks) {
    staleRanges.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
  }
  const staleDecorations = staleRanges.flatMap(({ from, to }) =>
    from < to ? decorationSet.find(from, to) : []
  );
  decorationSet = decorationSet.remove(staleDecorations);

  if (changedBlocks.size === 0) return decorationSet;
  const registeredLanguages = lowlight.listLanguages();
  const additions: Decoration[] = [];
  for (const [pos, node] of changedBlocks) {
    additions.push(...getBlockDecorations({
      block: { pos, node },
      name,
      lowlight,
      defaultLanguage,
      registeredLanguages,
    }));
  }
  return decorationSet.add(transaction.doc, additions);
}

export function LowlightPlugin(opts: {
  name: string;
  lowlight: LowlightLike;
  defaultLanguage: string | null;
}): Plugin {
  const { name, lowlight, defaultLanguage } = opts;
  const lowlightPlugin: Plugin = new Plugin({
    key: new PluginKey('codeBlockLowlight'),
    state: {
      init: (_config, { doc }) => getDecorations({ doc, name, lowlight, defaultLanguage }),
      apply: (transaction, decorationSet) => {
        // Selection-only transactions never need a redecoration — short-circuit
        // before inspecting steps. Remote-peer awareness ticks and local cursor
        // moves both land here.
        if (!transaction.docChanged) {
          return decorationSet.map(transaction.mapping, transaction.doc);
        }
        return updateDecorations({
          transaction,
          decorationSet,
          name,
          lowlight,
          defaultLanguage,
        });
      },
    },
    props: {
      decorations(state) {
        return lowlightPlugin.getState(state);
      },
    },
  });
  return lowlightPlugin;
}
