/**
 * What the visual engine's chrome shares with the editor host: the host's
 * current props, and requests one piece of chrome makes of another (the slash
 * menu asking for the link editor, the emoji picker, or a file picker).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { VisualMarkdownEditorProps } from "../../visual-editor-props";

export type ChromeRequest =
  | { kind: "link"; from: number; to: number }
  | { kind: "citation"; at: number }
  | { kind: "emoji"; at: number }
  | { kind: "image"; at: number }
  | { kind: "find"; replace: boolean; seed: string };

export type ChromeHost = {
  /** The host's latest props; `setProps` keeps them current after each render. */
  props: () => VisualMarkdownEditorProps;
  setProps: (props: VisualMarkdownEditorProps) => void;
  /** The latest request, until the chrome that serves it clears it. */
  request: ChromeRequest | null;
  ask: (request: ChromeRequest) => void;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createChromeHost(initial: VisualMarkdownEditorProps): ChromeHost {
  const listeners = new Set<() => void>();
  let latest = initial;
  const host: ChromeHost = {
    props: () => latest,
    setProps: (props) => {
      latest = props;
    },
    request: null,
    ask: (request) => {
      host.request = request;
      listeners.forEach((listener) => listener());
    },
    clear: () => {
      if (!host.request) return;
      host.request = null;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return host;
}
