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
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";

export const sourceDirtyPluginKey = new PluginKey("sourceDirty");

export const SourceDirtyObserver = Extension.create({
  name: "sourceDirtyObserver",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sourceDirtyPluginKey,
        appendTransaction(transactions, oldState, newState) {
          // Skip pure canonical-reconcile updates (external text applied via
          // setMarkdownWithoutHistory) — they are not user intent.
          const hasUserTransaction = transactions.some(
            (tr) => tr.getMeta("addToHistory") !== false,
          );
          if (!hasUserTransaction) return null;

          const docChanged = transactions.some((tr) => tr.docChanged);
          if (!docChanged) return null;

          // Map new-state positions back to old-state positions so insertions
          // or deletions before a jsxComponent don't shift the comparison onto
          // the wrong node (which would false-positive mark it dirty and
          // defeat the pristine sourceRaw path).
          const combinedMapping = new Mapping();
          for (const tr of transactions) {
            combinedMapping.appendMapping(tr.mapping);
          }
          const invertedMapping = combinedMapping.invert();

          const updates: Array<{ pos: number }> = [];

          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "jsxComponent") return;
            if (node.attrs.sourceDirty) return; // already dirty, skip

            // Positions at an insertion boundary are association-sensitive.
            // Probe both sides: block insertion commands commonly insert a
            // paragraph immediately before a component, and choosing the
            // inserted side makes an untouched component look newly created.
            const oldCandidates = [
              oldState.doc.nodeAt(invertedMapping.map(pos, -1)),
              oldState.doc.nodeAt(invertedMapping.map(pos, 1)),
            ];
            const oldNode = oldCandidates.find((candidate) => (
              candidate?.type.name === "jsxComponent"
              && candidate.attrs.componentName === node.attrs.componentName
              && candidate.attrs.sourceRaw === node.attrs.sourceRaw
            )) ?? oldCandidates[0];

            // Fresh-insert pristine-preservation guard: a jsxComponent newly
            // inserted with an authoritative non-empty sourceRaw (parsed
            // content, MDX paste, block moves) must stay pristine so the
            // serializer re-emits its exact bytes.
            const isFreshInsert = !oldNode || oldNode.type.name !== "jsxComponent";
            const hasAuthoritativeSource =
              typeof node.attrs.sourceRaw === "string" && node.attrs.sourceRaw.length > 0;
            if (isFreshInsert && hasAuthoritativeSource) {
              return;
            }

            if (!oldNode) {
              // Node is new (inserted) — mark dirty if it has content
              if (node.content.size > 0 || Object.keys(node.attrs.props ?? {}).length > 0) {
                updates.push({ pos });
              }
              return;
            }

            if (oldNode.type.name !== "jsxComponent") {
              updates.push({ pos });
              return;
            }

            const propsChanged = !deepEqual(oldNode.attrs.props, node.attrs.props);
            const contentChanged = !oldNode.content.eq(node.content);

            if (propsChanged || contentChanged) {
              updates.push({ pos });
            }
          });

          if (updates.length === 0) return null;

          const tr = newState.tr;
          for (const { pos } of updates) {
            tr.setNodeAttribute(pos, "sourceDirty", true);
          }
          // This appended transaction only maintains serializer metadata. The
          // user transaction that caused it already owns history and update
          // publication; emitting this internal follow-up can publish a stale
          // pristine source between an edit and its metadata repair.
          tr.setMeta("addToHistory", false);
          tr.setMeta("preventUpdate", true);
          return tr;
        },
      }),
    ];
  },
});

/** Simple deep equality for attr comparison (primitives, arrays, plain objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  }
  return true;
}
