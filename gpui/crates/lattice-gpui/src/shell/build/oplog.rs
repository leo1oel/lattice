//! A build's entries in the app's log (`crate::app_log::trace`), as the
//! Tauri app's build pipeline writes them.

use lattice_i18n::t;

use super::{BuildRequest, Finished};
use crate::app_log::trace::Trace;

/// Open a build's operation in the log: "▶ Build", a forced one's trigger
/// "clean rebuild", one that waited behind another build's "queued".
pub(super) fn start(request: BuildRequest, cx: &mut gpui::App) -> Trace {
    let trigger = if request.force {
        Some(t!("clean rebuild"))
    } else {
        request.queued.then(|| t!("queued"))
    };
    Trace::start(
        t!("Build"),
        t!("Build"),
        trigger.map(|trigger| trigger.to_string()),
        "Build",
        cx,
    )
}

/// The clean before a forced build failed: a notice says so, and the
/// operation ends with the clean's own failure.
pub(super) fn clean_failed(trace: Option<&mut Trace>, error: String, cx: &mut gpui::App) {
    let title = t!("Couldn’t clean the build files");
    if let Some(trace) = trace {
        trace.fail(title.to_string(), &error, cx);
    }
    crate::notices::error(title, error, cx);
}

/// How the build ended, in the app's log (`use-build-pipeline.ts`): its
/// counts, then success with its time, a failure with its first error, or
/// superseded when another project took the window or the pass was cancelled.
pub(super) fn outcome(
    trace: &mut Trace,
    current: bool,
    outcome: Option<&Result<Finished, String>>,
    cx: &mut gpui::App,
) {
    let superseded = || Some(t!("Build superseded").to_string());
    match outcome {
        _ if !current => trace.finish("cancelled", superseded(), cx),
        None => {}
        Some(Ok(Finished { result, .. })) => {
            trace.enrich([
                (
                    "compiler_duration_ms",
                    serde_json::json!(result.duration_ms as u64),
                ),
                ("diagnostics", serde_json::json!(result.diagnostics.len())),
                ("has_pdf", serde_json::json!(result.has_pdf)),
            ]);
            let cancelled = result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == Some("build-cancelled"));
            if cancelled {
                trace.finish("cancelled", superseded(), cx);
            } else if result.success {
                let seconds = format!("{:.1}", result.duration_ms as f64 / 1000.);
                trace.finish(
                    "success",
                    Some(t!("Build succeeded in {seconds} s", seconds = seconds)),
                    cx,
                );
            } else {
                let first = result
                    .diagnostics
                    .iter()
                    .find(|diagnostic| diagnostic.level == "error")
                    .or(result.diagnostics.first())
                    .map(|diagnostic| diagnostic.message.as_str())
                    .unwrap_or_default();
                trace.fail(t!("LaTeX compilation failed.").to_string(), first, cx);
            }
        }
        Some(Err(error)) => trace.fail(t!("LaTeX compilation failed.").to_string(), error, cx),
    }
}
