//! Reading latexmk's output into diagnostics. Adapted from Lattice's
//! `latex/build_log.rs`, without Lattice's translated advice codes.

use regex::{Captures, Regex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// Relative to the document's folder, as TeX names it (`chapters/a.tex`).
    pub file: Option<String>,
    pub line: Option<u32>,
    pub level: Level,
    pub message: String,
}

impl Diagnostic {
    fn new(file: Option<String>, line: Option<u32>, level: Level, message: String) -> Self {
        Self {
            file,
            line,
            level,
            message,
        }
    }
}

/// Warnings every multi-pass build prints on its way to converging, or that
/// are never actionable. Matched case-insensitively anywhere in the message.
const PASS_NOISE: [&str; 8] = [
    "rerun to get",
    "may have changed",
    "there were undefined citations",
    "there were undefined references",
    "empty `thebibliography'",
    "empty thebibliography",
    "shell escape feature is not enabled",
    "ignoring empty anchor",
];

/// How many `file:line:` diagnostics one build lists.
const LOCATED_CAP: usize = 40;

/// A file TeX names in its log, `./main.tex` or `../shared/macros.tex`.
const LOG_FILE: &str = r"([^\n:]+\.[A-Za-z0-9]+)";

pub fn is_pass_noise_warning(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    PASS_NOISE.iter().any(|phrase| lower.contains(phrase))
}

pub fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    // Latexmk concatenates every pass; first-pass "undefined citation/ref"
    // noise should not inflate the warning count after a successful final run.
    let log = last_typeset_pass(log);
    let file_line = Regex::new(&format!(r"(?m)^{LOG_FILE}:(\d+):\s*(.+)$")).unwrap();
    let warning_on_line = Regex::new(&format!(
        r"(?m)^{LOG_FILE}:(\d+):\s*(?:Package|LaTeX|Class) .+? Warning:\s*(.+)$"
    ))
    .unwrap();
    let warning = Regex::new(r"(?m)^(?:LaTeX|Package .+?) Warning:\s*(.+)$").unwrap();
    let missing_command =
        Regex::new(r"(?m)^(?:sh:\s*)?([A-Za-z0-9_+.-]+): command not found$").unwrap();
    let missing_dependency = Regex::new(
        r"(?m)(?:!\s*)?LaTeX Error: File [`']([^`']+\.(?:sty|cls|bst|bbx|cbx))[`'] not found\.",
    )
    .unwrap();
    let located = |capture: &Captures, level: Level| {
        let file = Some(normalize_log_path(&capture[1]));
        let message = match level {
            Level::Warning => warning_message(log, capture),
            _ => capture[3].trim().to_string(),
        };
        Diagnostic::new(file, capture[2].parse().ok(), level, message)
    };

    let mut located_lines = file_line
        .captures_iter(log)
        .filter(|capture| !warning_on_line.is_match(&capture[0]));
    let mut diagnostics: Vec<Diagnostic> = located_lines
        .by_ref()
        .take(LOCATED_CAP)
        .map(|capture| {
            let warns = capture[3].to_ascii_lowercase().contains("warning");
            located(&capture, if warns { Level::Warning } else { Level::Error })
        })
        .collect();
    let unlisted = located_lines.count();
    for capture in warning_on_line.captures_iter(log).take(LOCATED_CAP) {
        push_unique(&mut diagnostics, located(&capture, Level::Warning));
    }
    for error in prompt_errors(log) {
        if !missing_dependency.is_match(&error.message) {
            push_unique(&mut diagnostics, error);
        }
    }
    if let Some(capture) = missing_command.captures(log) {
        let message = format!(
            "The LaTeX tool '{}' was not found. Install MacTeX, MiKTeX or TeX Live.",
            &capture[1]
        );
        push_unique(
            &mut diagnostics,
            Diagnostic::new(None, None, Level::Error, message),
        );
    }
    if let Some(capture) = missing_dependency.captures(log) {
        let message = format!("Missing LaTeX dependency `{}`.", &capture[1]);
        push_unique(
            &mut diagnostics,
            Diagnostic::new(None, None, Level::Error, message),
        );
    }
    for capture in warning.captures_iter(log).take(LOCATED_CAP) {
        let message = warning_message(log, &capture);
        if !is_pass_noise_warning(&message) {
            push_unique(
                &mut diagnostics,
                Diagnostic::new(None, None, Level::Warning, message),
            );
        }
    }
    // LaTeX's terminal boilerplate goes: the preceding error is the
    // actionable cause, while "Emergency stop" only says compilation ended.
    diagnostics.retain(|diagnostic| {
        let lower = diagnostic.message.trim().to_ascii_lowercase();
        let terminal_error = lower == "emergency stop."
            || [
                "fatal error occurred",
                "no output pdf file produced",
                "==> fatal error occurred",
            ]
            .iter()
            .any(|boilerplate| lower.starts_with(boilerplate));
        !terminal_error
            && (diagnostic.level == Level::Error || !is_pass_noise_warning(&diagnostic.message))
    });
    if unlisted > 0 {
        let message = format!(
            "Only the first {LOCATED_CAP} of {} errors and warnings are listed. The raw build log has the rest.",
            LOCATED_CAP + unlisted
        );
        diagnostics.push(Diagnostic::new(None, None, Level::Info, message));
    }
    diagnostics
}

/// A warning's whole message. TeX writes a long one over several lines: a
/// package or class starts each further line with its name in parentheses,
/// `(hyperref)       removing …`, and LaTeX's own warnings indent it under the
/// text. `capture` is a warning pattern's match, whose last group is the
/// message's first line.
fn warning_message(log: &str, capture: &Captures) -> String {
    let whole = capture.get(0).expect("a match has group 0");
    let first = &capture[capture.len() - 1];
    let source = Regex::new(r"(?:Package|Class) (\S+) Warning:").unwrap();
    let continuation = match source.captures(whole.as_str()) {
        Some(source) => format!("({})", &source[1]),
        None => " ".repeat("LaTeX Warning: ".len()),
    };
    let mut message = first.trim().to_string();
    for line in log[whole.end()..].lines().skip(1) {
        let Some(rest) = line.strip_prefix(&continuation) else {
            break;
        };
        let rest = rest.trim();
        if rest.is_empty() {
            break;
        }
        message.push(' ');
        message.push_str(rest);
    }
    message
}

/// Errors TeX raises at its own prompt, such as an `\input` file that does not
/// exist: `! LaTeX Error: File `intro.tex' not found.` has no location even
/// under `-file-line-error`. Nonstop mode ends the run there, with an
/// `./main.tex:4: Emergency stop.` that names where it happened.
fn prompt_errors(log: &str) -> Vec<Diagnostic> {
    let prompt = Regex::new(r"(?m)^! (.+)$").unwrap();
    let stop = Regex::new(&format!(r"(?m)^{LOG_FILE}:(\d+): Emergency stop\.$")).unwrap();
    prompt
        .captures_iter(log)
        .filter_map(|capture| {
            let after = &log[capture.get(0)?.end()..];
            let before_next = prompt.find(after).map_or(after.len(), |next| next.start());
            let place = stop.captures(&after[..before_next])?;
            let file = Some(normalize_log_path(&place[1]));
            Some(Diagnostic::new(
                file,
                place[2].parse().ok(),
                Level::Error,
                capture[1].trim().to_string(),
            ))
        })
        .collect()
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

pub fn normalize_log_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"').replace('\\', "/");
    let without_dot = trimmed.strip_prefix("./").unwrap_or(&trimmed);
    match without_dot.rsplit_once("/./") {
        Some((_, relative)) => relative.to_string(),
        None => without_dot.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_file_line_errors() {
        let log = "Running 'pdflatex'\n./main.tex:12: Undefined control sequence.\nl.12 \\foo\n";
        let diagnostics = parse_diagnostics(log);
        assert_eq!(
            diagnostics,
            vec![Diagnostic::new(
                Some("main.tex".into()),
                Some(12),
                Level::Error,
                "Undefined control sequence.".into()
            )]
        );
    }

    #[test]
    fn joins_multiline_package_warnings_and_drops_pass_noise() {
        let log = "Running 'pdflatex'\nPackage hyperref Warning: Token not allowed in a PDF string\n(hyperref)                removing `math shift'.\n\nLaTeX Warning: There were undefined references.\n";
        let diagnostics = parse_diagnostics(log);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(
            diagnostics[0].message,
            "Token not allowed in a PDF string removing `math shift'."
        );
    }

    #[test]
    fn locates_prompt_errors_by_their_emergency_stop() {
        let log = "! LaTeX Error: File `intro.tex' not found.\n\n./main.tex:4: Emergency stop.\n";
        let diagnostics = parse_diagnostics(log);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].file.as_deref(), Some("main.tex"));
        assert_eq!(diagnostics[0].line, Some(4));
    }
}
