/**
 * CodeMirror language resolution for the plain-text editor.
 *
 * Kept out of `document-canvas.tsx` so that file exports components only and
 * keeps Fast Refresh. The caches here are module state on purpose: they must
 * survive editor remounts, so a revisited file is parsed with its language on
 * the first frame instead of being reconfigured a moment later.
 */
import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { bibtex } from "codemirror-lang-bib";
import { isHtmlFilePath } from "../app-utils";

/** Shared empty array: a new `[]` per call would reconfigure CodeMirror needlessly. */
export const EMPTY_EXTENSIONS: Extension[] = [];
const BIBTEX_EXTENSIONS: Extension[] = [bibtex({
  enableLinting: false,
  enableTooltips: true,
  enableAutocomplete: true,
  autoCloseBrackets: true,
})];
const gitignoreParser: StreamParser<{ atLineStart: boolean }> = {
  startState: () => ({ atLineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.atLineStart = true;
    if (stream.eatSpace()) return null;
    if (state.atLineStart && stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (state.atLineStart && stream.peek() === "!") {
      state.atLineStart = false;
      stream.next();
      return "operator";
    }
    state.atLineStart = false;
    if (stream.peek() === "\\") {
      stream.next();
      stream.next();
      return "escape";
    }
    if (stream.match(/^[*?]+/)) return "regexp";
    if (stream.peek() === "[") {
      stream.next();
      stream.skipTo("]");
      stream.next();
      return "regexp";
    }
    if (stream.peek() === "/") {
      stream.next();
      return "operator";
    }
    stream.eatWhile((character) => !"\\*?[/".includes(character));
    return "string";
  },
  languageData: { commentTokens: { line: "#" } },
};
const GITIGNORE_EXTENSIONS: Extension[] = [
  new LanguageSupport(StreamLanguage.define(gitignoreParser)),
];
// These are CSS custom-property references consumed by CodeMirror, not text
// shown to the user.
/* eslint-disable lingui/no-unlocalized-strings */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syntax-function)", fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--syntax-variable-special)" },
  { tag: [tags.monospace, tags.string], color: "var(--syntax-string)" },
  { tag: tags.quote, color: "var(--syntax-comment-doc)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--syntax-keyword)" },
  { tag: tags.contentSeparator, color: "var(--syntax-bracket)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
]);
/* eslint-enable lingui/no-unlocalized-strings */
/** Starts `load` on first call and shares its promise afterwards. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => (promise ??= load());
}

const loadMarkdownExtensions = once(() => Promise.all([
  import("@codemirror/lang-markdown"),
  import("@codemirror/language-data"),
]).then(([{ markdown }, { languages }]): Extension[] => [
  markdown({ codeLanguages: languages }),
  syntaxHighlighting(markdownHighlightStyle),
]));

const loadHtmlExtensions = once(() => import("@codemirror/lang-html").then(({ html }): Extension[] => [html()]));

/**
 * Languages already resolved this session, keyed by file extension.
 *
 * Without this, opening a file whose language loads asynchronously mounts the
 * editor with no language and reconfigures it a moment later, so the document
 * is parsed twice on every visit — expensive for Markdown, whose parser is
 * configured with the whole nested code-language table.
 */
const resolvedLanguageExtensions = new Map<string, Extension[]>();

function languageCacheKey(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase();
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : filename;
}

export function immediateTextLanguageExtensions(path: string): Extension[] {
  if (/\.bib$/i.test(path)) return BIBTEX_EXTENSIONS;
  if (/(?:^|\/)\.gitignore$/i.test(path)) return GITIGNORE_EXTENSIONS;
  return resolvedLanguageExtensions.get(languageCacheKey(path)) ?? EMPTY_EXTENSIONS;
}

/** Load the CodeMirror language associated with a project filename. */
export async function loadTextLanguageExtensions(path: string): Promise<Extension[]> {
  const immediate = immediateTextLanguageExtensions(path);
  if (immediate.length > 0) return immediate;
  const remember = (extensions: Extension[]) => {
    // Empty means "no language matched"; caching that would be harmless but
    // pointless, and it keeps `immediate.length > 0` meaning "already known".
    if (extensions.length > 0) resolvedLanguageExtensions.set(languageCacheKey(path), extensions);
    return extensions;
  };
  if (/\.md$/i.test(path)) return loadMarkdownExtensions().then(remember);
  if (isHtmlFilePath(path)) return loadHtmlExtensions().then(remember);

  const { languages } = await import("@codemirror/language-data");
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const description = LanguageDescription.matchFilename(languages, filename)
    ?? LanguageDescription.matchFilename(languages, filename.toLowerCase());
  return description ? remember([await description.load()]) : EMPTY_EXTENSIONS;
}
