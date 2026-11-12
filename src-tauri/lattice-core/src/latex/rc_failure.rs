//! latexmk stopping in a project's rc file, before any engine pass: the
//! failure explained, with Playwright's missing browser download named.

use super::build_log::advice;
use crate::models::Diagnostic;
use regex::Regex;

/// latexmk runs a project's rc file before any engine pass, and a `die` there
/// ends the build with only the rc's own output in the log: no LaTeX error,
/// so the diagnostics list stayed empty and the raw dump was all anyone saw.
pub(super) fn rc_file_failure(log: &str) -> Option<Diagnostic> {
    let rc_error = Regex::new(
        r"(?m)^Latexmk: Initialization file '([^'\n]+)' gave an error:[ \t]*\n((?:[ \t]+\S[^\n]*\n?)*)",
    )
    .unwrap();
    let capture = rc_error.captures(log)?;
    Some(playwright_browser_missing(log).unwrap_or_else(|| {
        let file = capture[1].trim_start_matches("./");
        let reason = crate::util::collapse_whitespace(&capture[2]);
        let reason = reason.trim_end_matches('.');
        let message = if reason.is_empty() {
            format!("latexmk stopped before LaTeX ran because {file} failed. The Log tab shows the output of the command it runs.")
        } else {
            format!("latexmk stopped before LaTeX ran because {file} failed: {reason}. The Log tab shows the output of the command it runs.")
        };
        advice("error", "latexmkrc-failed", &[("file", file), ("reason", reason)], message)
    }))
}

/// Projects render figures from `.latexmkrc` with Playwright. Its browsers are
/// a separate download per Playwright release, so an unpinned `playwright`
/// dependency that resolves a new release fails with "Executable doesn't
/// exist" until that release's browser is installed. Lattice runs latexmk with
/// the user's HOME, so the lookup is the same `~/Library/Caches/ms-playwright`
/// a Terminal build uses; the fix is the install Playwright asks for, run by
/// the same Playwright, which the traceback's site-packages path identifies.
fn playwright_browser_missing(log: &str) -> Option<Diagnostic> {
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
    let message = format!(
        "The project's .latexmkrc runs Playwright, and the Chromium this Playwright version needs is not downloaded, so latexmk stopped before LaTeX ran. Run `{command}` in Terminal, then build again."
    );
    Some(advice("error", "playwright-chromium-missing", &[("command", &command)], message))
}

fn shell_word(value: &str) -> String {
    if value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/._+-@%=:,".contains(&byte)) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
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
    use super::super::build_log::parse_diagnostics;
    use super::*;

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
}
