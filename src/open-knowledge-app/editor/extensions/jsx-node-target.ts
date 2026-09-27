/**
 * Local seam — not upstream code.
 *
 * Ported from inkeep/open-knowledge #4638 (v0.78.0), which postdates the
 * vendored pin, so it lives outside the vendor manifest. JsxComponentView
 * resolves every chrome/NodeView action through this before dispatching:
 * `getPos()` can map onto a different node after an earlier fallback
 * conversion or a concurrent edit, and acting on that position would move,
 * delete, or overwrite unrelated content.
 */
import type { NodeViewProps } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';

export type JsxNodeTarget =
  | { kind: 'current' | 'changed'; pos: number; node: PmNode }
  | { kind: 'removed' };

/**
 * `current` only when the node at the live position is still value-equal to
 * the node this NodeView rendered; `changed` when something else (or an
 * edited copy) now sits there; `removed` when the position is gone.
 */
export function resolveJsxNodeTarget(
  doc: PmNode,
  getPos: NodeViewProps['getPos'],
  expected: PmNode,
): JsxNodeTarget {
  const pos = typeof getPos === 'function' ? getPos() : undefined;
  if (typeof pos !== 'number') return { kind: 'removed' };
  const node = doc.nodeAt(pos);
  if (!node) return { kind: 'removed' };
  return { kind: node.eq(expected) ? 'current' : 'changed', pos, node };
}

/**
 * Property and source edits may target a node whose props already changed
 * (the edit being applied is what changes them), so they accept any element
 * of the same component rather than requiring value equality.
 */
export function isSameJsxElement(current: PmNode, expected: PmNode): boolean {
  return (
    current.type === expected.type &&
    current.attrs.kind === 'element' &&
    current.attrs.componentName === expected.attrs.componentName
  );
}
