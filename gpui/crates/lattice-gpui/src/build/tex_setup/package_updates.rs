//! The TeX doctor's package-update check and its one-click update, as the
//! Tauri app's `useTexPackageUpdates` keeps them
//! (`src/app/use-tex-package-updates.ts`, `src/build/tex-package-updates.ts`,
//! `src/settings/tex-package-check-problem.ts`): the last check of what the
//! TeX Live repository has newer, and the update, present while it runs and
//! after it ends, until a later check.

use lattice_core::tex_setup::TexPackageUpdates;

use super::center::InstallProgress;

/// What the writer runs for a TeX Lattice does not manage (lattice-core's
/// `UPDATE_COMMAND`).
pub const UPDATE_COMMAND: &str = "sudo tlmgr update --self --all";

/// Package names the doctor spells out before it only counts the rest.
const NAMED_PACKAGES: usize = 3;

#[derive(Clone, Debug)]
pub struct UpdateRun {
    pub progress: InstallProgress,
    pub running: bool,
    /// Why it failed; `None` while running and after it succeeded.
    pub error: Option<String>,
}

#[derive(Default)]
pub struct PackageUpdates {
    /// The last check; `None` before one finishes, or without a tlmgr to ask.
    pub report: Option<TexPackageUpdates>,
    pub checking: bool,
    pub run: Option<UpdateRun>,
    pub(super) generation: u64,
}

impl PackageUpdates {
    /// The update can be offered: Lattice's own BasicTeX has packages to
    /// update, and nothing is checking or updating.
    pub fn offer(&self) -> bool {
        !self.checking
            && !self.run.as_ref().is_some_and(|run| run.running)
            && self.report.as_ref().is_some_and(|report| {
                report.error.is_none() && report.managed && !report.packages.is_empty()
            })
    }
}

/// The doctor's "TeX packages" tile: whether it reads as a problem, and the
/// line under its name.
pub fn check_detail(report: &TexPackageUpdates) -> Option<String> {
    if let Some(error) = &report.error {
        return Some(check_problem(error).0);
    }
    let count = report.packages.len();
    if count == 0 {
        return None;
    }
    let named = report
        .packages
        .iter()
        .take(NAMED_PACKAGES)
        .map(|package| {
            format!(
                "{} {} → {}",
                package.name, package.installed, package.available
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(if count > NAMED_PACKAGES {
        format!(
            "Updates available ({count}): {named}, and {} more",
            count - NAMED_PACKAGES
        )
    } else {
        format!("Updates available ({count}): {named}")
    })
}

/// Why the doctor could not check for updates: a summary and, unless the
/// network is to blame, tlmgr's own words. A release older than the
/// repository is checked first: every repository tried says so, and a later
/// one may also time out.
pub fn check_problem(error: &str) -> (String, String) {
    let lowercase = error.to_lowercase();
    if lowercase.contains("older than remote repository") {
        return (
            "This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.".into(),
            error.trim().to_string(),
        );
    }
    let unreachable = [
        "did not answer within",
        "could not get texlive.tlpdb",
        "cannot contact",
        "could not resolve host",
        "connection",
        "timed out",
        "unable to download",
    ];
    if unreachable.iter().any(|sign| lowercase.contains(sign)) {
        return (
            "Couldn’t check for updates. Check the network connection, then run the TeX doctor again."
                .into(),
            String::new(),
        );
    }
    (
        "Couldn’t check for updates".into(),
        error.trim().to_string(),
    )
}

/// A package update's failure (or an install's warning) as a summary and
/// tlmgr's own words.
pub fn update_failure(message: &str) -> (String, String) {
    let (first, rest) = message.split_once('\n').unwrap_or((message, ""));
    let summary = match first {
        "TeX Live's package manager could not update the packages." => {
            "TeX Live’s package manager could not update the packages.".to_string()
        }
        first => first.to_string(),
    };
    (summary, rest.trim().to_string())
}

#[cfg(test)]
mod tests {
    use lattice_core::tex_setup::TexPackageUpdate;

    use super::*;

    fn report(names: &[&str]) -> TexPackageUpdates {
        TexPackageUpdates {
            managed: true,
            packages: names
                .iter()
                .map(|name| TexPackageUpdate {
                    name: name.to_string(),
                    installed: "1".into(),
                    available: "2".into(),
                })
                .collect(),
            error: None,
        }
    }

    #[test]
    fn the_tile_names_three_packages_then_counts() {
        assert_eq!(check_detail(&report(&[])), None);
        assert_eq!(
            check_detail(&report(&["lineno"])).as_deref(),
            Some("Updates available (1): lineno 1 → 2")
        );
        assert_eq!(
            check_detail(&report(&["a", "b", "c", "d", "e"])).as_deref(),
            Some("Updates available (5): a 1 → 2, b 1 → 2, c 1 → 2, and 2 more")
        );
    }

    #[test]
    fn an_unreachable_repository_is_told_apart() {
        let (summary, detail) = check_problem("tlmgr: cannot contact mirror");
        assert!(summary.contains("network connection") && detail.is_empty());
        let (summary, detail) =
            check_problem("tlmgr: Local TeX Live (2025) is older than remote repository (2026).");
        assert!(summary.starts_with("This TeX Live release is older") && !detail.is_empty());
    }

    #[test]
    fn only_a_managed_tex_with_updates_is_offered_the_update() {
        let mut updates = PackageUpdates {
            report: Some(report(&["lineno"])),
            ..PackageUpdates::default()
        };
        assert!(updates.offer());
        updates.report.as_mut().unwrap().managed = false;
        assert!(!updates.offer());
    }
}
