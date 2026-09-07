/**
 * Canonical set of jsxComponent descriptor names that participate in
 * the `align`-based positioning pipeline — `text-align` on the wrapper,
 * FLIP-animated transitions, and the chrome-bar alignment trio.
 * JsxComponentView uses the same set for its data-align default clamp,
 * render condition, and click-handler selection check.
 *
 * The descriptor's own `align` PropDef in
 * `packages/core/src/registry/built-ins.ts` is a separate concern —
 * adding the prop is what makes the chrome-bar / PropPanel render the
 * dropdown; adding the descriptor name here is what makes the gate
 * predicates recognize it.
 */
export const ALIGNABLE_DESCRIPTOR_NAMES = new Set<string>([
  'img',
  'CommonMarkImage',
  'Embed',
  'video',
]);
