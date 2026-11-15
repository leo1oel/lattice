//! The parts of LaTeX source a language edit must leave byte for byte, the
//! Tauri app's `src/editor/latex/latex-protected.ts` ported line for line:
//! math, citation/reference/label commands with their keys, `%` comments,
//! command names with their braces and options, environment boundaries,
//! verbatim code, and paragraph breaks. Everything outside a span is prose an
//! editor may change, including the text inside known prose arguments such as
//! `\emph{…}` and `\caption{…}`; the arguments of a macro this module does not
//! know are protected whole, because nothing says they are prose.
//!
//! The scanner is stateless between spans: starting it at any position that
//! no span covers reads the rest of the source the way a scan from the start
//! would. [`crate::proofread::context`] relies on that to check a selection
//! on its own.
//!
//! Offsets are bytes of the source. Every character the scanner acts on is
//! ASCII, so it walks bytes: a UTF-8 continuation byte never equals one of
//! them, and a step that lands inside a multi-byte character only reads on
//! to its end. Where the TypeScript steps over "one character" to end a span
//! (an escape such as `\é`, a `\verb` delimiter), this steps over the whole
//! character, so every span starts and ends on a character boundary.

use std::sync::LazyLock;

use regex::Regex;

/// What a protected span is, which the proofread card names when it holds an
/// edit back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProtectedKind {
    Math,
    Reference,
    Comment,
    Command,
    Environment,
    Verbatim,
    Paragraph,
}

/// One protected span, `[from, to)` in bytes of the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectedSpan {
    pub from: usize,
    pub to: usize,
    pub kind: ProtectedKind,
}

/// Whether `name` is in `list` bare or starred.
fn starred_in(list: &[&str], name: &str) -> bool {
    let bare = name.strip_suffix('*').unwrap_or(name);
    list.contains(&bare)
}

const MATH_ENVIRONMENTS: &[&str] = &[
    "align",
    "alignat",
    "displaymath",
    "eqnarray",
    "equation",
    "flalign",
    "gather",
    "math",
    "multline",
];

const VERBATIM_ENVIRONMENTS: &[&str] = &[
    "comment",
    "listing",
    "lstlisting",
    "minted",
    "verbatim",
    "Verbatim",
];

/// Every argument of these is a key, label, URL or path: the whole command is
/// protected.
const REFERENCE_COMMANDS: &[&str] = &[
    "autocite",
    "autoref",
    "bibliography",
    "bibliographystyle",
    "cite",
    "citealp",
    "citealt",
    "citeauthor",
    "citep",
    "citet",
    "citeyear",
    "cref",
    "Cref",
    "eqref",
    "footcite",
    "fullcite",
    "href",
    "hyperref",
    "include",
    "includegraphics",
    "input",
    "label",
    "nameref",
    "nocite",
    "pageref",
    "parencite",
    "ref",
    "subref",
    "textcite",
    "url",
    "vref",
];

/// Commands whose braced arguments are prose. Their name, options and braces
/// stay protected; the prose between the braces may be edited.
const PROSE_COMMANDS: &[&str] = &[
    "caption",
    "chapter",
    "emph",
    "enquote",
    "footnote",
    "marginpar",
    "mbox",
    "paragraph",
    "part",
    "section",
    "subparagraph",
    "subsection",
    "subsubsection",
    "textbf",
    "textit",
    "textmd",
    "textnormal",
    "textrm",
    "textsc",
    "textsf",
    "textsl",
    "textup",
    "thanks",
    "title",
    "underline",
];

/// How many leading braced arguments of a prose command are not prose (a
/// colour name, say); `None` for a command whose arguments are not prose.
fn prose_leading(name: &str) -> Option<usize> {
    match name {
        "colorbox" | "textcolor" => Some(1),
        _ if PROSE_COMMANDS.contains(&name) => Some(0),
        _ => None,
    }
}

/// A blank line: a line break, spaces or tabs (any whitespace but a line
/// break, as JavaScript's `[^\S\n]`), and another line break.
static BLANK_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[^\S\n]*\n").unwrap());

/// A paragraph break as one span: the blank line and the whitespace after it.
static PARAGRAPH_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A\n[^\S\n]*\n\s*").unwrap());

fn is_letter(byte: Option<&u8>) -> bool {
    byte.is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'@')
}

fn is_space(byte: Option<&u8>) -> bool {
    matches!(byte, Some(b' ' | b'\t'))
}

/// The length in bytes of the character starting at `at`, 1 past the end so
/// a span there still ends past its start (and is then clamped).
fn char_len_at(source: &str, at: usize) -> usize {
    source[at..].chars().next().map_or(1, char::len_utf8)
}

/// Offset just past the balanced `open`…`close` group starting at `start`;
/// the source end if unclosed.
fn group_end(source: &str, start: usize, open: u8, close: u8) -> usize {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = start;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' {
            index += 2;
            continue;
        }
        if byte == open {
            depth += 1;
        } else if byte == close {
            // `start` is always the opener, so the depth is at least one here.
            if depth <= 1 {
                return index + 1;
            }
            depth -= 1;
        }
        index += 1;
    }
    bytes.len()
}

/// Offset of the blank line ending the paragraph at `from`, or the source end.
fn paragraph_end(source: &str, from: usize) -> usize {
    BLANK_LINE
        .find_at(source, from)
        .map_or(source.len(), |found| found.start())
}

/// Offset just past an unescaped `closer` after `from`. TeX refuses a blank
/// line inside inline or display math, so an unclosed delimiter protects only
/// to the end of its paragraph.
fn math_end(source: &str, from: usize, closer: &str) -> usize {
    let bytes = source.as_bytes();
    let limit = paragraph_end(source, from);
    let mut index = from;
    while index < limit {
        if bytes[index..].starts_with(closer.as_bytes()) {
            return index + closer.len();
        }
        if bytes[index] == b'\\' {
            index += 1;
        }
        index += 1;
    }
    limit
}

/// Offset just past the adjacent `[…]` and `{…}` groups at `from`, at most
/// `braced` brace groups.
fn arguments_end(source: &str, from: usize, braced: usize, skip_spaces: bool) -> usize {
    let bytes = source.as_bytes();
    let mut cursor = from;
    let mut groups = 0;
    loop {
        let mut next = cursor;
        if skip_spaces {
            while is_space(bytes.get(next)) {
                next += 1;
            }
        }
        match bytes.get(next) {
            Some(b'[') => cursor = group_end(source, next, b'[', b']'),
            Some(b'{') if groups < braced => {
                cursor = group_end(source, next, b'{', b'}');
                groups += 1;
            }
            _ => return cursor,
        }
    }
}

/// Offset just past `[…]` groups (a command's options) at `from`.
fn options_end(source: &str, from: usize) -> usize {
    arguments_end(source, from, 0, false)
}

/// The spans being collected, and the offset to continue from after each.
struct Spans {
    spans: Vec<ProtectedSpan>,
    len: usize,
}

impl Spans {
    /// Record `[from, to)` when it is not empty (clamped to the source, which
    /// an unclosed `\verb` at the very end overruns); the scan continues past
    /// it, and always at least one byte on (`from` is always an ASCII byte).
    fn add(&mut self, from: usize, to: usize, kind: ProtectedKind) -> usize {
        let to = to.min(self.len);
        if to > from {
            self.spans.push(ProtectedSpan { from, to, kind });
        }
        to.max(from + 1)
    }
}

/// The protected spans of `source`, in order and never overlapping.
pub fn protected_latex_spans(source: &str) -> Vec<ProtectedSpan> {
    protected_latex_spans_until(source, source.len())
}

/// [`protected_latex_spans`], without the spans starting at or after `until`
/// (one that starts before it is still reported whole).
pub fn protected_latex_spans_until(source: &str, until: usize) -> Vec<ProtectedSpan> {
    let bytes = source.as_bytes();
    let mut spans = Spans {
        spans: Vec::new(),
        len: source.len(),
    };
    let mut index = 0;
    while index < bytes.len() && index < until {
        index = match bytes[index] {
            b'%' => {
                // An escaped \% never reaches here: the backslash branch
                // consumes it.
                let end = source[index..]
                    .find('\n')
                    .map_or(source.len(), |newline| index + newline);
                spans.add(index, end, ProtectedKind::Comment)
            }
            b'$' => {
                let marker = if bytes.get(index + 1) == Some(&b'$') {
                    "$$"
                } else {
                    "$"
                };
                let end = math_end(source, index + marker.len(), marker);
                spans.add(index, end, ProtectedKind::Math)
            }
            b'{' | b'}' | b'&' | b'#' => spans.add(index, index + 1, ProtectedKind::Command),
            b'\n' => match PARAGRAPH_BREAK.find(&source[index..]) {
                Some(found) => spans.add(index, index + found.end(), ProtectedKind::Paragraph),
                None => index + 1,
            },
            b'\\' => protect_command_at(source, index, &mut spans),
            _ => index + 1,
        };
    }
    spans.spans
}

/// Protect the command, escape or math opener at `start`; the offset to
/// continue from.
fn protect_command_at(source: &str, start: usize, spans: &mut Spans) -> usize {
    let bytes = source.as_bytes();
    let next = bytes.get(start + 1);
    if !is_letter(next) {
        match next {
            Some(b'(') => {
                return spans.add(
                    start,
                    math_end(source, start + 2, "\\)"),
                    ProtectedKind::Math,
                );
            }
            Some(b'[') => {
                return spans.add(
                    start,
                    math_end(source, start + 2, "\\]"),
                    ProtectedKind::Math,
                );
            }
            _ => {}
        }
        // `\\` takes a spacing option (`\\[2pt]`); any other escape is the
        // backslash and one character.
        let end = if start + 1 < bytes.len() {
            start + 1 + char_len_at(source, start + 1)
        } else {
            bytes.len()
        };
        let end = if next == Some(&b'\\') {
            options_end(source, end)
        } else {
            end
        };
        return spans.add(start, end, ProtectedKind::Command);
    }
    let mut cursor = start + 1;
    while is_letter(bytes.get(cursor)) {
        cursor += 1;
    }
    let name = &source[start + 1..cursor];
    if bytes.get(cursor) == Some(&b'*') {
        cursor += 1;
    }

    if name == "begin" || name == "end" {
        let environment_end = if bytes.get(cursor) == Some(&b'{') {
            group_end(source, cursor, b'{', b'}')
        } else {
            cursor
        };
        let environment = environment_name(source, cursor, environment_end);
        let math = starred_in(MATH_ENVIRONMENTS, environment);
        if name == "begin" && (math || starred_in(VERBATIM_ENVIRONMENTS, environment)) {
            let closer = format!("\\end{{{environment}}}");
            let end = source[environment_end..]
                .find(&closer)
                .map_or(source.len(), |close| environment_end + close + closer.len());
            let kind = if math {
                ProtectedKind::Math
            } else {
                ProtectedKind::Verbatim
            };
            return spans.add(start, end, kind);
        }
        // `\begin{tabular}{ll}`, `\begin{figure}[t]`: the arguments configure
        // the environment.
        let end = if name == "begin" {
            arguments_end(source, environment_end, usize::MAX, false)
        } else {
            environment_end
        };
        return spans.add(start, end, ProtectedKind::Environment);
    }
    if name == "verb" {
        let end = match source[cursor..].chars().next() {
            Some(delimiter) => {
                let after = cursor + delimiter.len_utf8();
                let close = source[after..].find(delimiter).map(|close| after + close);
                let line_end = source[cursor..].find('\n').map(|newline| cursor + newline);
                match close {
                    Some(close) if line_end.is_none_or(|line_end| close <= line_end) => {
                        close + delimiter.len_utf8()
                    }
                    _ => after,
                }
            }
            None => cursor + 1,
        };
        return spans.add(start, end, ProtectedKind::Verbatim);
    }
    if REFERENCE_COMMANDS.contains(&name) {
        let end = arguments_end(source, cursor, usize::MAX, true);
        return spans.add(start, end, ProtectedKind::Reference);
    }
    if let Some(leading) = prose_leading(name) {
        // The prose argument's braces are protected one by one by the main
        // scan.
        return spans.add(
            start,
            arguments_end(source, cursor, leading, false),
            ProtectedKind::Command,
        );
    }
    spans.add(
        start,
        arguments_end(source, cursor, usize::MAX, false),
        ProtectedKind::Command,
    )
}

/// The name between `\begin`'s braces: what lies between the `{` at `cursor`
/// and the byte before `end`, as the TypeScript's `slice(cursor + 1, end - 1)`
/// reads it. Unclosed, that drops the source's last character; with no brace
/// at all it is empty.
fn environment_name(source: &str, cursor: usize, end: usize) -> &str {
    let from = cursor + 1;
    if end <= from {
        return "";
    }
    let mut to = end - 1;
    while !source.is_char_boundary(to) {
        to -= 1;
    }
    source.get(from..to.max(from)).unwrap_or("")
}

/// One protected span as it compares across edits: its kind and text, where
/// a paragraph break is any blank-line run (its text is left empty).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SignatureEntry<'a> {
    pub kind: ProtectedKind,
    pub text: &'a str,
}

/// The protected spans of `source` as they compare across an edit.
pub fn protected_latex_signature(source: &str) -> Vec<SignatureEntry<'_>> {
    protected_latex_spans(source)
        .into_iter()
        .map(|ProtectedSpan { from, to, kind }| SignatureEntry {
            kind,
            text: if kind == ProtectedKind::Paragraph {
                ""
            } else {
                &source[from..to]
            },
        })
        .collect()
}

/// The kind of protected LaTeX that differs between two signatures, or `None`
/// when every protected span survived unchanged and in order.
pub fn protected_difference(
    before: &[SignatureEntry<'_>],
    after: &[SignatureEntry<'_>],
) -> Option<ProtectedKind> {
    let length = before.len().max(after.len());
    (0..length).find_map(|index| {
        let left = before.get(index);
        let right = after.get(index);
        if left == right {
            return None;
        }
        // A span the edit added names the change better than the one it
        // shifted.
        let named = if after.len() > before.len() {
            right.or(left)
        } else {
            left.or(right)
        };
        named.map(|entry| entry.kind)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ProtectedKind, protected_difference, protected_latex_signature, protected_latex_spans,
    };
    use ProtectedKind::*;

    fn spans(source: &str) -> Vec<(ProtectedKind, &str)> {
        protected_latex_spans(source)
            .into_iter()
            .map(|span| (span.kind, &source[span.from..span.to]))
            .collect()
    }

    fn changed(before: &str, after: &str) -> Option<ProtectedKind> {
        protected_difference(
            &protected_latex_signature(before),
            &protected_latex_signature(after),
        )
    }

    #[test]
    fn protects_math_in_every_delimiter_form() {
        assert_eq!(
            spans("Let $x$ and $$y$$ with \\(a\\) and \\[b\\]."),
            [
                (Math, "$x$"),
                (Math, "$$y$$"),
                (Math, "\\(a\\)"),
                (Math, "\\[b\\]")
            ]
        );
        assert_eq!(
            spans("a \\begin{align*}x &= 1\n\ny\\end{align*} b"),
            [(Math, "\\begin{align*}x &= 1\n\ny\\end{align*}")]
        );
    }

    #[test]
    fn an_escaped_dollar_or_percent_is_prose_and_a_bare_percent_a_comment() {
        assert_eq!(
            spans("costs \\$5, 50\\% off % note\nnext"),
            [(Command, "\\$"), (Command, "\\%"), (Comment, "% note")]
        );
        assert_eq!(spans("$a\\$b$ c"), [(Math, "$a\\$b$")]);
    }

    #[test]
    fn protects_citation_reference_and_label_commands_with_every_argument() {
        assert_eq!(
            spans("see \\cite[p.~4]{smith, jones} and \\ref {fig:a}\\label{sec:x}."),
            [
                (Reference, "\\cite[p.~4]{smith, jones}"),
                (Reference, "\\ref {fig:a}"),
                (Reference, "\\label{sec:x}"),
            ]
        );
    }

    #[test]
    fn leaves_prose_arguments_of_known_text_commands_editable() {
        assert_eq!(
            spans("\\caption[Short]{A exmaple \\emph{figure}}"),
            [
                (Command, "\\caption[Short]"),
                (Command, "{"),
                (Command, "\\emph"),
                (Command, "{"),
                (Command, "}"),
                (Command, "}"),
            ]
        );
        assert_eq!(
            spans("\\textcolor{red}{hi}"),
            [
                (Command, "\\textcolor{red}"),
                (Command, "{"),
                (Command, "}")
            ]
        );
    }

    #[test]
    fn protects_an_unknown_macro_s_arguments_whole() {
        assert_eq!(
            spans("\\todo[inline]{fix teh text} \\LaTeX{} is"),
            [
                (Command, "\\todo[inline]{fix teh text}"),
                (Command, "\\LaTeX{}")
            ]
        );
    }

    #[test]
    fn protects_environment_boundaries_verbatim_code_and_paragraph_breaks() {
        assert_eq!(
            spans("\\begin{figure}[t]\nText.\n\n  More \\verb|$x| here.\n\\end{figure}"),
            [
                (Environment, "\\begin{figure}[t]"),
                (Paragraph, "\n\n  "),
                (Verbatim, "\\verb|$x|"),
                (Environment, "\\end{figure}"),
            ]
        );
        assert_eq!(
            spans("\\begin{verbatim}\n% $x\n\\end{verbatim}"),
            [(Verbatim, "\\begin{verbatim}\n% $x\n\\end{verbatim}")]
        );
    }

    #[test]
    fn ends_an_unclosed_inline_math_at_its_paragraph() {
        assert_eq!(
            spans("an $x open\n\nnext $y$"),
            [(Math, "$x open"), (Paragraph, "\n\n"), (Math, "$y$")]
        );
    }

    /// Not in the TypeScript tests: an escape, a `\verb` delimiter and a
    /// group around multi-byte characters end on character boundaries
    /// (slicing would panic otherwise).
    #[test]
    fn spans_end_on_character_boundaries() {
        assert_eq!(
            spans("「\\é」 \\verb“x“ \\verb” \\todo{引用\\」} $数$"),
            [
                (Command, "\\é"),
                (Verbatim, "\\verb“x“"),
                (Verbatim, "\\verb”"),
                (Command, "\\todo{引用\\」}"),
                (Math, "$数$"),
            ]
        );
        assert_eq!(spans("\\begin{对"), [(Environment, "\\begin{对")]);
    }

    #[test]
    fn accepts_prose_edits_that_keep_every_protected_span() {
        assert_eq!(
            changed("We beleive $x$ \\cite{a}.", "We believe $x$ \\cite{a}."),
            None
        );
        assert_eq!(
            changed("\\caption{A exmaple}", "\\caption{An example}"),
            None
        );
        assert_eq!(changed("one\n\ntwo", "one\n  \ntwo"), None);
    }

    #[test]
    fn names_the_kind_of_protected_latex_an_edit_changed() {
        assert_eq!(changed("We beleive $x$.", "We believe $y$."), Some(Math));
        assert_eq!(changed("see \\cite{a}.", "see \\cite{b}."), Some(Reference));
        assert_eq!(
            changed("text % todo\nmore", "text % to do\nmore"),
            Some(Comment)
        );
        assert_eq!(changed("one\n\ntwo", "one two"), Some(Paragraph));
        assert_eq!(changed("50\\% of", "50% of"), Some(Command));
        assert_eq!(changed("price", "price $5"), Some(Math));
        assert_eq!(changed("\\LaTeX is", "\\LaTeXis"), Some(Command));
        assert_eq!(changed("\\emph{word}", "\\emph{word"), Some(Command));
    }
}
