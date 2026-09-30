/**
 * Code block languages for the visual engine: what the language picker
 * offers, how an authored info-string language resolves to one of them, and
 * the fence metadata tokens Lattice reads and writes (spec R-FMT-8, R-BLK-5,
 * R-BLK-7, §11.6).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import hljsCore from "highlight.js/lib/core";
import latex from "highlight.js/lib/languages/latex";
import { common } from "lowlight";

export type CodeLanguage = {
  /** Written into the info string when picked. */
  value: string;
  label: string;
  /** Other spellings authors use for the same language. */
  aliases?: string[];
  /** The lowlight grammar that highlights it, if any. */
  grammar?: string;
};

/**
 * The picker's languages, in order, by highlight.js grammar name. Everything
 * else (display names and the spellings an info string may use) is read from
 * highlight.js's own registration of each grammar, so only Lattice's choices
 * live here: which languages the picker offers, the token a pick writes when
 * it differs from the grammar name, a label where highlight.js's name is not
 * the one Lattice shows, and spellings Lattice accepts that highlight.js does
 * not register.
 */
/* eslint-disable lingui/no-unlocalized-strings -- grammar names, info-string tokens and proper names */
type PickerEntry = { grammar: string; writes?: string; label?: string; aliases?: string[] };
/** Rendered by Lattice rather than highlighted (R-BLK-5), so highlight.js does not know it. */
const MERMAID: CodeLanguage = { value: "mermaid", label: "Mermaid" };
const PICKER: readonly (PickerEntry | CodeLanguage)[] = [
  { grammar: "plaintext", writes: "text", aliases: ["plain"] },
  { grammar: "bash", aliases: ["shell", "console"] }, { grammar: "c" }, { grammar: "cpp" }, { grammar: "csharp" }, { grammar: "css" },
  { grammar: "diff" }, { grammar: "go" }, { grammar: "graphql" },
  { grammar: "xml", writes: "html", label: "HTML" },
  { grammar: "java" }, { grammar: "javascript" }, { grammar: "json", aliases: ["json5"] }, { grammar: "kotlin" },
  { grammar: "latex" }, { grammar: "lua" }, { grammar: "makefile" }, { grammar: "markdown" },
  MERMAID, { grammar: "php", label: "PHP" }, { grammar: "python", aliases: ["python3"] }, { grammar: "r" }, { grammar: "ruby" },
  { grammar: "rust" }, { grammar: "scss", aliases: ["sass"] }, { grammar: "sql" }, { grammar: "swift" },
  { grammar: "ini", writes: "toml", label: "TOML" },
  { grammar: "typescript" }, { grammar: "yaml" },
];
/* eslint-enable lingui/no-unlocalized-strings */

const registry = hljsCore.newInstance();
for (const [name, grammar] of Object.entries({ ...common, latex })) registry.registerLanguage(name, grammar);

function fromRegistry({ grammar, writes, label, aliases: extra = [] }: PickerEntry): CodeLanguage {
  const registered = registry.getLanguage(grammar);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a build-time invariant, never shown to readers
  if (!registered) throw new Error(`highlight.js has no ${grammar} grammar`);
  const value = writes ?? grammar;
  const aliases = [...new Set([grammar, ...(registered.aliases ?? []), ...extra])].filter((alias) => alias !== value);
  // Plain text has nothing to highlight.
  return { value, label: label ?? registered.name ?? grammar, aliases, grammar: grammar === "plaintext" ? undefined : grammar };
}

/** Offered in the picker, in this order. Plain text's label is localized by the view. */
export const CODE_LANGUAGES: readonly CodeLanguage[] = PICKER.map((entry) => ("value" in entry ? entry : fromRegistry(entry)));

const byName = new Map<string, CodeLanguage>();
for (const language of CODE_LANGUAGES) {
  byName.set(language.value, language);
  for (const alias of language.aliases ?? []) if (!byName.has(alias)) byName.set(alias, language);
}

/** The language an authored info-string token names, or null for plain or unknown text. */
export function resolveCodeLanguage(authored: string | null | undefined): CodeLanguage | null {
  if (!authored) return null;
  return byName.get(authored.toLowerCase()) ?? null;
}

/**
 * The label for an authored language: its proper name when Lattice knows it,
 * else the authored token itself; plain text gets the caller's localized label.
 */
export function codeLanguageLabel(authored: string | null | undefined, plainText: string): string {
  const language = resolveCodeLanguage(authored);
  if (!authored || language?.value === "text") return plainText;
  return language?.label ?? authored;
}

/**
 * Mermaid renders only from a plain, exactly spelled fence: nonstandard
 * casing, tilde fences, and longer or unbalanced fences stay code (R-BLK-5).
 */
export function rendersMermaid(attrs: { language?: unknown; fence?: unknown; closeFence?: unknown }): boolean {
  if (attrs.language !== "mermaid") return false;
  const fence = (attrs.fence as string | null) ?? "```";
  const close = (attrs.closeFence as string | null) ?? fence;
  return fence === "```" && close === "```";
}

// --- Fence metadata ---------------------------------------------------------

const TITLE = /(^|\s)title=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
const WIDTH = /(^|\s)w=(\d+)px(?=\s|$)/;

/** The `title="…"` of an info string's metadata. */
export function metaTitle(meta: string | null | undefined): string {
  const match = meta?.match(TITLE);
  if (!match) return "";
  return (match[2] ?? match[3] ?? match[4] ?? "").replace(/\\(["\\])/g, "$1");
}

/** `meta` with its title replaced (or added at the end, or removed when empty). */
export function withMetaTitle(meta: string | null | undefined, title: string): string | null {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- info-string syntax
  const token = title ? `title="${title.replace(/(["\\])/g, "\\$1")}"` : "";
  return replaceToken(meta, TITLE, token);
}

/** The `w=<n>px` preview width of an info string's metadata, or null. */
export function metaWidth(meta: string | null | undefined): number | null {
  const match = meta?.match(WIDTH);
  return match ? Number(match[2]) : null;
}

/** `meta` with its preview width replaced (or added, or removed when null). Height is never written. */
export function withMetaWidth(meta: string | null | undefined, width: number | null): string | null {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- info-string syntax
  return replaceToken(meta, WIDTH, width ? `w=${Math.round(width)}px` : "");
}

function replaceToken(meta: string | null | undefined, pattern: RegExp, token: string): string | null {
  const current = meta ?? "";
  const match = current.match(pattern);
  let next: string;
  if (!match) {
    next = token ? `${current}${current ? " " : ""}${token}` : current;
  } else if (token) {
    const start = match.index! + match[1]!.length;
    next = `${current.slice(0, start)}${token}${current.slice(match.index! + match[0].length)}`;
  } else {
    // Removing a token also removes the space that separated it.
    next = `${current.slice(0, match.index!)}${current.slice(match.index! + match[0].length)}`.replace(/^\s+/, "");
  }
  return next || null;
}
