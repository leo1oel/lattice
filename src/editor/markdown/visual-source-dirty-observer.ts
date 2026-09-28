/*
 * Port of inkeep/open-knowledge's source-dirty observer
 * (packages/app/src/editor/extensions/source-dirty-observer.ts at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e, GPL-3.0-or-later).
 *
 * Watches ProseMirror transactions and marks `jsxComponent` nodes as
 * `sourceDirty: true` when their content or structured attrs change through
 * user-intent transactions. Without this, typing inside a pristine parsed
 * component (for example a `<Callout>` body) would leave `sourceRaw` stale
 * and the serializer would re-emit the old bytes, silently dropping the edit.
 *
 * Deviation from upstream: upstream deny-lists CRDT-origin transactions via
 * `ySyncPluginKey` meta from `@tiptap/y-tiptap`. This app does not run Yjs in
 * the visual editor yet; its only non-user origin is the canonical-reconcile
 * path (`setMarkdownWithoutHistory`), which tags its transaction with
 * `addToHistory: false`. When the Markdown Yjs layer lands, reinstate the
 * upstream ySyncPluginKey guard here.
 */
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";

/** Structural equality for JSON-like attrs (primitives, arrays, plain objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function becameDirty(node: PmNode, oldNode: PmNode | null | undefined): boolean {
  if (oldNode?.type.name !== "jsxComponent") {
    // A component newly inserted with an authoritative non-empty sourceRaw
    // (parsed content, MDX paste, block moves) must stay pristine so the
    // serializer re-emits its exact bytes.
    if (typeof node.attrs.sourceRaw === "string" && node.attrs.sourceRaw.length > 0) return false;
    return oldNode != null || node.content.size > 0 || Object.keys(node.attrs.props ?? {}).length > 0;
  }
  return !deepEqual(oldNode.attrs.props, node.attrs.props) || !oldNode.content.eq(node.content);
}

export const SourceDirtyObserver = Extension.create({
  name: "sourceDirtyObserver",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("sourceDirty"),
      appendTransaction(transactions, oldState, newState) {
        // Skip pure canonical-reconcile updates (external text applied via
        // setMarkdownWithoutHistory) — they are not user intent.
        if (!transactions.some((tr) => tr.getMeta("addToHistory") !== false)) return null;
        if (!transactions.some((tr) => tr.docChanged)) return null;

        // Map new-state positions back to old-state positions so insertions
        // or deletions before a jsxComponent don't shift the comparison onto
        // the wrong node (which would false-positive mark it dirty and
        // defeat the pristine sourceRaw path).
        const mapping = new Mapping();
        for (const tr of transactions) mapping.appendMapping(tr.mapping);
        const inverted = mapping.invert();

        const dirty: number[] = [];
        newState.doc.descendants((node, pos) => {
          if (node.type.name !== "jsxComponent" || node.attrs.sourceDirty) return;
          // Positions at an insertion boundary are association-sensitive.
          // Probe both sides: block insertion commands commonly insert a
          // paragraph immediately before a component, and choosing the
          // inserted side makes an untouched component look newly created.
          const candidates = [oldState.doc.nodeAt(inverted.map(pos, -1)), oldState.doc.nodeAt(inverted.map(pos, 1))];
          const oldNode = candidates.find((candidate) => (
            candidate?.type.name === "jsxComponent"
            && candidate.attrs.componentName === node.attrs.componentName
            && candidate.attrs.sourceRaw === node.attrs.sourceRaw
          )) ?? candidates[0];
          if (becameDirty(node, oldNode)) dirty.push(pos);
        });
        if (dirty.length === 0) return null;

        const tr = newState.tr;
        for (const pos of dirty) tr.setNodeAttribute(pos, "sourceDirty", true);
        // This appended transaction only maintains serializer metadata. The
        // user transaction that caused it already owns history and update
        // publication; emitting this internal follow-up can publish a stale
        // pristine source between an edit and its metadata repair.
        return tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
      },
    })];
  },
});
