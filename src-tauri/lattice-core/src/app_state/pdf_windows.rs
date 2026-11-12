//! Which workspace window owns each separate PDF window. A PDF window never
//! holds a project binding of its own: it shows its owner's
//! (`AppState::root_for`). The shell builds and places the windows.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

const LABEL_PREFIX: &str = "pdf-";

/// Whether `label` names a PDF window rather than a workspace, browser host or
/// sign-in window.
pub fn is_pdf_window(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Which workspace window owns each PDF window. A workspace window has at
/// most one: asking again brings that one forward.
#[derive(Default)]
pub struct PdfWindows {
    owners: Mutex<HashMap<String, String>>,
    next: AtomicU64,
}

impl PdfWindows {
    fn owners(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.owners.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The workspace window that owns the PDF window `label`.
    pub fn owner(&self, label: &str) -> Option<String> {
        self.owners().get(label).cloned()
    }

    /// The label of `owner`'s PDF window, and whether it already had one.
    /// Claimed before the window is built, so two quick requests open one.
    pub fn claim(&self, owner: &str) -> (String, bool) {
        let mut owners = self.owners();
        if let Some((label, _)) = owners.iter().find(|(_, open)| open.as_str() == owner) {
            return (label.clone(), true);
        }
        let label = format!("{LABEL_PREFIX}{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        owners.insert(label.clone(), owner.to_string());
        (label, false)
    }

    pub fn forget(&self, label: &str) -> Option<String> {
        self.owners().remove(label)
    }

    /// Forget `owner`'s PDF window, returning its label.
    pub fn forget_owner(&self, owner: &str) -> Option<String> {
        let mut owners = self.owners();
        let label = owners
            .iter()
            .find(|(_, open)| open.as_str() == owner)
            .map(|(label, _)| label.clone())?;
        owners.remove(&label);
        Some(label)
    }
}

#[cfg(test)]
mod tests {
    use super::{is_pdf_window, PdfWindows};

    #[test]
    fn each_workspace_window_has_one_pdf_window() {
        let windows = PdfWindows::default();
        let (first, existing) = windows.claim("main");
        assert!(is_pdf_window(&first) && !existing);
        // Asking again, even before the window is built, names the same one.
        assert_eq!(windows.claim("main"), (first.clone(), true));
        let (other, _) = windows.claim("project-2");
        assert_ne!(other, first);
        assert_eq!(windows.owner(&first).as_deref(), Some("main"));
        assert_eq!(windows.forget_owner("main"), Some(first.clone()));
        assert_eq!(windows.owner(&first), None);
        // A label is never reused, so a late close of the old window cannot reach a new one.
        assert_ne!(windows.claim("main").0, first);
        assert!(!is_pdf_window("project-1") && !is_pdf_window("main"));
    }
}
