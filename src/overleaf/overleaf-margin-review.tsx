/**
 * Margin review: Overleaf's comments and suggestions in the source's right
 * margin, each beside its line, using only width the text does not need.
 *
 * One rule, from the editor's width, decides how review shows:
 *
 * - **Wide** (Auto, and room for the 88-column reading measure focus mode
 *   reads at plus a card): the text keeps that measure and the cards stand in
 *   the spare width beside their lines, a crowded one stacking under the one
 *   above it. Only this mode limits the text, and never below the measure.
 * - **Markers** (less room, Markers only, or focus mode): a 14px pip per
 *   thread (its number of messages) or suggestion (+ or −) in the author's
 *   colour, in the outline rail's gutter, so the text keeps its width. A
 *   pointer resting on a pip or a click opens its card over the text beside
 *   the line.
 * - **Narrow** (markers, and too little text width for a card beside it): a
 *   pip opens a rail over the editor's right side listing what is on screen.
 *   It covers the text rather than reflowing it, and Escape or ✕ closes it.
 *   The whole list stays in the Overleaf panel.
 *
 * The layer lives in CodeMirror's scroller, outside `.cm-content`, so it
 * scrolls with the text and takes none of its width; it is placed from
 * `coordsAtPos`/`lineBlockAt` whenever the editor's geometry changes
 * (`onMarginGeometry`). Positions are written straight to the DOM in
 * CodeMirror's measure cycle: typing re-places the cards without rendering
 * them. While a card, a pip or its popover is pointed at or focused, its line
 * is tinted in the author's colour, so text and card read as one even 300px
 * apart; pointing at the text lights its card or pip in turn.
 *
 * The cards are the Overleaf panel's own (`OverleafThreadCard`,
 * `OverleafChangeCard`) in their margin variant. J and K (or the arrow keys)
 * walk the pips or cards from one that has focus; "Review here" in the
 * palette starts the walk at the caret.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import type { EditorView } from "@codemirror/view";
import { X } from "lucide-react";
import type { OverleafThread } from "../app-types";
import { LeavesOnClose } from "../components/ui/exit-picture";
import { IconButton } from "../components/ui/icon-button";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { useLatestRef } from "../hooks/use-latest-ref";
import { formatCount } from "../i18n";
import { OverleafChangeCard } from "./overleaf-changes";
import { OverleafThreadCard, type OverleafThreadActions } from "./overleaf-comments";
import type { PeopleHues } from "./overleaf-collab-people";
import { onMarginGeometry, setMarginLinkedEffect } from "./overleaf-editor-extensions";
import { marginReviewMode, onMarginReviewRequest, subscribeMarginReview } from "./margin-review-mode";
import type { TrackedChange } from "./overleaf-realtime-model";
import type { OverleafCommentAnchor } from "./use-overleaf-comments";
import "./overleaf-collab.css";
import "./overleaf-margin-review.css";

/** A card's width, the gap between the text and the cards, and between stacked cards. */
const CARD_WIDTH = 268;
const CARD_GAP = 24;
const STACK_GAP = 8;
/** The outline rail's gutter (`--outline-rail-clearance`, editor-workspace.css). */
const RAIL_CLEARANCE = 36;
/** A pip, and how far from the scroller's right edge it stands: just short of the outline rail's marks. */
const PIP = 14;
const PIP_INSET = 46;
/** Below this much text width a card beside the line would cover most of it, so the rail opens instead. */
const NARROW_TEXT = 480;
/** As the outline rail: a pointer passing over a pip does not open it, and may stray briefly. */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 200;

export type MarginComment = {
  thread: OverleafThread;
  anchor: OverleafCommentAnchor;
  /** The span in the open document, and its opener's colour. */
  from: number;
  to: number;
  color: string;
};

type Item =
  | { key: string; kind: "comment"; from: number; to: number; color: string; comment: MarginComment }
  | { key: string; kind: "change"; from: number; to: number; color: string; change: TrackedChange };

type Layout = { kind: "wide" | "markers"; narrow: boolean };

/** Where the review is open: a pip's card over the text, or the rail. */
type Opened = { key: string; via: "hover" | "click" | "rail" } | null;

/** Put `element` at (x, y) in the scroller's coordinates (overleaf-margin-review.css reads them). */
function place(element: HTMLElement, x: number, y: number) {
  element.style.setProperty("--margin-x", `${x}px`);
  element.style.setProperty("--margin-y", `${y}px`);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.matches("textarea, input, select"));

export function OverleafMarginReview(props: OverleafThreadActions & {
  view: EditorView;
  focusMode: boolean;
  comments: MarginComment[];
  /** Suggestions in this document, and what can be done about one. */
  changes: TrackedChange[];
  authorName: (userId: string | null) => string;
  canAct: boolean;
  /** The suggestion mid-request; "all" for a bulk action. */
  changeBusy: string | null;
  onAccept: (change: TrackedChange) => void;
  onReject: (change: TrackedChange) => void;
  hues: PeopleHues;
  /** The open file, as the cards' "show this" wants it. */
  path: string;
}) {
  const { i18n, t } = useLingui();
  const { view } = props;
  const setting = useSyncExternalStore(subscribeMarginReview, marginReviewMode);
  const [layout, setLayout] = useState<Layout>({ kind: "markers", narrow: false });
  const [opened, setOpened] = useState<Opened>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);

  const items: Item[] = [
    ...props.comments.map((comment): Item => ({
      key: `comment:${comment.thread.id}`, kind: "comment", from: comment.from, to: comment.to, color: comment.color, comment,
    })),
    ...props.changes.map((change): Item => ({
      key: `change:${change.id}`, kind: "change", from: change.position, to: change.position + change.text.length,
      color: `hsl(${change.hue}, 70%, 50%)`, change,
    })),
  ].sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));
  const itemsKey = items.map((item) => `${item.key}@${item.from}`).join(",");
  const latest = useLatestRef({ items, layout, opened });
  const off = setting === "off" || items.length === 0;
  const wantWide = setting === "auto" && !props.focusMode;

  // The pane says how review shows, and the text gives up its width only in wide mode.
  const pane = view.dom.closest<HTMLElement>(".source-editor");
  useLayoutEffect(() => {
    if (!pane || off) return;
    pane.setAttribute("data-margin-review", layout.kind);
    return () => pane.removeAttribute("data-margin-review");
  }, [layout.kind, off, pane]);

  // Place everything from the editor's geometry: read in CodeMirror's measure
  // phase, written straight to the elements, so nothing renders for it.
  useLayoutEffect(() => {
    if (off) return;
    const measure = () => view.requestMeasure({
      key: "overleaf-margin-review",
      read: () => {
        const scroller = view.scrollDOM;
        const box = scroller.getBoundingClientRect();
        const base = box.top - scroller.scrollTop;
        const content = view.contentDOM.getBoundingClientRect();
        const gutters = view.dom.querySelector(".cm-gutters")?.getBoundingClientRect().width ?? 0;
        const columns = Number.parseFloat(getComputedStyle(view.contentDOM).getPropertyValue("--focus-mode-measure")) || 88;
        // The text's measure, with the line's own padding either side.
        const measurePx = columns * view.defaultCharacterWidth + 8;
        const width = scroller.clientWidth;
        const wide = wantWide && width >= gutters + measurePx + CARD_GAP + CARD_WIDTH + RAIL_CLEARANCE;
        const length = view.state.doc.length;
        const lines = latest.current.items.map((item) => {
          const pos = Math.max(0, Math.min(item.from, length));
          const coords = view.coordsAtPos(pos, 1);
          if (coords) return { top: coords.top - base, height: coords.bottom - coords.top };
          const block = view.lineBlockAt(pos);
          return { top: block.top + view.documentTop - base, height: view.defaultLineHeight };
        });
        const heights = latest.current.items.map((item) => elements.current.get(item.key)?.offsetHeight ?? 0);
        const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
        return {
          wide, lines, heights, popoverHeight, width,
          contentLeft: content.left - box.left, contentRight: content.right - box.left,
          textWidth: content.width,
          visible: [scroller.scrollTop, scroller.scrollTop + scroller.clientHeight] as const,
        };
      },
      write: (geometry) => {
        const { items: current, layout: shown, opened: open } = latest.current;
        const next: Layout = { kind: geometry.wide ? "wide" : "markers", narrow: !geometry.wide && geometry.textWidth < NARROW_TEXT };
        if (next.kind !== shown.kind || next.narrow !== shown.narrow) setLayout(next);
        if (shown.kind === "wide") {
          // Beside its line, or under the card above it when they crowd.
          let floor = 0;
          const left = geometry.contentRight + CARD_GAP;
          current.forEach((item, index) => {
            const element = elements.current.get(item.key);
            if (!element) return;
            const top = Math.max(geometry.lines[index]!.top - 6, floor);
            place(element, left, top);
            floor = top + geometry.heights[index]! + STACK_GAP;
          });
        } else {
          // Markers in the rail's gutter, stacked when lines share them.
          const left = Math.min(geometry.contentRight + 6, geometry.width - PIP_INSET);
          let floor = 0;
          current.forEach((item, index) => {
            const element = elements.current.get(item.key);
            const line = geometry.lines[index]!;
            const top = Math.max(line.top + (line.height - PIP) / 2, floor);
            floor = top + PIP + 2;
            if (element) place(element, left, top);
            if (open?.key === item.key && open.via !== "rail" && popoverRef.current) {
              // Beside the line, left of its pip, over the text; never past the text's left edge.
              const popLeft = Math.max(geometry.contentLeft, left - CARD_WIDTH - 10);
              place(popoverRef.current, popLeft, Math.max(0, line.top - 8));
            }
          });
        }
        // What the rail lists: the items whose line is on screen.
        if (open?.via === "rail" || shown.narrow) {
          const [from, to] = geometry.visible;
          const keys = current.filter((_, index) => {
            const line = geometry.lines[index]!;
            return line.top + line.height > from && line.top < to;
          }).map((item) => item.key);
          setOnScreen((previous) => previous.size === keys.length && keys.every((key) => previous.has(key)) ? previous : new Set(keys));
        }
      },
    });
    measure();
    const stopGeometry = onMarginGeometry(view, measure);
    // A card grows when its replies unfold or a composer opens.
    const resize = new ResizeObserver(measure);
    for (const element of elements.current.values()) resize.observe(element);
    if (popoverRef.current) resize.observe(popoverRef.current);
    resize.observe(view.scrollDOM);
    view.scrollDOM.addEventListener("scroll", measure, { passive: true });
    return () => {
      stopGeometry();
      resize.disconnect();
      view.scrollDOM.removeEventListener("scroll", measure);
    };
  }, [itemsKey, latest, layout.kind, layout.narrow, off, opened, replyingTo, view, wantWide]);

  // A card's line stays tinted while the card (or its pip) is pointed at or focused.
  const active = opened?.key ?? linked;
  useEffect(() => {
    const item = active ? latest.current.items.find((candidate) => candidate.key === active) : null;
    if (view.dom.isConnected) view.dispatch({ effects: setMarginLinkedEffect.of(item ? { from: item.from, to: item.to, color: item.color } : null) });
  }, [active, itemsKey, latest, view]);
  // A rebuilt editor (another file) has gone with its tint.
  useEffect(() => () => {
    if (view.dom.isConnected) view.dispatch({ effects: setMarginLinkedEffect.of(null) });
  }, [view]);

  // Pointing at the text lights its card or pip.
  useEffect(() => {
    if (off) return;
    const content = view.contentDOM;
    const over = (event: PointerEvent) => {
      const mark = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-comment-id^='overleaf:'], [data-change-id]")
        : null;
      const key = mark?.dataset.changeId
        ? `change:${mark.dataset.changeId}`
        : mark?.dataset.commentId ? `comment:${mark.dataset.commentId.slice("overleaf:".length)}` : null;
      setLinked((current) => current === key ? current : key);
    };
    const leave = () => setLinked(null);
    content.addEventListener("pointerover", over);
    content.addEventListener("pointerleave", leave);
    return () => {
      content.removeEventListener("pointerover", over);
      content.removeEventListener("pointerleave", leave);
    };
  }, [off, view]);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);
  const later = (delay: number, action: () => void) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      action();
    }, delay);
  };

  /** Focus `key`'s pip (markers) or card (wide), once it is on screen. */
  const focusItem = (key: string) => {
    setFocusKey(key);
    const element = elements.current.get(key);
    const item = latest.current.items.find((candidate) => candidate.key === key);
    if (item) {
      // Bring its line into view first; the layer follows on the next measure.
      const block = view.lineBlockAt(Math.min(item.from, view.state.doc.length));
      const scroller = view.scrollDOM;
      const top = block.top + view.documentTop - (scroller.getBoundingClientRect().top - scroller.scrollTop);
      if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 40) {
        scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3) });
      }
    }
    // In the rail, the card stands in for the pip.
    const target = latest.current.opened?.via === "rail"
      ? railRef.current?.querySelector<HTMLElement>(`[data-review-key="${CSS.escape(key)}"]`)
      : element;
    target?.focus({ preventScroll: true });
  };

  /** Open `key` as the layout shows it: its card beside the line, or the rail. */
  const open = (key: string, via: "hover" | "click") => {
    clearTimer();
    setOpened(latest.current.layout.narrow ? { key, via: "rail" } : { key, via });
  };
  const close = (refocus: boolean) => {
    clearTimer();
    const key = opened?.key;
    setOpened(null);
    setReplyingTo(null);
    if (refocus && key) window.requestAnimationFrame(() => elements.current.get(key)?.focus({ preventScroll: true }));
  };

  // "Review here": the item at or after the caret's line, opened.
  const actions = useLatestRef({ open, focusItem });
  useEffect(() => {
    if (off) return;
    return onMarginReviewRequest(() => {
      const { items: current, layout: shown } = latest.current;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const next = current.find((item) => item.to >= line.from) ?? current[0];
      if (!next) return;
      if (shown.kind === "markers") actions.current.open(next.key, "click");
      // The pip, card or rail is in the DOM a frame later.
      window.requestAnimationFrame(() => actions.current.focusItem(next.key));
    });
  }, [actions, latest, off, view]);

  // The rail keeps the item it was opened for in sight.
  const railKey = opened?.via === "rail" ? opened.key : null;
  useEffect(() => {
    if (!railKey) return;
    railRef.current?.querySelector(`[data-review-key="${CSS.escape(railKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [railKey]);

  /** J and K, or the arrows, walk to the next or previous item; Escape steps back out. */
  const walk = (event: KeyboardEvent, from: string) => {
    if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.key === "j" || event.key === "J" || event.key === "ArrowDown" ? 1
      : event.key === "k" || event.key === "K" || event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (opened) close(true);
      else view.focus();
      return;
    }
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const index = items.findIndex((item) => item.key === from);
    const next = items[(index + step + items.length) % items.length];
    if (!next) return;
    if (opened && layout.kind === "markers") setOpened({ key: next.key, via: layout.narrow ? "rail" : "click" });
    // The next card is in the DOM a frame later.
    window.requestAnimationFrame(() => focusItem(next.key));
  };

  if (off) return null;

  const reveal = (position: number) => {
    view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length) }, scrollIntoView: true });
    view.focus();
  };
  const disabledTitle = !props.canAct ? t`This account cannot accept or reject suggestions here` : undefined;
  const card = (item: Item) => item.kind === "comment" ? (
    <OverleafThreadCard
      variant="margin"
      thread={item.comment.thread}
      anchor={item.comment.anchor}
      path={props.path}
      hues={props.hues}
      replying={replyingTo === item.key}
      onReplyingChange={(replying) => setReplyingTo(replying ? item.key : null)}
      expanded={false}
      onExpandedChange={() => {}}
      onReveal={(_, position) => reveal(position)}
      onReply={props.onReply}
      onResolve={props.onResolve}
      onDelete={props.onDelete}
      onEditMessage={props.onEditMessage}
      onDeleteMessage={props.onDeleteMessage}
    />
  ) : (
    <OverleafChangeCard
      variant="margin"
      change={item.change}
      source={view.state.doc.toString()}
      author={props.authorName(item.change.userId)}
      actionable={props.canAct}
      disabledTitle={disabledTitle}
      working={props.changeBusy === item.change.id || props.changeBusy === "all"}
      onAccept={props.onAccept}
      onReject={props.onReject}
      onReveal={reveal}
    />
  );
  const describe = (item: Item) => {
    if (item.kind === "comment") {
      const opener = item.comment.thread.messages[0]?.authorName ?? t`Anonymous`;
      const count = item.comment.thread.messages.length;
      return count === 1
        ? t`Comment from ${opener}`
        : t`Comment from ${opener}, ${formatCount(count, i18n.locale)} messages`;
    }
    const author = props.authorName(item.change.userId);
    return item.change.deletion ? t`${author} suggests deleting text` : t`${author} suggests inserting text`;
  };
  const roving = focusKey && items.some((item) => item.key === focusKey) ? focusKey : items[0]?.key;
  const linkHandlers = (key: string) => ({
    onPointerEnter: () => setLinked(key),
    onPointerLeave: () => setLinked((current) => current === key ? null : current),
  });

  if (layout.kind === "wide") {
    return createPortal(
      <div className="margin-review-layer" data-layout="wide" role="region" aria-label={t`Margin review`}>
        {items.map((item) => (
          <div
            key={item.key}
            ref={(element) => {
              if (element) elements.current.set(item.key, element);
              else elements.current.delete(item.key);
            }}
            className="margin-review-card"
            data-linked={linked === item.key ? "" : undefined}
            tabIndex={item.key === roving ? 0 : -1}
            aria-label={describe(item)}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setFocusKey(item.key);
              setLinked(item.key);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setLinked((current) => current === item.key ? null : current);
            }}
            onKeyDown={(event) => walk(event, item.key)}
            {...linkHandlers(item.key)}
          >
            {card(item)}
          </div>
        ))}
      </div>,
      view.scrollDOM,
    );
  }

  const openItem = opened ? items.find((item) => item.key === opened.key) : undefined;
  const railItems = items.filter((item) => onScreen.has(item.key) || item.key === opened?.key);
  const commentCount = railItems.filter((item) => item.kind === "comment").length;
  const changeCount = railItems.length - commentCount;
  const railSummary = [
    commentCount === 1 ? t`1 comment` : commentCount ? t`${formatCount(commentCount, i18n.locale)} comments` : "",
    changeCount === 1 ? t`1 suggestion` : changeCount ? t`${formatCount(changeCount, i18n.locale)} suggestions` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      {createPortal(
        <div className="margin-review-layer" data-layout="markers">
          <div role="toolbar" aria-orientation="vertical" aria-label={t`Margin review`}>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                ref={(element) => {
                  if (element) elements.current.set(item.key, element);
                  else elements.current.delete(item.key);
                }}
                className="margin-review-pip"
                data-kind={item.kind}
                data-linked={linked === item.key ? "" : undefined}
                data-open={opened?.key === item.key ? "" : undefined}
                style={{ background: item.color }}
                tabIndex={item.key === roving ? 0 : -1}
                aria-label={describe(item)}
                aria-expanded={opened?.key === item.key}
                onFocus={() => setFocusKey(item.key)}
                onKeyDown={(event) => walk(event, item.key)}
                onClick={(event) => {
                  if (opened?.key === item.key && opened.via !== "hover") close(false);
                  else open(item.key, "click");
                  // A pointer click keeps the caret where the writer left it.
                  if (event.detail > 0) event.currentTarget.blur();
                }}
                onPointerEnter={(event) => {
                  setLinked(item.key);
                  if (event.pointerType === "touch" || layout.narrow) return;
                  if (!opened || opened.via === "hover") later(opened ? 0 : OPEN_DELAY_MS, () => open(item.key, "hover"));
                }}
                onPointerLeave={() => {
                  setLinked((current) => current === item.key ? null : current);
                  if (opened?.via === "hover" || (!opened && timer.current !== null)) later(CLOSE_DELAY_MS, () => setOpened(null));
                }}
              >
                <span aria-hidden="true">
                  {item.kind === "comment" ? formatCount(item.comment.thread.messages.length, i18n.locale) : item.change.deletion ? "−" : "+"}
                </span>
              </button>
            ))}
          </div>
          {openItem && opened?.via !== "rail" && (
            <LeavesOnClose surface={popoverRef}>
              <div
                ref={popoverRef}
                className={`margin-review-popover ${popupMotionClassName}`}
                role="dialog"
                aria-label={describe(openItem)}
                onPointerEnter={() => {
                  clearTimer();
                  setLinked(openItem.key);
                }}
                onPointerLeave={() => {
                  if (opened?.via === "hover" && !popoverRef.current?.contains(document.activeElement)) later(CLOSE_DELAY_MS, () => setOpened(null));
                }}
                onFocus={() => {
                  // A keyboard (or a click) in the card keeps it open.
                  if (opened?.via === "hover") setOpened({ key: openItem.key, via: "click" });
                }}
                onKeyDown={(event) => walk(event, openItem.key)}
              >
                {card(openItem)}
              </div>
            </LeavesOnClose>
          )}
        </div>,
        view.scrollDOM,
      )}
      {opened?.via === "rail" && (
        <LeavesOnClose surface={railRef}>
          <aside
            ref={railRef}
            className="margin-review-rail"
            aria-label={t({ message: "On screen", context: "margin review" })}
            onKeyDown={(event) => {
              const key = (event.target as HTMLElement).closest<HTMLElement>("[data-review-key]")?.dataset.reviewKey ?? opened.key;
              walk(event, key);
            }}
          >
            <header className="margin-review-rail-head">
              <h2>{t({ message: "On screen", context: "margin review" })}</h2>
              <span>{railSummary}</span>
              <IconButton size="compact" label={t`Close`} onClick={() => close(true)}>
                <X size={14} aria-hidden="true" />
              </IconButton>
            </header>
            <div className="margin-review-rail-list">
              {railItems.map((item) => (
                <div
                  key={item.key}
                  className="margin-review-rail-item"
                  data-review-key={item.key}
                  data-current={item.key === opened.key ? "" : undefined}
                  tabIndex={item.key === focusKey ? 0 : -1}
                  {...linkHandlers(item.key)}
                >
                  {card(item)}
                </div>
              ))}
            </div>
          </aside>
        </LeavesOnClose>
      )}
    </>
  );
}
