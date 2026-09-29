/**
 * Shared pieces of the visual engine's block chrome: actions that find their
 * node where it is now (spec R-PUB-22), and Enter handling that ignores the
 * Enter an input method uses to commit its candidate (R-PUB-18).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- chrome helpers and the one field component they format belong together */
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

/** Counters the engine keeps for health reporting. */
export const engineHealth = { refusedChromeActions: 0 };

/**
 * Run `action` against the node a view rendered, at the position it holds
 * now. When the document changed that node underneath the view (a concurrent
 * write, a remote edit), the action is refused and counted instead of being
 * applied to whatever now sits at the old position.
 */
export function onLiveNode(
  editor: Editor,
  getPos: () => number | undefined,
  node: PmNode,
  action: (position: number, transaction: Transaction) => Transaction | null,
): boolean {
  const position = getPos();
  const current = typeof position === "number" ? editor.state.doc.nodeAt(position) : null;
  if (typeof position !== "number" || !current || !current.eq(node)) {
    engineHealth.refusedChromeActions += 1;
    return false;
  }
  const transaction = action(position, editor.state.tr);
  if (!transaction) return false;
  editor.view.dispatch(transaction);
  return true;
}

/** Replace the attributes of the node a view renders. */
export function setNodeAttrs(editor: Editor, getPos: () => number | undefined, node: PmNode, attrs: Record<string, unknown>): boolean {
  return onLiveNode(editor, getPos, node, (position, transaction) => transaction.setNodeMarkup(position, undefined, { ...node.attrs, ...attrs }));
}

/** Delete the node a view renders. */
export function deleteNode(editor: Editor, getPos: () => number | undefined, node: PmNode): boolean {
  return onLiveNode(editor, getPos, node, (position, transaction) => transaction.delete(position, position + node.nodeSize));
}

/**
 * Enter for fields inside the editor's chrome. Returns a keydown handler that
 * calls `onEnter` only for an Enter the user meant: not one that commits an
 * IME candidate, whether it arrives during the composition or (WebKit) right
 * after its `compositionend`.
 */
export function useCommitKeys(onEnter: () => void, onEscape?: () => void) {
  const composing = useRef(false);
  const justComposed = useRef(false);
  return {
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
      justComposed.current = true;
      setTimeout(() => {
        justComposed.current = false;
      }, 0);
    },
    onKeyDown: (event: ReactKeyboardEvent) => {
      const native = event.nativeEvent as KeyboardEvent;
      const ime = composing.current || justComposed.current || native.isComposing || native.keyCode === 229;
      if (event.key === "Enter" && !event.shiftKey) {
        if (ime) return;
        event.preventDefault();
        onEnter();
      } else if (event.key === "Escape" && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
    },
  };
}

/** A labelled field row for a properties popover. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="lx-md-field">
      <span className="lx-md-field-label">{label}</span>
      {children}
    </label>
  );
}
