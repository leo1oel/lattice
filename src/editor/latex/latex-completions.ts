/** Completion sources for citation keys, labels, project paths, and project macros. */
import { completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationCompletionRange, includeCompletionRange, referenceCompletionRange } from "./latex-symbols";
import { referenceKindLabel } from "./latex-text";
import { paperBylineAuthors } from "../../papers/paper-identity";

const GRAPHICS_FILE = /\.(png|jpe?g|pdf|svg|eps|webp)$/i;

export const textBefore = (state: EditorState, position: number, size = 600) =>
  state.sliceDoc(Math.max(0, position - size), position);

const matchesQuery = (query: string, ...fields: string[]) =>
  !query || fields.some((field) => field.toLocaleLowerCase().includes(query));

const KEY_CHARACTER = /[^,{}%\s]/;

/**
 * Where the key under the cursor ends, when the rest of the argument is a
 * key list that closes: keys separated by commas, with whitespace, line
 * breaks and `%` comments between them, then `}`. Anything else means the
 * `{` was left open before prose (the bracket pairing does not close one
 * typed before a word), so nothing after the cursor is replaced. The scan
 * stops at the first character that breaks that grammar.
 */
function keyEnd(doc: Text, position: number): number {
  let end = position;
  // After a comma a new key may start; after a key or gap only `,` or `}`
  // may follow, so another word there is prose.
  let state: "cursorKey" | "afterComma" | "laterKey" | "awaitingSeparator" = "cursorKey";
  let inComment = false;
  for (const chunks = doc.iterRange(position); !chunks.next().done;) {
    for (const character of chunks.value) {
      if (inComment) {
        inComment = character !== "\n";
        continue;
      }
      if (KEY_CHARACTER.test(character)) {
        if (state === "awaitingSeparator") return position;
        if (state === "cursorKey") end += character.length;
        else state = "laterKey";
        continue;
      }
      if (character === "}") return end;
      if (state === "cursorKey" || state === "laterKey") state = "awaitingSeparator";
      if (character === ",") state = "afterComma";
      else if (character === "%") inComment = true;
      else if (!/\s/.test(character)) return position;
    }
  }
  return position;
}

export function citationCompletions(live: () => LatexEditorLiveData) {
  return (context: CompletionContext): CompletionResult | null => {
    const range = citationCompletionRange(textBefore(context.state, context.pos), context.pos);
    if (!range) return null;
    const { citations, citationKeys } = live();
    const query = range.query.toLocaleLowerCase();
    // Clicking inside an existing key must replace its suffix too, but only
    // a key the argument goes on to close or separate. The bracket pairing
    // leaves a `{` typed before a word open, and that prose is not a key.
    return {
      from: range.from,
      to: keyEnd(context.state.doc, context.pos),
      // We filter titles as well as keys. CodeMirror's default label-only
      // filter would discard title matches; recompute on each edit instead.
      filter: false,
      options: (citations.length ? citations : citationKeys.map((key) => ({ key, title: "", authors: "", year: "", venue: "" })))
        .filter((citation) => matchesQuery(query, citation.key, citation.title))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((citation) => ({
          label: citation.key,
          // Display the paper title, but keep the actual completion text a key.
          displayLabel: citation.title || citation.key,
          type: "citation",
          detail: [citation.title ? citation.key : "", paperBylineAuthors({ authors: citation.authors }), citation.year, citation.venue]
            .filter(Boolean).join(", ") || undefined,
        })),
    };
  };
}

export function referenceCompletions(live: () => LatexEditorLiveData) {
  return (context: CompletionContext): CompletionResult | null => {
    const range = referenceCompletionRange(textBefore(context.state, context.pos), context.pos);
    if (!range) return null;
    const query = range.query.toLocaleLowerCase();
    return {
      from: range.from,
      options: live().references
        .filter((reference) => matchesQuery(query, reference.label, reference.title))
        .map((reference) => ({ label: reference.label, type: "variable", detail: referenceKindLabel(reference.kind), info: reference.title || undefined })),
      validFor: /^[^,}\s]*$/,
    };
  };
}

export function includeCompletions(live: () => LatexEditorLiveData) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = textBefore(context.state, context.pos);
    const range = includeCompletionRange(before, context.pos);
    if (!range) return null;
    const { projectPaths, graphicsRoots } = live();
    const graphics = before.includes("\\includegraphics");
    const details = new Map<string, string>();
    const figure = referenceKindLabel("figure");
    for (const path of projectPaths) {
      if (!graphics) {
        if (path.endsWith(".tex")) details.set(path, "tex");
        continue;
      }
      if (!GRAPHICS_FILE.test(path)) continue;
      details.set(path, figure);
      for (const root of graphicsRoots) {
        if (path.startsWith(`${root}/`)) details.set(path.slice(root.length + 1), "graphicspath");
      }
    }
    const query = range.query.toLocaleLowerCase();
    return {
      from: range.from,
      options: [...details]
        .filter(([path]) => matchesQuery(query, path))
        .map(([path, detail]) => ({ label: path, type: "text", detail })),
      validFor: /^[^}]*$/,
    };
  };
}

export function macroCompletions(live: () => LatexEditorLiveData) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\\[A-Za-z@]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const query = word.text.toLocaleLowerCase();
    const options: Completion[] = live().localMacros
      .filter((macro) => macro.label.toLocaleLowerCase().includes(query))
      .map(({ label, type, detail }) => ({ label, type, detail }));
    return options.length ? { from: word.from, options, validFor: /^\\?[A-Za-z@]*$/ } : null;
  };
}

// eslint-disable-next-line lingui/no-unlocalized-strings -- SVG markup
const CITATION_ICON = '<svg class="cm-citation-icon" viewBox="0 0 24 24" aria-hidden="true">'
  // eslint-disable-next-line lingui/no-unlocalized-strings -- SVG markup
  + '<path d="M12 7v14m0-14C9 4 5 4 2 5v15c3-1 7-1 10 1 3-2 7-2 10-1V5c-3-1-7-1-10 2Z"/></svg>';

export function citationIcon(completion: Completion): Node | null {
  if (completion.type !== "citation") return null;
  const template = document.createElement("template");
  template.innerHTML = CITATION_ICON;
  return template.content.firstChild;
}

export function openCitationAtCursor(view: EditorView) {
  const { empty, head } = view.state.selection.main;
  if (!view.hasFocus || !empty || completionStatus(view.state) !== null) return;
  if (citationCompletionRange(textBefore(view.state, head), head)) startCompletion(view);
}
