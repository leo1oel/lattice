//! The compiled PDF in a window of its own, for a writer who keeps the editor
//! on one screen and the PDF on another.
//!
//! The window runs Lattice's page in its viewer-only mode
//! (`src/pdf/pdf-window-app.tsx`). The workspace window that opened it, its
//! owner, keeps the build, SyncTeX and the open documents, and the two pages
//! talk through events. Its commands resolve against the owner's project
//! (`AppState::root_for`), so it never holds a binding of its own: a project
//! switch in the owner is one for the window too, and its closing never
//! retires a project.
//!
//! The owner's page opens and closes it. Only a close the writer makes (its
//! close button, ⌘W) is reported back, as `pdf-window-closed`, which docks
//! the PDF again; a window torn down with its owner, by a project switch or by
//! quitting is not, so the choice to keep the PDF apart outlives the session.

pub(crate) use crate::app_state::is_pdf_window;
use crate::app_state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, Runtime, State, WebviewWindowBuilder, Window,
};

const CLOSED_EVENT: &str = "pdf-window-closed";
const FRAME_EVENT: &str = "pdf-window-frame";
const DEFAULT_SIZE: (f64, f64) = (760.0, 880.0);
const MIN_SIZE: (f64, f64) = (420.0, 360.0);
/// The title bar's height, in points: what must stay on a screen to be grabbed.
const TITLE_BAR: f64 = 28.0;
/// How much of the title bar's width must stay on one screen.
const GRIP: f64 = 64.0;

/// A window's place on the desktop, in logical points: its outer top-left
/// corner and its content size, as the window builder takes them.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Frame {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// The saved frame when enough of its title bar is still on an attached screen
/// to grab it, its size kept within that screen. None when the screen it was
/// on is gone (or the frame is nonsense): the window then opens centred on the
/// main screen.
pub(crate) fn placement(saved: Frame, screens: &[Frame]) -> Option<Frame> {
    let finite =
        [saved.x, saved.y, saved.width, saved.height].iter().all(|value| value.is_finite());
    if !finite || saved.width <= 0.0 || saved.height <= 0.0 {
        return None;
    }
    let screen = screens.iter().find(|screen| {
        let across = (saved.x + saved.width).min(screen.x + screen.width) - saved.x.max(screen.x);
        let down = (saved.y + TITLE_BAR).min(screen.y + screen.height) - saved.y.max(screen.y);
        across >= GRIP && down >= TITLE_BAR / 2.0
    })?;
    Some(Frame {
        width: saved.width.clamp(MIN_SIZE.0, screen.width.max(MIN_SIZE.0)),
        height: saved.height.clamp(MIN_SIZE.1, screen.height.max(MIN_SIZE.1)),
        ..saved
    })
}

/// The attached screens, in logical points. macOS places screens in one space
/// of points; each monitor reports its corner in its own pixels.
fn screens<R: Runtime>(app: &AppHandle<R>) -> Vec<Frame> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            Frame {
                x: f64::from(monitor.position().x) / scale,
                y: f64::from(monitor.position().y) / scale,
                width: f64::from(monitor.size().width) / scale,
                height: f64::from(monitor.size().height) / scale,
            }
        })
        .collect()
}

fn build(
    app: &AppHandle, label: &str, title: &str, frame: Option<Frame>, focus: bool,
) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title(title)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .focused(focus)
        .background_color(tauri::window::Color(0xF7, 0xF7, 0xF6, 0xFF))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    // A click into the window while the editor has the keyboard reaches the
    // page, so a double-click there jumps to the source at once.
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    let builder = match frame.and_then(|saved| placement(saved, &screens(app))) {
        Some(frame) => builder.position(frame.x, frame.y).inner_size(frame.width, frame.height),
        None => builder.inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1).center(),
    };
    let window = builder.build()?;
    crate::macos_window::render_at_display_refresh_rate(&window);
    #[cfg(feature = "perf-lab")]
    crate::perf_lab::tune_wkwebview(&window);
    Ok(())
}

/// Open the calling workspace window's PDF window at `frame` (where the
/// writer last left it for this project), or bring the one it has forward.
/// Answers its label, which the owner's page addresses it by.
#[tauri::command]
pub async fn open_pdf_window(
    app: AppHandle, window: Window, state: State<'_, AppState>, title: String,
    frame: Option<Frame>, focus: bool,
) -> Result<String, String> {
    let owner = window.label();
    if !crate::is_workspace_window(owner) {
        return Err("Only a Lattice window can open the PDF in a window of its own.".to_string());
    }
    let (label, existing) = state.pdf_windows.claim(owner);
    if existing {
        if let Some(open) = app.get_webview_window(&label) {
            let _ = open.set_title(&title);
            if focus {
                let _ = open.unminimize();
                let _ = open.set_focus();
            }
        }
        return Ok(label);
    }
    if let Err(error) = build(&app, &label, &title, frame, focus) {
        state.pdf_windows.forget(&label);
        return Err(format!("Could not open the PDF in a new window: {error}"));
    }
    // Closed while it was being built (the PDF docked, the owner's page
    // reloaded or closed): nothing would address or close it again.
    if state.pdf_windows.owner(&label).as_deref() != Some(owner) {
        if let Some(open) = app.get_webview_window(&label) {
            let _ = open.destroy();
        }
        return Err("The PDF window was closed while it opened.".to_string());
    }
    Ok(label)
}

/// Close the calling window's PDF window `label`, the PDF going back to its
/// panel or the project closing: not reported as the writer's close. It is
/// forgotten at once, so asking again while it closes opens a new one.
#[tauri::command]
pub fn close_pdf_window(app: AppHandle, window: Window, state: State<'_, AppState>, label: String) {
    if state.pdf_windows.owner(&label).as_deref() != Some(window.label()) {
        return;
    }
    state.pdf_windows.forget(&label);
    if let Some(open) = app.get_webview_window(&label) {
        let _ = open.destroy();
    }
}

/// Close the PDF window `owner` has, if any, without reporting it: its owner
/// closed, or its page reloaded and will open it again if it should.
pub(crate) fn close_owned<R: Runtime>(app: &AppHandle<R>, owner: &str) {
    let Some(label) = app.state::<AppState>().pdf_windows.forget_owner(owner) else { return };
    if let Some(open) = app.get_webview_window(&label) {
        let _ = open.destroy();
    }
}

#[derive(Clone, Serialize)]
struct FrameReport<'a> {
    label: &'a str,
    frame: Frame,
}

/// Where the window is now, unless it is minimized or full screen: neither is
/// a place to come back to.
fn current_frame<R: Runtime>(window: &Window<R>) -> Option<Frame> {
    if window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    (size.width > 0.0 && size.height > 0.0).then_some(Frame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// A PDF window's close by the writer and its moves and resizes, reported to
/// its owner; a workspace window going takes its PDF window with it.
pub(crate) fn on_window_event<R: Runtime>(window: &Window<R>, event: &tauri::WindowEvent) {
    let label = window.label();
    if !is_pdf_window(label) {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            close_owned(window.app_handle(), label);
        }
        return;
    }
    let state = window.state::<AppState>();
    let Some(owner) = state.pdf_windows.owner(label) else { return };
    let owner = EventTarget::webview_window(owner);
    match event {
        tauri::WindowEvent::CloseRequested { .. } => {
            let _ = window.emit_to(owner, CLOSED_EVENT, label);
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let Some(frame) = current_frame(window) {
                let _ = window.emit_to(owner, FRAME_EVENT, FrameReport { label, frame });
            }
        }
        tauri::WindowEvent::Destroyed => {
            state.pdf_windows.forget(label);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{placement, Frame};

    const MAIN: Frame = Frame { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    const RIGHT: Frame = Frame { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 };

    #[test]
    fn a_saved_frame_comes_back_on_a_screen_still_attached() {
        let saved = Frame { x: 1800.0, y: 40.0, width: 900.0, height: 1200.0 };
        assert_eq!(placement(saved, &[MAIN, RIGHT]), Some(saved));
    }

    #[test]
    fn a_frame_whose_screen_is_gone_opens_on_the_main_screen() {
        // The second monitor was unplugged: the window would open off screen.
        let saved = Frame { x: 1800.0, y: 40.0, width: 900.0, height: 1200.0 };
        assert_eq!(placement(saved, &[MAIN]), None);
        // A title bar hanging off the bottom, or a sliver at the edge, cannot be grabbed.
        assert_eq!(placement(Frame { y: 975.0, ..saved }, &[MAIN]), None);
        assert_eq!(placement(Frame { x: 1480.0, ..saved }, &[MAIN]), None);
    }

    #[test]
    fn a_saved_frame_is_kept_within_its_screen_and_sane() {
        let tall = Frame { x: 100.0, y: 40.0, width: 200.0, height: 5000.0 };
        assert_eq!(
            placement(tall, &[MAIN]),
            Some(Frame { x: 100.0, y: 40.0, width: 420.0, height: 982.0 }),
        );
        assert_eq!(placement(Frame { width: f64::NAN, ..tall }, &[MAIN]), None);
        assert_eq!(placement(Frame { height: 0.0, ..tall }, &[MAIN]), None);
    }
}
