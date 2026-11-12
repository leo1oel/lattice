//! A package order that a newer LaTeX breaks.
//!
//! LaTeX 2026-11-01, with the first-aid patch for arydshln it ships (dated
//! 2026-10-02), ends every table wrongly when arydshln is loaded after
//! colortbl: each `\end{tabularx}` or `\end{tabular*}` reports "Extra }, or
//! forgotten $", "Missing $ inserted" and "Missing } inserted", though the
//! table itself is fine. The same paper compiles on TeX Live 2024, on TeX Live
//! 2026 before that update, and on Overleaf's frozen images, so nothing in the
//! paper looks wrong; loading arydshln before colortbl, or not at all (papers
//! often load it and never draw a dashed rule), compiles it here too.

use super::build_log::advice;
use crate::models::Diagnostic;
use regex::Regex;
use std::sync::OnceLock;

pub(super) const CODE: &str = "arydshln-after-colortbl";

/// The notice for a typeset whose log (`tex_log`, the TeX log file) loaded
/// arydshln after colortbl, had the kernel patch it, and stopped at the end
/// of a table.
pub(super) fn arydshln_after_colortbl(tex_log: &str) -> Option<Diagnostic> {
    static TABLE_END: OnceLock<Regex> = OnceLock::new();
    // TeX's context line under each error: `l.115 \end{tabularx}`.
    let table_end =
        TABLE_END.get_or_init(|| Regex::new(r"(?m)^l\.\d+ .*\\end\{tabular").expect("valid regex"));
    if !tex_log.contains("First Aid for arydshln.sty applied") {
        return None;
    }
    let colortbl = tex_log.find("/colortbl.sty")?;
    let arydshln = tex_log.find("/arydshln.sty")?;
    (colortbl < arydshln && table_end.is_match(tex_log)).then(|| {
        advice(
            "info",
            CODE,
            &[],
            "These table errors come from loading arydshln after colortbl, which LaTeX 2026-11 broke: the tables are fine. Load arydshln before colortbl, or remove \\usepackage{arydshln} if no table draws dashed rules.".to_string(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A TeX log that loads `packages` in order, the kernel's first aid for
    /// arydshln when it is among them, and stops at `\end{tabularx}`.
    fn log(packages: &[&str], first_aid: bool, stopped_at: &str) -> String {
        let mut log = String::from("This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026)\nLaTeX2e <2026-11-01>\n");
        for package in packages {
            log.push_str(&format!(
                "(/usr/local/texlive/2026basic/texmf-dist/tex/latex/{package}/{package}.sty\nPackage: {package}\n)\n"
            ));
            if *package == "arydshln" && first_aid {
                log.push_str("==> First Aid for arydshln.sty applied!\n");
            }
        }
        log.push_str(&format!(
            "./section/5_experiments_v2.tex:115: Extra }}, or forgotten $.\n<recently read> \\egroup \n\nl.115 {stopped_at}\n"
        ));
        log
    }

    #[test]
    fn names_the_order_when_tables_fail_after_the_kernel_patched_arydshln() {
        let notice =
            arydshln_after_colortbl(&log(&["colortbl", "arydshln"], true, "\\end{tabularx}"));
        assert_eq!(notice.map(|notice| notice.code), Some(Some(CODE)));
        let star = log(&["colortbl", "arydshln"], true, "\\end{tabular*}");
        assert!(arydshln_after_colortbl(&star).is_some());
    }

    #[test]
    fn stays_quiet_for_the_order_that_works_or_an_error_elsewhere() {
        for (packages, first_aid, stopped_at) in [
            // arydshln first: the kernel's patch holds.
            (&["arydshln", "colortbl"][..], true, "\\end{tabularx}"),
            // A kernel that does not patch arydshln (TeX Live 2024).
            (&["colortbl", "arydshln"][..], false, "\\end{tabularx}"),
            // Only one of the two packages.
            (&["colortbl"][..], false, "\\end{tabularx}"),
            // An error that is not at the end of a table is the paper's own.
            (&["colortbl", "arydshln"][..], true, "$x}$"),
        ] {
            let log = log(packages, first_aid, stopped_at);
            assert!(arydshln_after_colortbl(&log).is_none(), "{log}");
        }
    }
}
