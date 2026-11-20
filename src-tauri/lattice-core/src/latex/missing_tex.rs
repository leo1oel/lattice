//! The advice a build gets when the TeX it ran lacks a package or a program,
//! naming that TeX: "Your TinyTeX does not include every package…" on a Linux
//! TinyTeX, where it used to say BasicTeX whatever was installed.
//!
//! The log does not say which distribution ran, so `parse_diagnostics` writes
//! the advice without one, and the build names it afterwards
//! (`name_distribution`) from where its programs live
//! (`tex_setup::detect_distribution`). The interface translates either from
//! the code and params (src/build/build-log-messages.ts).

use super::build_log::advice;
use crate::models::Diagnostic;
use crate::tex_setup::TexDistribution;

pub(super) const TOOL_MISSING: &str = "latex-tool-missing";
pub(super) const DEPENDENCY_MISSING: &str = "tex-dependency-missing";

/// A program the build ran that the search path does not have.
pub(super) fn missing_tool(tool: &str) -> Diagnostic {
    advice("error", TOOL_MISSING, &[("tool", tool)], tool_message(tool, None))
}

/// A package, class or style TeX could not find, which a TeX package provides.
pub(super) fn missing_dependency(file: &str) -> Diagnostic {
    advice("error", DEPENDENCY_MISSING, &[("file", file)], dependency_message(file, None))
}

fn tool_message(tool: &str, distribution: Option<TexDistribution>) -> String {
    match distribution {
        Some(distribution) => {
            let distribution = distribution.name();
            format!(
                "The LaTeX tool '{tool}' was not found. Add it to your {distribution}, then restart Lattice."
            )
        }
        None => format!(
            "The LaTeX tool '{tool}' was not found. Install MacTeX or TeX Live, then restart Lattice."
        ),
    }
}

fn dependency_message(file: &str, distribution: Option<TexDistribution>) -> String {
    match distribution {
        Some(distribution) => {
            let (distribution, packages) = (distribution.name(), distribution.packages());
            format!(
                "Missing LaTeX dependency `{file}`. Your {distribution} does not include every package available on Overleaf. Use Install missing package to find and install its {packages} package."
            )
        }
        None => format!(
            "Missing LaTeX dependency `{file}`. Your TeX distribution does not include every package available on Overleaf. Use Install missing package to find and install the package that provides it."
        ),
    }
}

/// Name the TeX distribution in the advice about a missing package or tool.
/// `detect` finds it, and is asked only when there is such advice; when it
/// cannot tell, the advice stays as written.
pub(super) fn name_distribution(
    diagnostics: &mut [Diagnostic], detect: impl FnOnce() -> Option<TexDistribution>,
) {
    let mut missing = diagnostics
        .iter_mut()
        .filter(|diagnostic| matches!(diagnostic.code, Some(TOOL_MISSING | DEPENDENCY_MISSING)))
        .peekable();
    if missing.peek().is_none() {
        return;
    }
    let Some(distribution) = detect() else { return };
    for diagnostic in missing {
        let params = &mut diagnostic.params;
        params.insert("distribution", distribution.name().to_string());
        diagnostic.message = if diagnostic.code == Some(TOOL_MISSING) {
            tool_message(params.get("tool").map_or("", String::as_str), Some(distribution))
        } else {
            params.insert("packages", distribution.packages().to_string());
            dependency_message(params.get("file").map_or("", String::as_str), Some(distribution))
        };
    }
}

#[cfg(test)]
mod tests {
    use super::super::build_log::parse_diagnostics;
    use super::*;

    const MISSING_PACKAGE: &str = "! LaTeX Error: File `lipsum.sty' not found.\n";
    const MISSING_TOOL: &str = "sh: biber: command not found\n";

    fn named(log: &str, distribution: Option<TexDistribution>) -> Diagnostic {
        let mut diagnostics = parse_diagnostics(log);
        name_distribution(&mut diagnostics, || distribution);
        diagnostics.into_iter().next().expect("one diagnostic")
    }

    #[test]
    fn names_the_distribution_that_lacks_a_package() {
        let advice = named(MISSING_PACKAGE, Some(TexDistribution::TinyTex));
        assert_eq!(
            advice.message,
            "Missing LaTeX dependency `lipsum.sty`. Your TinyTeX does not include every package available on Overleaf. Use Install missing package to find and install its TeX Live package."
        );
        assert_eq!(advice.params.get("distribution").map(String::as_str), Some("TinyTeX"));
        assert_eq!(advice.params.get("packages").map(String::as_str), Some("TeX Live"));
        // MiKTeX's packages are its own.
        let advice = named(MISSING_PACKAGE, Some(TexDistribution::Miktex));
        assert!(
            advice.message.ends_with("find and install its MiKTeX package."),
            "{}",
            advice.message
        );
    }

    #[test]
    fn names_the_distribution_that_lacks_a_tool() {
        let advice = named(MISSING_TOOL, Some(TexDistribution::TexLive));
        assert_eq!(
            advice.message,
            "The LaTeX tool 'biber' was not found. Add it to your TeX Live, then restart Lattice."
        );
        assert_eq!(advice.params.get("tool").map(String::as_str), Some("biber"));
        assert_eq!(advice.params.get("distribution").map(String::as_str), Some("TeX Live"));
    }

    #[test]
    fn names_no_distribution_it_cannot_tell() {
        // Not BasicTeX, which is only what Lattice installs on a Mac.
        let advice = named(MISSING_PACKAGE, None);
        assert_eq!(
            advice.message,
            "Missing LaTeX dependency `lipsum.sty`. Your TeX distribution does not include every package available on Overleaf. Use Install missing package to find and install the package that provides it."
        );
        assert!(!advice.params.contains_key("distribution"));
        let advice = named(MISSING_TOOL, None);
        assert!(advice.message.ends_with("Install MacTeX or TeX Live, then restart Lattice."));
    }

    #[test]
    fn looks_only_when_something_is_missing() {
        let mut diagnostics = parse_diagnostics("./main.tex:3: Undefined control sequence.\n");
        name_distribution(&mut diagnostics, || panic!("nothing is missing"));
    }
}
