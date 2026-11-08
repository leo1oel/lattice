/**
 * The writer's own editor typography: a face, size and line height for the
 * source editor (CodeMirror, .tex/.md/code) and for the visual Markdown
 * editor. An empty face and the default numbers leave the CSS tokens in
 * styles/theme.css untouched, so nobody sees a change until they choose one.
 *
 * Loaded at startup by use-appearance.ts, so it holds only what applying a
 * choice needs; Settings' face lists live in editor-font-settings.tsx.
 */

export const SOURCE_LINE_HEIGHT = 1.6;
export const PROSE_FONT_SIZE = 14;
export const PROSE_LINE_HEIGHT = 1.7;
export const FONT_SIZE_RANGE = [10, 28] as const;
export const LINE_HEIGHT_RANGE = [1.2, 2.4] as const;

/** CSS generic families, which must stay unquoted to mean the system face. */
/* eslint-disable lingui/no-unlocalized-strings -- CSS keywords and declarations */
const GENERIC_FAMILIES = new Set(["ui-monospace", "ui-serif", "ui-sans-serif", "ui-rounded", "system-ui", "monospace", "serif", "sans-serif"]);

/**
 * A stored face name as one CSS family: quoted (so a name like "Fira Code"
 * or one with digits is never read as keywords), or a bare generic.
 */
export function cssFontFamily(name: string): string {
  return GENERIC_FAMILIES.has(name) ? name : `"${name}"`;
}

/**
 * Normalizes a stored face name. Quotes, backslashes and characters that
 * could close the declaration are dropped rather than escaped: no font
 * family needs them, and the name is written into an inline style.
 */
export function normalizeFontName(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this strips
  return typeof value === "string" ? value.replace(/["'\\;{}<>\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
}

/** A face chosen in Settings, falling back through the default stack the token names. */
export function editorFontStack(name: string, fallbackToken: string): string {
  return `${cssFontFamily(name)}, var(${fallbackToken})`;
}
/* eslint-enable lingui/no-unlocalized-strings */

/** Line heights move in steps of 0.05, inside LINE_HEIGHT_RANGE. */
export function normalizeLineHeight(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const [minimum, maximum] = LINE_HEIGHT_RANGE;
  return Math.round(Math.min(maximum, Math.max(minimum, number)) * 20) / 20;
}
