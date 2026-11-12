//! What the TeX doctor's report means for setup, and how an install's
//! stages and failures read, as the Tauri app has it
//! (`src/build/tex-setup.ts`, `tex-install-dialog.tsx`): which compile tools
//! are missing (any one engine will do), whether the conference fonts or
//! the paper tools are, and which of those hold the app in setup.

use lattice_core::doctor::DoctorReport;

pub mod backend;
pub mod center;
mod dialogs;

/// Rough installed size after the one-click scripts finish.
pub const TEX_INSTALL_SIZE_HINT: &str = "1 GB";

/// `CANCELLED` in lattice-core's `tex_setup/windows.rs`: what a cancelled
/// install fails with.
pub const TEX_INSTALL_CANCELLED: &str = "The TeX installation was cancelled.";

/// The distribution the one-click install sets up: TeX Live (per user) on
/// Windows, BasicTeX on a Mac.
pub fn distribution_name() -> &'static str {
    if cfg!(windows) {
        "TeX Live"
    } else {
        "BasicTeX"
    }
}

const REQUIRED_ALWAYS: [&str; 3] = ["latexmk", "synctex", "bibtex"];
const TEX_ENGINES: [&str; 3] = ["pdflatex", "xelatex", "lualatex"];
/// The app-managed uv pair the paper tools (arXiv import, bibcite) run through.
const PAPER_TOOLS: [&str; 2] = ["uv", "uvx"];

fn tool_ok(report: &DoctorReport, name: &str) -> bool {
    report
        .checks
        .iter()
        .any(|check| check.name == name && check.ok)
}

/// Missing compile tools; any one engine will do. Unrelated checks (git,
/// texlab, …) do not count.
pub fn missing_tex_tools(report: Option<&DoctorReport>) -> Vec<&'static str> {
    let Some(report) = report else {
        return Vec::new();
    };
    let mut missing: Vec<&'static str> = REQUIRED_ALWAYS
        .into_iter()
        .filter(|name| !tool_ok(report, name))
        .collect();
    if !TEX_ENGINES.iter().any(|name| tool_ok(report, name)) {
        missing.push("pdflatex");
    }
    missing
}

pub fn conference_fonts_missing(report: Option<&DoctorReport>) -> bool {
    report.is_some_and(|report| {
        !report
            .checks
            .iter()
            .any(|check| check.name == "conference-fonts" && check.ok)
    })
}

pub fn missing_paper_tools(report: Option<&DoctorReport>) -> Vec<&'static str> {
    report.map_or_else(Vec::new, |report| {
        PAPER_TOOLS
            .into_iter()
            .filter(|name| !tool_ok(report, name))
            .collect()
    })
}

/// What compiling needs: a TeX toolchain and the conference fonts.
pub fn compile_setup_missing(report: Option<&DoctorReport>) -> bool {
    !missing_tex_tools(report).is_empty() || conference_fonts_missing(report)
}

/// Only the paper tools are missing: writing, compiling and reading all
/// work, so setup can wait until a paper feature asks for them.
pub fn only_paper_tools_missing(report: Option<&DoctorReport>) -> bool {
    !missing_paper_tools(report).is_empty() && !compile_setup_missing(report)
}

pub fn required_setup_missing(report: Option<&DoctorReport>) -> bool {
    compile_setup_missing(report) || !missing_paper_tools(report).is_empty()
}

/// A build failed because there is no TeX to run: latex/build.rs's spawn
/// failure and build_log.rs's missing-tool diagnostic.
pub fn is_missing_tex_build_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "could not start latexmk",
        "mactex or tex live",
        "the latex tool",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
}

/// The first lines lattice-core's `dependency_install_error` gives a failed
/// package install, which read as the summary; tlmgr's own words follow.
const DEPENDENCY_FAILURES: [&str; 8] = [
    "Administrator approval was cancelled, so nothing was installed.",
    "There is not enough disk space to install the package. Free up some space, then try again.",
    "Lattice could not write to the TeX installation folder.",
    "This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.",
    "The package repository does not have this package.",
    "Could not reach the TeX Live package repository. Check the network connection, then try again.",
    "TeX Live's package manager needs an update, and the update did not finish.",
    "TeX Live's package manager could not install the package.",
];

/// A failed package install's message as a summary and the installer's own
/// words behind it.
pub fn dependency_install_failure(message: &str) -> (String, String) {
    let (first, rest) = message.split_once('\n').unwrap_or((message, ""));
    if let Some(known) = DEPENDENCY_FAILURES.iter().find(|known| **known == first) {
        // The interface's spelling of the one known line with an apostrophe.
        return (
            known.replace("TeX Live's", "TeX Live’s"),
            rest.trim().to_string(),
        );
    }
    (first.to_string(), rest.trim().to_string())
}

/// What each install stage is doing, and what the writer can expect from it.
pub fn stage_copy(stage: &str) -> (&'static str, &'static str) {
    let windows = cfg!(windows);
    match stage {
        "downloading" if windows => ("Downloading TeX Live…", ""),
        "downloading" => ("Downloading BasicTeX…", ""),
        "authorizing" => (
            "Waiting for administrator approval…",
            "Approve the macOS prompt to continue",
        ),
        "installing-base" if windows => ("Installing TeX Live…", ""),
        "installing-base" => ("Installing BasicTeX…", ""),
        "updating-base" => ("Updating LaTeX packages…", "Can take up to 15 minutes"),
        "installing-packages" => ("Installing LaTeX packages…", "Can take up to 15 minutes"),
        "installing-tools" => ("Installing required tools…", ""),
        "verifying" | "verifying-dependency" => ("Verifying installation…", ""),
        "searching-packages" => ("Resolving…", ""),
        "installing-dependency" => ("Installing LaTeX packages…", ""),
        _ => ("Finishing setup…", ""),
    }
}

#[cfg(test)]
mod tests {
    use lattice_core::doctor::DoctorCheck;

    use super::*;

    fn report(missing: &[&str]) -> DoctorReport {
        let names = [
            "latexmk",
            "pdflatex",
            "xelatex",
            "lualatex",
            "synctex",
            "bibtex",
            "uv",
            "uvx",
            "conference-fonts",
            "git",
        ];
        DoctorReport {
            ok: missing.is_empty(),
            summary: String::new(),
            checks: names
                .iter()
                .map(|name| DoctorCheck {
                    name: name.to_string(),
                    detail: String::new(),
                    ok: !missing.contains(name),
                    code: None,
                    params: Default::default(),
                })
                .collect(),
        }
    }

    #[test]
    fn any_one_engine_will_do() {
        let only_xelatex = report(&["pdflatex", "lualatex"]);
        assert!(missing_tex_tools(Some(&only_xelatex)).is_empty());
        let none = report(&["pdflatex", "xelatex", "lualatex", "synctex"]);
        assert_eq!(missing_tex_tools(Some(&none)), ["synctex", "pdflatex"]);
        assert!(missing_tex_tools(None).is_empty());
    }

    #[test]
    fn only_missing_paper_tools_can_wait() {
        let tools = report(&["uv", "uvx", "git"]);
        assert!(only_paper_tools_missing(Some(&tools)));
        assert!(required_setup_missing(Some(&tools)));
        assert!(!compile_setup_missing(Some(&tools)));
        let fonts = report(&["conference-fonts", "uv"]);
        assert!(!only_paper_tools_missing(Some(&fonts)));
        assert!(compile_setup_missing(Some(&fonts)));
        assert!(!required_setup_missing(Some(&report(&["git"]))));
        // No report yet: nothing is known to be missing.
        assert!(!required_setup_missing(None));
    }

    #[test]
    fn a_missing_toolchain_is_told_from_its_build_error() {
        assert!(is_missing_tex_build_error(
            "Could not start latexmk. Install MacTeX or TeX Live. No such file"
        ));
        assert!(is_missing_tex_build_error(
            "The LaTeX tool 'latexmk' was not found."
        ));
        assert!(!is_missing_tex_build_error("Undefined control sequence."));
    }

    #[test]
    fn a_known_failure_keeps_tlmgr_words_as_its_detail() {
        let (summary, detail) = dependency_install_failure(
            "TeX Live's package manager could not install the package.\ntlmgr: package foo not present",
        );
        assert_eq!(
            summary,
            "TeX Live’s package manager could not install the package."
        );
        assert_eq!(detail, "tlmgr: package foo not present");
        let (summary, detail) = dependency_install_failure("No TeX Live package provides x.sty.");
        assert_eq!(
            (summary.as_str(), detail.as_str()),
            ("No TeX Live package provides x.sty.", "")
        );
    }
}
