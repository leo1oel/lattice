//! Where "Open from Overleaf" downloads a project: the folder it offers
//! (the last one used, else Documents/Overleaf Projects) and the check a
//! folder the writer chooses must pass. The download itself is
//! `overleaf_clone_project` in `overleaf.rs`.

use super::overleaf::{overleaf_config_dir, overleaf_projects_dir};
use super::run_blocking;
use crate::overleaf;
use std::path::Path;
use tauri::AppHandle;

/// A folder Overleaf projects download into.
#[derive(serde::Serialize)]
pub struct DownloadParent {
    path: String,
    /// The path for people to read, with the home folder as `~`.
    display: String,
}

impl DownloadParent {
    fn of(path: &Path) -> Self {
        DownloadParent {
            path: path.to_string_lossy().into_owned(),
            display: overleaf::display_path(path),
        }
    }
}

/// The folder "Open from Overleaf" offers to download into: the last one
/// used, else Documents/Overleaf Projects.
#[tauri::command]
pub async fn overleaf_download_parent(app: AppHandle) -> Result<DownloadParent, String> {
    let config = overleaf_config_dir(&app)?;
    let default = overleaf_projects_dir(&app)?;
    Ok(DownloadParent::of(&overleaf::download_parent(&config, &default)))
}

/// Whether a project can be downloaded into `parent`, the folder the writer
/// just chose, so the picker says so before anything downloads.
#[tauri::command]
pub async fn overleaf_check_download_parent(parent: String) -> Result<DownloadParent, String> {
    run_blocking("Overleaf download folder", move || {
        let parent = Path::new(&parent);
        overleaf::check_download_parent(parent)?;
        Ok(DownloadParent::of(parent))
    })
    .await
}
