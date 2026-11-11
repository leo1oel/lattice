/**
 * What the "Open from Overleaf" picker says about a project download in
 * flight: how much has arrived, how fast, and how long it has left.
 *
 * Overleaf builds the zip as it streams it, so it almost never sends a size
 * up front (`api.rs` `download_once`), and asking first would make it build
 * the whole zip twice. So a download usually has no total, and then the
 * picker shows an indeterminate bar with what has arrived, the current speed
 * and the time so far, so a long download reads as moving rather than stuck.
 * When Overleaf does send a size, the bar fills and says the time left.
 *
 * Times are `performance.now()` milliseconds. The Rust side already sends at
 * most one step every 250 ms, so the samples here stay a dozen or so long.
 */
import { msg } from "@lingui/core/macro";
import { formatSize } from "../app-utils";
import { i18n } from "../i18n";

/** `overleaf-download-progress`: bytes so far, and the size when Overleaf says it up front. */
export type DownloadProgress = { received: number; total: number | null };

type Sample = { received: number; at: number };

/** How much of a download has arrived, with its recent progress. */
export type DownloadTrack = {
  received: number;
  total: number | null;
  /** Progress steps from the last {@link RATE_WINDOW_MS}, oldest first. */
  samples: Sample[];
};

/** The speed is measured over this much recent time, so it follows changes without jitter. */
const RATE_WINDOW_MS = 3_000;
/** Less time than this between the first and last sample is too little to give a speed. */
const MIN_RATE_SPAN_MS = 750;
/** After this long with no new bytes the download reads as waiting, not as its last speed. */
const STALL_MS = 2_000;

export const NOTHING_RECEIVED: DownloadTrack = { received: 0, total: null, samples: [] };

export function recordDownload(track: DownloadTrack, progress: DownloadProgress, at: number): DownloadTrack {
  // A retried attempt starts again from the first byte (Overleaf cannot
  // resume a zip it builds afresh); the old attempt's samples would make the
  // speed negative.
  const restarted = progress.received < track.received;
  const kept = restarted ? [] : track.samples.filter((sample) => at - sample.at <= RATE_WINDOW_MS);
  return { ...track, received: progress.received, total: progress.total, samples: [...kept, { received: progress.received, at }] };
}

/** Bytes a second lately: null until there is enough to tell, 0 once the bytes have stopped. */
export function downloadRate(track: DownloadTrack, now: number): number | null {
  const first = track.samples[0];
  const last = track.samples.at(-1);
  if (!first || !last) return null;
  if (now - last.at >= STALL_MS) return 0;
  const span = last.at - first.at;
  if (span < MIN_RATE_SPAN_MS) return null;
  return ((last.received - first.received) * 1_000) / span;
}

/** How much of the download has arrived, when Overleaf said how big it is. */
export function downloadFraction(track: DownloadTrack): number | null {
  return track.total ? Math.min(1, track.received / track.total) : null;
}

/** Seconds until the download ends at `rate`, when its size is known and it is moving. */
export function secondsLeft(track: DownloadTrack, rate: number | null): number | null {
  if (!track.total || !rate) return null;
  return Math.max(0, (track.total - track.received) / rate);
}

/** Elapsed time as a clock, `0:42`, `12:05` or `1:02:05`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/**
 * The time left, rounded the way people say it: a speed that wobbles should
 * not make the estimate tick by single seconds.
 */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 10) return i18n._(msg`A few seconds left`);
  if (seconds < 60) {
    const rounded = Math.min(55, Math.ceil(seconds / 5) * 5);
    return i18n._(msg`About ${rounded} s left`);
  }
  if (seconds < 3_600) {
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? i18n._(msg`About ${minutes} min left`) : i18n._(msg`About 1 h left`);
  }
  const hours = Math.round(seconds / 3_600);
  return i18n._(msg`About ${hours} h left`);
}

export function formatRate(bytesPerSecond: number): string {
  const size = formatSize(bytesPerSecond);
  return i18n._(msg`${size}/s`);
}

/** The bar's fill (null: indeterminate), its percent label, and the line under it. */
export type DownloadSummary = { fraction: number | null; percent: string | null; detail: string };

/** `startedAt`: when the download was asked for, which the elapsed time counts from. */
export function summarizeDownload(track: DownloadTrack, startedAt: number, now: number): DownloadSummary {
  // `now` comes from a once-a-second clock, so a step that just arrived can
  // be newer than it.
  const at = Math.max(now, track.samples.at(-1)?.at ?? now);
  const elapsed = formatClock((at - startedAt) / 1_000);
  const fraction = downloadFraction(track);
  const percent = fraction === null ? null : `${Math.floor(fraction * 100)}%`;
  if (!track.received) {
    return { fraction, percent, detail: join([i18n._(msg`Waiting for Overleaf to send it`), i18n._(msg`${elapsed} elapsed`)]) };
  }
  const rate = downloadRate(track, at);
  const speed = rate === 0 ? i18n._(msg`Waiting for more data`) : rate === null ? null : formatRate(rate);
  const received = formatSize(track.received);
  if (fraction === null || !track.total) {
    return { fraction, percent, detail: join([i18n._(msg`${received} received`), speed, i18n._(msg`${elapsed} elapsed`)]) };
  }
  const total = formatSize(track.total);
  const left = secondsLeft(track, rate);
  return {
    fraction,
    percent,
    detail: join([i18n._(msg`${received} of ${total}`), speed, left === null ? null : formatTimeLeft(left)]),
  };
}

function join(parts: (string | null)[]): string {
  return parts.filter(Boolean).join(" · ");
}
