//! Reading latexmk's log: diagnostics for the editor, and a trimmed copy for
//! the Log tab.

use crate::models::Diagnostic;
use regex::{Captures, Regex};

/// Warnings every multi-pass build prints on its way to converging, or that
/// are never actionable. Matched case-insensitively anywhere in the message.
const PASS_NOISE: [&str; 8] = [
    "rerun to get",
    "may have changed",
    "there were undefined citations",
    "there were undefined references",
    // Fresh / empty projects always trip this; not actionable until a .bib entry exists.
    "empty `thebibliography'",
    "empty thebibliography",
    // Default Lattice builds use -no-shell-escape; epstopdf always complains.
    "shell escape feature is not enabled",
    // hyperref fires this for every \section without a label. Nothing to act
    // on, and a normal paper produces one per heading.
    "ignoring empty anchor",
];

/// Conference template styles by file-name prefix. They are not on CTAN —
/// `tlmgr install` can never provide them — because their author kits ship
/// them in the project folder.
const CONFERENCE_STYLES: [(&str, &str); 5] = [
    ("neurips", "NeurIPS"),
    ("nips", "NeurIPS"),
    ("icml", "ICML"),
    ("iclr", "ICLR"),
    ("cvpr", "CVPR"),
];

pub(super) fn diagnostic(
    file: Option<String>, line: Option<u32>, level: &str, message: String,
) -> Diagnostic {
    let level = level.to_string();
    Diagnostic { file, line, column: None, end_line: None, end_column: None, level, message }
}

/// latexmk's answer when the PDF is already current.
pub(super) fn skipped_recompile(log: &str) -> bool {
    let lower = log.to_ascii_lowercase();
    lower.contains("nothing to do") || lower.contains("up-to-date")
}

pub(super) fn is_stale_previous_invocation_log(log: &str) -> bool {
    let lower = log.to_ascii_lowercase();
    lower.contains("error in previous invocation")
        || (lower.contains("nothing to do") && lower.contains("gave an error in previous"))
}

pub(crate) fn is_pass_noise_warning(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    PASS_NOISE.iter().any(|phrase| lower.contains(phrase))
}

/// Whether this build loaded one of the conference templates.
///
/// The log names every style it reads, so the document that was actually
/// typeset answers this — the project manifest cannot. A project created as
/// NeurIPS holds whatever its author later writes in it, including documents
/// that are not submissions at all.
pub(super) fn log_loads_conference_template(log: &str) -> bool {
    Regex::new(r"[A-Za-z0-9_\-]+\.sty")
        .unwrap()
        .find_iter(log)
        .any(|style| conference_template_venue(style.as_str()).is_some())
}

fn conference_template_venue(sty: &str) -> Option<&'static str> {
    let lower = sty.to_ascii_lowercase();
    CONFERENCE_STYLES.iter().find(|(prefix, _)| lower.starts_with(prefix)).map(|(_, venue)| *venue)
}

pub(super) fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    // Latexmk concatenates every pass; first-pass "undefined citation/ref" noise
    // should not inflate the warning count after a successful final run.
    let log = last_typeset_pass(log);
    let file_line = Regex::new(r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+):\s*(.+)$").unwrap();
    let warning_on_line = Regex::new(
        r"(?m)^([^\n:]+\.(?:tex|sty|cls)):(\d+):\s*(?:Package|LaTeX|Class) .+? Warning:\s*(.+)$",
    )
    .unwrap();
    let warning = Regex::new(r"(?m)^(?:LaTeX|Package .+?) Warning:\s*(.+)$").unwrap();
    let missing_command =
        Regex::new(r"(?m)^(?:sh:\s*)?([A-Za-z0-9_+.-]+): command not found$").unwrap();
    let missing_dependency = Regex::new(
        r"(?m)(?:!\s*)?LaTeX Error: File [`']([^`']+\.(?:sty|cls|bst|bbx|cbx))[`'] not found\.",
    )
    .unwrap();
    let located = |capture: &Captures, level: &str| {
        let file = Some(normalize_log_path(&capture[1]));
        diagnostic(file, capture[2].parse().ok(), level, capture[3].trim().to_string())
    };

    let mut diagnostics: Vec<Diagnostic> = file_line
        .captures_iter(log)
        .take(40)
        .map(|capture| {
            let warns = capture[3].to_ascii_lowercase().contains("warning");
            located(&capture, if warns { "warning" } else { "error" })
        })
        .collect();
    for capture in warning_on_line.captures_iter(log).take(40) {
        push_unique(&mut diagnostics, located(&capture, "warning"));
    }
    let missing_tool = missing_command.captures(log).map(|capture| {
        format!(
            "The LaTeX tool '{}' was not found. Install MacTeX or TeX Live, then restart Lattice.",
            &capture[1]
        )
    });
    let missing_file =
        missing_dependency.captures(log).map(|capture| missing_dependency_message(&capture[1]));
    let stale = is_stale_previous_invocation_log(log).then(|| {
        "Stale failed build. Use Clean rebuild (Shift-click Build), or delete aux files and build again.".to_string()
    });
    for message in [missing_tool, missing_file, rc_file_failure(log), stale].into_iter().flatten() {
        push_unique(&mut diagnostics, diagnostic(None, None, "error", message));
    }
    for capture in warning.captures_iter(log).take(40) {
        let message = capture[1].trim();
        if !is_pass_noise_warning(message) {
            push_unique(&mut diagnostics, diagnostic(None, None, "warning", message.to_string()));
        }
    }
    // The same noise warnings also arrive with a `file:line:` prefix through
    // the other two patterns, so filter once at the end to cover every
    // producer. LaTeX's terminal boilerplate goes too: the preceding error is
    // the actionable cause, while "Emergency stop" only says compilation ended.
    diagnostics.retain(|diagnostic| {
        let lower = diagnostic.message.trim().to_ascii_lowercase();
        let terminal_error = lower == "emergency stop."
            || ["fatal error occurred", "no output pdf file produced", "==> fatal error occurred"]
                .iter()
                .any(|boilerplate| lower.starts_with(boilerplate));
        !terminal_error
            && (diagnostic.level == "error" || !is_pass_noise_warning(&diagnostic.message))
    });
    diagnostics
}

fn missing_dependency_message(missing_file: &str) -> String {
    match conference_template_venue(missing_file) {
        Some(venue) => format!(
            "Missing style file `{missing_file}`. It is part of the {venue} template and belongs next to main.tex — TeX Live cannot install it. Sync or copy it back from another copy of the project."
        ),
        None => format!(
            "Missing LaTeX dependency `{missing_file}`. BasicTeX does not include every package available on Overleaf. Use Install missing package to find and install its TeX Live package."
        ),
    }
}

/// latexmk runs a project's rc file before any engine pass, and a `die` there
/// ends the build with only the rc's own output in the log: no LaTeX error,
/// so the diagnostics list stayed empty and the raw dump was all anyone saw.
fn rc_file_failure(log: &str) -> Option<String> {
    let rc_error = Regex::new(
        r"(?m)^Latexmk: Initialization file '([^'\n]+)' gave an error:[ \t]*\n((?:[ \t]+\S[^\n]*\n?)*)",
    )
    .unwrap();
    let capture = rc_error.captures(log)?;
    Some(playwright_browser_missing(log).unwrap_or_else(|| {
        let file = capture[1].trim_start_matches("./");
        let reason = crate::util::collapse_whitespace(&capture[2]);
        let reason = reason.trim_end_matches('.');
        let reason = if reason.is_empty() { String::new() } else { format!(": {reason}") };
        format!(
            "latexmk stopped before LaTeX ran because {file} failed{reason}. The Log tab shows the output of the command it runs."
        )
    }))
}

/// Projects render figures from `.latexmkrc` with Playwright. Its browsers are
/// a separate download per Playwright release, so an unpinned `playwright`
/// dependency that resolves a new release fails with "Executable doesn't
/// exist" until that release's browser is installed. Lattice runs latexmk with
/// the user's HOME, so the lookup is the same `~/Library/Caches/ms-playwright`
/// a Terminal build uses; the fix is the install Playwright asks for, run by
/// the same Playwright, which the traceback's site-packages path identifies.
fn playwright_browser_missing(log: &str) -> Option<String> {
    let missing = Regex::new(r"(?m)Executable doesn't exist at (.+?)\s*$").unwrap();
    let executable = missing.captures(log)?.get(1)?.as_str();
    let chromium_build = Regex::new(r"^chromium[a-z_]*-\d+$").unwrap();
    // Match the browser directory only: the browsers directory can sit under a
    // custom PLAYWRIGHT_BROWSERS_PATH whose own components look like `name-123`.
    let needs_chromium = std::path::Path::new(executable)
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .any(|component| chromium_build.is_match(component));
    if !needs_chromium {
        return None;
    }
    let python_env =
        Regex::new(r#"File "([^"\n]+?)/lib/python[0-9.]+/site-packages/playwright/"#).unwrap();
    let capture = python_env.captures(log)?;
    let python = format!("{}/bin/python3", &capture[1]);
    let command = format!("{} -m playwright install chromium", shell_word(&python));
    Some(format!(
        "The project's .latexmkrc runs Playwright, and the Chromium this Playwright version needs is not downloaded, so latexmk stopped before LaTeX ran. Run `{command}` in Terminal, then build again."
    ))
}

fn shell_word(value: &str) -> String {
    if value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/._+-@%=:,".contains(&byte)) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn last_typeset_pass(log: &str) -> &str {
    let start = ["pdflatex", "xelatex", "lualatex", "latex"]
        .iter()
        .filter_map(|engine| log.rfind(&format!("Running '{engine}")))
        .max()
        .unwrap_or(0);
    &log[start..]
}

fn push_unique(diagnostics: &mut Vec<Diagnostic>, candidate: Diagnostic) {
    let duplicate = diagnostics.iter().any(|item| {
        item.file == candidate.file
            && item.line == candidate.line
            && item.message == candidate.message
    });
    if !duplicate {
        diagnostics.push(candidate);
    }
}

fn normalize_log_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"').replace('\\', "/");
    let without_dot = trimmed.strip_prefix("./").unwrap_or(&trimmed);
    match without_dot.rsplit_once("/./") {
        Some((_, relative)) => relative.to_string(),
        None => without_dot.to_string(),
    }
}

pub(super) fn trim_log(log: &str) -> String {
    const LIMIT: usize = 30_000;
    // Drop latexmk's startup banner ("Rc files read: NONE", version, initial setup).
    // It is not a Lattice warning and crowds the Log tab when something else is wrong.
    let trimmed = strip_latexmk_preamble(log);
    if trimmed.len() <= LIMIT {
        return trimmed;
    }
    // Byte offsets, and a latexmk log is full of accented text and of U+FFFD
    // from lossy decoding, so the cut has to be moved to a character boundary
    // — landing inside one panicked after the PDF had already been read,
    // losing a build that had in fact succeeded.
    let start = trimmed.ceil_char_boundary(trimmed.len() - LIMIT);
    format!("…\n{}", &trimmed[start..])
}

/// The log from the first engine banner on. A banner at the very start does
/// not count; with none after it, the log starts at latexmk's first run.
fn strip_latexmk_preamble(log: &str) -> String {
    let start = ["This is pdfTeX", "This is XeTeX", "This is LuaTeX", "This is TeX", "LaTeX2e"]
        .iter()
        .filter_map(|marker| log.find(marker))
        .filter(|index| *index > 0)
        .min()
        .or_else(|| log.find("Running '"))
        .unwrap_or(0);
    log[start..].trim_start().to_string()
}

/// The tail of the reported log (reproduced with a `.latexmkrc` that runs
/// a uv script whose unpinned Playwright resolved 1.63.0, browsers absent).
#[cfg(test)]
pub(super) const PLAYWRIGHT_RC_FAILURE: &str = r#"Traceback (most recent call last):
  File "/Users/me/paper/scripts/export_probe_pdfs.py", line 20, in main
    browser = p.chromium.launch()
  File "/Users/me/.cache/uv/environments-v2/export-probe-pdfs-d4814944139a86e2/lib/python3.13/site-packages/playwright/_impl/_connection.py", line 632, in wrap_api_call
    raise rewrite_error(error, f"{parsed_st['apiName']}: {error}") from None
playwright._impl._errors.Error: BrowserType.launch: Executable doesn't exist at /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     playwright install                                     ║
╚════════════════════════════════════════════════════════════╝
Latexmk: Initialization file './.latexmkrc' gave an error:
     Probe SVG conversion failed

Latexmk: Stopping because of problem with rc file
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const CONFERENCE_STYLE_FILES: [&str; 5] =
        ["neurips.sty", "neurips_2026.sty", "icml2026.sty", "iclr2026_conference.sty", "cvpr.sty"];

    /// The diagnostic that mentions `needle`, which must exist.
    fn message_about(log: &str, needle: &str) -> String {
        let diagnostics = parse_diagnostics(log);
        let found = diagnostics.iter().find(|item| item.message.contains(needle));
        found.unwrap_or_else(|| panic!("nothing about {needle} in {diagnostics:?}")).message.clone()
    }

    #[test]
    fn explains_a_failing_latexmkrc_and_the_playwright_browser_it_needs() {
        let diagnostics = parse_diagnostics(PLAYWRIGHT_RC_FAILURE);
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert_eq!(diagnostics[0].level, "error");
        assert!(diagnostics[0].message.contains("Chromium"), "{diagnostics:?}");
        let environment = "/Users/me/.cache/uv/environments-v2/export-probe-pdfs-d4814944139a86e2";
        // The same Playwright the rc ran, so the download matches build 1243;
        // a path with spaces is quoted and a relocated browsers directory
        // is still recognized.
        let relocated = PLAYWRIGHT_RC_FAILURE
            .replace("/Users/me/.cache/uv", "/Users/me/My Cache/uv")
            .replace("/Users/me/Library/Caches", "/Volumes/build-2026");
        for (log, python) in [
            (PLAYWRIGHT_RC_FAILURE.to_string(), format!("{environment}/bin/python3")),
            (relocated, format!("'{}/bin/python3'", environment.replace(".cache", "My Cache"))),
        ] {
            let message = &parse_diagnostics(&log)[0].message;
            let command = format!("`{python} -m playwright install chromium`");
            assert!(message.contains(&command), "{message}");
        }

        // Without Playwright, the rc file and its own error are named instead
        // of leaving only the raw log.
        let diagnostics = parse_diagnostics(
            "Latexmk: Initialization file './.latexmkrc' gave an error:\n     \
             Figure export failed\n\nLatexmk: Stopping because of problem with rc file\n",
        );
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert!(
            diagnostics[0].message.contains(".latexmkrc failed: Figure export failed."),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn explains_missing_tools_and_dependencies() {
        let diagnostics = parse_diagnostics("sh: pdflatex: command not found\n");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("pdflatex"));

        // Packages, classes and bibliography styles are offered an install,
        // named without the log's quotes.
        for (log, missing) in [
            ("! LaTeX Error: File `algorithm.sty' not found.\n", "algorithm.sty"),
            ("./main.tex:3: LaTeX Error: File `acmart.cls' not found.\n", "acmart.cls"),
            ("./main.tex:3: LaTeX Error: File `plainnat.bst' not found.\n", "plainnat.bst"),
            ("./main.tex:3: LaTeX Error: File `authoryear.bbx' not found.\n", "authoryear.bbx"),
            ("./main.tex:3: LaTeX Error: File `numeric.cbx' not found.\n", "numeric.cbx"),
        ] {
            let hint = message_about(log, "Missing LaTeX dependency");
            assert!(hint.starts_with(&format!("Missing LaTeX dependency `{missing}`.")), "{hint}");
            assert!(hint.contains("Install missing package"), "{hint}");
        }

        // Conference author-kit styles are not on CTAN; `tlmgr install neurips`
        // fails and strands the user (they "installed everything" already).
        for sty in CONFERENCE_STYLE_FILES {
            let hint = message_about(&format!("! LaTeX Error: File `{sty}' not found.\n"), sty);
            assert!(!hint.contains("Install missing package"), "no tlmgr for {sty}: {hint}");
            assert!(hint.contains("next to main.tex"), "{sty} belongs in the project: {hint}");
        }
    }

    #[test]
    fn conference_font_expectations_only_apply_to_conference_documents() {
        // A grant proposal that asks for Latin Modern on purpose.
        let plain = "(./lambda_gpu_proposal.tex (/usr/local/texlive/2026basic/texmf-dist/tex/latex/lm/lmodern.sty\n\
             (/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/microtype.sty";
        assert!(!log_loads_conference_template(plain));
        for style in CONFERENCE_STYLE_FILES {
            let log = format!("(./main.tex (./{style}\nPackage: whatever\n");
            assert!(log_loads_conference_template(&log), "{style} is a conference template");
        }
    }

    #[test]
    fn normalizes_file_paths_and_classifies_warnings() {
        let diagnostics = parse_diagnostics(
            "./chapters/intro.tex:12: Undefined control sequence.\n\
             /Users/me/paper/./main.tex:40: Package natbib Warning: Citation undefined.\n\
             LaTeX Warning: Reference `fig:x' on page 1 undefined.\n",
        );
        assert_eq!(diagnostics[0].file.as_deref(), Some("chapters/intro.tex"));
        assert_eq!(diagnostics[0].level, "error");
        assert_eq!(diagnostics[1].file.as_deref(), Some("main.tex"));
        assert_eq!(diagnostics[1].level, "warning");
        assert!(diagnostics.iter().any(|item| item.file.is_none() && item.level == "warning"));
    }

    /// A latexmk pdfLaTeX pass that printed `body`.
    fn pass(body: &str) -> String {
        format!("------------\nRunning 'pdflatex  -interaction=nonstopmode \"main.tex\"'\n------------\n{body}")
    }

    /// How a pass that typeset the PDF ends.
    const TYPESET: &str =
        "Output written on main.pdf (1 page, 54890 bytes).\nLatexmk: All targets (main.pdf) are up-to-date\n";

    /// latexmk's startup banner, before its first pass.
    const BANNER: &str = "Rc files read:\n  NONE\nLatexmk: This is Latexmk, John Collins, 31 Jan. 2024. Version 4.83.\n";

    /// Logs whose every message is noise or terminal boilerplate.
    #[test]
    fn reports_nothing_for_noise_only_logs() {
        let cases = [
            (
                "LaTeX's terminal boilerplate after the real error",
                "./main.tex:8: Emergency stop.\n\
                 ./main.tex:8:  ==> Fatal error occurred, no output PDF file produced!\n"
                    .to_string(),
            ),
            (
                "first-pass noise before a clean final run",
                pass(
                    "Package natbib Warning: Citation `lei2025scalability' on page 1 undefined on input line 22.\n\
                     LaTeX Warning: Reference `fig:native-umm' on page 1 undefined on input line 24.\n\
                     LaTeX Warning: There were undefined references.\n\
                     Package rerunfilecheck Warning: File `main.out' has changed.\n\
                     (rerunfilecheck)                Rerun to get outlines right\n",
                ) + &pass(TYPESET),
            ),
            (
                "a fresh BasicTeX NeurIPS template",
                pass(&format!(
                    "Package epstopdf Warning: Shell escape feature is not enabled.\n\
                     Package natbib Warning: Empty `thebibliography' environment on input line 8.\n{TYPESET}"
                )),
            ),
            (
                "an empty bibliography after latexmk's banner",
                BANNER.to_string() + &pass(&format!(
                    "This is pdfTeX, Version 3.141592653-2.6-1.40.26\n\
                     Package natbib Warning: Empty `thebibliography' environment on input line 8.\n{TYPESET}"
                )),
            ),
            // hyperref reports this once per unlabelled heading, bare and
            // prefixed with `file:line:`; the prefixed shape is parsed by a
            // different pattern, which used to bypass the noise filter.
            (
                "hyperref empty anchors in both log shapes",
                pass(&format!(
                    "Package hyperref Warning: Ignoring empty anchor on input line 42.\n\
                     ./main.tex:57: Package hyperref Warning: Ignoring empty anchor on input line 57.\n{TYPESET}"
                )),
            ),
        ];
        for (case, log) in cases {
            let diagnostics = parse_diagnostics(&log);
            assert!(diagnostics.is_empty(), "{case}: {diagnostics:?}");
        }

        // A real error that happens to mention a noise phrase still counts.
        let log = pass(
            "./main.tex:12: Undefined control sequence while ignoring empty anchor handling.\n",
        );
        let diagnostics = parse_diagnostics(&log);
        assert_eq!(diagnostics.len(), 1, "got: {diagnostics:?}");
        assert_eq!(diagnostics[0].level, "error");
    }

    #[test]
    fn trims_latexmks_banner_and_keeps_the_tail_of_long_logs() {
        let log = BANNER.to_string() + &pass("This is pdfTeX, Version 3.141592653-2.6-1.40.26\n");
        assert!(trim_log(&log).starts_with("This is pdfTeX"));
        // The cut lands inside a two-byte character and must move past it.
        let long = trim_log(&format!("x{}z", "é".repeat(20_000)));
        assert!(long.starts_with("…\né") && long.len() == "…\n".len() + 29_999, "{}", long.len());
    }

    #[test]
    fn classifies_latexmk_run_summaries() {
        // A PDF someone else built leaves latexmk with nothing to do; a run
        // that actually typeset must not be repeated for SyncTeX.
        let stale_log = "Latexmk: Nothing to do for 'main.tex'.\n\
                         pdflatex: gave an error in previous invocation of latexmk.\n";
        for (log, skipped, stale) in [
            ("Latexmk: Nothing to do for 'main.tex'.", true, false),
            ("Latexmk: All targets (main.pdf) are up-to-date\n", true, false),
            ("Latexmk: applying rule 'pdflatex'...", false, false),
            (stale_log, true, true),
        ] {
            let summary = (skipped_recompile(log), is_stale_previous_invocation_log(log));
            assert_eq!(summary, (skipped, stale), "{log}");
        }
    }
}
