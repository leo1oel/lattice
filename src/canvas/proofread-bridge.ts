import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { proofreadExtension, type ProofreadKeyHandlers } from "../editor/proofread-anchor";

/**
 * The canvas's fixed handle on proofreading. The editor's extension and the
 * selection toolbar call through it, and `ProofreadLayer` connects the
 * handlers once it mounts, so the canvas holds a single stable value instead
 * of the layer's state and callbacks: those would run on every canvas render.
 */
export type ProofreadBridge = {
  extension: Extension;
  /** Proofread `view`'s selection; false when nothing is connected or selected. */
  start: (view: EditorView) => boolean;
  /** Route the keys to `handlers` until the returned disconnect runs. */
  connect: (handlers: ProofreadKeyHandlers) => () => void;
};

export function createProofreadBridge(): ProofreadBridge {
  let connected: ProofreadKeyHandlers | null = null;
  return {
    extension: proofreadExtension({
      request: (view) => connected?.request(view) ?? false,
      accept: (view) => connected?.accept(view) ?? false,
      dismiss: (view) => connected?.dismiss(view) ?? false,
    }),
    start: (view) => connected?.request(view) ?? false,
    connect: (handlers) => {
      connected = handlers;
      return () => {
        if (connected === handlers) connected = null;
      };
    },
  };
}
