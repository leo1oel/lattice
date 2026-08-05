/**
 * Local seam — not upstream code.
 *
 * Upstream `config-provider.tsx` merges workspace + user config over a
 * server round-trip. The only setting the vendored editor tree reads is
 * `merged.editor.wordWrap` (nested CodeMirror line wrapping), and every
 * consumer already defaults it to `true` via `?? true`. Returning an empty
 * merge keeps upstream call sites byte-identical without dragging the host
 * settings store across the vendor boundary.
 */
export interface HostMergedConfig {
  editor?: {
    wordWrap?: boolean;
  };
}

export function useConfigContext(): { merged: HostMergedConfig | undefined } {
  return { merged: undefined };
}
