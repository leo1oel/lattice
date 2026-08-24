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
const LEGACY_FONT_MACROS: Record<string, string> = {
  // KaTeX supports the other LaTeX 2.09 font declarations (\rm, \sf, \tt,
  // \bf, \it) directly. Its fonts have no small-caps or separate slanted
  // face, so preserve declaration scope while falling back to the nearest
  // available face instead of rendering the command as a red parse error.
  '\\sc': '\\rm',
  '\\sl': '\\it',
};

let hostMacros: Record<string, string> = {};

export function setHostKatexMacros(macros: Record<string, string>): void {
  hostMacros = macros;
}

export function getHostKatexMacros(): Record<string, string> {
  // KaTeX mutates the macros object while rendering (\def etc.); hand it a
  // copy so user renders can't leak state into each other. Document macros
  // win so an authored \renewcommand remains authoritative.
  return { ...LEGACY_FONT_MACROS, ...hostMacros };
}
