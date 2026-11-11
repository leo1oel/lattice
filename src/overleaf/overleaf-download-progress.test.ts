import { describe, expect, it } from "vitest";
import {
  downloadFraction,
  downloadRate,
  formatClock,
  formatRate,
  formatTimeLeft,
  recordDownload,
  secondsLeft,
  NOTHING_RECEIVED,
  summarizeDownload,
  type DownloadProgress,
  type DownloadTrack,
} from "./overleaf-download-progress";

/** Steps 250 ms apart, as `report_download` sends them, starting at `from`. */
function steps(track: DownloadTrack, from: number, progress: DownloadProgress[]): DownloadTrack {
  return progress.reduce<DownloadTrack>((next, step, index) => recordDownload(next, step, from + index * 250), track);
}

/** A download asked for at 0 that received `perStep` bytes every 250 ms for `count` steps. */
function steady(perStep: number, count: number, total: number | null = null): DownloadTrack {
  const progress = Array.from({ length: count }, (_, index) => ({ received: (index + 1) * perStep, total }));
  return steps(NOTHING_RECEIVED, 1_000, progress);
}

describe("downloadRate", () => {
  it("waits for enough samples before giving a speed", () => {
    expect(downloadRate(NOTHING_RECEIVED, 0)).toBeNull();
    expect(downloadRate(steady(500_000, 2), 1_250)).toBeNull();
  });

  it("measures bytes a second over the recent window", () => {
    // 500 kB every 250 ms is 2 MB/s.
    expect(downloadRate(steady(500_000, 8), 2_750)).toBeCloseTo(2_000_000);
  });

  it("follows a change of speed rather than the whole download's average", () => {
    const fast = steady(1_000_000, 20);
    const last = fast.received;
    const slowed = steps(fast, 1_000 + 20 * 250, Array.from({ length: 16 }, (_, index) => ({ received: last + (index + 1) * 25_000, total: null })));
    expect(downloadRate(slowed, 1_000 + 35 * 250)).toBeCloseTo(100_000);
  });

  it("reads as stopped once no bytes have come for a while", () => {
    const track = steady(500_000, 8);
    expect(downloadRate(track, 2_750 + 1_900)).toBeCloseTo(2_000_000);
    expect(downloadRate(track, 2_750 + 2_000)).toBe(0);
  });

  it("starts over when a retried attempt starts again from zero", () => {
    const broken = steady(500_000, 8);
    const retried = recordDownload(broken, { received: 0, total: null }, 5_000);
    expect(retried.samples).toEqual([{ received: 0, at: 5_000 }]);
    expect(downloadRate(retried, 5_000)).toBeNull();
    const moving = steps(retried, 5_250, [1, 2, 3, 4].map((step) => ({ received: step * 100_000, total: null })));
    expect(downloadRate(moving, 6_000)).toBeCloseTo(400_000);
  });

  it("keeps only the recent samples", () => {
    expect(steady(1_000, 200).samples.length).toBeLessThanOrEqual(13);
  });
});

describe("downloadFraction and secondsLeft", () => {
  it("needs a size from Overleaf", () => {
    const track = steady(500_000, 8);
    expect(downloadFraction(track)).toBeNull();
    expect(secondsLeft(track, 2_000_000)).toBeNull();
  });

  it("says how much has arrived and how long the rest takes at the current speed", () => {
    const track = steady(500_000, 8, 10_000_000);
    expect(downloadFraction(track)).toBeCloseTo(0.4);
    expect(secondsLeft(track, 2_000_000)).toBeCloseTo(3);
    expect(secondsLeft(track, 0)).toBeNull();
    expect(secondsLeft(track, null)).toBeNull();
  });

  it("never goes past the whole", () => {
    const over = recordDownload(NOTHING_RECEIVED, { received: 12, total: 10 }, 0);
    expect(downloadFraction(over)).toBe(1);
    expect(secondsLeft(over, 1)).toBe(0);
  });
});

describe("formatting", () => {
  it("shows elapsed time as a clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(42.9)).toBe("0:42");
    expect(formatClock(725)).toBe("12:05");
    expect(formatClock(3_725)).toBe("1:02:05");
    expect(formatClock(-1)).toBe("0:00");
  });

  it("rounds the time left the way people say it", () => {
    expect(formatTimeLeft(3)).toBe("A few seconds left");
    expect(formatTimeLeft(11)).toBe("About 15 s left");
    expect(formatTimeLeft(59)).toBe("About 55 s left");
    expect(formatTimeLeft(90)).toBe("About 2 min left");
    expect(formatTimeLeft(3_590)).toBe("About 1 h left");
    expect(formatTimeLeft(9_000)).toBe("About 3 h left");
  });

  it("gives a speed per second", () => {
    expect(formatRate(2_100_000)).toBe("2.1 MB/s");
    expect(formatRate(300)).toBe("1 kB/s");
  });
});

describe("summarizeDownload", () => {
  it("waits for Overleaf before any bytes arrive", () => {
    expect(summarizeDownload(NOTHING_RECEIVED, 0, 7_000)).toEqual({
      fraction: null, percent: null, detail: "Waiting for Overleaf to send it · 0:07 elapsed",
    });
  });

  it("without a size, says what has arrived, how fast, and for how long", () => {
    const track = steady(500_000, 8);
    expect(summarizeDownload(track, 0, 2_000)).toEqual({
      fraction: null, percent: null, detail: "4 MB received · 2 MB/s · 0:02 elapsed",
    });
  });

  it("says it is waiting rather than showing a stale speed once the bytes stop", () => {
    expect(summarizeDownload(steady(500_000, 8), 0, 6_000).detail).toBe("4 MB received · Waiting for more data · 0:06 elapsed");
  });

  it("with a size, fills the bar and says the time left", () => {
    expect(summarizeDownload(steady(500_000, 8, 41_000_000), 0, 2_750)).toEqual({
      fraction: 4_000_000 / 41_000_000, percent: "9%", detail: "4 MB of 41 MB · 2 MB/s · About 20 s left",
    });
  });

  it("leaves the speed and time left out until it can tell", () => {
    const track = recordDownload(NOTHING_RECEIVED, { received: 30_000_000, total: 41_000_000 }, 500);
    expect(summarizeDownload(track, 0, 500).detail).toBe("30 MB of 41 MB");
  });
});
