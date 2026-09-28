/** Review chrome over the visual editor: Overleaf tracked-change cards and editor-comment cards. */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Editor } from "@tiptap/react";
import { Check, X } from "lucide-react";
import type { TrackedChangeTooltipActions } from "../../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../../overleaf/use-overleaf-realtime";
import type { EditorComment } from "../comments/editor-comment-data";
import { buildCommentTooltipDom } from "../comments/editor-comments";
import { listen } from "../dom-utils";
import {
  trackedChangeColor,
  trackedChangeLabel,
  trackedChangeTint,
  type CommentDraftAnchor,
} from "./visual-source-decorations";

const TRACKED_CHANGE_HOVER_RADIUS = 24;
const TRACKED_CHANGE_CLOSE_DELAY_MS = 180;
const CHANGE_MARK = "[data-visual-change-id]";
const CHANGE_TOOLTIP = ".visual-tracked-change-tooltip";
const COMMENT_MARK = "[data-visual-comment-id]";

type HoveredChanges = { changeIds: string[]; left: number; top: number };

const changeMarks = (section: HTMLElement | null, ids: string[]) => (
  Array.from(section?.querySelectorAll<HTMLElement>(CHANGE_MARK) ?? [])
    .filter((mark) => ids.includes(mark.dataset.visualChangeId ?? ""))
);

const activeRegions = (section: HTMLElement | null, ids: string[]) => [
  ...changeMarks(section, ids),
  ...Array.from(section?.querySelectorAll<HTMLElement>(CHANGE_TOOLTIP) ?? []),
];

function cancelTimer(timer: { current: ReturnType<typeof setTimeout> | undefined }) {
  clearTimeout(timer.current);
  timer.current = undefined;
}

function distanceFromPointToRect(x: number, y: number, rect: DOMRect): number {
  return Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
}

/**
 * Hovering, focusing, or pressing Enter on a tracked change opens its card; the
 * card stays open while the pointer is near the change or the card.
 */
export function TrackedChangeLayer({ sectionRef, changes, actions, hidden }: {
  sectionRef: RefObject<HTMLElement | null>;
  changes: TrackedChange[];
  actions?: TrackedChangeTooltipActions;
  hidden: boolean;
}) {
  const [hovered, setHovered] = useState<HoveredChanges | null>(null);
  const latest = useRef({ hovered, changes });
  useLayoutEffect(() => {
    latest.current = { hovered, changes };
  });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const reveal = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || target.closest(CHANGE_TOOLTIP)) return;
      const mark = target.closest<HTMLElement>(CHANGE_MARK);
      if (!mark) return;
      cancelTimer(closeTimer);
      const changeIds = latest.current.changes
        .filter((change) => change.id === mark.dataset.visualChangeId)
        .map((change) => change.id);
      if (!changeIds.length) return;
      const { left, top } = mark.getBoundingClientRect();
      setHovered((current) => (
        current?.changeIds[0] === changeIds[0] && current.left === left && current.top === top
          ? current
          : { changeIds, left, top }
      ));
    };
    const revealTarget = (event: Event) => reveal(event.target);
    const activate = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const ids = latest.current.hovered?.changeIds ?? [];
        setHovered(null);
        queueMicrotask(() => changeMarks(section, ids)[0]?.focus());
        return;
      }
      const target = event.target;
      if ((event.key !== "Enter" && event.key !== " ") || !(target instanceof HTMLElement) || !target.closest(CHANGE_MARK)) return;
      event.preventDefault();
      reveal(target);
      queueMicrotask(() => section.querySelector<HTMLButtonElement>(`${CHANGE_TOOLTIP} button:not(:disabled)`)?.focus());
    };
    // ProseMirror handles pointer events at its root. Listen during capture so
    // tracked-change interactions still reach the surrounding React view.
    return listen(section, [["mouseover", revealTarget, true], ["focusin", revealTarget, true], ["keydown", activate, true]]);
  }, [sectionRef]);

  useEffect(() => {
    if (!hovered) return;
    const section = sectionRef.current;
    const keepOpenNearSuggestion = (event: PointerEvent) => {
      if (!section) return;
      const regions = activeRegions(section, hovered.changeIds);
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const nearby = regions.some((region) => (
        (focused && region.contains(focused))
        || distanceFromPointToRect(event.clientX, event.clientY, region.getBoundingClientRect()) <= TRACKED_CHANGE_HOVER_RADIUS
      ));
      if (nearby) cancelTimer(closeTimer);
      else if (!closeTimer.current) {
        closeTimer.current = setTimeout(() => {
          closeTimer.current = undefined;
          setHovered(null);
        }, TRACKED_CHANGE_CLOSE_DELAY_MS);
      }
    };
    const closeWhenFocusLeaves = ({ target }: FocusEvent) => {
      if (target instanceof Node && !activeRegions(section, hovered.changeIds).some((region) => region.contains(target))) {
        setHovered(null);
      }
    };
    const stop = listen(window, [["pointermove", keepOpenNearSuggestion, true], ["focusin", closeWhenFocusLeaves, true]]);
    return () => {
      stop();
      cancelTimer(closeTimer);
    };
  }, [hovered, sectionRef]);

  const activeChanges = (hovered?.changeIds ?? []).flatMap((id) => changes.find((change) => change.id === id) ?? []);
  if (hidden || !hovered || !activeChanges.length || !actions) return null;
  const decide = (change: TrackedChange, apply: (change: TrackedChange) => void) => {
    changeMarks(sectionRef.current, hovered.changeIds)[0]?.focus();
    setHovered(null);
    apply(change);
  };
  return (
    <div
      id="visual-tracked-change-tooltip"
      className="visual-tracked-change-tooltip"
      role="dialog"
      aria-label="Suggested change"
      style={{ left: hovered.left, top: hovered.top }}
      onMouseOver={(event) => event.stopPropagation()}
    >
      {activeChanges.map((change) => {
        const canAct = actions.canAct();
        return (
          <div className="visual-tracked-change-tooltip-item" key={change.id}>
            <div className="visual-tracked-change-tooltip-head">
              <span style={{ backgroundColor: trackedChangeColor(change) }} />
              <div>
                <strong>{actions.authorName(change.userId)}</strong>
                <small>{trackedChangeLabel(change)}</small>
              </div>
            </div>
            <div
              className={`visual-tracked-change-quote${change.deletion ? " is-deletion" : ""}`}
              style={{
                backgroundColor: trackedChangeTint(change),
                textDecorationColor: change.deletion ? trackedChangeColor(change) : undefined,
              }}
            >
              {change.text}
            </div>
            <div className="visual-tracked-change-tooltip-actions">
              <button className="accept" type="button" disabled={!canAct} onClick={() => decide(change, actions.onAccept)}>
                <Check aria-hidden="true" />Accept
              </button>
              <button className="reject" type="button" disabled={!canAct} onClick={() => decide(change, actions.onReject)}>
                <X aria-hidden="true" />Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Clicking (or Enter/Space on) a comment highlight opens its thread, the same
 * gesture the source editor offers; hovering or focusing one shows a floating
 * card. Both are delegated to the section so they also work in read-only
 * previews, and the card closes on navigation or typing so it never outlives
 * its document anchor.
 */
export function useVisualCommentInteractions(sectionRef: RefObject<HTMLElement | null>, {
  editor,
  comments,
  activePath,
  tooltipId,
  onOpen,
}: {
  editor: Editor | null;
  comments: EditorComment[];
  activePath: string;
  tooltipId: string;
  onOpen?: (id: string) => void;
}) {
  const { i18n, t } = useLingui();
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || !onOpen) return;
    const open = ({ target }: Event) => {
      const id = target instanceof HTMLElement ? target.closest<HTMLElement>(COMMENT_MARK)?.dataset.visualCommentId : undefined;
      if (id) onOpen(id);
    };
    const activate = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    };
    return listen(section, [["click", open], ["keydown", activate]]);
  }, [onOpen, sectionRef]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!editor || !section) return;
    let anchor: HTMLElement | null = null;
    let popup: HTMLElement | null = null;
    let dwellTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(dwellTimer);
      clearTimeout(leaveTimer);
      popup?.remove();
      anchor = popup = null;
    };
    const leave = (event: MouseEvent | FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (anchor?.contains(next) || popup?.contains(next))) return;
      if (!popup) return close();
      clearTimeout(dwellTimer);
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(close, 150);
    };
    const open = (mark: HTMLElement) => {
      if (anchor !== mark || !mark.isConnected) return;
      const threads = comments.filter((comment) => (
        comment.id === mark.dataset.visualCommentId && comment.path === activePath && !comment.resolved
      ));
      if (!threads.length) return;
      const tooltip = buildCommentTooltipDom(threads, undefined, Date.now(), {
        locale: i18n.locale, anonymous: t`Anonymous`, noCommentText: t`(no comment text)`,
        reopen: t`Reopen`, resolve: t`Resolve comment`, reply: t`Reply`,
      });
      popup = tooltip;
      tooltip.classList.add("visual-editor-comment-tooltip");
      tooltip.id = tooltipId;
      tooltip.setAttribute("role", "tooltip");
      tooltip.style.visibility = "hidden";
      tooltip.addEventListener("mouseenter", () => clearTimeout(leaveTimer));
      tooltip.addEventListener("mouseleave", leave);
      document.body.appendChild(tooltip);
      // Mark attributes belong to decorations. Mutating them here makes
      // ProseMirror replace the anchor while Floating UI is measuring it.
      void computePosition(mark, tooltip, {
        strategy: "fixed", placement: "top-start", middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (popup !== tooltip) return;
        Object.assign(tooltip.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    };
    const enter = (event: Event) => {
      const mark = event.target instanceof Element ? event.target.closest<HTMLElement>(COMMENT_MARK) : null;
      if (!mark || !section.contains(mark)) return;
      clearTimeout(leaveTimer);
      if (anchor === mark) return;
      close();
      anchor = mark;
      if (event.type === "focusin") open(mark);
      else dwellTimer = setTimeout(() => open(mark), 300);
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popup?.contains(event.target)) close();
    };
    const stops = [
      listen(section, [["mouseover", enter], ["mouseout", leave], ["focusin", enter], ["focusout", leave]]),
      listen(document, [["click", close], ["keydown", close], ["scroll", scroll, true]]),
      listen(window, [["resize", close]]),
    ];
    return () => {
      close();
      stops.forEach((stop) => stop());
    };
  }, [activePath, comments, editor, i18n.locale, sectionRef, t, tooltipId]);
}

export type CommentComposerState = CommentDraftAnchor & { body: string; error: string | null; left: number; top: number };

export function VisualCommentComposer({ composer, onChange, onCancel, onSubmit }: {
  composer: CommentComposerState;
  onChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      className="visual-comment-composer"
      role="dialog"
      aria-label={t`Add comment`}
      style={{ left: composer.left, top: composer.top }}
    >
      <p className="editor-comment-quote">{composer.quote}</p>
      <textarea
        autoFocus
        rows={3}
        aria-label={t`Comment`}
        placeholder={t`Leave a comment for collaborators…`}
        value={composer.body}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {composer.error && <p role="alert" className="visual-node-source-error">{composer.error}</p>}
      <div className="editor-comment-popover-actions">
        <button type="button" onClick={onCancel}>{t`Cancel`}</button>
        <button type="button" className="primary" disabled={!composer.body.trim()} onClick={onSubmit}>{t`Add comment`}</button>
      </div>
    </div>
  );
}
