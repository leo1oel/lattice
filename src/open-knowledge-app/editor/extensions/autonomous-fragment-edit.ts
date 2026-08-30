/**
 * An autonomous (non-user-initiated) structural fragment rewrite issued from a
 * source-mode-hidden WYSIWYG editor races Observer B's per-keystroke re-derive
 * and double-materializes the span at the Y.XmlFragment CRDT level (precedent
 * #14: Observer B is the sole fragment writer during source typing). Gate every
 * autonomous structural dispatch on the editor being the visible/authoritative
 * surface — in source mode the WYSIWYG is hidden, so its structural rewrites
 * serve no user and only create the double-write race.
 *
 * Checked at DISPATCH time (not effect entry): the mode can flip between
 * scheduling a rAF/timeout and its firing, and a stale-scheduled dispatch is
 * exactly the hazard.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { getEditorSourceMode } from './editor-mode-context.ts';

export function autonomousFragmentEditAllowed(editor: Editor): boolean {
  return !getEditorSourceMode(editor);
}

const AUTONOMOUS_FRAGMENT_EDIT_META = 'autonomousFragmentEdit/swap';

/**
 * Mark a NodeView representation swap so host transaction observers do not
 * classify or publish it as user-authored content. Lattice has no
 * y-prosemirror binding, so its local observers use the existing
 * addToHistory/preventUpdate contract rather than upstream's origin reader.
 */
export function markAutonomousFragmentEdit(tr: Transaction): Transaction {
  return tr
    .setMeta(AUTONOMOUS_FRAGMENT_EDIT_META, true)
    .setMeta('addToHistory', false)
    .setMeta('preventUpdate', true);
}

/** Only suppress dirty-marking when the replacement preserves authored bytes. */
export function markSwapIfByteNeutral(
  tr: Transaction,
  replaced: PmNode,
  nextSource: string,
): Transaction {
  return nextSource === replaced.textContent ? markAutonomousFragmentEdit(tr) : tr;
}
