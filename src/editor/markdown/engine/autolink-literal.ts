/**
 * Where GFM finds extended autolinks in plain text (GFM spec §6.9): `www.`
 * and `http(s)://` URLs and email addresses, with or without `mailto:` or
 * `xmpp:`. The parser links them however their characters are escaped, so the
 * safe serializer writes these spans as typed and escapes only around them.
 * An approximation is caught, not corrected: a run that reads back otherwise is
 * reported unverified.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */

/** A URL: scheme or `www.`, a domain, then anything up to whitespace or `<`. */
const WEB = /(?:https?:\/\/|www\.)([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)[^\s<]*/giu;
/** An email address, with an optional scheme; `xmpp:` may carry a `/resource`. */
const EMAIL = /(?:mailto:|xmpp:)?[\w.+-]+@([\w-]+(?:\.[\w-]+)+)(?:\/[\w.@-]+)?/gu;

/**
 * Whether GFM may start an extended autolink after `previous` (empty at the
 * start): a URL with a scheme after anything but an ASCII letter, a `www.`
 * host after whitespace or one of `(*_[]~`, an email after anything but `/`
 * (the email pattern already starts after the last address character).
 */
function opensAfter(pattern: RegExp, url: string, previous: string): boolean {
  if (!previous) return true;
  if (pattern === EMAIL) return previous !== "/";
  return /^www\./iu.test(url) ? /[\s(*_[\]~]/u.test(previous) : !/[A-Za-z]/u.test(previous);
}
/** Trailing characters GFM leaves out of a link. */
const TRAILING = /[?!.,:*_~'"]$/u;
const TRAILING_ENTITY = /&[A-Za-z0-9]+;$/u;

/** The `[from, to)` spans of `text` that GFM reads as extended autolinks. */
export function autolinkLiteralSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const [pattern, trim] of [[WEB, trimUrl], [EMAIL, trimEmail]] as const) {
    for (const match of text.matchAll(pattern)) {
      const from = match.index;
      if (!opensAfter(pattern, match[0], text.charAt(from - 1))) continue;
      const domain = match[1]!;
      // GFM: no underscore in the last two domain labels, and at least one period for a URL.
      if (domain.split(".").slice(-2).some((label) => label.includes("_"))) continue;
      if (pattern === WEB && !domain.includes(".") && !/^www\./iu.test(match[0])) continue;
      // Trailing punctuation is not part of the link; what remains must still reach the domain.
      const value = trim(match[0]);
      if (value.length > match[0].indexOf(domain)) spans.push([from, from + value.length]);
    }
  }
  spans.sort((left, right) => left[0] - right[0]);
  // The two patterns can overlap (a URL whose path holds an `@`): keep the first.
  return spans.reduce<[number, number][]>((kept, span) => (
    kept.length && span[0] < kept[kept.length - 1]![1] ? kept : [...kept, span]
  ), []);
}

function trimUrl(value: string): string {
  for (;;) {
    if (TRAILING.test(value)) value = value.slice(0, -1);
    else if (TRAILING_ENTITY.test(value)) value = value.replace(TRAILING_ENTITY, "");
    else if (value.endsWith(")") && count(value, ")") > count(value, "(")) value = value.slice(0, -1);
    else return value;
  }
}

function trimEmail(value: string): string {
  const trimmed = value.replace(/\.+$/u, "");
  // An address ending in `-` or `_` is not linked at all.
  return /[-_]$/u.test(trimmed) ? "" : trimmed;
}

const count = (value: string, character: string) => value.split(character).length - 1;
