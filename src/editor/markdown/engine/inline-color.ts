/** Foreground color is the only CSS declaration admitted from Markdown spans. */
let probe: CSSStyleDeclaration | undefined;

export function foregroundColor(value: unknown): string | null {
  if (typeof value !== "string" || typeof document === "undefined") return null;
  const color = value.trim();
  // A single, self-contained color. CSS-wide keywords and substitutions can
  // pass CSS syntax validation even when they supply no color of their own.
  if (!color || /[;"'<>\\!]|\/\*|\b(?:var|env|attr|url)\s*\(/i.test(color)
    || /^(?:inherit|initial|unset|revert|revert-layer|revert-rule)$/i.test(color)) return null;
  probe ??= document.createElement("span").style;
  probe.color = "";
  probe.color = color;
  return probe.color ? color : null;
}

export function spanColor(tag: string): string | null {
  const match = /^<span[ \t]+style[ \t]*=[ \t]*(["'])[ \t]*color[ \t]*:[ \t]*([^;"'<>]+?)[ \t]*;?[ \t]*\1[ \t]*>$/i.exec(tag);
  return foregroundColor(match?.[2]);
}

export const closeColorSpan = /^<\/span[ \t]*>$/i;
