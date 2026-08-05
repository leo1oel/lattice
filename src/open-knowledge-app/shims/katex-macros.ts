/**
 * Local seam — not upstream code.
 *
 * Upstream's inline-math renderer (MathInlineView.tsx) calls KaTeX with a
 * fixed options object; this host supports user-defined LaTeX macros that
 * must reach that render call. The vendor script injects a
 * `getHostKatexMacros()` lookup into the vendored file; the visual editor
 * publishes its current macros here whenever they change.
 *
 * Module-level state is safe because macros are document-scoped and only one
 * visual Markdown editor renders at a time in this host.
 */
let hostMacros: Record<string, string> = {};

export function setHostKatexMacros(macros: Record<string, string>): void {
  hostMacros = macros;
}

export function getHostKatexMacros(): Record<string, string> {
  // KaTeX mutates the macros object while rendering (\def etc.); hand it a
  // copy so user renders can't leak state into each other.
  return { ...hostMacros };
}
