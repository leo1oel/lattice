import { EditorView } from "@codemirror/view";
import type { PaperSummary } from "../app-types";
import { hasPaperDrag, paperMarkdownCitation, resolvePaperDrag } from "../papers/paper-drag";

type CitationEdit = { from: number; to: number; insert: string };

/** Snap to a key boundary instead of splitting a key under the pointer. */
export function latexCitationDrop(source: string, position: number, key: string): CitationEdit | null {
  if (!key || /[\s,{}\\%]/.test(key)) return null;
  const commands = /\\(?:[Cc]ite(?:p|t|alp|alt|author|year(?:par)?|num|url)?|[Pp]arencite|[Tt]extcite|[Aa]utocite|[Ff]ootcite|[Ss]martcite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/g;
  for (const match of source.matchAll(commands)) {
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
  return { from: position, to: position, insert: String.raw`~\citep{${key}}` };
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
