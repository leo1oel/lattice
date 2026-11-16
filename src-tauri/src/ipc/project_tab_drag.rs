//! The desktop window under a project-tab drag. The webview owns the tab strip's
//! geometry; the host owns which window actually receives a drop at the cursor.

use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTabDragTarget {
    window_label: String,
    /// Fractions of the webview's width and height, with the origin at its top left.
    x: f64,
    y: f64,
}

#[tauri::command]
pub(crate) async fn project_tab_drag_target(
    app: AppHandle, window: WebviewWindow,
) -> Result<Option<ProjectTabDragTarget>, String> {
    if !crate::is_workspace_window(window.label()) {
        return Ok(None);
    }
    hit_project_window(&app, &window).await
}

#[cfg(target_os = "macos")]
async fn hit_project_window(
    app: &AppHandle, _source: &WebviewWindow,
) -> Result<Option<ProjectTabDragTarget>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSWindow};

    let (send, receive) = tokio::sync::oneshot::channel();
    let host = app.clone();
    app.run_on_main_thread(move || {
        let hit = MainThreadMarker::new().and_then(|main| {
            let point = NSEvent::mouseLocation();
            // Ask AppKit for the real frontmost window rather than comparing
            // rectangles, which would let a covered strip take the drop.
            let number = NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(point, 0, main);
            host.webview_windows().into_iter().find_map(|(label, window)| {
                if !crate::is_workspace_window(&label) {
                    return None;
                }
                let address = crate::macos_window::ns_window_address(&window)?;
                // SAFETY: AppKit owns the live window and this is its main thread.
                let native = unsafe { &*(address as *const NSWindow) };
                if native.windowNumber() != number {
                    return None;
                }
                let view = native.contentView()?;
                let local = view.convertPoint_fromView(native.convertPointFromScreen(point), None);
                let bounds = view.bounds();
                if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                    return None;
                }
                let y = (local.y - bounds.origin.y) / bounds.size.height;
                Some(ProjectTabDragTarget {
                    window_label: label,
                    x: (local.x - bounds.origin.x) / bounds.size.width,
                    y: if view.isFlipped() { y } else { 1.0 - y },
                })
            })
        });
        let _ = send.send(hit);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
async fn hit_project_window(
    app: &AppHandle, source: &WebviewWindow,
) -> Result<Option<ProjectTabDragTarget>, String> {
    let cursor = source.cursor_position().map_err(|error| error.to_string())?;
    let contains = |position: tauri::PhysicalPosition<i32>, size: tauri::PhysicalSize<u32>| {
        let x = cursor.x - f64::from(position.x);
        let y = cursor.y - f64::from(position.y);
        x >= 0.0 && x < f64::from(size.width) && y >= 0.0 && y < f64::from(size.height)
    };
    let mut hit = None;
    let mut ambiguous = false;
    for (label, window) in app.webview_windows() {
        if !crate::is_workspace_window(&label)
            || !window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(true)
        {
            continue;
        }
        let outer = window.outer_position().map_err(|error| error.to_string())?;
        let frame = window.outer_size().map_err(|error| error.to_string())?;
        if !contains(outer, frame) {
            continue;
        }
        let origin = window.inner_position().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let target = ProjectTabDragTarget {
            window_label: label,
            x: (cursor.x - f64::from(origin.x)) / f64::from(size.width.max(1)),
            y: (cursor.y - f64::from(origin.y)) / f64::from(size.height.max(1)),
        };
        if window.is_focused().unwrap_or(false) {
            return Ok(Some(target));
        }
        ambiguous |= hit.replace(target).is_some();
    }
    if ambiguous {
        // Without a known front window, an overlapping hit is ambiguous.
        return Err("Project tab drop is covered by another window.".to_string());
    }
    Ok(hit)
}
