//! The work Settings › About › Acknowledgements names first, before the full
//! list of every package the app ships (`acknowledged-software.ts`, the
//! same entries in the same order).
//!
//! Choosing what is prominent is the only hand-kept part. Version and license
//! come from THIRD_PARTY_NOTICES.md through `package`, so they move with the
//! lockfiles; `license` is written here only for work the notices do not list
//! as a package.

use lattice_i18n::t;

use super::notices::{Closure, Notices, Package};

/// The interface fonts' credit (`interface-font-credit.ts`).
pub const TIMELESS_NAME: &str = "Timeless";
pub const TIMELESS_LICENSE: &str = "Timeless Free Font License";
pub const TIMELESS_SITE: &str = "timeless.co";
pub const TIMELESS_URL: &str = "https://timeless.co";

/// The Node.js the Agent's runtime is staged with (`synara-runtime.json`'s
/// `nodeVersion`).
fn node_version() -> &'static str {
    static VERSION: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../../../../scripts/synara-runtime.json"
        ))
        .ok()
        .and_then(|config| config.get("nodeVersion")?.as_str().map(str::to_string))
        .unwrap_or_default()
    });
    &VERSION
}

pub struct Credit {
    pub name: &'static str,
    /// Who made it, or how Lattice adapted it.
    pub role: Option<fn() -> &'static str>,
    pub url: Option<&'static str>,
    /// Wording the work's license requires, shown verbatim after any role.
    pub attribution: Option<&'static str>,
    /// The package whose recorded version and license this credit shows.
    pub package: Option<(Closure, &'static str)>,
    pub license: Option<&'static str>,
    pub version: Option<fn() -> &'static str>,
}

const fn credit(name: &'static str, url: &'static str) -> Credit {
    Credit {
        name,
        role: None,
        url: Some(url),
        attribution: None,
        package: None,
        license: None,
        version: None,
    }
}

const fn of(mut credit: Credit, closure: Closure, package: &'static str) -> Credit {
    credit.package = Some((closure, package));
    credit
}

const fn licensed(mut credit: Credit, license: &'static str) -> Credit {
    credit.license = Some(license);
    credit
}

const fn by(mut credit: Credit, role: fn() -> &'static str) -> Credit {
    credit.role = Some(role);
    credit
}

use Closure::{Crates, Npm, PresentationRuntime};

pub const CORE_SOFTWARE: &[Credit] = &[
    of(credit("Tauri", "https://tauri.app"), Crates, "tauri"),
    of(credit("React", "https://react.dev"), Npm, "react"),
    of(
        credit("CodeMirror", "https://codemirror.net"),
        Npm,
        "@codemirror/view",
    ),
    of(credit("Tiptap", "https://tiptap.dev"), Npm, "@tiptap/core"),
    of(
        credit("PDF.js", "https://mozilla.github.io/pdf.js/"),
        Npm,
        "pdfjs-dist",
    ),
    licensed(
        by(
            credit("Synara", "https://github.com/Emanuele-web04/synara"),
            || t!("By T3 Tools Inc. and Emanuele Di Pietro"),
        ),
        "MIT",
    ),
    Credit {
        version: Some(node_version),
        ..licensed(credit("Node.js", "https://nodejs.org"), "MIT")
    },
    of(
        credit("Open Slide", "https://github.com/open-slide/open-slide"),
        PresentationRuntime,
        "@open-slide/core",
    ),
    licensed(
        of(
            credit("Excalidraw", "https://excalidraw.com"),
            Npm,
            "@excalidraw/excalidraw",
        ),
        "MIT",
    ),
    Credit {
        attribution: Some("Uses Trellis by DanFessler - github.com/DanFessler/trellis"),
        ..licensed(
            of(
                credit("Trellis", "https://github.com/DanFessler/trellis"),
                Npm,
                "@danfessler/trellis",
            ),
            "Trellis license",
        )
    },
    of(
        credit("Pierre Trees", "https://pierre.computer"),
        Npm,
        "@pierre/trees",
    ),
    of(
        credit("Pierre Diffs", "https://diffs.com"),
        Npm,
        "@pierre/diffs",
    ),
    of(credit("Univer", "https://univer.ai"), Npm, "@univerjs/core"),
    of(credit("KaTeX", "https://katex.org"), Npm, "katex"),
    of(credit("Pele", "https://pele.run"), Npm, "pele"),
    of(credit("Shiki", "https://shiki.style"), Npm, "shiki"),
    of(
        credit("Harper", "https://writewithharper.com"),
        Crates,
        "harper-core",
    ),
    of(
        credit("tantivy", "https://github.com/quickwit-oss/tantivy"),
        Crates,
        "tantivy",
    ),
    of(
        credit("jieba-rs", "https://github.com/messense/jieba-rs"),
        Crates,
        "jieba-rs",
    ),
];

/// Type, icons and sound; the Timeless family, when embedded, leads.
pub const DESIGN_CREDITS: &[Credit] = &[
    by(
        of(
            credit("Inter", "https://rsms.me/inter/"),
            Npm,
            "@fontsource-variable/inter",
        ),
        || t!("By Rasmus Andersson"),
    ),
    of(
        credit(
            "Instrument Serif",
            "https://github.com/Instrument/instrument-serif",
        ),
        Npm,
        "@fontsource/instrument-serif",
    ),
    Credit {
        version: Some(|| "2.0.0"),
        ..licensed(
            by(
                credit("Ioskeley Mono", "https://github.com/ahatem/IoskeleyMono"),
                || t!("By Ahmed Hatem, built on Iosevka by Renzhi Li"),
            ),
            "OFL-1.1",
        )
    },
    by(
        of(
            credit(
                "Atkinson Hyperlegible",
                "https://www.brailleinstitute.org/freefont/",
            ),
            Npm,
            "@fontsource/atkinson-hyperlegible",
        ),
        || t!("By the Braille Institute"),
    ),
    by(
        of(
            credit("OpenDyslexic", "https://opendyslexic.org"),
            Npm,
            "@fontsource/opendyslexic",
        ),
        || t!("By Abbie Gonzalez"),
    ),
    licensed(
        credit("IBM Plex and Shantell Sans", "https://github.com/IBM/plex"),
        "OFL-1.1",
    ),
    of(credit("Lucide", "https://lucide.dev"), Npm, "lucide-react"),
    licensed(
        by(
            credit("Phosphor Icons", "https://phosphoricons.com"),
            || t!("Redrawn from Phosphor glyphs"),
        ),
        "MIT",
    ),
    by(
        of(
            credit("Cuelume", "https://github.com/Danilaa1/cuelume"),
            Npm,
            "cuelume",
        ),
        || t!("By Daniel Belyi"),
    ),
];

/// Work Lattice adapted or began from, which no package list would show.
pub const ORIGIN_CREDITS: &[Credit] = &[
    by(
        credit("Open Knowledge", "https://github.com/inkeep/open-knowledge"),
        || t!("By Inkeep; Lattice's first visual Markdown editor began there"),
    ),
    licensed(
        by(
            credit(
                "Fluid Functionalism and Lina",
                "https://github.com/mickadesign/fluid-functionalism",
            ),
            || {
                t!(
                    "By Micka Touillaud and Sameer Singh; several interface controls are adapted from them"
                )
            },
        ),
        "MIT",
    ),
    Credit {
        name: "ICLR, ICML and NeurIPS style files",
        role: Some(|| {
            t!(
                "From the official conference author kits, bundled unmodified with their authors' credits"
            )
        }),
        url: None,
        attribution: None,
        package: None,
        license: None,
        version: None,
    },
];

impl Credit {
    /// The newest recorded version of the credited package; a closure can
    /// hold two (`recordedPackage`).
    pub fn recorded<'a>(&self, notices: &'a Notices) -> Option<&'a Package> {
        let (closure, name) = self.package?;
        notices
            .packages
            .iter()
            .filter(|package| package.closure == closure && package.name == name)
            .max_by(|a, b| natural(&a.version, &b.version))
    }

    /// The license and version beside the credit.
    pub fn terms(&self, notices: &Notices) -> Option<String> {
        let recorded = self.recorded(notices);
        let license = self
            .license
            .map(str::to_string)
            .or_else(|| recorded.map(|package| package.license.clone()))
            .filter(|license| !license.is_empty());
        let version = self
            .version
            .map(|version| version().to_string())
            .or_else(|| recorded.map(|package| package.version.clone()))
            .filter(|version| !version.is_empty());
        let parts: Vec<String> = [license, version].into_iter().flatten().collect();
        (!parts.is_empty()).then(|| parts.join(", "))
    }

    /// Who made it, then the wording its license requires.
    pub fn description(&self) -> Option<String> {
        let parts: Vec<&str> = [self.role.map(|role| role()), self.attribution]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join(". "))
    }
}

/// Versions compared as `localeCompare(…, { numeric: true })` does: runs of
/// digits by their value.
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| -> Vec<(u64, String)> {
        s.split(['.', '-', '+'])
            .map(|part| (part.parse::<u64>().unwrap_or(0), part.to_string()))
            .collect()
    };
    parts(a).cmp(&parts(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_credited_package_is_in_the_shipped_notices() {
        let notices = super::super::notices::shipped();
        for credit in CORE_SOFTWARE
            .iter()
            .chain(DESIGN_CREDITS)
            .chain(ORIGIN_CREDITS)
        {
            if credit.package.is_some() {
                assert!(
                    credit.recorded(notices).is_some(),
                    "{} is not in the notices",
                    credit.name
                );
            }
        }
    }

    #[test]
    fn versions_compare_by_their_numbers() {
        assert_eq!(natural("1.10.0", "1.9.0"), std::cmp::Ordering::Greater);
        assert!(!node_version().is_empty());
    }
}
