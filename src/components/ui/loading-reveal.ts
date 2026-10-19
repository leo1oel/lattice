/**
 * The reveal of a loading indicator (see loading-status.tsx): transparent
 * until the load has outlasted a glance, then a quick fade, on a clock one
 * load's indicators share.
 */
import { useEffect, useState, type CSSProperties } from "react";
import "./loading-status.css";

/** How long a load runs before its indicator shows: useLoadingShell's delay, so every loader keeps one clock. */
export const LOADING_REVEAL_DELAY_MS = 150;

/**
 * How long after its last indicator unmounted a scope's load still counts as
 * the same one: a Suspense fallback handing over to the component's own
 * skeleton remounts it within a frame or two.
 */
const HANDOFF_MS = 250;

type RevealClock = { since: number; holders: number; releasedAt: number };
const clocks = new Map<string, RevealClock>();

/** When the load the scope's indicator joins started: the running one's start, or now. */
function loadStart(scope: string, now: number) {
  const clock = clocks.get(scope);
  if (clock && (clock.holders > 0 || now - clock.releasedAt < HANDOFF_MS)) return clock.since;
  clocks.set(scope, { since: now, holders: 0, releasedAt: now });
  return now;
}

/** Counts an indicator on screen for the load that started at `since`; the returned release uncounts it. */
function holdClock(scope: string, since: number) {
  const clock = clocks.get(scope);
  if (!clock || clock.since !== since) return () => {};
  clock.holders += 1;
  return () => {
    clock.holders -= 1;
    clock.releasedAt = performance.now();
  };
}

/**
 * The style that reveals a loading indicator on its scope's clock. One load
 * often passes through several indicators of the same shape (a chunk's
 * fallback, then a Suspense fallback, then the component's own skeleton);
 * each remount picks up the reveal where the last one was, so the indicator
 * neither flickers out nor waits its delay again. The delay is fixed at
 * mount: changing it later would move a running animation.
 */
export function useLoadingReveal(scope: string): CSSProperties {
  const [since] = useState(() => loadStart(scope, performance.now()));
  const [delay] = useState(() => Math.round(since + LOADING_REVEAL_DELAY_MS - performance.now()));
  useEffect(() => holdClock(scope, since), [scope, since]);
  return { animationDelay: `${delay}ms` };
}
