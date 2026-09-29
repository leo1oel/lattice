/**
 * Code block languages for the visual engine: what the language picker
 * offers, how an authored info-string language resolves to one of them, and
 * the fence metadata tokens Lattice reads and writes (spec R-FMT-8, R-BLK-5,
 * R-BLK-7, §11.6).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */

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
 * Offered in the picker, in this order after Plain text. Labels are proper
 * names, the same in every locale; Plain text's label is localized by the view.
 */
/* eslint-disable lingui/no-unlocalized-strings -- language names and info-string tokens are proper names and syntax */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { value: "text", label: "Plain text", aliases: ["plain", "plaintext", "txt"] },
  { value: "bash", label: "Bash", aliases: ["sh", "shell", "zsh", "console"], grammar: "bash" },
  { value: "c", label: "C", aliases: ["h"], grammar: "c" },
  { value: "cpp", label: "C++", aliases: ["c++", "cc", "hpp"], grammar: "cpp" },
  { value: "csharp", label: "C#", aliases: ["cs", "c#"], grammar: "csharp" },
  { value: "css", label: "CSS", grammar: "css" },
  { value: "diff", label: "Diff", aliases: ["patch"], grammar: "diff" },
  { value: "go", label: "Go", aliases: ["golang"], grammar: "go" },
  { value: "graphql", label: "GraphQL", aliases: ["gql"], grammar: "graphql" },
  { value: "html", label: "HTML", aliases: ["xml", "svg"], grammar: "xml" },
  { value: "java", label: "Java", grammar: "java" },
  { value: "javascript", label: "JavaScript", aliases: ["js", "jsx", "mjs", "cjs"], grammar: "javascript" },
  { value: "json", label: "JSON", aliases: ["jsonc", "json5"], grammar: "json" },
  { value: "kotlin", label: "Kotlin", aliases: ["kt"], grammar: "kotlin" },
  { value: "latex", label: "LaTeX", aliases: ["tex"], grammar: "latex" },
  { value: "lua", label: "Lua", grammar: "lua" },
  { value: "makefile", label: "Makefile", aliases: ["make"], grammar: "makefile" },
  { value: "markdown", label: "Markdown", aliases: ["md"], grammar: "markdown" },
  { value: "mermaid", label: "Mermaid" },
  { value: "php", label: "PHP", grammar: "php" },
  { value: "python", label: "Python", aliases: ["py", "python3"], grammar: "python" },
  { value: "r", label: "R", grammar: "r" },
  { value: "ruby", label: "Ruby", aliases: ["rb"], grammar: "ruby" },
  { value: "rust", label: "Rust", aliases: ["rs"], grammar: "rust" },
  { value: "scss", label: "SCSS", aliases: ["sass"], grammar: "scss" },
  { value: "sql", label: "SQL", grammar: "sql" },
  { value: "swift", label: "Swift", grammar: "swift" },
  { value: "toml", label: "TOML", aliases: ["ini"], grammar: "ini" },
  { value: "typescript", label: "TypeScript", aliases: ["ts", "tsx", "mts", "cts"], grammar: "typescript" },
  { value: "yaml", label: "YAML", aliases: ["yml"], grammar: "yaml" },
];
/* eslint-enable lingui/no-unlocalized-strings */

const byName = new Map<string, CodeLanguage>();
for (const language of CODE_LANGUAGES) {
  byName.set(language.value, language);
  for (const alias of language.aliases ?? []) byName.set(alias, language);
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
