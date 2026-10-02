import { EditorView } from "@codemirror/view";
import type { PaperSummary } from "../app-types";
import { hasPaperDrag, paperMarkdownCitation, resolvePaperDrag } from "../papers/paper-drag";

type CitationEdit = { from: number; to: number; insert: string };

/** Letters of scripts that separate words with spaces; Chinese or Japanese prose has no word to snap to. */
const WORD_CHARACTER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}]/u;
const isWordAt = (source: string, index: number) => WORD_CHARACTER.test(source.charAt(index));

/**
 * Where a citation dropped into prose goes: after the word under or before
 * the pointer, never inside it or after the space that follows it. A drop at
 * the start of the next word ("word |next") otherwise came out as
 * "word ~\citep{key}next": a doubled space before the tie and the citation
 * glued to the following word.
 */
function proseCitationPoint(source: string, position: number): number {
  let point = position;
  while (isWordAt(source, point - 1) && isWordAt(source, point)) point += 1;
  while (point > 0 && (source[point - 1] === " " || source[point - 1] === "\t")) point -= 1;
  return point;
}

const CITATION_COMMAND = /\\(?:[Cc]ite(?:p|t|alp|alt|author|year(?:par)?|num|url)?|[Pp]arencite|[Tt]extcite|[Aa]utocite|[Ff]ootcite|[Ss]martcite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/g;

/**
 * The key list of a live citation command at `position`, with `key` added at
 * the nearest key boundary; null when it already cites `key`, undefined when
 * no citation command is there.
 */
function citationMerge(source: string, position: number, key: string): CitationEdit | null | undefined {
  for (const match of source.matchAll(CITATION_COMMAND)) {
    const start = match.index;
    const end = start + match[0].length;
    // Both halves of the closing brace must merge: coordinate hit-testing
    // can resolve its right half to the boundary immediately after it.
    if (position < start || position > end) continue;
    // A commented-out command must not absorb a citation dropped in prose.
    const prefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
    if (/(^|[^\\])(?:\\\\)*%/.test(prefix)) continue;
    const from = end - match[1].length - 1;
    const keys = Array.from(match[1].matchAll(/[^,\s]+/g));
    const unique = [...new Set(keys.map((part) => part[0]))];
    if (unique.includes(key)) return null;
    const offset = position - from;
    const index = keys.findIndex((part) => offset <= part.index + part[0].length / 2);
    const before = keys.slice(0, index < 0 ? keys.length : index).map((part) => part[0]);
    const insertion = new Set([...before, key, ...keys.slice(before.length).map((part) => part[0])]);
    return { from, to: end - 1, insert: [...insertion].join(", ") };
  }
  return undefined;
}

/** Snap to a key boundary instead of splitting a key under the pointer. */
export function latexCitationDrop(source: string, dropPosition: number, key: string): CitationEdit | null {
  if (!key || /[\s,{}\\%]/.test(key)) return null;
  const merged = citationMerge(source, dropPosition, key);
  if (merged !== undefined) return merged;
  const position = proseCitationPoint(source, dropPosition);
  // A drop just past a citation and its space joins that citation.
  const adjacent = position === dropPosition ? undefined : citationMerge(source, position, key);
  if (adjacent !== undefined) return adjacent;
  // A tie binds the citation to the text it follows; at the start of a line
  // there is nothing to bind, and a word right after needs its space back.
  const tie = /[^\s([{]/.test(source.charAt(position - 1)) ? "~" : "";
  const space = isWordAt(source, position) ? " " : "";
  return { from: position, to: position, insert: `${tie}\\citep{${key}}${space}` };
}

export function paperDropExtension(path: string, getLibrary: () => { projectRoot: string; papers: readonly PaperSummary[] }) {
  return EditorView.domEventHandlers({
    dragover(event) {
      if (!hasPaperDrag(event.dataTransfer)) return false;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      return true;
    },
    drop(event, view) {
      if (!hasPaperDrag(event.dataTransfer)) return false;
      event.preventDefault();
      event.stopPropagation();
      const { projectRoot, papers } = getLibrary();
      const paper = resolvePaperDrag(event.dataTransfer, projectRoot, papers);
      if (!paper || view.state.readOnly || !view.state.facet(EditorView.editable)) return true;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return true;
      const edit = /\.tex$/i.test(path)
        ? latexCitationDrop(view.state.doc.toString(), position, paper.citationKey ?? "")
        : /\.md$/i.test(path)
          ? { from: position, to: position, insert: paperMarkdownCitation(path, paper) }
          : null;
      if (edit) {
        view.dispatch({ changes: edit, selection: { anchor: edit.from + edit.insert.length }, userEvent: "input.drop" });
        view.focus();
      }
      return true;
    },
  });
}
