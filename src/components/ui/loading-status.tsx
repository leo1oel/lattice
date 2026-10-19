/**
 * What every loading surface shares, so a load shows one indicator and a
 * quick one shows none:
 *
 * - its indicator (a skeleton shaped like what is coming, or one small
 *   status) stays transparent until the load has outlasted a glance, then
 *   fades in (`useLoadingReveal`, the `loading-reveal` class);
 * - what the indicator means is said to assistive technology in a polite
 *   live region (`LoadingAnnouncement`) rather than drawn beside it as a
 *   second indicator.
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

function clockFor(scope: string, now: number) {
  const clock = clocks.get(scope);
  if (clock && (clock.holders > 0 || now - clock.releasedAt < HANDOFF_MS)) return clock;
  const fresh = { since: now, holders: 0, releasedAt: now };
  clocks.set(scope, fresh);
  return fresh;
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
  const [clock] = useState(() => clockFor(scope, performance.now()));
  const [delay] = useState(() => Math.round(clock.since + LOADING_REVEAL_DELAY_MS - performance.now()));
  useEffect(() => {
    clock.holders += 1;
    return () => {
      clock.holders -= 1;
      clock.releasedAt = performance.now();
    };
  }, [clock]);
  return { animationDelay: `${delay}ms` };
}

/**
 * A loader's message, in a polite live region with no visible text: the
 * indicator already shows that something is loading. The region is in the
 * page a frame before its text: one that arrives already holding it is not
 * reliably announced.
 */
export function LoadingAnnouncement({ message }: { message: string }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSaid(message));
    return () => window.cancelAnimationFrame(frame);
  }, [message]);
  return <p className="loading-announcement" role="status" aria-live="polite">{said}</p>;
}
