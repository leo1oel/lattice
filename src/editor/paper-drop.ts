import { EditorView } from "@codemirror/view";
import type { PaperSummary } from "../app-types";
import { hasPaperDrag, PAPER_DRAG_TYPE, paperMarkdownCitation, resolvePaperDrag } from "../papers/paper-drag";
import { dropPoint } from "./drop-cursor";

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

/** The key list `from`–`to` of a citation command, with the key boundary `index` a new key joins at, document position `at`. */
type CitationList = { from: number; to: number; keys: string[]; index: number; at: number };

/** The key list of a live citation command at `position`, split at the nearest key boundary. */
function citationList(source: string, position: number): CitationList | undefined {
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
    const parts = Array.from(match[1].matchAll(/[^,\s]+/g));
    const offset = position - from;
    const found = parts.findIndex((part) => offset <= part.index + part[0].length / 2);
    const index = found < 0 ? parts.length : found;
    const last = parts.at(-1);
    const at = from + (found >= 0 ? parts[found].index : last ? last.index + last[0].length : 0);
    return { from, to: end - 1, keys: parts.map((part) => part[0]), index, at };
  }
  return undefined;
}

/** Where a citation dropped at `dropPosition` goes: a citation list there or just before it, else a word end. */
function latexCitationPoint(source: string, dropPosition: number): { at: number; list?: CitationList } {
  const list = citationList(source, dropPosition);
  if (list) return { at: list.at, list };
  const position = proseCitationPoint(source, dropPosition);
  // A drop just past a citation and its space joins that citation.
  const adjacent = position === dropPosition ? undefined : citationList(source, position);
  return adjacent ? { at: adjacent.at, list: adjacent } : { at: position };
}

/** Snap to a key boundary instead of splitting a key under the pointer. */
export function latexCitationDrop(source: string, dropPosition: number, key: string): CitationEdit | null {
  if (!key || /[\s,{}\\%]/.test(key)) return null;
  const { at, list } = latexCitationPoint(source, dropPosition);
  if (list) {
    if (list.keys.includes(key)) return null;
    const keys = new Set([...list.keys.slice(0, list.index), key, ...list.keys.slice(list.index)]);
    return { from: list.from, to: list.to, insert: [...keys].join(", ") };
  }
  // A tie binds the citation to the text it follows; at the start of a line
  // there is nothing to bind, and a word right after needs its space back.
  const tie = /[^\s([{]/.test(source.charAt(at - 1)) ? "~" : "";
  const space = isWordAt(source, at) ? " " : "";
  return { from: at, to: at, insert: `${tie}\\citep{${key}}${space}` };
}

/** Sentence punctuation a claim may end on; the citation goes before it, as "claim~\citep{key}." */
const CLOSING_PUNCTUATION = /[.,;:!?。，；：！？]/;

/**
 * The citation for a claim at `[from, to)` of `source`, after its last word:
 * before the full stop or comma that ends it, and into the citation list
 * that already follows it (after a space or a tie) rather than beside it.
 * Null when that list already cites `key`.
 */
export function latexCitationAfter(source: string, from: number, to: number, key: string): CitationEdit | null {
  let end = to;
  while (end > from && /\s/.test(source[end - 1])) end -= 1;
  if (end > from && CLOSING_PUNCTUATION.test(source[end - 1]) && source[end - 2] !== "\\") end -= 1;
  while (end > from && /\s/.test(source[end - 1])) end -= 1;
  let next = end;
  while (next < source.length && /[ \t~]/.test(source[next])) next += 1;
  const following = new RegExp(CITATION_COMMAND.source, "y");
  following.lastIndex = next;
  const command = following.exec(source);
  // Before its closing brace, so the key joins the end of that list.
  if (command) return latexCitationDrop(source, next + command[0].length - 1, key);
  return latexCitationDrop(source, end, key);
}

/**
 * Where the drop caret goes for a citation dropped at `dropPosition`: where
 * `latexCitationDrop` puts the key, or null when that drop inserts nothing.
 * Without a key (a browser hides a drag's data until it drops) only the place is known.
 */
function latexCitationCaret(source: string, dropPosition: number, key?: string): number | null {
  if (key !== undefined && !latexCitationDrop(source, dropPosition, key)) return null;
  return latexCitationPoint(source, dropPosition).at;
}

/**
 * The lines around `position`, from a line start: a citation command a drop
 * joins and the word it snaps past are never further away, and a drag must
 * not copy and scan a whole thesis on every move.
 */
function dropContext(view: EditorView, position: number) {
  const { doc } = view.state;
  const line = doc.lineAt(position).number;
  const from = doc.line(Math.max(1, line - 5)).from;
  return { from, source: doc.sliceString(from, doc.line(Math.min(doc.lines, line + 5)).to) };
}

export function paperDropExtension(path: string, getLibrary: () => { projectRoot: string; papers: readonly PaperSummary[] }) {
  const tex = /\.tex$/i.test(path);
  const markdown = /\.md$/i.test(path);
  const writable = (view: EditorView) => !view.state.readOnly && view.state.facet(EditorView.editable);
  return [
    dropPoint.of((view, event, pointer) => {
      const data = event.dataTransfer;
      if (!hasPaperDrag(data)) return undefined;
      if (!writable(view) || !(tex || markdown)) return null;
      const { projectRoot, papers } = getLibrary();
      const paper = resolvePaperDrag(data, projectRoot, papers);
      // A browser hides the paper until the drop, so the caret then shows
      // where it would go; the native bridge's transfer names it at once.
      const hidden = !paper && !data?.getData(PAPER_DRAG_TYPE) && !data?.getData("text/plain");
      if (!paper && !hidden) return null;
      if (!tex) return pointer;
      const { from, source } = dropContext(view, pointer);
      const caret = latexCitationCaret(source, pointer - from, paper ? paper.citationKey ?? "" : undefined);
      return caret === null ? null : from + caret;
    }),
    EditorView.domEventHandlers({
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
        if (!paper || !writable(view)) return true;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return true;
        let edit: CitationEdit | null = null;
        if (tex) {
          const { from, source } = dropContext(view, position);
          const citation = latexCitationDrop(source, position - from, paper.citationKey ?? "");
          if (citation) edit = { from: from + citation.from, to: from + citation.to, insert: citation.insert };
        } else if (markdown) edit = { from: position, to: position, insert: paperMarkdownCitation(path, paper) };
        if (edit) {
          view.dispatch({ changes: edit, selection: { anchor: edit.from + edit.insert.length }, userEvent: "input.drop" });
          view.focus();
        }
        return true;
      },
    }),
  ];
}
