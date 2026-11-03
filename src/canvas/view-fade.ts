import { useLayoutEffect, useRef } from "react";
import { animationTiming } from "../components/ui/motion-values";

/** One view fade per panel, so a quick run of switches restarts it rather than stacking. */
const fades = new WeakMap<HTMLElement, Animation>();

/**
 * The panel now shows another view (a file, a Paper's Blog or full text, its
 * PDF, the source beside its preview): it comes in on a quick fade rather
 * than a hard cut. Only the new view fades, from the panel's own ground, so
 * two pages of text never show through each other. Opacity alone, so the
 * fade costs the compositor and never a layout.
 */
function fadeInView(host: HTMLElement) {
  if (!host.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  fades.get(host)?.cancel();
  const fade = host.animate([{ opacity: 0 }, { opacity: 1 }], animationTiming("moderate"));
  fades.set(host, fade);
  fade.onfinish = () => {
    if (fades.get(host) === fade) fades.delete(host);
  };
}

/**
 * Fade `host` in each time `view` (what it shows, as one string) changes,
 * before the new view is first painted; never on mount.
 */
export function useViewFade(host: HTMLElement, view: string) {
  const shownRef = useRef(view);
  useLayoutEffect(() => {
    if (shownRef.current === view) return;
    shownRef.current = view;
    fadeInView(host);
  }, [host, view]);
}
