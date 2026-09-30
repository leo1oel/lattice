/**
 * What the visual engine's chrome shares with the editor host: the host's
 * current props, and requests one piece of chrome makes of another (the slash
 * menu asking for the link editor, the emoji picker, or a file picker).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useSyncExternalStore } from "react";
import type { VisualMarkdownEditorProps } from "../../visual-editor-props";
import type { SourceMap } from "../source-map";

type ChromeRequest =
  | { kind: "link"; from: number; to: number }
  | { kind: "citation"; at: number }
  | { kind: "emoji"; at: number }
  | { kind: "image"; at: number }
  | { kind: "find"; replace: boolean; seed: string }
  | { kind: "comment" };

export type ChromeHost = {
  /** The host's latest props; `setProps` keeps them current after each render. */
  props: () => VisualMarkdownEditorProps;
  setProps: (props: VisualMarkdownEditorProps) => void;
  /**
   * The editor's source map, or null while the document has none (declined,
   * or not yet loaded). With `settle`, a pending edit is published first, so
   * the map covers the document exactly as shown.
   */
  sourceMap: (settle?: boolean) => SourceMap | null;
  setSourceMap: (read: (settle?: boolean) => SourceMap | null) => void;
  /** The latest request, until the chrome that serves it clears it. */
  request: ChromeRequest | null;
  ask: (request: ChromeRequest) => void;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createChromeHost(initial: VisualMarkdownEditorProps): ChromeHost {
  const listeners = new Set<() => void>();
  let latest = initial;
  let readMap: (settle?: boolean) => SourceMap | null = () => null;
  const host: ChromeHost = {
    props: () => latest,
    setProps: (props) => {
      latest = props;
    },
    sourceMap: (settle) => readMap(settle),
    setSourceMap: (read) => {
      readMap = read;
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

/** The host's current request, re-rendering the caller whenever it changes. */
export function useChromeRequest(host: ChromeHost): ChromeRequest | null {
  return useSyncExternalStore(host.subscribe, () => host.request, () => host.request);
}
