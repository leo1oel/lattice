import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ProofreadMode } from "../agent/agent-proofread";
import { proofreadExtension, type ProofreadKeyHandlers } from "../editor/proofread-anchor";

/** The layer's handlers: the keys', with a request that may ask for Polish. */
type ProofreadHandlers = Omit<ProofreadKeyHandlers, "request"> & {
  request: (view: EditorView, mode?: ProofreadMode) => boolean;
};

/**
 * The canvas's fixed handle on proofreading. The editor's extension and the
 * selection toolbar call through it, and `ProofreadLayer` connects the
 * handlers once it mounts, so the canvas holds a single stable value instead
 * of the layer's state and callbacks: those would run on every canvas render.
 */
export type ProofreadBridge = {
  extension: Extension;
  /** Proofread (or polish) `view`'s selection; false when nothing is connected or selected. */
  start: (view: EditorView, mode?: ProofreadMode) => boolean;
  /** Route the keys and requests to `handlers` until the returned disconnect runs. */
  connect: (handlers: ProofreadHandlers) => () => void;
};

export function createProofreadBridge(): ProofreadBridge {
  let connected: ProofreadHandlers | null = null;
  return {
    extension: proofreadExtension({
      // ⌘⌥P is always Proofread.
      request: (view) => connected?.request(view, "proofread") ?? false,
      accept: (view) => connected?.accept(view) ?? false,
      dismiss: (view) => connected?.dismiss(view) ?? false,
    }),
    start: (view, mode) => connected?.request(view, mode) ?? false,
    connect: (handlers) => {
      connected = handlers;
      return () => {
        if (connected === handlers) connected = null;
      };
    },
  };
}
