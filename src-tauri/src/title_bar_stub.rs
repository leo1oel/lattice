//! Non-macOS title-bar behavior.

pub fn overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(windows)]
    let builder = builder.min_inner_size(640.0, 240.0);
    builder
}

pub fn perform_double_click(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        if window.is_fullscreen().unwrap_or(false) {
            return;
        }
        let result = if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        };
        if let Err(error) = result {
            log::warn!(target: "lattice::window", "Could not toggle maximization: {error}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}
