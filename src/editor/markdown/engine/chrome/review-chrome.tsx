/**
 * Review in the visual engine (spec R-SRC-5–9):
 *
 * - A comment highlight shows its thread on hover or focus. The card stays
 *   while the pointer moves onto it; Escape, a scroll, a click or unmounting
 *   closes it, and a click opens the thread.
 * - A tracked change offers "Suggested change" with its author and Accept or
 *   Reject. Opened by hovering, it survives the pointer crossing the gap to
 *   it; opened with Enter, it takes focus and gives it back on Escape.
 * - "Comment" opens "Add comment" for the selection, which stays marked while
 *   the comment is written and follows edits made meanwhile. The comment is
 *   anchored in Markdown offsets; a selection with no exact place, or whose
 *   text changed, is refused with a message.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the Comment request and the composer it opens belong together */
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { AllSelection } from "@tiptap/pm/state";
import type { TrackedChange } from "../../../../overleaf/use-overleaf-realtime";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Button } from "../../../../components/ui/button";
import { hueColor } from "../../../../components/ui/collab-colors";
import { Textarea } from "../../../../components/ui/textarea";
import { buildCommentTooltipDom } from "../../../comments/editor-comments";
import { commentCardId, commentDraft, setCommentDraft } from "../source-overlays";
import { useChromeRequest, type ChromeHost } from "./chrome-host";

function place(element: HTMLElement, anchor: { getBoundingClientRect: () => DOMRect }, placement: "top" | "bottom" = "top") {
  void computePosition(anchor, element, {
    placement,
    strategy: "fixed",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  });
}

const markOf = (target: EventTarget | null, attribute: string) =>
  (target instanceof Element ? target.closest<HTMLElement>(`[${attribute}]`) : null);

/** The thread card for the comment highlight under the pointer or focus. */
export function CommentCard({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const [open, setOpen] = useState<{ id: string; mark: HTMLElement } | null>(null);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  // The highlight names this card in its own attributes (R-SRC-7): the editor draws it, so it is never touched here.
  const id = open ? commentCardId(open.id) : "";

  useEffect(() => {
    const surface = editor.view.dom;
    const show = (event: Event) => {
      const mark = markOf(event.target, "data-lx-comment");
      if (mark) setOpen({ id: mark.dataset.lxComment!, mark });
    };
    const leave = (event: MouseEvent) => {
      const mark = markOf(event.target, "data-lx-comment");
      const next = event.relatedTarget as Node | null;
      if (!mark || (next && (mark.contains(next) || document.getElementById(commentCardId(mark.dataset.lxComment!))?.contains(next)))) return;
      setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && markOf(event.target, "data-lx-comment")) setOpen(null);
    };
    const click = (event: MouseEvent) => {
      const mark = markOf(event.target, "data-lx-comment");
      if (!mark) return;
      setOpen(null);
      host.props().onEditorCommentClick?.(mark.dataset.lxComment!);
    };
    const close = () => setOpen(null);
    surface.addEventListener("mouseover", show);
    surface.addEventListener("focusin", show);
    surface.addEventListener("mouseout", leave);
    surface.addEventListener("keydown", key);
    surface.addEventListener("click", click);
    document.addEventListener("scroll", close, true);
    return () => {
      surface.removeEventListener("mouseover", show);
      surface.removeEventListener("focusin", show);
      surface.removeEventListener("mouseout", leave);
      surface.removeEventListener("keydown", key);
      surface.removeEventListener("click", click);
      document.removeEventListener("scroll", close, true);
    };
  }, [editor, host]);

  const comment = open ? host.props().editorComments?.find((candidate) => candidate.id === open.id) ?? null : null;
  useLayoutEffect(() => {
    if (!card || !open || !comment) return;
    card.replaceChildren(buildCommentTooltipDom([comment]));
    place(card, open.mark);
  }, [card, comment, open]);

  if (!open || !comment) return null;
  return createPortal(
    <div
      ref={setCard}
      id={id}
      role="tooltip"
      className="lx-md-comment-card"
      style={{ position: "fixed", left: 0, top: 0 }}
      onMouseLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && open.mark.contains(event.relatedTarget))) setOpen(null);
      }}
    />,
    document.body,
  );
}

/** Accept or Reject for the tracked change under the pointer, or focused and opened with Enter. */
export function ChangePopover({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t } = useLingui();
  const [open, setOpen] = useState<{ id: string; mark: HTMLElement; keyboard: boolean } | null>(null);
  const [popover, setPopover] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const surface = editor.view.dom;
    const hover = (event: MouseEvent) => {
      const mark = markOf(event.target, "data-lx-change");
      if (mark) setOpen((current) => (current?.keyboard ? current : { id: mark.dataset.lxChange!, mark, keyboard: false }));
    };
    const key = (event: KeyboardEvent) => {
      const mark = markOf(event.target, "data-lx-change");
      if (!mark || event.key !== "Enter") return;
      event.preventDefault();
      setOpen({ id: mark.dataset.lxChange!, mark, keyboard: true });
    };
    surface.addEventListener("mouseover", hover);
    surface.addEventListener("keydown", key);
    return () => {
      surface.removeEventListener("mouseover", hover);
      surface.removeEventListener("keydown", key);
    };
  }, [editor]);

  // Opened by hovering, it closes once the pointer leaves the mark, the popover and the gap between them.
  useEffect(() => {
    if (!open || open.keyboard || !popover) return;
    const move = (event: PointerEvent) => {
      const rects = [open.mark.getBoundingClientRect(), popover.getBoundingClientRect()];
      const left = Math.min(...rects.map((rect) => rect.left)) - 4;
      const right = Math.max(...rects.map((rect) => rect.right)) + 4;
      const top = Math.min(...rects.map((rect) => rect.top)) - 4;
      const bottom = Math.max(...rects.map((rect) => rect.bottom)) + 4;
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) setOpen(null);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [open, popover]);

  const actions = host.props().overleafTrackChangeActions;
  // Always the latest suggestion with this id: canonical updates move and rewrite them.
  const change = open ? host.props().overleafChanges?.find((candidate) => candidate.id === open.id) ?? null : null;
  useLayoutEffect(() => {
    if (!popover || !open) return;
    place(popover, open.mark);
    if (open.keyboard) popover.querySelector("button")?.focus();
  }, [open, popover]);

  if (!open || !change || !actions) return null;
  const shown: TrackedChange = change;
  const close = (restoreFocus: boolean) => {
    setOpen(null);
    if (restoreFocus) (editor.view.dom.querySelector<HTMLElement>(`[data-lx-change="${CSS.escape(open.id)}"]`) ?? open.mark).focus();
  };
  const act = (run: (value: TrackedChange) => void) => {
    run(shown);
    close(open.keyboard);
  };
  return createPortal(
    <div
      ref={setPopover}
      role="dialog"
      aria-label={t`Suggested change`}
      className="lx-md-change-popover"
      style={{ position: "fixed", left: 0, top: 0, "--lx-md-change-color": hueColor(change.hue) } as CSSProperties}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close(true);
      }}
    >
      <span className="lx-md-change-author">
        <span className="lx-md-change-dot" aria-hidden="true" />
        {actions.authorName(change.userId)}
      </span>
      {actions.canAct() && (
        <span className="lx-md-change-actions">
          <Button variant="ghost" size="compact" onClick={() => act(actions.onAccept)}>{t`Accept`}</Button>
          <Button variant="ghost" size="compact" onClick={() => act(actions.onReject)}>{t`Reject`}</Button>
        </span>
      )}
    </div>,
    document.body,
  );
}

/** Ask for a comment on the current selection (the toolbar's Comment). */
export function requestComment(host: ChromeHost) {
  host.ask({ kind: "comment" });
}

type Draft = { quote: string; whole: boolean };

/** Where the draft range sits in the Markdown, or why it cannot be placed. */
function anchorDraft(editor: Editor, host: ChromeHost, draft: Draft | null) {
  const map = host.sourceMap(true);
  const range = commentDraft(editor.state);
  if (!map || !range) return { error: "locate" as const };
  if (draft?.whole ?? editor.state.selection instanceof AllSelection) {
    return { from: 0, to: map.text.length, quote: map.text };
  }
  const from = map.positionToOffset(range.from);
  const to = map.positionToOffset(range.to, "before");
  if (from == null || to == null || to <= from) return { error: "locate" as const };
  const quote = map.text.slice(from, to);
  if (draft && quote !== draft.quote) return { error: "changed" as const };
  return { from, to, quote };
}

export function CommentComposer({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t } = useLingui();
  const request = useChromeRequest(host);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<"locate" | "changed" | null>(null);
  const [body, setBody] = useState("");
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);

  // A comment request marks the selection and opens the composer for it.
  useEffect(() => {
    if (request?.kind !== "comment") return;
    host.clear();
    const { selection } = editor.state;
    const whole = selection instanceof AllSelection;
    editor.view.dispatch(setCommentDraft(editor.state.tr, { from: whole ? 0 : selection.from, to: whole ? editor.state.doc.content.size : selection.to }));
    const anchored = anchorDraft(editor, host, null);
    // Opening the composer from a request is this effect's whole job.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBody("");
    if ("error" in anchored) {
      setError(anchored.error ?? null);
      setDraft({ quote: "", whole });
    } else {
      setError(null);
      setDraft({ quote: anchored.quote, whole });
    }
  }, [editor, host, request]);

  useLayoutEffect(() => {
    if (!dialog || !draft) return;
    const range = commentDraft(editor.state);
    const at = editor.view.coordsAtPos(range?.from ?? editor.state.selection.from);
    place(dialog, { getBoundingClientRect: () => new DOMRect(at.left, at.top, 1, at.bottom - at.top) }, "bottom");
  }, [dialog, draft, editor]);

  if (!draft) return null;
  const finish = () => {
    setDraft(null);
    setError(null);
    editor.view.dispatch(setCommentDraft(editor.state.tr, null));
    editor.view.focus();
  };
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    const anchored = anchorDraft(editor, host, draft);
    if ("error" in anchored) {
      setError(anchored.error ?? "locate");
      return;
    }
    host.props().onCreateComment?.(anchored.from, anchored.to, text);
    finish();
  };
  return createPortal(
    <div ref={setDialog} role="dialog" aria-label={t`Add comment`} className="lx-md-comment-composer" style={{ position: "fixed", left: 0, top: 0 }}>
      {draft.quote && <blockquote className="lx-md-comment-quote">{draft.quote}</blockquote>}
      {error && (
        <p className="lx-md-comment-error" role="alert">
          {error === "changed"
            ? t`The selected text changed. Select it again before commenting.`
            : t`Cannot precisely locate this selection in Markdown source. Switch to Source view to add a comment.`}
        </p>
      )}
      <Textarea
        autoFocus
        aria-label={t`Comment`}
        value={body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            finish();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <span className="lx-md-comment-actions">
        <Button variant="ghost" size="compact" onClick={finish}>{t`Cancel`}</Button>
        <Button variant="primary" size="compact" disabled={!body.trim() || error === "locate"} onClick={submit}>{t`Add comment`}</Button>
      </span>
    </div>,
    document.body,
  );
}
