import { useLayoutEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import type { EditorView } from "@codemirror/view";
import { Textarea } from "../components/ui/textarea";
import { resolveCommentAnchor } from "../editor/comments/editor-comments";
import { clamp } from "../settings/app-settings";

export type CommentDraft = {
  path: string;
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  error: string | null;
};

/**
 * The popover for a new source-editor comment, pinned beside the text it quotes
 * while the editor scrolls. `anchorKey` names the document and editor instance.
 */
export function CommentComposer({ draft, view, anchorKey, onBodyChange, onCancel, onSave }: {
  draft: CommentDraft;
  view: EditorView | null;
  anchorKey: string;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useLingui();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const host = view?.dom.closest(".source-editor");
    if (!view || !popup || !host) return;
    let frame: number | null = null;
    let above: boolean | undefined;
    const reposition = () => {
      const range = resolveCommentAnchor(view.state.doc.toString(), draftRef.current);
      const anchor = range && view.coordsAtPos(range.from);
      const bounds = host.getBoundingClientRect();
      const viewport = view.scrollDOM.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport.top);
      const bottom = Math.min(bounds.bottom, viewport.bottom);
      if (!anchor || anchor.bottom <= top || anchor.top >= bottom) {
        // Keep the mounted textarea and draft, but never pin it to a viewport edge.
        popup.style.visibility = "hidden";
        return;
      }
      const width = Math.min(320, Math.max(0, bounds.width - 16));
      Object.assign(popup.style, { visibility: "visible", width: `${width}px` });
      // Choose a side once so scrolling cannot make the draft jump across its text.
      if (above === undefined) above = bottom - anchor.bottom - 8 < popup.offsetHeight && anchor.top - top > bottom - anchor.bottom;
      Object.assign(popup.style, {
        left: `${clamp(anchor.left - bounds.left, 8, Math.max(8, bounds.width - width - 8))}px`,
        top: `${(above ? anchor.top - 8 : anchor.bottom + 8) - bounds.top}px`,
        translate: above ? "0 -100%" : "none",
        maxHeight: `${Math.max(0, Math.min(280, above ? anchor.top - top - 8 : bottom - anchor.bottom - 8))}px`,
      });
    };
    const scheduleReposition = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        reposition();
      });
    };
    reposition();
    const observer = new ResizeObserver(scheduleReposition);
    observer.observe(host);
    observer.observe(view.contentDOM);
    const listening = new AbortController();
    window.addEventListener("scroll", scheduleReposition, { capture: true, signal: listening.signal });
    window.addEventListener("resize", scheduleReposition, { signal: listening.signal });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      listening.abort();
    };
  }, [anchorKey, view]);
  return (
    <div
      ref={popupRef}
      className="editor-comment-popover"
      style={{ bottom: "auto", right: "auto" }}
      role="dialog"
      aria-label={t`Add comment`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <p className="editor-comment-quote">{draft.quote}</p>
      <Textarea
        autoFocus
        rows={3}
        placeholder={t`Leave a comment for collaborators…`}
        value={draft.body}
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSave();
          }
        }}
      />
      {draft.error && <p role="alert" className="visual-node-source-error">{draft.error}</p>}
      <div className="editor-comment-popover-actions">
        <button type="button" onClick={onCancel}>{t`Cancel`}</button>
        <button type="button" className="primary" disabled={!draft.body.trim()} onClick={onSave}>
          {t`Add comment`}
        </button>
      </div>
    </div>
  );
}
