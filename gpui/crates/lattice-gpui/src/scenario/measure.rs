//! The measurements the pass criteria ask for (macOS): Lattice's perf-lab
//! `longTex` scenario, memory footprints and the Chinese input method.

use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, anyhow};
use gpui::{AsyncApp, Bounds, Entity, EntityInputHandler as _, Pixels, Window};
use serde_json::{Value, json};

use super::{Run, sleep};
use crate::{editor_panel::EditorPanel, native};

impl Run {
    fn editor_bounds(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
    ) -> Result<Bounds<Pixels>> {
        cx.update(|cx| editor.read(cx).editor().read(cx).last_bounds().copied())
            .context("the editor has not been laid out")
    }

    /// Lattice's perf-lab `longTex` scenario on this app: open the 3.3 MB
    /// `long.tex`, fling 200 wheel events of 120 px 8 ms apart while a frame
    /// meter runs, click a line and type with 110 ms between keys, then read
    /// the process footprint.
    pub(super) async fn perf(&self, cx: &mut AsyncApp) -> Result<Value> {
        let root = self.root(cx)?;
        sleep(cx, Duration::from_millis(1500)).await;
        let active_at_start = self.with_window(cx, |_, window, _| window.is_window_active())?;

        // Open, timed to the first frame that draws it.
        let opened_at = Rc::new(Cell::new(None::<Instant>));
        let open_started = Instant::now();
        let editor = self.open(cx, &root.join("long.tex"), None)?;
        let open_call = open_started.elapsed();
        self.with_window(cx, {
            let opened_at = opened_at.clone();
            move |_, window, _| {
                window.on_next_frame(move |window, _| {
                    window.on_next_frame(move |_, _| opened_at.set(Some(Instant::now())));
                })
            }
        })?;
        sleep(cx, Duration::from_millis(3000)).await;
        let open_to_frame = opened_at.get().map(|at| at - open_started);

        let bounds = self.editor_bounds(cx, &editor)?;
        let center = bounds.center();
        let scroll_before = cx.update(|cx| {
            editor.update(cx, |panel, cx| {
                panel.editor().update(cx, |e, cx| e.scroll_position(cx))
            })
        });

        // Fling.
        let native = self.native(cx)?;
        let fling_cpu = CpuMeter::start();
        crate::paint_probe::start_recording();
        let meter = FrameMeter::start(self, cx)?;
        let fling_started = Instant::now();
        for _ in 0..200 {
            native::send_wheel(native, center, -120)?;
            sleep(cx, Duration::from_millis(8)).await;
        }
        let fling_sent = fling_started.elapsed();
        sleep(cx, Duration::from_millis(300)).await;
        let paints = crate::paint_probe::take();
        crate::paint_probe::stop_recording();
        let fling = meter.stop(&paints);
        let fling_cpu = fling_cpu.percent_of_one_core();
        let scroll_after = cx.update(|cx| {
            editor.update(cx, |panel, cx| {
                panel.editor().update(cx, |e, cx| e.scroll_position(cx))
            })
        });

        // Click a line, then type.
        native::send_click(native, center)?;
        sleep(cx, Duration::from_millis(500)).await;
        let typing_before = self.with_window(cx, |_, window, _| window.input_latency_snapshot())?;
        let phrase = "the quick brown fox jumps over lazy dogs ";
        let mut to_frame = Vec::new();
        let mut to_paint = Vec::new();
        let typing_cpu = CpuMeter::start();
        crate::paint_probe::start_recording();
        for character in phrase.chars().chain(phrase.chars()) {
            let next_frame = Rc::new(Cell::new(None::<Instant>));
            self.with_window(cx, {
                let next_frame = next_frame.clone();
                move |_, window, _| {
                    window.on_next_frame(move |_, _| next_frame.set(Some(Instant::now())));
                }
            })?;
            crate::paint_probe::take();
            let sent = Instant::now();
            native::send_key(native, character, false)?;
            sleep(cx, Duration::from_millis(110)).await;
            if let Some(at) = next_frame.get() {
                to_frame.push(at.saturating_duration_since(sent));
            }
            if let Some(painted) = crate::paint_probe::take().into_iter().find(|at| *at > sent) {
                to_paint.push(painted - sent);
            }
        }
        crate::paint_probe::stop_recording();
        let typing_cpu = typing_cpu.percent_of_one_core();
        let typing_after = self.with_window(cx, |_, window, _| window.input_latency_snapshot())?;
        let mut latency = typing_after.latency_histogram.clone();
        latency.subtract(&typing_before.latency_histogram).ok();
        let typed = self
            .editor_text(cx, &editor)
            .contains("the quick brown fox jumps over lazy dogs the quick");
        let active_at_end = self.with_window(cx, |_, window, _| window.is_window_active())?;

        sleep(cx, Duration::from_secs(3)).await;
        let idle_cpu = CpuMeter::start();
        sleep(cx, Duration::from_secs(10)).await;
        let idle_cpu = idle_cpu.percent_of_one_core();
        let memory = footprint();

        Ok(json!({
            "scenario": "perf",
            "window_active": { "start": active_at_start, "end": active_at_end },
            "open_long_tex": {
                "open_call_ms": ms(open_call),
                "to_second_frame_ms": open_to_frame.map(ms),
            },
            "fling": {
                "events": 200,
                "sent_over_ms": ms(fling_sent),
                "scroll_rows_before": scroll_before.y,
                "scroll_rows_after": scroll_after.y,
                "frames": fling,
                "cpu_percent_of_one_core": fling_cpu,
            },
            "idle_cpu_percent_of_one_core_10s": idle_cpu,
            "typing": {
                "keys": phrase.len() * 2,
                "text_arrived": typed,
                "key_to_painted_frame_ms": durations_ms(&to_paint),
                "key_to_next_frame_start_ms": durations_ms(&to_frame),
                "gpui_profiler_input_to_present_ms": histogram_ms(&latency),
                "cpu_percent_of_one_core": typing_cpu,
            },
            "memory": memory,
        }))
    }

    /// The input-method protocol without an input method: the
    /// `NSTextInputClient` calls a Pinyin IME makes while composing 你好
    /// (marked `ni`, `nih`, …, `nihao`, then the commit), made directly on the
    /// view, so the result does not depend on focus or on the IME process.
    pub(super) async fn ime_protocol(&self, cx: &mut AsyncApp) -> Result<Value> {
        let root = self.root(cx)?;
        let scratch = root.join("ime-protocol-check.tex");
        std::fs::write(&scratch, "x\n")?;
        let editor = self.open(cx, &scratch, Some(1))?;
        sleep(cx, Duration::from_millis(500)).await;
        let native = self.native(cx)?;
        let mut steps = Vec::new();
        for marked in ["n", "ni", "nih", "niha", "nihao"] {
            // Each keystroke replaces the whole marked range, as an IME does.
            let inner = cx.update(|cx| editor.read(cx).editor().clone());
            unsafe_set_marked(native, marked)?;
            sleep(cx, Duration::from_millis(30)).await;
            let (text, marked_range) = self.with_window(cx, |_, window, cx| {
                inner.update(cx, |editor, cx| {
                    (editor.text(cx), editor.marked_text_range(window, cx))
                })
            })?;
            steps.push(json!({ "marked": marked, "text": text, "marked_utf16": marked_range.map(|r| [r.start, r.end]) }));
        }
        let (has_marked, _) = native::compose(native, "nihao", "你好")?;
        sleep(cx, Duration::from_millis(100)).await;
        let committed = self.editor_text(cx, &editor);
        let marked_after = {
            let inner = cx.update(|cx| editor.read(cx).editor().clone());
            self.with_window(cx, |_, window, cx| {
                inner.update(cx, |editor, cx| editor.marked_text_range(window, cx))
            })?
        };
        std::fs::remove_file(&scratch).ok();
        let composed_inline = steps.iter().all(|step| !step["marked_utf16"].is_null());
        Ok(json!({
            "scenario": "ime-protocol",
            "while_composing": steps,
            "view_reported_marked_text": has_marked,
            "committed": committed,
            "marked_after_commit": marked_after.clone().map(|r| [r.start, r.end]),
            "passed": composed_inline && has_marked && committed == "你好x\n" && marked_after.is_none(),
        }))
    }

    /// Footprint at each stage of a session, to attribute memory: the project
    /// with its PDF, then `long.tex` open, then the PDF scrolled to its end.
    pub(super) async fn memory(&self, cx: &mut AsyncApp) -> Result<Value> {
        let root = self.root(cx)?;
        let mut stages = Vec::new();
        sleep(cx, Duration::from_secs(4)).await;
        stages.push(json!({ "stage": "project open, main.tex and main.pdf shown", "memory": footprint_summary() }));
        // LATTICE_MEMORY_FILE swaps the big file, to attribute what the
        // editor costs with and without LaTeX highlighting.
        let big = std::env::var_os("LATTICE_MEMORY_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("long.tex"));
        let _editor = self.open(cx, &big, None)?;
        sleep(cx, Duration::from_secs(4)).await;
        stages.push(json!({ "stage": format!("{} open", big.file_name().unwrap_or_default().to_string_lossy()), "memory": footprint_summary() }));
        let pages = cx.update(|cx| self.shell.read(cx).pdf().read(cx).page_count());
        for page in 0..pages {
            cx.update(|cx| {
                let pdf = self.shell.read(cx).pdf().clone();
                pdf.update(cx, |pdf, cx| pdf.scroll_to_page(page, cx))
            });
            sleep(cx, Duration::from_millis(60)).await;
        }
        sleep(cx, Duration::from_secs(3)).await;
        stages.push(json!({ "stage": format!("PDF scrolled through all {pages} pages"), "memory": footprint_summary() }));
        Ok(json!({ "scenario": "memory", "stages": stages }))
    }

    /// Chinese input through the system Pinyin input method: select it for
    /// this window, type `nihao` and a space with native key events, and
    /// check that the editor received 你好 (and showed marked text on the
    /// way).
    pub(super) async fn ime(&self, cx: &mut AsyncApp) -> Result<Value> {
        // Apple's Pinyin, or the Sogou Pinyin this machine actually uses.
        const PINYIN: [&str; 2] = [
            "com.apple.inputmethod.SCIM.ITABC",
            "com.sogou.inputmethod.sogou.pinyin",
        ];
        let root = self.root(cx)?;
        let scratch = root.join("ime-check.tex");
        std::fs::write(&scratch, "")?;
        let editor = self.open(cx, &scratch, Some(1))?;
        sleep(cx, Duration::from_millis(500)).await;
        let native = self.native(cx)?;
        let mut selected = None;
        let mut previous = None;
        let mut errors = Vec::new();
        for source in PINYIN {
            match native::select_input_source(native, source) {
                Ok(before) => {
                    selected = Some(source);
                    previous = before;
                    break;
                }
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        let Some(selected) = selected else {
            return Err(anyhow!(
                "no Pinyin input source could be selected: {}",
                errors.join("; ")
            ));
        };
        sleep(cx, Duration::from_millis(500)).await;

        let mut marked = Vec::new();
        for character in "nihao".chars() {
            self.type_text(cx, &character.to_string()).await?;
            sleep(cx, Duration::from_millis(150)).await;
            let inner = cx.update(|cx| editor.read(cx).editor().clone());
            let (text, marked_range) = self.with_window(cx, |_, window, cx| {
                inner.update(cx, |editor, cx| {
                    (editor.text(cx), editor.marked_text_range(window, cx))
                })
            })?;
            marked.push(json!({ "text": text, "marked_utf16": marked_range.map(|range| [range.start, range.end]) }));
        }
        self.type_text(cx, " ").await?;
        sleep(cx, Duration::from_millis(400)).await;
        let committed = self.editor_text(cx, &editor);

        if let Some(previous) = previous {
            native::select_input_source(native, &previous).ok();
        }
        std::fs::remove_file(&scratch).ok();
        Ok(json!({
            "scenario": "ime",
            "input_source": selected,
            "while_composing": marked,
            "committed": committed,
            "passed": committed.trim() == "你好",
        }))
    }
}

fn unsafe_set_marked(native: native::Native, marked: &str) -> Result<()> {
    native::set_marked(native, marked)
}

/// Lattice's frame meter on GPUI: a callback on every frame (like a
/// `requestAnimationFrame` loop) and the intervals between them.
struct FrameMeter {
    stamps: Rc<RefCell<Vec<Instant>>>,
    running: Rc<Cell<bool>>,
}

impl FrameMeter {
    fn start(run: &Run, cx: &mut AsyncApp) -> Result<Self> {
        let stamps = Rc::new(RefCell::new(Vec::new()));
        let running = Rc::new(Cell::new(true));
        fn tick(window: &mut Window, stamps: Rc<RefCell<Vec<Instant>>>, running: Rc<Cell<bool>>) {
            stamps.borrow_mut().push(Instant::now());
            if running.get() {
                window.on_next_frame(move |window, _| tick(window, stamps, running));
            }
        }
        run.with_window(cx, {
            let (stamps, running) = (stamps.clone(), running.clone());
            move |_, window, _| window.on_next_frame(move |window, _| tick(window, stamps, running))
        })?;
        Ok(Self { stamps, running })
    }

    /// `paints` are the editor's paint times over the same span: each frame's
    /// start to its paint is that frame's work up to the editor.
    fn stop(self, paints: &[Instant]) -> Value {
        self.running.set(false);
        let stamps = self.stamps.borrow();
        let mut frame_work: Vec<f64> = stamps
            .iter()
            .filter_map(|start| {
                paints
                    .iter()
                    .find(|painted| *painted > start)
                    .map(|painted| (*painted - *start).as_secs_f64() * 1000.)
                    .filter(|work| *work < 100.)
            })
            .collect();
        frame_work.sort_by(f64::total_cmp);
        let intervals: Vec<f64> = stamps
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).as_secs_f64() * 1000.)
            .collect();
        if intervals.is_empty() {
            return json!({ "frames": 0 });
        }
        let span = (stamps[stamps.len() - 1] - stamps[0]).as_secs_f64();
        let mut sorted = intervals.clone();
        sorted.sort_by(f64::total_cmp);
        let over = |limit: f64| intervals.iter().filter(|v| **v > limit).count();
        let jank: f64 = intervals
            .iter()
            .filter(|v| **v > 33.4)
            .map(|v| v - 16.7)
            .sum();
        json!({
            "frames": intervals.len(),
            "fps": intervals.len() as f64 / span,
            "interval_p50_ms": percentile(&sorted, 0.50),
            "interval_p95_ms": percentile(&sorted, 0.95),
            "longest_ms": sorted[sorted.len() - 1],
            "over_25ms": over(25.),
            "over_50ms": over(50.),
            "over_100ms": over(100.),
            "jank_ms": jank,
            "frame_start_to_editor_paint_ms": if frame_work.is_empty() {
                Value::Null
            } else {
                json!({
                    "p50": percentile(&frame_work, 0.5),
                    "p95": percentile(&frame_work, 0.95),
                    "max": frame_work[frame_work.len() - 1],
                })
            },
        })
    }
}

/// Process CPU time over a span of wall time (user + system, all threads).
struct CpuMeter {
    cpu: Duration,
    wall: Instant,
}

impl CpuMeter {
    fn start() -> Self {
        Self {
            cpu: process_cpu_time(),
            wall: Instant::now(),
        }
    }

    fn percent_of_one_core(self) -> f64 {
        let cpu = process_cpu_time().saturating_sub(self.cpu).as_secs_f64();
        100. * cpu / self.wall.elapsed().as_secs_f64()
    }
}

fn process_cpu_time() -> Duration {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage fills the struct it is handed.
    let usage = unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        usage.assume_init()
    };
    let time = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
    time(usage.ru_utime) + time(usage.ru_stime)
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    let ix = ((sorted.len() as f64 - 1.) * q).round() as usize;
    sorted[ix.min(sorted.len() - 1)]
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.
}

fn durations_ms(durations: &[Duration]) -> Value {
    let mut sorted: Vec<f64> = durations.iter().copied().map(ms).collect();
    if sorted.is_empty() {
        return json!({ "n": 0 });
    }
    sorted.sort_by(f64::total_cmp);
    json!({
        "n": sorted.len(),
        "mean": sorted.iter().sum::<f64>() / sorted.len() as f64,
        "p50": percentile(&sorted, 0.5),
        "p90": percentile(&sorted, 0.9),
        "p95": percentile(&sorted, 0.95),
        "max": sorted[sorted.len() - 1],
    })
}

fn histogram_ms(histogram: &hdrhistogram::Histogram<u64>) -> Value {
    if histogram.is_empty() {
        return json!({ "n": 0 });
    }
    let at = |q: f64| histogram.value_at_quantile(q) as f64 / 1e6;
    json!({
        "n": histogram.len(),
        "mean": histogram.mean() / 1e6,
        "p50": at(0.5),
        "p90": at(0.9),
        "p95": at(0.95),
        "max": histogram.max() as f64 / 1e6,
    })
}

fn footprint_summary() -> Value {
    let mut value = footprint();
    if let Some(object) = value.as_object_mut() {
        object.remove("raw");
    }
    value
}

/// `footprint -p <this process>`, the tool Lattice's perf lab reads memory
/// with: the total and the graphics categories, plus the raw report.
fn footprint() -> Value {
    let output = std::process::Command::new("/usr/bin/footprint")
        .arg("-p")
        .arg(std::process::id().to_string())
        .output();
    let Ok(output) = output else {
        return json!({ "error": "footprint did not run" });
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut categories = serde_json::Map::new();
    let mut total = None;
    let mut peak = None;
    for line in text.lines() {
        if let Some(rest) = line.split("phys_footprint_peak:").nth(1) {
            peak = Some(rest.trim().to_string());
            continue;
        }
        if let Some(rest) = line.split("Footprint:").nth(1) {
            total = Some(rest.trim().to_string());
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // "  78 MB  0 B  0 B  38  IOSurface"
        if fields.len() >= 8 && fields[1].ends_with('B') {
            let name = fields[7..].join(" ");
            categories.insert(name, json!(format!("{} {}", fields[0], fields[1])));
        }
    }
    json!({ "footprint": total, "phys_footprint_peak": peak, "dirty_by_category": categories, "raw": text })
}
