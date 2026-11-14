//! The commit messages Lattice writes into a project's git history, ported
//! from the Tauri app's `src/history/version-messages.ts`. That history is
//! shared with collaborators and remotes, so it stays English whatever the
//! interface language; only the versions list shows these translated.

use std::sync::LazyLock;

use lattice_i18n::t;
use regex::Regex;

pub const OVERLEAF_SYNC: &str = "Overleaf sync";
/// Also written by lattice-core (git.rs) before it restores a file or the project.
pub const AUTO_SAVED: &str = "Auto-saved version";
pub const SAVED: &str = "Saved version";
/// Written by lattice-core (git.rs) when version tracking starts.
pub const INITIALIZED: &str = "Initialize version tracking";

/// Written by lattice-core (git.rs) when the whole project is restored.
static RESTORE_MESSAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Restore project to (\S+)$").expect("the restore pattern compiles")
});

/// A version Lattice made on its own (after a sync or a build) rather than
/// one someone saved or named.
pub fn is_automatic(message: &str) -> bool {
    message == AUTO_SAVED || message == OVERLEAF_SYNC
}

/// A version Lattice wrote while starting tracking or restoring.
pub fn is_bookkeeping(message: &str) -> bool {
    message == INITIALIZED || RESTORE_MESSAGE.is_match(message)
}

/// A commit message as the versions list shows it: Lattice's own in the
/// interface language, the rest as written.
pub fn label(message: &str) -> String {
    match message {
        OVERLEAF_SYNC => t!("Overleaf sync").into(),
        AUTO_SAVED => t!("Auto-saved version").into(),
        SAVED => t!("Saved version").into(),
        INITIALIZED => t!("Initialize version tracking").into(),
        _ => match RESTORE_MESSAGE.captures(message) {
            Some(captures) => t!("Restore project to {restored}", restored = &captures[1]),
            None => message.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_lattices_own_versions_from_named_ones() {
        assert!(is_automatic(AUTO_SAVED) && is_automatic(OVERLEAF_SYNC));
        assert!(!is_automatic(SAVED) && !is_automatic("Draft for Anna"));
        assert!(is_bookkeeping(INITIALIZED) && is_bookkeeping("Restore project to abc1234"));
        assert!(!is_bookkeeping("Restore project to"));
        assert_eq!(label("Draft for Anna"), "Draft for Anna");
    }
}
