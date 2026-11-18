//! Where a download the page started was saved, told back to its window
//! (`DOWNLOAD_SAVED_EVENT`): a board's Export image is a WebKit download into
//! the Downloads folder, and without this the window never learns it landed.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
};

use tauri::{webview::DownloadEvent, Emitter, EventTarget, Manager, Runtime, WebviewWindowBuilder};

/// `DOWNLOAD_SAVED_EVENT` in src/telemetry/saved-downloads.ts; the payload is
/// the saved file's path.
pub(crate) const DOWNLOAD_SAVED_EVENT: &str = "download-saved";

/// `builder` reporting each finished download to its window. Every download
/// still goes where WebKit would send it.
pub(crate) fn report_saved<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    // WebKit names a finished download by its URL only (macOS passes no
    // path), so each one's destination is kept from when it started.
    let destinations = Arc::new(Mutex::new(HashMap::<String, PathBuf>::new()));
    builder.on_download(move |webview, event| {
        let mut destinations = destinations.lock().unwrap_or_else(PoisonError::into_inner);
        match event {
            DownloadEvent::Requested { url, destination } => {
                destinations.insert(url.to_string(), destination.clone());
            }
            DownloadEvent::Finished { url, path, success } => {
                let started = destinations.remove(url.as_str());
                if let Some(path) = path.or(started).filter(|_| success) {
                    let target = EventTarget::webview_window(webview.label());
                    let _ = webview.emit_to(target, DOWNLOAD_SAVED_EVENT, path);
                }
            }
            _ => {}
        }
        true
    })
}
