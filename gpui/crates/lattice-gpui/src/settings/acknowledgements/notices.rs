//! THIRD_PARTY_NOTICES.md read back into the list Settings › About ›
//! Acknowledgements shows (`third-party-notices.ts`, ported line for line).
//!
//! That file is the one source of truth for what Lattice distributes: its
//! generated half (`scripts/generate-notices.mjs`) lists every package of the
//! four closures the app carries, grouped by the license text that governs
//! them, and `pnpm notices:check` keeps it in step with the lockfiles. The
//! app embeds the file as it builds, so the list and the license texts are
//! the very ones distributed. Only the generated half is read; the license
//! texts sit in fenced blocks, some of them Markdown with headings of their
//! own, so fences are tracked and nothing inside one is taken for structure.

use std::{
    collections::{BTreeMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;

/// The file as this build ships it.
pub const TEXT: &str = include_str!("../../../../../../THIRD_PARTY_NOTICES.md");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Closure {
    Npm,
    Crates,
    Sidecar,
    PresentationRuntime,
}

impl Closure {
    /// The page's order.
    pub const ORDER: [Closure; 4] = [
        Closure::Npm,
        Closure::Crates,
        Closure::Sidecar,
        Closure::PresentationRuntime,
    ];

    fn from_tag(tag: &str) -> Option<Closure> {
        Some(match tag {
            "npm" => Closure::Npm,
            "crates" => Closure::Crates,
            "sidecar" => Closure::Sidecar,
            "presentation-runtime" => Closure::PresentationRuntime,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Package {
    pub closure: Closure,
    pub name: String,
    pub version: String,
    /// The declared license of the text that governs it, as the notices name it.
    pub license: String,
}

/// One reproduced license text and the notices that share it.
#[derive(Clone, Debug, Default)]
pub struct LicenseGroup {
    pub closure: Option<Closure>,
    /// Its heading, e.g. "MIT — 254 package(s), from LICENSE".
    pub title: String,
    /// `name@version` of every package it governs.
    pub packages: Vec<String>,
    pub copyrights: Option<String>,
    pub text: String,
    label: String,
}

#[derive(Debug, Default)]
pub struct Notices {
    pub packages: Vec<Package>,
    pub groups: Vec<LicenseGroup>,
}

const BEGIN: &str = "<!-- BEGIN GENERATED NOTICES";
const NO_LICENSE_FIELD: &str = "(no license field)";

fn license_of(declared: &str) -> String {
    if declared == NO_LICENSE_FIELD {
        String::new()
    } else {
        declared.to_string()
    }
}

/// `@scope/name@1.2.3` as its name and version; the version follows the last `@`.
pub fn split_package_id(id: &str) -> Option<(&str, &str)> {
    let at = id.rfind('@')?;
    (at > 0).then(|| (&id[..at], &id[at + 1..]))
}

pub fn parse(markdown: &str) -> Notices {
    static CLOSURE_HEADINGS: LazyLock<[(Regex, Closure); 4]> = LazyLock::new(|| {
        [
            (Regex::new(r"^## npm packages\b").unwrap(), Closure::Npm),
            (Regex::new(r"^## Rust crates\b").unwrap(), Closure::Crates),
            (Regex::new(r"^## Synara agent sidecar\b").unwrap(), Closure::Sidecar),
            (
                Regex::new(r"^## Open Slide presentation runtime\b").unwrap(),
                Closure::PresentationRuntime,
            ),
        ]
    });
    static GROUP_HEADING: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^#### \d+\. (.+?)(?: \(\+\d+ other declarations?\))? — (\d+ package\(s\), from .+)$",
        )
        .unwrap()
    });
    static UNRESOLVED_ITEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^- `([^`]+)` \(([a-z-]+)\)(?: — declared `([^`]+)`)?").unwrap()
    });
    static PACKAGE_ITEM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"`([^`]+)`(?: \(`([^`]+)`\))?").unwrap());
    static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(`{3,})").unwrap());
    static COPYRIGHTS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^Copyright notices \(\d+\):$").unwrap());

    let Some(start) = markdown.find(BEGIN) else {
        return Notices::default();
    };
    let mut groups: Vec<LicenseGroup> = Vec::new();
    // closure → package id → license, the first declaration standing.
    let mut licenses: BTreeMap<Closure, Vec<(String, String)>> = BTreeMap::new();
    let mut seen: HashSet<(Closure, String)> = HashSet::new();
    let mut record = |closure: Closure, id: &str, license: String, licenses: &mut BTreeMap<_, Vec<_>>| {
        if seen.insert((closure, id.to_string())) {
            licenses
                .entry(closure)
                .or_insert_with(Vec::new)
                .push((id.to_string(), license));
        }
    };
    let mut unresolved: Vec<(Closure, String, String)> = Vec::new();
    let mut closure: Option<Closure> = None;
    // The group lines below belong to, by index into `groups`.
    let mut group: Option<usize> = None;
    let mut fence: Option<(String, Vec<&str>)> = None;
    let mut copyrights_next = false;

    for line in markdown[start..].split('\n') {
        if let Some((marker, lines)) = &mut fence {
            if line.starts_with(marker.as_str()) && line[marker.len()..].trim().is_empty() {
                let block = lines.join("\n");
                if let Some(index) = group {
                    let current = &mut groups[index];
                    if copyrights_next {
                        current.copyrights = Some(block);
                    } else if current.text.is_empty() {
                        current.text = block;
                    }
                }
                copyrights_next = false;
                fence = None;
            } else {
                lines.push(line);
            }
            continue;
        }
        if let Some(opening) = FENCE.captures(line) {
            fence = Some((opening[1].to_string(), Vec::new()));
            continue;
        }
        if COPYRIGHTS.is_match(line) {
            copyrights_next = true;
            continue;
        }
        if line.starts_with("## ") {
            closure = CLOSURE_HEADINGS
                .iter()
                .find(|(heading, _)| heading.is_match(line))
                .map(|(_, closure)| *closure)
                .or(closure);
            group = None;
            continue;
        }
        if let (Some(heading), Some(closure)) = (GROUP_HEADING.captures(line), closure) {
            groups.push(LicenseGroup {
                closure: Some(closure),
                label: license_of(&heading[1]),
                title: format!("{} — {}", &heading[1], heading[2].replace('`', "")),
                ..LicenseGroup::default()
            });
            group = Some(groups.len() - 1);
            continue;
        }
        if line.starts_with('#') {
            group = None;
            continue;
        }
        if let Some(index) = group
            && groups[index].packages.is_empty()
            && line.starts_with('`')
        {
            for item in PACKAGE_ITEM.captures_iter(line) {
                let id = &item[1];
                if split_package_id(id).is_none() {
                    continue;
                }
                let current = &mut groups[index];
                current.packages.push(id.to_string());
                let license = match item.get(2) {
                    Some(declared) => license_of(declared.as_str()),
                    None => current.label.clone(),
                };
                let group_closure = current.closure.unwrap_or(Closure::Npm);
                record(group_closure, id, license, &mut licenses);
            }
            continue;
        }
        // A package with no license text appears in no group, only in the
        // unresolved lists, which name the closure on each line.
        if let Some(item) = UNRESOLVED_ITEM.captures(line)
            && let Some(closure) = Closure::from_tag(&item[2])
        {
            let license = item.get(3).map(|m| m.as_str()).unwrap_or_default();
            unresolved.push((closure, item[1].to_string(), license.to_string()));
        }
    }
    for (closure, id, license) in unresolved {
        record(closure, &id, license, &mut licenses);
    }

    let mut packages: Vec<Package> = licenses
        .into_iter()
        .flat_map(|(closure, ids)| {
            ids.into_iter().filter_map(move |(id, license)| {
                let (name, version) = split_package_id(&id)?;
                Some(Package {
                    closure,
                    name: name.to_string(),
                    version: version.to_string(),
                    license,
                })
            })
        })
        .collect();
    packages.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.version.cmp(&b.version))
    });
    Notices { packages, groups }
}

/// The notices as this build ships them, parsed once.
pub fn shipped() -> &'static Notices {
    static NOTICES: LazyLock<Notices> = LazyLock::new(|| parse(TEXT));
    &NOTICES
}

/// The license texts that govern one package (`licenseGroupsFor`).
pub fn groups_for<'a>(notices: &'a Notices, package: &Package) -> Vec<&'a LicenseGroup> {
    let id = format!("{}@{}", package.name, package.version);
    notices
        .groups
        .iter()
        .filter(|group| group.closure == Some(package.closure) && group.packages.contains(&id))
        .collect()
}

/// Where a package is published, for a link out of the list.
pub fn registry_url(package: &Package) -> String {
    match package.closure {
        Closure::Crates => format!("https://crates.io/crates/{}", package.name),
        _ => format!("https://www.npmjs.com/package/{}", package.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "intro\n<!-- BEGIN GENERATED NOTICES -->\n## npm packages (3)\n#### 1. MIT (+1 other declarations) — 2 package(s), from `LICENSE`\n`react@19.0.0`, `@scope/pkg@1.2.3` (`Apache-2.0`)\nCopyright notices (1):\n```\nCopyright Meta\n```\n```\nMIT License\n## not a heading\n```\n## Rust crates (1)\n#### 1. MIT — 1 package(s), from `LICENSE-MIT`\n`tauri@2.0.0`\n```\nMIT text\n```\n### Unresolved\n- `unicount@1.1.0` (npm) — declared `ISC`\n- `bare@0.1.0` (npm)\n";

    #[test]
    fn packages_and_groups_read_as_the_tauri_parser_reads_them() {
        let notices = parse(SAMPLE);
        let names: Vec<_> = notices
            .packages
            .iter()
            .map(|p| format!("{}@{} {}", p.name, p.version, p.license))
            .collect();
        assert_eq!(
            names,
            [
                "@scope/pkg@1.2.3 Apache-2.0",
                "bare@0.1.0 ",
                "react@19.0.0 MIT",
                "tauri@2.0.0 MIT",
                "unicount@1.1.0 ISC"
            ]
        );
        assert_eq!(notices.groups.len(), 2);
        let react = &notices.groups[0];
        assert_eq!(react.title, "MIT — 2 package(s), from LICENSE");
        assert_eq!(react.copyrights.as_deref(), Some("Copyright Meta"));
        assert_eq!(react.text, "MIT License\n## not a heading");
        let tauri = notices.packages.iter().find(|p| p.name == "tauri").unwrap();
        assert_eq!(groups_for(&notices, tauri).len(), 1);
        assert_eq!(registry_url(tauri), "https://crates.io/crates/tauri");
    }

    #[test]
    fn the_shipped_notices_list_packages() {
        assert!(shipped().packages.len() > 100);
        assert!(shipped().packages.iter().any(|p| p.name == "react"));
    }
}
