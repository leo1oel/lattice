/**
 * A .bib reference list beside its source in Split, kept in step with it as
 * SyncTeX keeps the PDF with its source: the reference under the source's
 * cursor comes to the front of the list (`onFollow`), and the returned
 * `showInSource` selects and marks a reference in the source, keeping the
 * keyboard where it was (editor-reveal.ts).
 */
import { useEffect, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { useLatestRef } from "../hooks/use-latest-ref";
import { revealInEditor } from "../editor/editor-reveal";
import { readBibDocument } from "./bib-document";
import type { Row } from "./bib-entry-detail";

/** The row whose entry holds `offset`, by the offsets `rows` were read with; none between entries. */
function rowAt(rows: Row[], offset: number): Row | undefined {
  let low = 0;
  let high = rows.length - 1;
  let found: Row | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].entry.from <= offset) {
      found = rows[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  return found && offset <= found.entry.to ? found : undefined;
}

export function useBibSourceSync({ sourceView, cursorRef, rows, selectedKey, onFollow }: {
  /** The source editor beside the list; none outside Split. */
  sourceView: EditorView | null | undefined;
  /** The slot the source editor's every update calls (DocumentCanvas's cursor reveal). */
  cursorRef: RefObject<(() => void) | null> | undefined;
  /** The list's rows, in file order, and the key of the one in front. */
  rows: Row[];
  selectedKey: string | null;
  /** Bring the reference `key` to the front and into view. */
  onFollow: (key: string) => void;
}) {
  const followRef = useLatestRef({ rows, selectedKey, onFollow });
  useEffect(() => {
    if (!sourceView || !cursorRef) return;
    let head = -1;
    let timer = 0;
    const follow = () => {
      const { rows: current, selectedKey: inFront, onFollow: bring } = followRef.current;
      const key = rowAt(current, sourceView.state.selection.main.head)?.entry.key;
      if (key !== undefined && key !== inFront) bring(key);
    };
    const onCursor = () => {
      if (sourceView.state.selection.main.head === head) return;
      head = sourceView.state.selection.main.head;
      // The writer's own motion only: not a view restored unfocused, nor this list's own mark in it.
      if (!sourceView.hasFocus) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(follow, 80);
    };
    cursorRef.current = onCursor;
    return () => {
      window.clearTimeout(timer);
      if (cursorRef.current === onCursor) cursorRef.current = null;
    };
  }, [cursorRef, followRef, sourceView]);
  return (key: string) => {
    // Found in the source as it is now: the list may be drawn from an older copy.
    const entry = sourceView && readBibDocument(sourceView.state.doc.toString()).document?.entries.find((item) => item.key === key);
    if (sourceView && entry) revealInEditor(sourceView, { from: entry.from, to: entry.to }, { focus: false });
  };
}
