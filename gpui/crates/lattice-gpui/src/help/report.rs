//! Help ▸ Report a Problem… and the palette's "Report a problem", as the
//! Tauri app files one (`src/app/report-problem.ts`): save the log export
//! Settings › Logs › Export makes by default (redacted: operation metadata
//! and counts only) in the log folder's `reports/`, show it in Finder, and
//! open a new bug report with the Lattice and macOS versions filled in.
//!
//! The issue page is public and its address travels through the browser's
//! history, so the address carries the versions and the architecture and
//! nothing from the log; the reporter attaches the saved file themselves,
//! after reading it if they like.
//!
//! The Tauri app first offers an update it already found; the GPUI preview
//! has no updater, so it files the report at once.

use gpui::{App, AppContext as _};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use crate::{
    app_log::{self, export},
    notices::{self, Notice},
};

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes a value:
/// letters, digits and `*-._` as they are, a space as `+`, the rest escaped.
fn form_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                (byte as char).to_string()
            }
            b' ' => "+".to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// The bug report form (`.github/ISSUE_TEMPLATE/bug_report.yml`), its
/// version fields filled in.
pub fn new_issue_url(os_version: Option<&str>, arch: &str, lattice_version: &str) -> String {
    let macos = format!("macOS {} ({arch})", os_version.unwrap_or("unknown"));
    format!(
        "https://github.com/leo1oel/lattice/issues/new?template={}&lattice-version={}&macos-version={}",
        form_encode("bug_report.yml"),
        form_encode(lattice_version),
        form_encode(&macos)
    )
}

/// A saved report: the file to attach and the form to open.
pub struct Saved {
    pub path: std::path::PathBuf,
    pub issue_url: String,
}

/// Save the redacted export in the log folder's `reports/`, off the main
/// thread. A run with no state folder saves in a folder of its own.
pub fn save_report(cx: &mut App) -> gpui::Task<Result<Saved, String>> {
    let log = app_log::global(cx);
    let (entries, folder) = {
        let log = log.read(cx);
        (log.entries().to_vec(), log.log_folder())
    };
    let folder = folder
        .unwrap_or_else(|| std::env::temp_dir().join("lattice-gpui-logs"))
        .join("reports");
    let contents =
        serde_json::to_string_pretty(&export::create_now(&entries, false)).unwrap_or_default();
    cx.background_spawn(async move {
        let home = dirs::home_dir();
        let (path, report) = lattice_core::diagnostic_logs::save_problem_report(
            &folder,
            &contents,
            home.as_deref(),
        )?;
        Ok(Saved {
            path,
            issue_url: new_issue_url(report.os_version(), report.arch(), lattice_core::VERSION),
        })
    })
}

/// File a report: save it, then show the file in Finder and open the form;
/// a refusal says why in a notice.
pub fn report_problem(cx: &mut App) {
    let saved = save_report(cx);
    cx.spawn(async move |cx| {
        let saved = saved.await;
        let source = t!("Report a problem");
        cx.update(|cx| match saved {
            Ok(saved) => {
                notices::show(
                    Notice::new(ToastLevel::Info, t!("Diagnostic log saved"))
                        .source(source)
                        .detail(t!("Attach the file shown in Finder to the bug report.")),
                    cx,
                );
                cx.reveal_path(&saved.path);
                cx.open_url(&saved.issue_url);
            }
            Err(error) => notices::show(
                Notice::new(ToastLevel::Error, t!("Couldn’t save the diagnostic log"))
                    .source(source)
                    .detail(error),
                cx,
            ),
        });
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_carries_only_the_versions_and_the_architecture() {
        // The Tauri app's `report-problem.test.ts` expectations.
        let url = new_issue_url(Some("15.1"), "aarch64", "0.16.1");
        assert_eq!(
            url,
            "https://github.com/leo1oel/lattice/issues/new?template=bug_report.yml&lattice-version=0.16.1&macos-version=macOS+15.1+%28aarch64%29"
        );
        assert!(new_issue_url(None, "x86_64", "1.0.0").ends_with("macOS+unknown+%28x86_64%29"));
    }
}
