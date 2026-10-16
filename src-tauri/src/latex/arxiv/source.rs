//! A paper's TeX sources as arXiv receives them: `%` comments taken out,
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
static CONTROL_WORD_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[A-Za-z@]+$").unwrap());
static ENDINPUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\endinput\b").unwrap());
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
            // `\endinput` ends the file it is read in, which merged would be
            // this one.
            if stack.len() > MAX_INPUT_DEPTH
                || stack.contains(&path)
                || code_matches(&sources[&path], &ENDINPUT)
            {
                continue;
            }
            stack.push(path.clone());
            let mut nested = BTreeSet::new();
            let inner = expand(&sources[&path], sources, merge_includes, stack, &mut nested);
            stack.pop();
            // TeX skips the spaces that start the file's first line.
            let inner = inner.trim_start_matches([' ', '\t']);
            // Nothing written in its place reads as TeX reads an empty file:
            // a group starts a table row, a missing line loses a space. The
            // command stays, and its empty file ships.
            if inner.is_empty() {
                continue;
            }
            let (before, rest_blank) =
                (&body[..whole.start()], body[whole.end()..].trim().is_empty());
            // TeX ends the file's last line like any other, then this line
            // after the command: a space more, which `\space` keeps on a line
            // of its own, whatever the file's last line swallowed. Text after
            // the command, a control word the file's first letters would
            // lengthen, or a blank first line that ends a paragraph only at a
            // line's start, would each typeset differently merged; those
            // stay commands.
            let replacement = match command {
                "include" => format!(
                    "\\clearpage\n{}\\clearpage{}",
                    with_line_end(inner),
                    if rest_blank { "" } else { "\n" }
                ),
                _ if !rest_blank
                    || CONTROL_WORD_END.is_match(before)
                    || (!before.trim().is_empty()
                        && inner.lines().next().is_some_and(|first| first.trim().is_empty())) =>
                {
                    continue
                }
                _ => format!("{}\\space", with_line_end(inner)),
            };
            merged.insert(path);
            merged.append(&mut nested);
            out.push_str(&line[copied..whole.start()]);
            out.push_str(&replacement);
            copied = whole.end();
        }
        out.push_str(&line[copied..]);
    }
    out
}

fn with_line_end(text: &str) -> String {
    if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

/// The source `\input{name}` reads, by TeX's order: `name.tex`, then `name`.
fn resolve_input(name: &str, sources: &BTreeMap<String, String>) -> Option<String> {
    let name = name.trim_start_matches("./");
    [format!("{name}.tex"), name.to_string()]
        .into_iter()
        .find(|candidate| sources.contains_key(candidate))
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
            "\\begin{document}\nIntro detail\n\\space\n\\space\n\\clearpage\nAppendix\n\\clearpage\n\\end{document}\n"
        );
        assert_eq!(
            merged.into_iter().collect::<Vec<_>>(),
            ["appendix.tex", "sections/detail.tex", "sections/intro.tex"]
        );
    }

    #[test]
    fn an_empty_file_stays_an_input_as_written() {
        let mut sources = BTreeMap::from([
            ("rows.tex".to_string(), String::new()),
            ("todo.tex".to_string(), String::new()),
        ]);
        for main in [
            "\\begin{tabular}{l}\n\\hline\n\\input{rows}\n\\hline\n\\end{tabular}\n",
            "\\begin{tabular}{l}\na \\\\\n\\input{rows}\n\\end{tabular}\n",
            "para text\n\\input{todo}\nmore text\n",
            "foo%\n\\input{todo}\nbar\n",
            "\\include{todo}\n",
        ] {
            sources.insert("main.tex".to_string(), main.to_string());
            let (text, merged) = merge_inputs("main.tex", &sources);
            assert_eq!(text, main);
            assert!(merged.is_empty(), "{main}");
        }
    }

    /// What a file's last line swallows, the line end after `\input` still makes.
    const ENDINGS: [&str; 4] = ["FooBar\n", "FooBar%\n", "FooBar % name\n", "the \\LaTeX\n"];

    #[test]
    fn a_merged_input_keeps_the_space_its_line_ends_in() {
        for tool in ENDINGS {
            let tool = stripped(tool);
            let sources = BTreeMap::from([
                ("main.tex".to_string(), "We use \\input{tool}\nto do X\n".to_string()),
                ("tool.tex".to_string(), format!("  {tool}")),
            ]);
            let (text, merged) = merge_inputs("main.tex", &sources);
            assert_eq!(text, format!("We use {tool}\\space\nto do X\n"));
            assert_eq!(merged.into_iter().collect::<Vec<_>>(), ["tool.tex"]);
        }
    }

    #[test]
    fn an_input_that_would_typeset_differently_merged_stays_as_written() {
        let mut sources = BTreeMap::from([
            ("tool.tex".to_string(), "FooBar\n".to_string()),
            ("gap.tex".to_string(), "\nNext paragraph\n".to_string()),
            ("intro.tex".to_string(), "Intro.\n\\endinput\nold draft\n".to_string()),
            ("outer.tex".to_string(), "\\input{tool}\n".to_string()),
        ]);
        for main in [
            "\\begin{document}\n\\input{intro}\n\\end{document}\n",
            "We use \\input{outer} daily\n",
            "We use \\input{tool} daily\n",
            "We use \\input{tool}% joined\n",
            "\\foo\\input{tool}\n",
            "We use \\input{gap}\n",
        ] {
            sources.insert("main.tex".to_string(), main.to_string());
            let (text, merged) = merge_inputs("main.tex", &sources);
            assert_eq!(text, main);
            assert!(merged.is_empty(), "{main}");
        }

        sources.insert("intro.tex".to_string(), "Intro.\n% \\endinput\n".to_string());
        sources.insert("main.tex".to_string(), "\\input{intro}\n".to_string());
        let (text, merged) = merge_inputs("main.tex", &sources);
        assert_eq!(text, "Intro.\n% \\endinput\n\\space\n");
        assert_eq!(merged.into_iter().collect::<Vec<_>>(), ["intro.tex"]);
    }

    /// The width TeX typesets `body` at, with `files` beside it.
    fn typeset_width(label: &str, body: &str, files: &BTreeMap<String, String>) -> String {
        let fixture = crate::project::test_support::Fixture::empty(label);
        for (path, text) in files {
            fixture.write(path, text);
        }
        fixture.write(
            "main.tex",
            format!("\\documentclass{{article}}\n\\begin{{document}}\n\\setbox0\\hbox{{{body}}}\\typeout{{WIDTH=\\the\\wd0}}\n\\end{{document}}\n"),
        );
        let output = crate::commands::command("pdflatex")
            .args(["-interaction=nonstopmode", "-no-shell-escape", "main.tex"])
            .current_dir(&fixture.root)
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&output.stdout);
        let width = log.lines().find_map(|line| line.strip_prefix("WIDTH="));
        width.unwrap_or_else(|| panic!("{log}")).to_string()
    }

    /// Where TeX is installed: merged and unmerged typeset alike.
    #[test]
    fn merged_inputs_typeset_as_the_unmerged_ones_do() {
        if !crate::commands::available("pdflatex") {
            return;
        }
        let body = "We use \\input{tool}\nto do X";
        for (index, tool) in ENDINGS.into_iter().enumerate() {
            let files = BTreeMap::from([("tool.tex".to_string(), stripped(tool))]);
            let mut sources = files.clone();
            sources.insert("body.tex".to_string(), body.to_string());
            let (merged, inlined) = merge_inputs("body.tex", &sources);
            assert!(!inlined.is_empty(), "{tool}");
            assert_eq!(
                typeset_width(&format!("arxiv-merge-width-{index}"), body, &files),
                typeset_width(
                    &format!("arxiv-merge-width-{index}-merged"),
                    &merged,
                    &BTreeMap::new()
                ),
                "{tool}"
            );
        }
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
        assert_eq!(
            text,
            "\\includeonly{a}\n% \\input{a}\n\\input{missing}\n\\input{loop}\n\\space\n\\include{a}\n"
        );
        assert_eq!(merged.into_iter().collect::<Vec<_>>(), ["loop.tex"]);
    }
}
