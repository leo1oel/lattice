//! What the "Open from Overleaf" picker says about a project download in
//! flight: how much has arrived, how fast, and how long it has left
//! (`src/overleaf/overleaf-download-progress.ts`).
//!
//! Overleaf builds the zip as it streams it, so it almost never sends a size
//! up front (lattice-core's `download_once`), and asking first would make it
//! build the whole zip twice. So a download usually has no total, and then
//! the picker shows an indeterminate bar with what has arrived, the current
//! speed and the time so far, so a long download reads as moving rather than
//! stuck. When Overleaf does send a size, the bar fills and says the time
//! left.
//!
//! Times are milliseconds from any fixed start (the picker uses the
//! download's own start). lattice-core is asked for at most one step every
//! 250 ms (`super::sync::report_download`), so the samples stay a dozen or
//! so long.

use lattice_i18n::{locale, t};

/// Bytes so far, and the size when Overleaf says it up front.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Sample {
    received: u64,
    at: f64,
}

/// How much of a download has arrived, with its recent progress.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DownloadTrack {
    pub received: u64,
    pub total: Option<u64>,
    /// Progress steps from the last [`RATE_WINDOW_MS`], oldest first.
    samples: Vec<Sample>,
}

/// The speed is measured over this much recent time, so it follows changes
/// without jitter.
const RATE_WINDOW_MS: f64 = 3_000.;
/// Less time than this between the first and last sample is too little to
/// give a speed.
const MIN_RATE_SPAN_MS: f64 = 750.;
/// After this long with no new bytes the download reads as waiting, not as
/// its last speed.
const STALL_MS: f64 = 2_000.;

impl DownloadTrack {
    /// Nothing received yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a step that arrived at `at`.
    pub fn record(&mut self, progress: DownloadProgress, at: f64) {
        // A retried attempt starts again from the first byte (Overleaf cannot
        // resume a zip it builds afresh); the old attempt's samples would make
        // the speed negative.
        if progress.received < self.received {
            self.samples.clear();
        } else {
            self.samples
                .retain(|sample| at - sample.at <= RATE_WINDOW_MS);
        }
        self.received = progress.received;
        self.total = progress.total;
        self.samples.push(Sample {
            received: progress.received,
            at,
        });
    }

    /// When the latest step arrived.
    fn last_at(&self) -> Option<f64> {
        self.samples.last().map(|sample| sample.at)
    }

    /// Bytes a second lately: none until there is enough to tell, 0 once the
    /// bytes have stopped.
    pub fn rate(&self, now: f64) -> Option<f64> {
        let (first, last) = (self.samples.first()?, self.samples.last()?);
        if now - last.at >= STALL_MS {
            return Some(0.);
        }
        let span = last.at - first.at;
        if span < MIN_RATE_SPAN_MS {
            return None;
        }
        Some((last.received - first.received) as f64 * 1_000. / span)
    }

    /// How much of the download has arrived, when Overleaf said how big it is.
    pub fn fraction(&self) -> Option<f64> {
        self.total
            .filter(|total| *total > 0)
            .map(|total| (self.received as f64 / total as f64).min(1.))
    }

    /// Seconds until the download ends at `rate`, when its size is known and
    /// it is moving.
    fn seconds_left(&self, rate: Option<f64>) -> Option<f64> {
        let total = self.total.filter(|total| *total > 0)?;
        let rate = rate.filter(|rate| *rate > 0.)?;
        Some((total.saturating_sub(self.received) as f64 / rate).max(0.))
    }
}

/// Elapsed time as a clock, `0:42`, `12:05` or `1:02:05`.
pub fn format_clock(seconds: f64) -> String {
    let whole = seconds.max(0.).floor() as u64;
    let (hours, minutes, secs) = (whole / 3_600, whole % 3_600 / 60, whole % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

/// The time left, rounded the way people say it: a speed that wobbles should
/// not make the estimate tick by single seconds.
pub fn format_time_left(seconds: f64) -> String {
    if seconds < 10. {
        return t!("A few seconds left").into();
    }
    if seconds < 60. {
        let rounded = ((seconds / 5.).ceil() * 5.).min(55.) as u64;
        return t!("About {rounded} s left", rounded = rounded).into();
    }
    if seconds < 3_600. {
        let minutes = (seconds / 60.).round() as u64;
        return if minutes < 60 {
            t!("About {minutes} min left", minutes = minutes).into()
        } else {
            t!("About 1 h left").into()
        };
    }
    let hours = (seconds / 3_600.).round() as u64;
    t!("About {hours} h left", hours = hours).into()
}

/// A file size in decimal units, as Finder states them and the Tauri app's
/// `formatSize` does (`Intl.NumberFormat`'s short kilobyte and megabyte).
pub fn format_size(bytes: f64) -> String {
    let (value, unit) = if bytes < 1_000_000. {
        ((bytes / 1_000.).round().max(1.), "kB")
    } else {
        (bytes / 1_000_000., "MB")
    };
    let rounded = (value * 10.).round() / 10.;
    let number = if rounded.fract() == 0. {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.1}")
    };
    // Intl writes the unit after a space in English and against the number
    // in Chinese.
    if locale().is_chinese() {
        format!("{number}{unit}")
    } else {
        format!("{number} {unit}")
    }
}

pub fn format_rate(bytes_per_second: f64) -> String {
    let size = format_size(bytes_per_second);
    t!("{size}/s", size = &size).into()
}

/// The bar's fill (none: indeterminate), its percent label, and the line
/// under it.
#[derive(Debug, PartialEq)]
pub struct DownloadSummary {
    pub fraction: Option<f64>,
    pub percent: Option<String>,
    pub detail: String,
}

/// `started_at`: when the download was asked for, which the elapsed time
/// counts from; `now` comes from a once-a-second clock.
pub fn summarize(track: &DownloadTrack, started_at: f64, now: f64) -> DownloadSummary {
    // A step that just arrived can be newer than the clock.
    let at = now.max(track.last_at().unwrap_or(now));
    let elapsed = format_clock((at - started_at) / 1_000.);
    let fraction = track.fraction();
    let percent = fraction.map(|fraction| format!("{}%", (fraction * 100.).floor() as u64));
    let elapsed_line = || t!("{elapsed} elapsed", elapsed = &elapsed).to_string();
    if track.received == 0 {
        return DownloadSummary {
            fraction,
            percent,
            detail: join(&[
                Some(t!("Waiting for Overleaf to send it").into()),
                Some(elapsed_line()),
            ]),
        };
    }
    let rate = track.rate(at);
    let speed = match rate {
        Some(rate) if rate == 0. => Some(t!("Waiting for more data").into()),
        Some(rate) => Some(format_rate(rate)),
        None => None,
    };
    let received = format_size(track.received as f64);
    let (Some(_), Some(total)) = (fraction, track.total) else {
        return DownloadSummary {
            fraction,
            percent,
            detail: join(&[
                Some(t!("{received} received", received = &received).into()),
                speed,
                Some(elapsed_line()),
            ]),
        };
    };
    let total = format_size(total as f64);
    let left = track.seconds_left(rate);
    DownloadSummary {
        fraction,
        percent,
        detail: join(&[
            Some(
                t!(
                    "{received} of {total}",
                    received = &received,
                    total = &total
                )
                .into(),
            ),
            speed,
            left.map(format_time_left),
        ]),
    }
}

fn join(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .flatten()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(received: u64, total: Option<u64>) -> DownloadProgress {
        DownloadProgress { received, total }
    }

    #[test]
    fn a_download_with_no_size_says_what_arrived_and_how_long() {
        let mut track = DownloadTrack::new();
        assert_eq!(
            summarize(&track, 0., 2_000.).detail,
            "Waiting for Overleaf to send it · 0:02 elapsed"
        );
        track.record(step(200_000, None), 0.);
        track.record(step(1_200_000, None), 1_000.);
        let summary = summarize(&track, 0., 1_000.);
        assert_eq!(summary.fraction, None);
        assert_eq!(summary.detail, "1.2 MB received · 1 MB/s · 0:01 elapsed");
    }

    #[test]
    fn a_sized_download_fills_and_says_the_time_left() {
        let mut track = DownloadTrack::new();
        track.record(step(0, Some(21_000_000)), 0.);
        track.record(step(1_000_000, Some(21_000_000)), 1_000.);
        let summary = summarize(&track, 0., 1_000.);
        assert_eq!(summary.percent.as_deref(), Some("4%"));
        assert_eq!(summary.detail, "1 MB of 21 MB · 1 MB/s · About 20 s left");
    }

    #[test]
    fn a_stalled_download_reads_as_waiting_and_a_retry_starts_over() {
        let mut track = DownloadTrack::new();
        track.record(step(500_000, None), 0.);
        track.record(step(900_000, None), 1_000.);
        assert_eq!(track.rate(4_000.), Some(0.));
        assert!(
            summarize(&track, 0., 4_000.)
                .detail
                .contains("Waiting for more data")
        );
        track.record(step(10_000, None), 5_000.);
        assert_eq!(
            track.rate(5_000.),
            None,
            "the old attempt's samples are gone"
        );
    }

    #[test]
    fn times_are_said_the_way_people_say_them() {
        assert_eq!(format_clock(42.), "0:42");
        assert_eq!(format_clock(725.), "12:05");
        assert_eq!(format_clock(3_725.), "1:02:05");
        assert_eq!(format_time_left(3.), "A few seconds left");
        assert_eq!(format_time_left(41.), "About 45 s left");
        assert_eq!(format_time_left(59.), "About 55 s left");
        assert_eq!(format_time_left(150.), "About 3 min left");
        assert_eq!(format_time_left(3_590.), "About 1 h left");
        assert_eq!(format_time_left(9_000.), "About 3 h left");
        assert_eq!(format_size(300.), "1 kB");
        assert_eq!(format_size(12_400.), "12 kB");
    }
}
