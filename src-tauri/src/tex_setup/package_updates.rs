//! Whether the installed TeX Live packages have updates: what
//! `tlmgr update --list` reports, and whether the TeX is the BasicTeX that
//! Lattice installs (and so may update) or the writer's own. Free of side
//! effects, so tests cover it everywhere.

use serde::Serialize;

/// What the doctor shows about package updates.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexPackageUpdates {
    /// The TeX is a BasicTeX, which Lattice installs and may update behind
    /// the administrator prompt. Any other TeX gets `UPDATE_COMMAND` to run.
    pub managed: bool,
    /// Installed packages the repository has a newer revision of.
    pub packages: Vec<TexPackageUpdate>,
    /// Why the repository could not be asked (offline, timed out); then
    /// `packages` says nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexPackageUpdate {
    pub name: String,
    /// The CTAN version when the package has one, else its TeX Live revision.
    pub installed: String,
    pub available: String,
}

/// What the writer runs for a TeX that Lattice does not manage.
pub(super) const UPDATE_COMMAND: &str = "sudo tlmgr update --self --all";

/// The packages `tlmgr update --list --machine-readable` reports updates for.
/// Each line between `end-of-header` and `end-of-updates` is tab-separated:
/// name, status, local revision, remote revision, size, three timing fields,
/// local CTAN version, remote CTAN version. Only status `u` is an installed
/// package with a newer revision; `a` (new in a collection), `d` (gone from
/// the repository) and `r` (local is newer) are not updates of what is
/// installed.
pub(super) fn parse_update_list(output: &str) -> Vec<TexPackageUpdate> {
    let mut in_updates = false;
    let mut packages = Vec::new();
    for line in output.lines() {
        match line.trim_end() {
            "end-of-header" => in_updates = true,
            "end-of-updates" => break,
            line if in_updates => {
                let fields: Vec<&str> = line.split('\t').collect();
                let [name, "u", local_revision, remote_revision, ..] = fields[..] else {
                    continue;
                };
                let version = |ctan: Option<&&str>, revision: &str| match ctan {
                    Some(&ctan) if ctan != "-" && !ctan.is_empty() => ctan.to_string(),
                    _ => format!("r{revision}"),
                };
                packages.push(TexPackageUpdate {
                    name: name.to_string(),
                    installed: version(fields.get(8), local_revision),
                    available: version(fields.get(9), remote_revision),
                });
            }
            _ => {}
        }
    }
    packages
}

/// Whether `texmfroot` (`kpsewhich -var-value=TEXMFROOT`) is a BasicTeX tree,
/// `/usr/local/texlive/<year>basic`: the one kind of TeX Lattice installs.
pub(super) fn is_basic_tex_root(texmfroot: &str) -> bool {
    texmfroot
        .trim()
        .strip_prefix("/usr/local/texlive/")
        .and_then(|rest| rest.strip_suffix("basic"))
        .is_some_and(|year| year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from a real BasicTeX 2026 run in November 2026.
    const UPDATE_LIST: &str = "location-url\thttps://mirror.example/ctan/systems/texlive/tlnet\n\
        total-bytes\t108367160\n\
        end-of-header\n\
        libertine\td\t77682\t-\t-\t-\t-\t-\t5.3.0\t-\n\
        amsmath\tu\t78101\t80868\t31748\t-\t-\t-\t-\t-\n\
        lineno\tu\t77875\t79618\t63100\t-\t-\t-\t5.7\t5.9\n\
        local-only\tr\t80000\t79000\t-\t-\t-\t-\t-\t-\n\
        end-of-updates\n\
        texlive.infra\tu\t79653\t80721\t476936\t-\t-\t-\t-\t-\n\
        arcs2\ta\t-\t80096\t2364\t-\t-\t-\t-\t-\n";

    #[test]
    fn update_list_reports_only_installed_packages_with_newer_revisions() {
        let packages = parse_update_list(UPDATE_LIST);
        let summary: Vec<_> = packages
            .iter()
            .map(|package| {
                format!("{} {} → {}", package.name, package.installed, package.available)
            })
            .collect();
        // Packages without a CTAN version fall back to the revision; nothing
        // after end-of-updates, deleted, reversed or auto-install rows counts.
        assert_eq!(summary, ["amsmath r78101 → r80868", "lineno 5.7 → 5.9"]);
    }

    #[test]
    fn update_list_without_updates_or_header_reports_none() {
        assert!(parse_update_list("location-url\tx\nend-of-header\nend-of-updates\n").is_empty());
        // A failed run's stderr chatter is not a package list.
        assert!(parse_update_list("tlmgr: package repository x (not verified)\n").is_empty());
    }

    #[test]
    fn only_basic_tex_trees_are_managed() {
        assert!(is_basic_tex_root("/usr/local/texlive/2026basic\n"));
        assert!(is_basic_tex_root("/usr/local/texlive/2027basic"));
        for other in [
            "/usr/local/texlive/2026",
            "/usr/local/texlive/basic",
            "/opt/texlive/2026basic",
            "/usr/local/texlive/2026basic/../2026",
            "",
        ] {
            assert!(!is_basic_tex_root(other), "{other}");
        }
    }

    #[test]
    fn report_serializes_for_the_doctor() {
        let report = TexPackageUpdates { managed: true, packages: Vec::new(), error: None };
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({ "managed": true, "packages": [] })
        );
    }
}
