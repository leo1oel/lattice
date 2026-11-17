//! What kind of window a label names, for the commands and events that treat
//! workspace windows apart from the browser bridges, PDF windows and popups.

use crate::app_state::MAIN_WINDOW_LABEL;

/// A desktop window running Lattice's own page (`workspace_window`): the
/// launch window or a project window, not a browser host, a presenter popup
/// or the Overleaf sign-in page.
pub(crate) fn is_workspace_window(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
        || label.strip_prefix("project-").is_some_and(|rest| !rest.is_empty())
}

/// Whether the window-state plugin remembers and restores the window
/// `label`. Not a browser bridge, which must stay hidden (the plugin's restore
/// shows it), nor a PDF window, placed per project instead (pdf_window.rs).
pub(crate) fn window_state_tracks(label: &str) -> bool {
    !label.starts_with("browser-") && !crate::pdf_window::is_pdf_window(label)
}

#[cfg(test)]
mod tests {
    use super::{is_workspace_window, window_state_tracks};

    #[test]
    fn workspace_windows_are_the_launch_and_project_windows() {
        for label in ["main", "project-1", "project-12"] {
            assert!(is_workspace_window(label), "{label}");
        }
        for label in ["project-", "browser-1", "overleaf-login", "presenter", "mainly"] {
            assert!(!is_workspace_window(label), "{label}");
        }
    }

    #[test]
    fn window_state_skips_bridge_and_pdf_windows() {
        for label in ["main", "project-2"] {
            assert!(window_state_tracks(label), "{label}");
        }
        for label in ["browser-1", "pdf-1"] {
            assert!(!window_state_tracks(label), "{label}");
        }
    }
}
