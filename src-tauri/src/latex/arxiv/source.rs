//! A paper's `.tex` sources as arXiv receives them: `%` comments taken out,
//! and `\input` / `\include` merged into the file that names them.
//!
//! arXiv publishes the source it is sent, so a comment is a note to
//! co-authors made public. Taking one out must not change what TeX typesets:
//! a comment also swallows its line's end, which is why a trailing comment
//! keeps its `%` and loses only its text. Neither pass touches what TeX reads
//! verbatim (`verbatim`, `lstlisting`, `\verb|…|`, a `\url`), where `%` is text
//! and `\input` is not a command.

use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

/// Environments whose body TeX reads verbatim.
const VERBATIM_ENVIRONMENTS: &[&str] = &[
    "verbatim",
    "verbatim*",
    "Verbatim",
    "Verbatim*",
    "BVerbatim",
    "LVerbatim",
    "lstlisting",
    "minted",
    "alltt",
    "filecontents",
    "filecontents*",
];

/// Commands whose first argument is read verbatim, so a `%` inside is text.
const VERBATIM_ARGUMENT_COMMANDS: &[&str] = &["url", "href", "path"];

/// How deep `\input` nests before merging stops and leaves the rest as is.
const MAX_INPUT_DEPTH: usize = 16;

static TODO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i:\btodo\b|\bfixme\b)|\bXXX\b").unwrap());
static INPUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(input|include)\s*\{([^{}]+)\}").unwrap());
static INCLUDEONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\includeonly\b").unwrap());

/// One comment the source carries, by its line in the file (from 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Comment {
    pub line: u32,
    pub text: String,
    pub todo: bool,
}

/// A file with its comments taken out, and what they said.
pub(super) struct Stripped {
    pub text: String,
    pub comments: Vec<Comment>,
}

/// What one line of source is to TeX.
enum LineKind {
    /// Read verbatim, or the body of a `comment` environment: no commands.
    Inert,
    /// Inside a `comment` environment (the line that opens it included):
    /// typeset nowhere, but published with the source.
    CommentEnvironment,
    /// Commands up to `live_end`; a comment starts at `comment` when one does.
    Code { live_end: usize, comment: Option<usize> },
}

/// Reads a file line by line, carrying which environment a line is in.
#[derive(Default)]
struct Scanner {
    verbatim: Option<&'static str>,
    comment_environment: bool,
}

impl Scanner {
    fn classify(&mut self, line: &str) -> LineKind {
        if let Some(environment) = self.verbatim {
            if line.contains(&format!("\\end{{{environment}}}")) {
                self.verbatim = None;
            }
            return LineKind::Inert;
        }
        if self.comment_environment {
            if line.contains("\\end{comment}") {
                self.comment_environment = false;
            }
            return LineKind::CommentEnvironment;
        }
        let comment = comment_start(line);
        let code = &line[..comment.unwrap_or(line.len())];
        if code.trim_start().starts_with("\\begin{comment}") {
            self.comment_environment = !code.contains("\\end{comment}");
            return LineKind::CommentEnvironment;
        }
        // Where a verbatim environment opens, the rest of the line is its body.
        let opens = VERBATIM_ENVIRONMENTS
            .iter()
            .filter_map(|environment| {
                let begin = format!("\\begin{{{environment}}}");
                code.find(&begin).map(|at| (at + begin.len(), *environment))
            })
            .min();
        match opens {
            Some((live_end, environment)) => {
                let rest = &line[live_end..];
                if !rest.contains(&format!("\\end{{{environment}}}")) {
                    self.verbatim = Some(environment);
                }
                LineKind::Code { live_end, comment: None }
            }
            None => LineKind::Code { live_end: comment.unwrap_or(line.len()), comment },
        }
    }
}

/// Where the line's comment starts: the first `%` that is neither escaped
/// (`\%`; `\\%` is a line break and then a comment) nor in a verbatim argument.
fn comment_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => return Some(at),
            b'\\' => at = verbatim_argument_end(bytes, at).unwrap_or(at + 2),
            _ => at += 1,
        }
    }
    None
}

/// Past the verbatim argument of the command at `backslash`: `\verb|…|`, or
/// the brace-balanced first argument of `\url`, `\href` and `\path`. To the
/// line's end when it does not close there.
fn verbatim_argument_end(bytes: &[u8], backslash: usize) -> Option<usize> {
    let name_start = backslash + 1;
    let name_end = (name_start..bytes.len())
        .find(|&at| !bytes[at].is_ascii_alphabetic())
        .unwrap_or(bytes.len());
    let name = &bytes[name_start..name_end];
    if name == b"verb" {
        let mut open = name_end;
        if bytes.get(open) == Some(&b'*') {
            open += 1;
        }
        let delimiter = *bytes.get(open)?;
        let close = (open + 1..bytes.len()).find(|&at| bytes[at] == delimiter);
        return Some(close.map_or(bytes.len(), |at| at + 1));
    }
    if !VERBATIM_ARGUMENT_COMMANDS.iter().any(|command| command.as_bytes() == name) {
        return None;
    }
    let open = (name_end..bytes.len()).find(|&at| !bytes[at].is_ascii_whitespace())?;
    if bytes[open] != b'{' {
        return None;
    }
    let mut depth = 0usize;
    for (at, byte) in bytes.iter().enumerate().skip(open) {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at + 1);
                }
            }
            _ => {}
        }
    }
    Some(bytes.len())
}

/// `line` without its line ending, and the ending.
fn split_ending(line: &str) -> (&str, &str) {
    let body = line.strip_suffix('\n').unwrap_or(line);
    let body = body.strip_suffix('\r').unwrap_or(body);
    (body, &line[body.len()..])
}

/// `source` without its comments, and the comments it had.
///
/// A line that is only a comment goes whole: its line end was swallowed by
/// the `%` anyway, so the lines either side join exactly as before. A comment
/// after code keeps its `%`, which still swallows the line end (`\foo{%`), and
/// loses its text. A bare `%` says nothing and stays. A `comment` environment
/// goes whole, from `\begin` to `\end`.
pub(super) fn strip_comments(source: &str) -> Stripped {
    let mut scanner = Scanner::default();
    let mut text = String::with_capacity(source.len());
    let mut comments = Vec::new();
    for (index, line) in source.split_inclusive('\n').enumerate() {
        let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let (body, ending) = split_ending(line);
        let mut note = |said: &str| {
            let said = said.trim();
            if !said.is_empty() {
                comments.push(Comment {
                    line: number,
                    text: said.to_string(),
                    todo: TODO.is_match(said),
                });
            }
        };
        match scanner.classify(body) {
            LineKind::Inert => text.push_str(line),
            LineKind::CommentEnvironment => {
                note(&body.replace("\\begin{comment}", "").replace("\\end{comment}", ""));
            }
            LineKind::Code { comment: None, .. } => text.push_str(line),
            LineKind::Code { comment: Some(at), .. } => {
                let said = &body[at + 1..];
                if said.trim().is_empty() {
                    text.push_str(line);
                    continue;
                }
                note(said);
                if !body[..at].trim().is_empty() {
                    text.push_str(&body[..=at]);
                    text.push_str(ending);
                }
            }
        }
    }
    Stripped { text, comments }
}

/// Whether the source's commands (not its comments) match `pattern`.
pub(super) fn code_matches(source: &str, pattern: &Regex) -> bool {
    let mut scanner = Scanner::default();
    source.split_inclusive('\n').any(|line| {
        let (body, _) = split_ending(line);
        match scanner.classify(body) {
            LineKind::Code { live_end, .. } => pattern.is_match(&body[..live_end]),
            _ => false,
        }
    })
}

/// `root`'s text with every `\input{…}` and `\include{…}` of a file in
/// `sources` (project-relative paths to texts) replaced by that file's text,
/// recursively, and the paths merged that way.
///
/// TeX looks for `name.tex` before `name`, and so does this. An `\include`
/// keeps the page breaks it makes; with `\includeonly` in the root none is
/// merged, since which of them typeset is that command's choice. A name that
/// is not in `sources`, a cycle, or nesting past [`MAX_INPUT_DEPTH`] stays a
/// command, and its file stays in the package.
pub(super) fn merge_inputs(
    root: &str, sources: &BTreeMap<String, String>,
) -> (String, BTreeSet<String>) {
    let Some(text) = sources.get(root) else {
        return (String::new(), BTreeSet::new());
    };
    let merge_includes = !code_matches(text, &INCLUDEONLY);
    let mut merged = BTreeSet::new();
    let mut stack = vec![root.to_string()];
    let text = expand(text, sources, merge_includes, &mut stack, &mut merged);
    (text, merged)
}

fn expand(
    text: &str, sources: &BTreeMap<String, String>, merge_includes: bool, stack: &mut Vec<String>,
    merged: &mut BTreeSet<String>,
) -> String {
    let mut scanner = Scanner::default();
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let (body, _) = split_ending(line);
        let LineKind::Code { live_end, .. } = scanner.classify(body) else {
            out.push_str(line);
            continue;
        };
        let mut copied = 0;
        for found in INPUT.captures_iter(&body[..live_end]) {
            let (whole, command, name) = (found.get(0).unwrap(), &found[1], found[2].trim());
            if command == "include" && !merge_includes {
                continue;
            }
            let Some(path) = resolve_input(name, sources) else { continue };
            if stack.len() > MAX_INPUT_DEPTH || stack.contains(&path) {
                continue;
            }
            stack.push(path.clone());
            let inner = expand(&sources[&path], sources, merge_includes, stack, merged);
            stack.pop();
            // TeX ends a file's last line like any other, then goes on with
            // the rest of this one. With nothing left on it, the line's own
            // ending stands in for the file's: two would make a blank line,
            // which is a paragraph break the source never had.
            let mut replacement = match command {
                "include" => format!("\\clearpage\n{}\\clearpage\n", with_line_end(inner)),
                _ => with_line_end(inner),
            };
            if body[whole.end()..].trim().is_empty() {
                replacement.pop();
            }
            out.push_str(&line[copied..whole.start()]);
            out.push_str(&replacement);
            copied = whole.end();
            merged.insert(path);
        }
        out.push_str(&line[copied..]);
    }
    out
}

fn with_line_end(mut text: String) -> String {
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// The source `\input{name}` reads, by TeX's order: `name.tex`, then `name`.
fn resolve_input(name: &str, sources: &BTreeMap<String, String>) -> Option<String> {
    let name = name.trim_start_matches("./");
    [format!("{name}.tex"), name.to_string()]
        .into_iter()
        .find(|candidate| candidate.ends_with(".tex") && sources.contains_key(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripped(source: &str) -> String {
        strip_comments(source).text
    }

    #[test]
    fn whole_line_comments_go_and_trailing_ones_keep_their_percent() {
        let source =
            "Intro text\n% TODO: cite Vaswani\n  % indented note\nmore % aside\n\\foo{%\n}\n";
        assert_eq!(stripped(source), "Intro text\nmore %\n\\foo{%\n}\n");
        let comments = strip_comments(source).comments;
        assert_eq!(
            comments,
            vec![
                Comment { line: 2, text: "TODO: cite Vaswani".into(), todo: true },
                Comment { line: 3, text: "indented note".into(), todo: false },
                Comment { line: 4, text: "aside".into(), todo: false },
            ]
        );
    }

    #[test]
    fn escaped_percents_and_verbatim_text_are_not_comments() {
        let source =
            "50\\% of runs\\\\% a note\n\\verb|100%| and \\url{https://x.org/a%20b} % gone\n";
        assert_eq!(
            stripped(source),
            "50\\% of runs\\\\%\n\\verb|100%| and \\url{https://x.org/a%20b} %\n"
        );
        let verbatim = "\\begin{verbatim}\n% printed as is\n\\end{verbatim}\n% gone\n";
        assert_eq!(stripped(verbatim), "\\begin{verbatim}\n% printed as is\n\\end{verbatim}\n");
    }

    #[test]
    fn a_comment_environment_goes_whole() {
        let source = "a\n\\begin{comment}\nold draft\n\\end{comment}\nb\n";
        let result = strip_comments(source);
        assert_eq!(result.text, "a\nb\n");
        assert_eq!(
            result.comments,
            vec![Comment { line: 3, text: "old draft".into(), todo: false }]
        );
    }

    #[test]
    fn todo_markers_are_found_in_any_case_but_xxx_only_in_capitals() {
        for (said, todo) in [
            ("todo fix", true),
            ("FIXME", true),
            ("XXX check", true),
            ("xxx", false),
            ("todos", false),
        ] {
            assert_eq!(strip_comments(&format!("% {said}\n")).comments[0].todo, todo, "{said}");
        }
    }

    #[test]
    fn inputs_merge_recursively_and_includes_keep_their_page_breaks() {
        let sources = BTreeMap::from([
            ("main.tex".to_string(), "\\begin{document}\n\\input{sections/intro}\n\\include{appendix}\n\\end{document}\n".to_string()),
            ("sections/intro.tex".to_string(), "Intro \\input{sections/detail.tex}".to_string()),
            ("sections/detail.tex".to_string(), "detail\n".to_string()),
            ("appendix.tex".to_string(), "Appendix\n".to_string()),
        ]);
        let (text, merged) = merge_inputs("main.tex", &sources);
        assert_eq!(
            text,
            "\\begin{document}\nIntro detail\n\\clearpage\nAppendix\n\\clearpage\n\\end{document}\n"
        );
        assert_eq!(
            merged.into_iter().collect::<Vec<_>>(),
            ["appendix.tex", "sections/detail.tex", "sections/intro.tex"]
        );
    }

    #[test]
    fn commented_unknown_cyclic_and_includeonly_inputs_stay_commands() {
        let sources = BTreeMap::from([
            (
                "main.tex".to_string(),
                "\\includeonly{a}\n% \\input{a}\n\\input{missing}\n\\input{loop}\n\\include{a}\n"
                    .to_string(),
            ),
            ("loop.tex".to_string(), "\\input{loop}\n".to_string()),
            ("a.tex".to_string(), "A\n".to_string()),
        ]);
        let (text, merged) = merge_inputs("main.tex", &sources);
        assert_eq!(text, sources["main.tex"]);
        assert_eq!(merged.into_iter().collect::<Vec<_>>(), ["loop.tex"]);
    }
}
