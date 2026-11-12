//! A failed build in plain words, ported line by line from the Tauri app's
//! `src/build/compile-explain.ts`. TeX's own message is read against a
//! small, fixed table of the mistakes papers make most, offline and with no
//! model: each entry gives a headline, a sentence on what went wrong and how
//! to fix it, and, where the log names one, the token TeX stopped at. For an
//! unknown command the fix can be concrete: the closest command this paper
//! already uses (or LaTeX defines), offered only when it is close enough to
//! be a typo. Messages the table does not know stay TeX's own, unchanged.

use std::{collections::HashMap, sync::LazyLock};

use lattice_core::models::Diagnostic;
use regex::{Captures, Regex};

use super::diagnostics::{Severity, severity, token_offset};

mod vocabulary;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExcerptLine {
    pub number: usize,
    pub text: String,
    pub failing: bool,
    /// Where the token stands on the failing line, in bytes.
    pub token: Option<(usize, usize)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Explained {
    pub headline: String,
    pub explanation: String,
    /// What to mark on the failing line, as written in the source.
    pub token: Option<String>,
    /// A replacement for `token` sure enough to offer as one click.
    pub suggestion: Option<String>,
    /// The failing line and one either side; empty without the source or a line.
    pub excerpt: Vec<ExcerptLine>,
}

/// What `explain` reads besides the diagnostic.
#[derive(Clone, Copy, Debug, Default)]
pub struct ExplainOptions<'a> {
    pub log: &'a str,
    /// Project-relative path of the compiled document; the log names files
    /// from its folder.
    pub root_document: &'a str,
    pub source: Option<&'a str>,
    /// Whether the build also failed with an error: a warning after one is
    /// often its echo.
    pub after_error: bool,
    /// How many identical diagnostics come after this one in the list, so
    /// its context is read from the log's end, past any earlier pass.
    pub same_after: usize,
    /// The build's notice that arydshln loaded after colortbl broke its
    /// tables (`arydshln-after-colortbl`).
    pub table_ends_clash: bool,
}

/// What an entry reads besides the message.
struct Context<'a> {
    /// The control sequence TeX stopped at, read from the context it printed
    /// under this error.
    stopped_at: Option<String>,
    /// Whether `stopped_at` is written on the failing source line: a macro
    /// can reach it from elsewhere.
    on_line: bool,
    source: &'a str,
    after_error: bool,
}

struct Explanation {
    headline: String,
    explanation: String,
    token: Option<String>,
    suggestion: Option<String>,
}

impl Explanation {
    fn new(headline: String, explanation: String) -> Self {
        Self {
            headline,
            explanation,
            token: None,
            suggestion: None,
        }
    }

    fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }
}

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("valid pattern")
}

/// The control sequence a context line ends with: the last one TeX read on it.
fn last_command(context: &str) -> Option<String> {
    static LAST: LazyLock<Regex> = LazyLock::new(|| pattern(r"(\\[A-Za-z@]+)\s*$"));
    LAST.captures(context).map(|found| found[1].to_string())
}

/// Edits between two command names, a swap of neighbours counting as one:
/// the typo \cietp is one edit from \citep.
fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let mut rows = vec![vec![0usize; right.len() + 1]; left.len() + 1];
    for (i, row) in rows.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=left.len() {
        for j in 1..=right.len() {
            let cost = usize::from(left[i - 1] != right[j - 1]);
            let mut best = (rows[i - 1][j] + 1)
                .min(rows[i][j - 1] + 1)
                .min(rows[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && left[i - 1] == right[j - 2] && left[i - 2] == right[j - 1] {
                best = best.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = best;
        }
    }
    rows[left.len()][right.len()]
}

/// The furthest a suggestion may be from what was typed.
const MAX_EDITS: usize = 2;

/// The command `token` most likely meant: the closest within two edits, a
/// command this paper already uses before one only LaTeX knows, and the
/// more it is used the better. None when nothing is close, when two
/// candidates tie (the guess would be a coin toss), or when the token is so
/// short that two edits reach almost anything.
fn closest_command(token: &str, source: &str) -> Option<(String, usize)> {
    static COMMAND: LazyLock<Regex> = LazyLock::new(|| pattern(r"\\[A-Za-z@]+"));
    let mut uses: HashMap<&str, usize> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    for found in COMMAND.find_iter(source) {
        let count = uses.entry(found.as_str()).or_insert(0);
        if *count == 0 {
            order.push(found.as_str());
        }
        *count += 1;
    }
    uses.remove(token);
    let budget = MAX_EDITS.min(token.chars().count().saturating_sub(3));
    if budget < 1 {
        return None;
    }
    let mut best: Option<(&str, f64)> = None;
    let mut tied = false;
    let mut seen = std::collections::HashSet::new();
    let candidates = order
        .into_iter()
        .filter(|name| *name != token)
        .chain(vocabulary::COMMANDS.iter().copied());
    for name in candidates {
        if !seen.insert(name) {
            continue;
        }
        let edits = edit_distance(token, name);
        if edits > budget {
            continue;
        }
        // Used in this paper beats LaTeX's vocabulary at the same distance,
        // and use breaks a tie between two of the paper's own; never more
        // than one edit's worth.
        let used = uses.get(name).map_or(-10.0, |count| *count as f64);
        let rank = edits as f64 - 0.9f64.min(0.5 + used / 40.0);
        match best {
            Some((_, best_rank)) if rank == best_rank => tied = true,
            Some((_, best_rank)) if rank > best_rank => {}
            _ => {
                tied = false;
                best = Some((name, rank));
            }
        }
    }
    let (name, _) = best.filter(|_| !tied)?;
    Some((name.to_string(), uses.get(name).copied().unwrap_or(0)))
}

/// Han, kana, Hangul and CJK punctuation: the text latex/cjk_text.rs counts as CJK.
fn is_cjk_character(text: &str) -> bool {
    let mut chars = text.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        return false;
    };
    matches!(c as u32,
        0x1100..=0x11FF | 0x3000..=0x30FF | 0x3130..=0x318F | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF
        | 0x20000..=0x3134F)
}

const BEGIN_DOCUMENT: &str = "\\begin{document}";

type Explain = fn(&Captures, &Context) -> Option<Explanation>;

struct Entry {
    pattern: Regex,
    explain: Explain,
}

/// The table. Patterns match TeX's message as the build reports it, with or
/// without the `LaTeX Error: ` prefix.
static ENTRIES: LazyLock<Vec<Entry>> = LazyLock::new(|| {
    let entry = |source: &str, explain: Explain| Entry {
        pattern: pattern(source),
        explain,
    };
    vec![
        entry(r"^Undefined control sequence", |_, context| {
            let token = context.stopped_at.clone()?;
            let close = context
                .on_line
                .then(|| closest_command(&token, context.source))
                .flatten();
            let headline = format!("Unknown command {token}");
            let Some((name, uses)) = close else {
                return Some(
                    Explanation::new(
                        headline,
                        format!("LaTeX doesn’t know {token}. Check its spelling, or load the package that defines it."),
                    )
                    .token(token),
                );
            };
            let explanation = if uses > 1 {
                format!(
                    "LaTeX doesn’t know {token}. It looks like a typo for {name}, which this paper uses {uses} times."
                )
            } else {
                format!("LaTeX doesn’t know {token}. It looks like a typo for {name}.")
            };
            let mut explained = Explanation::new(headline, explanation).token(token);
            explained.suggestion = Some(name);
            Some(explained)
        }),
        entry(r"Environment (\S+) undefined", |found, _| {
            let name = &found[1];
            Some(
                Explanation::new(
                    format!("Unknown environment {name}"),
                    format!("LaTeX doesn’t know the environment {name}. Check its spelling in \\begin and \\end, or load the package that defines it."),
                )
                .token(name),
            )
        }),
        entry(
            r"\\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}",
            |found, _| {
                let (opened, line, closed) = (&found[1], &found[2], &found[3]);
                let end = format!("\\end{{{closed}}}");
                Some(
                    Explanation::new(
                        format!("\\begin{{{opened}}} is closed by {end}"),
                        format!("Environments close in the reverse order they open. The {opened} environment from line {line} needs its \\end{{{opened}}} before this one."),
                    )
                    .token(end),
                )
            },
        ),
        entry(r"^Missing \$ inserted", |_, _| {
            Some(Explanation::new(
                "Math outside math mode".into(),
                "This line uses a math-only command or character, such as _ or ^, outside $…$. Put the math in $…$, or write \\_ for a literal underscore.".into(),
            ))
        }),
        entry(r"^Extra \}, or forgotten \$", |_, _| {
            Some(Explanation::new(
                "A } with no { before it".into(),
                "This line closes a group that was never opened, or leaves math mode with a } before its $. Remove the extra }, or add the { it closes.".into(),
            ))
        }),
        entry(
            r"^(?:Missing \} inserted|File ended while scanning use of (\\\S+?)\.?$)",
            |found, _| {
                let headline = "A { is never closed".to_string();
                Some(match found.get(1) {
                    Some(command) => {
                        let command = command.as_str();
                        Explanation::new(
                            headline,
                            format!("The argument of {command} runs to the end of the file. Add the }} it is missing."),
                        )
                        .token(command)
                    }
                    None => Explanation::new(
                        headline,
                        "A group opened before this point is still open. Add the } it is missing."
                            .into(),
                    ),
                })
            },
        ),
        entry(
            r"^Paragraph ended before (\\\S+?) was complete",
            |found, _| {
                let command = &found[1];
                Some(
                Explanation::new(
                    format!("{command} runs past a blank line"),
                    format!("The argument of {command} contains a blank line, which usually means a missing }}. Close the argument before the paragraph ends."),
                )
                .token(command),
            )
            },
        ),
        entry(r"^Extra alignment tab has been changed", |_, _| {
            Some(
                Explanation::new(
                    "Too many & in a table row".into(),
                    "This row has more cells than the table has columns. Remove an &, or add a column to the table’s column spec.".into(),
                )
                .token("&"),
            )
        }),
        entry(r"^Misplaced alignment tab character &", |_, _| {
            Some(
                Explanation::new(
                    "An & outside a table".into(),
                    "& separates the cells of a table or an aligned equation. To print an ampersand, write \\&.".into(),
                )
                .token("&"),
            )
        }),
        entry(r"^Double (sub|super)script", |found, _| {
            let sub = &found[1] == "sub";
            let (grouped, flat) = if sub {
                ("x_{i_j}", "x_i_j")
            } else {
                ("x^{a^b}", "x^a^b")
            };
            Some(Explanation::new(
                if sub {
                    "Two subscripts in a row"
                } else {
                    "Two superscripts in a row"
                }
                .into(),
                format!("Group a nested script in braces: write {grouped} rather than {flat}."),
            ))
        }),
        entry(r"File [`']([^`']+)' not found", |found, _| {
            // A missing package or class is TeX Live's to install, and
            // Lattice's own advice already says so.
            let file = &found[1];
            let package = [".sty", ".cls", ".bst", ".bbx", ".cbx"]
                .iter()
                .any(|extension| file.ends_with(extension));
            (!package).then(|| {
                Explanation::new(
                    format!("File not found: {file}"),
                    format!("Nothing in the project is called {file}. Check the path and its letter case; paths are relative to the root document."),
                )
                .token(file)
            })
        }),
        // pdfLaTeX stops at each character it has no font for; for CJK text
        // no inputenc option helps, only ctex under a Unicode engine.
        entry(
            r"^Unicode character (\S+) \(U\+[0-9A-Fa-f]+\)",
            |found, _| {
                let character = &found[1];
                is_cjk_character(character).then(|| {
                Explanation::new(
                    format!("pdfLaTeX can’t typeset {character}"),
                    "pdfLaTeX has no fonts for Chinese, Japanese or Korean text. Add \\usepackage{ctex} to the preamble and switch the project to XeLaTeX.".into(),
                )
                .token(character)
            })
            },
        ),
        entry(r"Missing \\begin\{document\}", |_, _| {
            Some(Explanation::new(
                format!("Text before {BEGIN_DOCUMENT}"),
                format!(
                    "Only definitions and \\usepackage belong in the preamble. Move this text after {BEGIN_DOCUMENT}, or check for a stray character above it."
                ),
            ))
        }),
        entry(r"Can be used only in preamble", |_, context| {
            let explained = Explanation::new(
                "A preamble command inside the document".into(),
                format!(
                    "Commands such as \\usepackage only work before {BEGIN_DOCUMENT}. Move this line into the preamble."
                ),
            );
            Some(match &context.stopped_at {
                Some(token) => explained.token(token.clone()),
                None => explained,
            })
        }),
        entry(r"Option clash for package (\S+?)\.?$", |found, _| {
            let name = &found[1];
            Some(Explanation::new(
                format!("{name} is loaded twice with different options"),
                format!(
                    "Another package or the template already loads {name}. Pass your options with \\PassOptionsToPackage before \\documentclass, or remove the second \\usepackage."
                ),
            ))
        }),
        entry(r"^Illegal unit of measure", |_, _| {
            Some(Explanation::new(
                "A length without a unit".into(),
                "Lengths need a unit: write 0.5\\linewidth, 2em or 10pt rather than a bare number."
                    .into(),
            ))
        }),
        entry(
            r"^Citation [`']([^']+)' (?:on page \S+ )?undefined",
            |found, context| {
                let key = &found[1];
                let explanation = if context.after_error {
                    format!(
                        "No bibliography entry has the key {key} yet. A build that stops at an error never reads the bibliography, so this may clear once the error above is fixed."
                    )
                } else {
                    format!(
                        "No bibliography entry has the key {key}. Check the key, or add the entry to the .bib file."
                    )
                };
                Some(Explanation::new(format!("No entry for {key}"), explanation).token(key))
            },
        ),
        entry(
            r"^Reference [`']([^']+)' (?:on page \S+ )?undefined",
            |found, _| {
                let label = &found[1];
                Some(
                    Explanation::new(
                        format!("No label {label}"),
                        format!("Nothing in the paper has \\label{{{label}}}. Check the spelling, or add the label where the reference should point."),
                    )
                    .token(label),
                )
            },
        ),
        entry(r"^Label [`']([^']+)' multiply defined", |found, _| {
            let label = &found[1];
            Some(
                Explanation::new(
                    format!("The label {label} is used twice"),
                    format!("Two places set \\label{{{label}}}, so references to it may point at the wrong one. Rename one of them."),
                )
                .token(label),
            )
        }),
        entry(r"^Overfull \\hbox \(([\d.]+)pt too wide\)", |found, _| {
            Some(Explanation::new(
                format!("A line runs {} pt into the margin", &found[1]),
                "LaTeX couldn’t break this line inside the text width. Rephrasing it, or allowing a hyphen in a long word, usually fixes it.".into(),
            ))
        }),
        entry(r"^Float too large for page by ([\d.]+)pt", |found, _| {
            Some(Explanation::new(
                format!("A figure or table is {} pt taller than the page", &found[1]),
                "Scale it down, for example with width=\\linewidth or a smaller height, so it fits on one page.".into(),
            ))
        }),
    ]
});

/// What LaTeX 2026-11 reports at the end of every table when arydshln is
/// loaded after colortbl, the table itself being fine (latex/package_order.rs,
/// whose notice says the build hit it). Read as TeX's usual words, these sent
/// the writer looking for a brace or a $ that is not missing.
static TABLE_END_ERROR: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"^(?:Extra \}, or forgotten \$|Missing \$ inserted|Missing \} inserted)")
});
static TABLE_END: LazyLock<Regex> = LazyLock::new(|| pattern(r"\\end\{tabular[^}]*\}"));

fn table_clash(token: String) -> Explanation {
    Explanation::new(
        "arydshln and colortbl clash at this table’s end".into(),
        "LaTeX 2026-11 ends every table with this error when arydshln is loaded after colortbl; the table is fine. Load arydshln before colortbl in the preamble, or remove \\usepackage{arydshln} if no table draws dashed rules.".into(),
    )
    .token(token)
}

/// `path`, as TeX named it from the root document's `folder`, from the
/// project root: the diagnostic's file was rebased the same way
/// (diagnostic_paths.rs), so `sec/a.tex` in the log is `cvpr/sec/a.tex` for
/// `cvpr/main.tex`.
fn from_folder(folder: &[&str], path: &str) -> Option<String> {
    if path.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = folder.to_vec();
    for part in path.split('/') {
        match part {
            ".." => {
                parts.pop()?;
            }
            "" | "." => {}
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// The control sequence TeX stopped at for this diagnostic, read from the
/// context printed under its own `file:line: message` line (`same_after`
/// counts identical diagnostics after it, so the match is taken from the
/// log's end, past any earlier pass). The top context line ends at it:
/// `l.<n> … \cietp` when the source itself used it, `\eg ->e.g.\xspace` when
/// a macro did. Above the `l.<n>` line, LaTeX's help text ends with no
/// control sequence.
fn stopped_at(
    log: &str,
    diagnostic: &Diagnostic,
    same_after: usize,
    root_document: &str,
) -> Option<String> {
    static LOCATED: LazyLock<Regex> = LazyLock::new(|| pattern(r"^([^:]+):(\d+):\s*(.*)$"));
    static CONTEXT_LINE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^l\.\d+ "));
    let (Some(file), Some(line)) = (diagnostic.file.as_deref(), diagnostic.line) else {
        return None;
    };
    let mut folder: Vec<&str> = root_document.split('/').collect();
    folder.pop();
    let lines: Vec<&str> = log
        .split('\n')
        .map(|text| text.strip_suffix('\r').unwrap_or(text))
        .collect();
    let message = diagnostic.message.trim();
    let errors: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, text)| {
            let located = LOCATED.captures(text)?;
            if located[2].parse::<u32>().ok()? != line || located[3].trim() != message {
                return None;
            }
            let path = located[1].replace('\\', "/");
            let path = path.trim_start_matches('"').trim_end_matches('"');
            (path == file
                || path.ends_with(&format!("/{file}"))
                || from_folder(&folder, path).as_deref() == Some(file))
            .then_some(index)
        })
        .collect();
    let at = *errors.get(errors.len().checked_sub(1 + same_after)?)?;
    for text in &lines[at + 1..] {
        if CONTEXT_LINE.is_match(text) {
            return last_command(text);
        }
        if let Some(command) = last_command(text) {
            return Some(command);
        }
    }
    None
}

/// The failing line and one either side, with `token` located on the failing one.
fn excerpt_around(source: &str, line: Option<u32>, token: Option<&str>) -> Vec<ExcerptLine> {
    let Some(line) = line.and_then(|line| usize::try_from(line).ok()) else {
        return Vec::new();
    };
    if source.is_empty() || line == 0 {
        return Vec::new();
    }
    let lines: Vec<&str> = source.split('\n').collect();
    if line > lines.len() {
        return Vec::new();
    }
    (line.saturating_sub(1).max(1)..=(line + 1).min(lines.len()))
        .map(|number| {
            let text = lines[number - 1];
            let failing = number == line;
            let token = token
                .filter(|_| failing)
                .and_then(|token| token_offset(text, token).map(|at| (at, at + token.len())));
            ExcerptLine {
                number,
                text: text.to_string(),
                failing,
                token,
            }
        })
        .collect()
}

/// Plain words for one diagnostic: `None` for one the table does not know,
/// or for Lattice's own advice (which is already in plain words).
pub fn explain(diagnostic: &Diagnostic, options: ExplainOptions) -> Option<Explained> {
    static PREFIX: LazyLock<Regex> =
        LazyLock::new(|| pattern(r"^(?:LaTeX|Package \S+) (?:Error|Warning):\s*"));
    if diagnostic.code.is_some() {
        return None;
    }
    let message = PREFIX.replace(diagnostic.message.trim(), "").into_owned();
    // Only an error stops TeX on the line it names; a warning's line is where it noticed.
    let error_line = (severity(&diagnostic.level) == Severity::Error)
        .then_some(diagnostic.line)
        .flatten();
    let failing_line = match (options.source, error_line) {
        (Some(source), Some(line)) if line > 0 && !source.is_empty() => {
            source.split('\n').nth(line as usize - 1)
        }
        _ => None,
    };
    let source = options.source.unwrap_or("");
    if options.table_ends_clash
        && TABLE_END_ERROR.is_match(&message)
        && let Some(end) = failing_line.and_then(|line| TABLE_END.find(line))
    {
        let explained = table_clash(end.as_str().to_string());
        return Some(finish(
            explained,
            excerpt_around(source, error_line, Some(end.as_str())),
        ));
    }
    for entry in ENTRIES.iter() {
        let Some(found) = entry.pattern.captures(&message) else {
            continue;
        };
        let token = stopped_at(
            options.log,
            diagnostic,
            options.same_after,
            options.root_document,
        );
        let on_line = match (&token, failing_line) {
            (Some(token), Some(line)) => token_offset(line, token).is_some(),
            _ => false,
        };
        let context = Context {
            stopped_at: token.clone(),
            on_line,
            source,
            after_error: options.after_error,
        };
        let explained = (entry.explain)(&found, &context)?;
        // A token TeX reached through a macro is not on the line: quoting the
        // line would point at the wrong text.
        let misplaced = explained.token.is_some() && explained.token == token && !on_line;
        let excerpt = if options.source.is_some() && !misplaced {
            excerpt_around(source, error_line, explained.token.as_deref())
        } else {
            Vec::new()
        };
        return Some(finish(explained, excerpt));
    }
    None
}

fn finish(explained: Explanation, excerpt: Vec<ExcerptLine>) -> Explained {
    Explained {
        headline: explained.headline,
        explanation: explained.explanation,
        token: explained.token,
        suggestion: explained.suggestion,
        excerpt,
    }
}

#[cfg(test)]
#[path = "explain_tests.rs"]
mod tests;
