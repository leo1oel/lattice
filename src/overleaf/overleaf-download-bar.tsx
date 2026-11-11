/**
 * The picker's row for a project download in flight: a bar that fills when
 * Overleaf said the size and sweeps when it did not, with what has arrived,
 * the speed and the time left or so far (`overleaf-download-progress.ts`).
 */
import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import { summarizeDownload, type DownloadTrack } from "./overleaf-download-progress";

/** The elapsed time and a stalled speed move on their own, so the row re-reads once a second. */
const CLOCK_INTERVAL_MS = 1_000;

const tick = (_previous: number, now: number) => now;
const readClock = () => performance.now();

export function OverleafDownloadBar(props: { name: string; track: DownloadTrack }) {
  const { t } = useLingui();
  // The row mounts as the download is asked for (the picker shows it for as
  // long as `cloning` is set), so its first clock reading is the start.
  const [startedAt] = useReducer(tick, undefined, readClock);
  const [now, setNow] = useReducer(tick, startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const { fraction, percent, detail } = summarizeDownload(props.track, startedAt, now);
  return (
    <div className="overleaf-progress overleaf-download">
      <div className="overleaf-download-head">
        <InfinityLoader size={15} />
        <span className="overleaf-download-title">{t`Downloading ${props.name}…`}</span>
        {percent && <span className="overleaf-download-percent">{percent}</span>}
      </div>
      <div
        className="overleaf-download-track"
        role="progressbar"
        aria-label={t`Download progress`}
        aria-valuemin={fraction === null ? undefined : 0}
        aria-valuemax={fraction === null ? undefined : 100}
        aria-valuenow={fraction === null ? undefined : Math.floor(fraction * 100)}
        aria-valuetext={detail}
        data-indeterminate={fraction === null ? "" : undefined}
      >
        <div className="overleaf-download-fill" style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </div>
      <span className="overleaf-download-detail">{detail}</span>
    </div>
  );
}
