//! A TeX whose lineno draws review-mode line numbers over the text.
//!
//! lineno 5.7 writes its column marker one column late on LaTeX 2025-06 and
//! later, so two-column templates (CVPR's review mode) number the right
//! column's lines over its text (#726). 5.9 fixes it. A new BasicTeX install
//! updates its packages, but one installed before that keeps 5.7 until the
//! writer updates them, and nothing told them to: the build says so here,
//! and its notice runs the TeX doctor's update.

use super::build_log::advice;
use crate::models::Diagnostic;
use regex::Regex;
use std::sync::OnceLock;

pub(super) const CODE: &str = "lineno-outdated";

/// The notice for a typeset whose log (`tex_log`, the TeX log file) loaded
/// lineno 5.7 on a kernel it misplaces line numbers on.
pub(super) fn outdated_lineno(tex_log: &str) -> Option<Diagnostic> {
    static LINENO: OnceLock<Regex> = OnceLock::new();
    static KERNEL: OnceLock<Regex> = OnceLock::new();
    let lineno = LINENO.get_or_init(|| {
        Regex::new(r"(?m)^Package: lineno \d{4}/\d\d/\d\d\b[^\n]*\bv5\.7\b").expect("valid regex")
    });
    let kernel = KERNEL
        .get_or_init(|| Regex::new(r"(?m)^LaTeX2e <(\d{4})-(\d\d)-(\d\d)>").expect("valid regex"));
    if !lineno.is_match(tex_log) {
        return None;
    }
    let date = kernel.captures(tex_log)?;
    let number = |index: usize| date[index].parse::<u32>().unwrap_or(0);
    if (number(1), number(2)) < (2025, 6) {
        return None;
    }
    Some(advice(
        "warning",
        CODE,
        &[],
        "Line numbers may be drawn over the text: your TeX has lineno 5.7, which has a known bug. Update TeX packages to fix it.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(kernel: &str, lineno: &str) -> String {
        format!(
            "This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2026)\nLaTeX2e <{kernel}>\nL3 programming layer <2026-01-19>\n(/usr/local/texlive/2026basic/texmf-dist/tex/latex/lineno/lineno.sty\nPackage: lineno {lineno} line numbers on paragraphs\n)\n"
        )
    }

    #[test]
    fn lineno_5_7_on_a_kernel_from_june_2025_on_is_flagged() {
        let notice = outdated_lineno(&log("2025-11-01", "2026/02/16 v5.7")).unwrap();
        assert_eq!(notice.code, Some(CODE));
        assert_eq!(notice.level, "warning");
        assert!(notice.file.is_none());
        assert!(outdated_lineno(&log("2025-06-01", "2026/02/16 v5.7")).is_some());
    }

    #[test]
    fn a_fixed_lineno_an_older_kernel_or_no_lineno_is_not() {
        assert!(outdated_lineno(&log("2025-11-01", "2026/03/08 v5.9")).is_none());
        assert!(outdated_lineno(&log("2024-11-01", "2026/02/16 v5.7")).is_none());
        assert!(outdated_lineno(&log("2025-11-01", "2026/02/16 v5.75")).is_none());
        let without =
            "LaTeX2e <2025-11-01>\nPackage: amsmath 2025/07/09 v2.17z AMS math features\n";
        assert!(outdated_lineno(without).is_none());
    }
}
