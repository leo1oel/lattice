//! The display text of a build diagnostic, as the Tauri app's
//! `build-log-messages.ts` gives it: Lattice's own build advice, which
//! lattice-core writes as a stable `code` with `params` beside its English
//! `message`, in the interface language, and the TeX engine's messages
//! unchanged. The English stays the source of truth for logs, copied
//! reports, fingerprints and the Agent; only the display is translated.

use lattice_core::models::Diagnostic;
use lattice_i18n::t;

fn param<'a>(diagnostic: &'a Diagnostic, name: &str) -> &'a str {
    diagnostic.params.get(name).map_or("", String::as_str)
}

/// What the card shows for `diagnostic`.
pub(crate) fn text(diagnostic: &Diagnostic) -> String {
    let p = |name| param(diagnostic, name);
    let file = p("file");
    match diagnostic.code {
        // `distribution` is the TeX the build ran (latex/missing_tex.rs), when
        // the host could tell.
        Some("latex-tool-missing") if !p("distribution").is_empty() => t!(
            "The LaTeX tool ''{tool}'' was not found. Add it to your {distribution}, then restart Lattice.",
            tool = p("tool"),
            distribution = p("distribution")
        )
        // Lingui's escaped apostrophe.
        .replace("''", "'"),
        Some("latex-tool-missing") => t!(
            "The LaTeX tool ''{tool}'' was not found. Install MacTeX or TeX Live, then restart Lattice.",
            tool = p("tool")
        )
        .replace("''", "'"),
        Some("tex-dependency-missing") if !p("distribution").is_empty() => t!(
            "Missing LaTeX dependency `{file}`. Your {distribution} does not include every package available on Overleaf. Use Install missing package to find and install its {packages} package.",
            file = file,
            distribution = p("distribution"),
            packages = p("packages")
        ),
        Some("tex-dependency-missing") => t!(
            "Missing LaTeX dependency `{file}`. Your TeX distribution does not include every package available on Overleaf. Use Install missing package to find and install the package that provides it.",
            file = file
        ),
        Some("conference-style-missing") => t!(
            "Missing style file `{file}`. It is part of the {venue} template and belongs next to main.tex — TeX Live cannot install it. Sync or copy it back from another copy of the project.",
            file = file,
            venue = p("venue")
        ),
        Some("latexmkrc-failed") if !p("reason").is_empty() => t!(
            "latexmk stopped before LaTeX ran because {file} failed: {reason}. The Log tab shows the output of the command it runs.",
            file = file,
            reason = p("reason")
        ),
        Some("latexmkrc-failed") => t!(
            "latexmk stopped before LaTeX ran because {file} failed. The Log tab shows the output of the command it runs.",
            file = file
        ),
        Some("playwright-chromium-missing") => t!(
            "The project's .latexmkrc runs Playwright, and the Chromium this Playwright version needs is not downloaded, so latexmk stopped before LaTeX ran. Run `{command}` in Terminal, then build again.",
            command = p("command")
        ),
        Some("pdftex-only-command") => t!(
            "`{command}` only works in pdfLaTeX, but this document was built with {engine}. Switch the project to pdfLaTeX to build it.",
            command = p("command"),
            engine = p("engine")
        ),
        Some("engine-switched") => t!(
            "Switched this project from {from} to pdfLaTeX: the document uses `{command}`, which only works in pdfLaTeX, and loads nothing that needs {from}.",
            command = p("command"),
            from = p("from")
        ),
        Some("built-beside") => t!(
            "This document builds beside itself rather than in the hidden build folder: it uses a package that ignores TeX's output directory, such as minted 2.x, imakeidx, glossaries or pythontex."
        )
        .into(),
        Some(code @ ("cjk-glyphs-missing" | "cjk-needs-unicode-engine")) => {
            cjk_text_advice(code, diagnostic)
        }
        Some("stale-build") => t!(
            "Stale failed build. Use Clean rebuild (Shift-click Build), or delete aux files and build again."
        )
        .into(),
        Some("build-cancelled") => t!(
            "Build stopped after {seconds} s. The log below is how far it got.",
            seconds = p("seconds")
        ),
        Some("build-stalled") if p("place").is_empty() => t!(
            "TeX stopped making progress, so the build was stopped after {seconds} s. Look for an unfinished command.",
            seconds = p("seconds")
        ),
        Some("build-stalled") => t!(
            "TeX stopped making progress, so the build was stopped after {seconds} s. Look for an unfinished command just before {place}.",
            seconds = p("seconds"),
            place = p("place")
        ),
        Some("lineno-outdated") => t!(
            "Line numbers may be drawn over the text: your TeX has lineno 5.7, which has a known bug. Update TeX packages to fix it."
        )
        .into(),
        // The LaTeX goes in as a parameter: its braces would read as
        // placeholders.
        Some("arydshln-after-colortbl") => t!(
            "These table errors come from loading arydshln after colortbl, which LaTeX 2026-11 broke: the tables are fine. Load arydshln before colortbl, or remove {command} if no table draws dashed rules.",
            command = "\\usepackage{arydshln}"
        ),
        Some("diagnostics-capped") => t!(
            "Only the first {shown} of {total} errors and warnings are listed. The raw build log has the rest.",
            shown = p("shown"),
            total = p("total")
        ),
        Some("pdf-fonts-not-times") => pdf_fonts_text(diagnostic, p("upToDate") == "true"),
        _ => diagnostic.message.clone(),
    }
}

/// A conference PDF typeset in the wrong fonts, and what in its build
/// replaced Times (`TimesCause` in lattice-core's `pdf_fonts.rs`).
fn pdf_fonts_text(diagnostic: &Diagnostic, up_to_date: bool) -> String {
    let p = |name| param(diagnostic, name);
    let venue = p("venue");
    let fonts = p("fonts");
    let problem = if fonts.is_empty() {
        t!(
            "PDF fonts are not the Times that {venue} requires.",
            venue = venue
        )
    } else {
        t!(
            "PDF fonts are not the Times that {venue} requires ({fonts}).",
            venue = venue,
            fonts = fonts
        )
    };
    let text = format!("{problem} {}", times_fix_text(p("cause")));
    if up_to_date {
        format!(
            "{text} — {}",
            t!(
                "latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts."
            )
        )
    } else {
        text
    }
}

fn times_fix_text(cause: &str) -> String {
    match cause {
        "lmodern" => t!(
            "The document loads lmodern after Times, which replaces it with Latin Modern: remove {command}, then Build.",
            command = "\\usepackage{lmodern}"
        ),
        "fontspec" => t!(
            "The document loads fontspec, which makes Latin Modern the main font: add {command} after it, or build with pdfLaTeX.",
            command = "\\setmainfont{Times New Roman}"
        ),
        "unicode-encoding" => t!(
            "XeLaTeX and LuaLaTeX have no Times in their default encoding, so LaTeX fell back to Latin Modern: add {command} after the template, or build with pdfLaTeX.",
            command = "\\usepackage[T1]{fontenc}"
        ),
        "fonts-missing" => t!(
            "Times is not installed, so LaTeX fell back to Computer Modern: click Install required tools in the TeX doctor, then Shift-click Build."
        )
        .into(),
        "not-loaded" => t!(
            "The document never loads Times: add {command} after the template, then Build.",
            command = "\\usepackage{times}"
        ),
        _ => t!("Expected NimbusRomNo9L-*.").into(),
    }
}

/// CJK text the build could not set (lattice-core's `cjk_text.rs`): the
/// fonts had no glyphs for it, or pdfLaTeX refused it. `missingFile` is
/// there when ctex is not installed, and the card offers to install it.
fn cjk_text_advice(code: &str, diagnostic: &Diagnostic) -> String {
    let p = |name| param(diagnostic, name);
    let (count, sample) = (p("count"), p("sample"));
    let command = "\\usepackage{ctex}";
    let chinese = p("script") == "chinese";
    let advice = match (code == "cjk-glyphs-missing", chinese) {
        (true, true) => t!(
            "The PDF is missing {count} Chinese characters ({sample}): this document's fonts have none. Add {command} to the preamble, or start from the Chinese article template.",
            count = count,
            sample = sample,
            command = command
        ),
        (true, false) => t!(
            "The PDF is missing {count} Chinese, Japanese or Korean characters ({sample}): this document's fonts have none. Add {command} to the preamble, or start from the Chinese article template.",
            count = count,
            sample = sample,
            command = command
        ),
        (false, true) => t!(
            "pdfLaTeX cannot typeset Chinese characters ({sample}). Add {command} to the preamble and switch the project to XeLaTeX, or start from the Chinese article template.",
            sample = sample,
            command = command
        ),
        (false, false) => t!(
            "pdfLaTeX cannot typeset Chinese, Japanese or Korean characters ({sample}). Add {command} to the preamble and switch the project to XeLaTeX, or start from the Chinese article template.",
            sample = sample,
            command = command
        ),
    };
    if p("missingFile").is_empty() {
        advice
    } else {
        t!(
            "{advice} ctex is not installed yet: Install adds it with its Chinese fonts, about 90 MB.",
            advice = advice
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coded(code: &'static str, params: &[(&'static str, &str)]) -> Diagnostic {
        Diagnostic {
            file: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            level: "error".into(),
            message: "the English".into(),
            code: Some(code),
            params: params
                .iter()
                .map(|(key, value)| (*key, value.to_string()))
                .collect(),
        }
    }

    #[test]
    fn lattices_advice_is_filled_from_its_params() {
        assert_eq!(
            text(&coded(
                "build-stalled",
                &[("seconds", "30"), ("place", "line 12")]
            )),
            "TeX stopped making progress, so the build was stopped after 30 s. Look for an unfinished command just before line 12."
        );
        assert_eq!(
            text(&coded("latex-tool-missing", &[("tool", "latexmk")])),
            "The LaTeX tool 'latexmk' was not found. Install MacTeX or TeX Live, then restart Lattice."
        );
        assert_eq!(
            text(&coded(
                "tex-dependency-missing",
                &[
                    ("file", "lipsum.sty"),
                    ("distribution", "TinyTeX"),
                    ("packages", "TeX Live")
                ]
            )),
            "Missing LaTeX dependency `lipsum.sty`. Your TinyTeX does not include every package available on Overleaf. Use Install missing package to find and install its TeX Live package."
        );
        assert_eq!(
            text(&coded(
                "latex-tool-missing",
                &[("tool", "biber"), ("distribution", "TinyTeX")]
            )),
            "The LaTeX tool 'biber' was not found. Add it to your TinyTeX, then restart Lattice."
        );
        assert_eq!(
            text(&coded("arydshln-after-colortbl", &[])),
            "These table errors come from loading arydshln after colortbl, which LaTeX 2026-11 broke: the tables are fine. Load arydshln before colortbl, or remove \\usepackage{arydshln} if no table draws dashed rules."
        );
    }

    #[test]
    fn tex_messages_and_unknown_codes_are_left_as_written() {
        let mut tex = coded("build-stalled", &[]);
        tex.code = None;
        assert_eq!(text(&tex), "the English");
        assert_eq!(text(&coded("some-new-code", &[])), "the English");
    }
}
