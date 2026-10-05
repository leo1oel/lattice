/**
 * The guided tour: one card that walks the sample project stop by stop
 * (guided-tour-steps.ts), with a spotlight on the place each stop is about.
 *
 * Non-modal on purpose. Every stop asks the writer to try something in the
 * real workspace, so nothing here blocks the pointer or traps the keyboard:
 * the dimming is a box-shadow on a pointer-transparent spotlight, and the card
 * is a labelled, non-modal dialog that takes focus once per stop so a screen
 * reader announces it. Escape ends the tour unless something else (a menu, a
 * completion list) already handled it.
 *
 * Loaded lazily: it is only ever needed after the Guided tutorial entry.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { LatticeMark } from "../components/ui/lattice-mark";
import { useLatestRef } from "../hooks/use-latest-ref";
import { snapshotOf, TOUR_REPLAY_WELCOME, TOUR_STEPS, type TourContext, type TourSnapshot, type TourStep } from "./guided-tour-steps";
import { placeCard, sameRect, spotlightOf, type Rect } from "./guided-tour-placement";
import "./guided-tour.css";

export type GuidedTourOutcome = "completed" | "skipped";

export type GuidedTourProps = TourContext & {
  onClose: (outcome: GuidedTourOutcome) => void;
  /** The stops to walk; the sample's tour by default (tests pass their own). */
  steps?: readonly TourStep[];
  /** The writer finished the tour before: welcome them back to it. */
  replay?: boolean;
};

/** How long a stop waits for its place to come on screen before the tour moves past it. */
const TARGET_PATIENCE_MS = 1600;
/** A second reveal, for a panel that was still settling when the first one asked. */
const REVEAL_RETRY_MS = 500;
function useViewport() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [viewport, setViewport] = useState(read);
  useEffect(() => {
    const onResize = () => setViewport(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return viewport;
}

export default function GuidedTour({ onClose, steps = TOUR_STEPS, replay = false, ...context }: GuidedTourProps) {
  const { t, i18n } = useLingui();
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  /** The current stop's target on screen; null while it is being revealed or has none. */
  const [found, setFound] = useState<{ step: string; rect: Rect | null }>({ step: "", rect: null });
  const [cardSize, setCardSize] = useState({ width: 340, height: 200 });
  const viewport = useViewport();
  const cardRef = useRef<HTMLElement>(null);
  const contextRef = useLatestRef(context);
  /** Which way the writer is moving, so a stop that cannot be shown is passed in that direction. */
  const directionRef = useRef<1 | -1>(1);
  const closedRef = useRef(false);
  const returnFocusRef = useRef<Element | null>(null);
  const step = steps[index];
  const stops = steps.length - 1;

  const close = useCallback((outcome: GuidedTourOutcome) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(outcome);
  }, [onClose]);

  const go = useCallback((next: number) => {
    if (next >= steps.length) {
      close("completed");
      return;
    }
    directionRef.current = next < index ? -1 : 1;
    setIndex(Math.max(0, next));
  }, [close, index, steps.length]);

  // Focus returns to where the writer was when the tour ends.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    return () => {
      const back = returnFocusRef.current;
      if (back instanceof HTMLElement && back.isConnected && !back.closest(".guided-tour-card")) back.focus({ preventScroll: true });
    };
  }, []);

  // Enter a stop: reveal its place, follow it every frame (panels move,
  // resize and hide), and move past it when it never comes on screen.
  useEffect(() => {
    const current = contextRef.current;
    const entered: TourSnapshot = snapshotOf(current.controller);
    let frame = 0;
    let last: Rect | null = null;
    let focused = false;
    const started = performance.now();
    let retried = false;
    const focusCard = () => {
      if (focused) return;
      focused = true;
      cardRef.current?.focus({ preventScroll: true });
    };
    if (!step.target) {
      focusCard();
    } else {
      step.reveal?.(current);
      const follow = () => {
        const target = step.target?.(contextRef.current) ?? null;
        const next = target ? { left: target.left, top: target.top, width: target.width, height: target.height } : null;
        if (!sameRect(last, next)) {
          last = next;
          setFound({ step: step.id, rect: next });
        }
        if (next) {
          // A frame later, so Trellis's own focus for a panel it just showed has landed.
          if (!focused) requestAnimationFrame(focusCard);
        } else if (!focused) {
          const waited = performance.now() - started;
          if (!retried && waited > REVEAL_RETRY_MS) {
            retried = true;
            step.reveal?.(contextRef.current);
          }
          if (waited > TARGET_PATIENCE_MS) {
            const next = index + directionRef.current;
            if (next <= 0) setIndex(0);
            else if (next >= steps.length) close("completed");
            else setIndex(next);
            return;
          }
        }
        frame = requestAnimationFrame(follow);
      };
      follow();
    }
    const stopWatching = step.watch?.(current, () => setDone((previous) => {
      if (previous.has(step.id)) return previous;
      return new Set(previous).add(step.id);
    }));
    return () => {
      cancelAnimationFrame(frame);
      stopWatching?.();
      // The controller a stop entered with is the one it leaves: App's is stable.
      step.leave?.(current, entered);
    };
  }, [close, contextRef, index, step, steps.length]);

  // Escape ends the tour, unless something above it (a menu, a dialog, a
  // completion list) already used that Escape to close itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      close("skipped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      setCardSize((size) => (size.width === width && size.height === height ? size : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  // A rect found for the stop before is not this one's.
  const rect = found.step === step.id ? found.rect : null;
  const spot = rect ? spotlightOf(rect, viewport) : null;
  const placement = useMemo(() => placeCard(spot, cardSize, viewport), [spot?.left, spot?.top, spot?.width, spot?.height, cardSize, viewport]); // eslint-disable-line react-hooks/exhaustive-deps
  const isWelcome = index === 0;
  const isLast = index === steps.length - 1;
  const actionDone = done.has(step.id);
  const words = isWelcome && replay ? TOUR_REPLAY_WELCOME : step;
  const titleId = "guided-tour-title";
  const bodyId = "guided-tour-body";

  const onCardKey = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      go(index - 1);
    }
  };

  const spotlightStyle = spot
    ? { transform: `translate(${spot.left}px, ${spot.top}px)`, width: spot.width, height: spot.height }
    : undefined;
  const cardStyle = { transform: `translate(${Math.round(placement.left)}px, ${Math.round(placement.top)}px)` } as CSSProperties;

  return createPortal(
    <div className="guided-tour" data-spotlit={spot ? "" : undefined}>
      <div className="guided-tour-scrim" aria-hidden="true" />
      <div className="guided-tour-spotlight" aria-hidden="true" style={spotlightStyle} />
      <section
        ref={cardRef}
        className="guided-tour-card"
        data-side={placement.side}
        data-welcome={isWelcome || undefined}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        style={cardStyle}
        onKeyDown={onCardKey}
      >
        <button type="button" className="guided-tour-close" aria-label={t`End tour`} onClick={() => close("skipped")}>
          <X size={14} />
        </button>
        <div key={step.id} className="guided-tour-content">
          {isWelcome
            ? <div className="guided-tour-mark"><LatticeMark size={36} motion="weave" /></div>
            : <p className="guided-tour-count">{t`${index} of ${stops}`}</p>}
          <h2 id={titleId} className="guided-tour-title">{i18n._(words.title)}</h2>
          <p id={bodyId} className="guided-tour-body">{i18n._(words.body)}</p>
          {step.action && (
            <p className="guided-tour-action" data-done={actionDone || undefined}>
              <span className="guided-tour-action-mark" aria-hidden="true">
                <Check size={11} strokeWidth={3} />
              </span>
              <span className="guided-tour-action-label">{i18n._(step.action)}</span>
              <span className="sr-only" aria-live="polite">{actionDone ? t`Done` : ""}</span>
            </p>
          )}
        </div>
        <footer className="guided-tour-footer">
          {isWelcome ? (
            <Button variant="ghost" size="compact" onClick={() => close("skipped")}>{t`Not now`}</Button>
          ) : (
            <ol className="guided-tour-progress" aria-label={t`Tour progress`}>
              {steps.slice(1).map((item, position) => (
                <li
                  key={item.id}
                  data-state={position + 1 < index ? "past" : position + 1 === index ? "current" : undefined}
                  aria-current={position + 1 === index ? "step" : undefined}
                >
                  <span className="sr-only">{i18n._(item.title)}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="guided-tour-actions">
            {!isWelcome && (
              <Button variant="ghost" size="compact" aria-label={t`Back`} className="guided-tour-back" onClick={() => go(index - 1)}>
                <ArrowLeft size={14} />
              </Button>
            )}
            <Button
              variant="primary"
              size="compact"
              className="guided-tour-next"
              data-tour-next=""
              data-tour-finish={isLast ? "" : undefined}
              onClick={() => go(index + 1)}
            >
              {isWelcome ? t`Start tour` : isLast ? t`Finish` : t`Next`}
              {!isLast && <ArrowRight size={14} />}
            </Button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
