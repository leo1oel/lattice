/**
 * What every loading surface shares, so a load shows one indicator and a
 * quick one shows none:
 *
 * - its indicator (a skeleton shaped like what is coming, or one small
 *   status) stays transparent until the load has outlasted a glance, then
 *   fades in (`useLoadingReveal` in loading-reveal.ts, the `loading-reveal`
 *   class);
 * - what the indicator means is said to assistive technology in a polite
 *   live region (`LoadingAnnouncement`) rather than drawn beside it as a
 *   second indicator.
 */
import { useEffect, useState } from "react";
import "./loading-status.css";

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
