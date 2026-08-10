/**
 * Math — DIY renderer for the canonical `<Math>` block descriptor.
 *
 * Renders the descriptor's prop surface: `formula` (LaTeX source string,
 * required), `id` (deep-link anchor), `language` (forward-compat hint,
 * default `'latex'`). Block-only at ship — every existing canonical
 * descriptor is block / `mdxJsxFlowElement`-shaped, and `jsxInline` is
 * intentionally render-less, so a live-rendered inline math variant
 * would set a new precedent rather than follow one.
 *
 * KaTeX loads with the Visual Editor chunk. Virtualized reading keeps the
 * number of mounted formulas bounded, while synchronous rendering prevents a
 * source-placeholder-to-formula swap as a chunk approaches the viewport.
 *
 * On parse error: KaTeX runs with `throwOnError: false`, so invalid LaTeX
 * renders as the source string in a tagged error span (red underline). The
 * component never crashes — co-editor DoS would otherwise be a single
 * malformed `\foo` away.
 *
 * Storage-layer fidelity contract — no sanitization at the storage layer. KaTeX HTML output is
 * render-time and uses `dangerouslySetInnerHTML`. KaTeX's renderToString
 * sanitizes its own output (strict HTML allowlist, no script execution);
 * formula source bytes round-trip through the descriptor unchanged.
 */

import katex from 'katex';
import { getHostKatexMacros } from '@ok-app/shims/katex-macros';

interface MathProps {
  formula?: string;
  id?: string;
  language?: string;
}

/** Synchronous inside the already-lazy Visual Editor bundle. */
function KatexRender(props: { formula: string; id?: string }) {
  const html = katex.renderToString(props.formula, {
    displayMode: true,
    throwOnError: false,
    strict: 'ignore',
    macros: getHostKatexMacros(),
    trust: false,
  });
  return (
    <div
      className="math math-display"
      data-component-type="math"
      id={props.id}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Renders the formula source verbatim while the complete editor keeps an
 * offscreen formula deferred, and for descriptors with an empty `formula` prop. Empty formulas
 * are valid (just-inserted descriptor before the author types) — show a
 * zero-width placeholder rather than passing `''` to the renderer.
 */
function MathPlaceholder(props: { formula: string; id?: string }) {
  return (
    <div className="math math-placeholder" data-component-type="math" id={props.id}>
      {props.formula || ' '}
    </div>
  );
}

/**
 * DIY math view. Descriptor-dispatched via `componentMap['Math']`.
 *
 * Function name diverges from the descriptor name `Math` — biome's
 * `noShadowRestrictedNames` flags `Math` as shadowing the JS global, which
 * doesn't apply to `Image` / `Audio` / `Video` (DOM-only globals). The map
 * key stays `Math`; the implementation just gets a non-shadowing name.
 *
 * `language` is read for forward-compat but ignored at ship — KaTeX-only.
 * A future MathJax / Typst renderer would branch here.
 */
export function MathView(props: MathProps) {
  const formula = props.formula ?? '';
  return (
    <div className="math-viewport-boundary">
      {!formula ? (
        <MathPlaceholder formula={formula} id={props.id} />
      ) : (
        <KatexRender formula={formula} id={props.id} />
      )}
    </div>
  );
}
