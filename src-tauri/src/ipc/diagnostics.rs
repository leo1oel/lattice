//! Settings › Logs' support bundle and Help ▸ Report a Problem…'s saved log
//! export (`diagnostic_logs`).

use super::run_blocking;
use crate::diagnostic_logs::{self, DiagnosticLogBundle, ProblemReport};
use tauri::{AppHandle, Manager};

/// Async so the log reads run on the blocking pool, not the main thread.
#[tauri::command]
pub async fn collect_diagnostic_logs(app: AppHandle) -> Result<DiagnosticLogBundle, String> {
    run_blocking("Diagnostic log collection", move || {
        let log_root = app.path().app_log_dir().map_err(|error| error.to_string())?;
        let data_root = app.path().app_data_dir().map_err(|error| error.to_string())?;
        let home = app.path().home_dir().ok();
        Ok(diagnostic_logs::collect(&log_root, &data_root, home.as_deref()))
    })
    .await
}

/// Save the redacted log export under Lattice's log folder and show it in
/// Finder (`diagnostic_logs::save_problem_report`).
#[tauri::command]
pub async fn save_problem_report(
    app: AppHandle, contents: String,
) -> Result<ProblemReport, String> {
    use tauri_plugin_opener::OpenerExt;

    let home = app.path().home_dir().ok();
    let folder = super::windows::app_log_dir(&app)?.join("reports");
    let (path, report) = run_blocking("Saving the diagnostic log", move || {
        diagnostic_logs::save_problem_report(&folder, &contents, home.as_deref())
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| format!("Could not show the diagnostic log in Finder: {error}"))?;
    Ok(report)
}
