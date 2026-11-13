//! The prose a spell and grammar check reads out of a LaTeX source:
//! `maskLatexForHarper` (`src/editor/harper-spellcheck.ts`), ported unit for
//! unit.
//!
//! LaTeX syntax (commands, the arguments that are identifiers rather than
//! prose, math, comments, verbatim environments, the preamble but its title)
//! and Markdown tables are replaced with spaces, so Harper reads ordinary
//! prose while every offset still matches the source. A masked span that
//! opens a sentence keeps a neutral subject (`X`) where it starts, so
//! `$g$ shares` or `\Cref{fig:loss} shows` is not asked for a capital. A TeX
//! accent (`Fr\'echet`) is filled with the letter it prints, so the word stays
//! one word; its span stays in the syntax mask, and a finding touching the
//! mask is dropped.
//!
//! Offsets are UTF-16 code units, as in the Tauri app (JavaScript strings
//! index by them) and as `lattice_core::harper::lint` answers.

use unicode_normalization::UnicodeNormalization as _;

/// The source with its syntax blanked, and which units were syntax.
#[derive(Clone, Debug, PartialEq)]
pub struct Masked {
    /// The prose, as long as the source in UTF-16 units.
    pub prose: String,
    /// Per UTF-16 unit: whether it was syntax.
    pub syntax: Vec<bool>,
}

/// Every argument of these commands is an identifier, path, or key rather
/// than prose.
const OPAQUE_COMMANDS: &[&str] = &[
    "addbibresource",
    "author",
    "autocite",
    "autoref",
    "Autoref",
    "begin",
    "bibitem",
    "bibliography",
    "bibliographystyle",
    "cite",
    "citealp",
    "citealt",
    "citeauthor",
    "citep",
    "Citep",
    "citet",
    "Citet",
    "citeyear",
    "cpageref",
    "Cpageref",
    "cref",
    "Cref",
    "documentclass",
    "end",
    "eqref",
    "footcite",
    "graphicspath",
    "include",
    "includegraphics",
    "input",
    "label",
    "nameref",
    "newcommand",
    "newenvironment",
    "nocite",
    "pageref",
    "parencite",
    "path",
    "providecommand",
    "ref",
    "renewcommand",
    "renewenvironment",
    "textcite",
    "url",
    "usepackage",
];

/// Opaque commands that print a citation or a reference in the paper: each
/// keeps a neutral subject in the prose, as math does.
const REFERENCE_COMMANDS: &[&str] = &[
    "autocite",
    "autoref",
    "Autoref",
    "cite",
    "citealp",
    "citealt",
    "citeauthor",
    "citep",
    "Citep",
    "citet",
    "Citet",
    "citeyear",
    "cpageref",
    "Cpageref",
    "cref",
    "Cref",
    "eqref",
    "footcite",
    "nameref",
    "pageref",
    "parencite",
    "ref",
    "textcite",
];

/// How many leading arguments of these commands are colours or URLs.
const NON_PROSE_ARGUMENTS: &[(&str, usize)] = &[
    ("color", 1),
    ("colorbox", 1),
    ("fcolorbox", 2),
    ("href", 1),
    ("pagecolor", 1),
    ("textcolor", 1),
];

const NON_PROSE_ENVIRONMENTS: &[&str] = &[
    "align",
    "align*",
    "displaymath",
    "equation",
    "equation*",
    "gather",
    "gather*",
    "lstlisting",
    "math",
    "minted",
    "multline",
    "multline*",
    "tikzpicture",
    "verbatim",
    "verbatim*",
];

/// The combining mark each TeX accent command puts on its letter.
const ACCENT_MARKS: &[(&str, char)] = &[
    ("'", '\u{0301}'),
    ("`", '\u{0300}'),
    ("^", '\u{0302}'),
    ("\"", '\u{0308}'),
    ("~", '\u{0303}'),
    ("=", '\u{0304}'),
    (".", '\u{0307}'),
    ("u", '\u{0306}'),
    ("v", '\u{030C}'),
    ("H", '\u{030B}'),
    ("c", '\u{0327}'),
    ("d", '\u{0323}'),
    ("b", '\u{0331}'),
    ("r", '\u{030A}'),
    ("k", '\u{0328}'),
];

const fn unit(character: char) -> u16 {
    character as u16
}

const NEWLINE: u16 = unit('\n');
const RETURN: u16 = unit('\r');
const BACKSLASH: u16 = unit('\\');
const OPEN: u16 = unit('{');
const CLOSE: u16 = unit('}');

fn is_ascii_letter(unit: u16) -> bool {
    (unit as u8 as u16 == unit) && (unit as u8).is_ascii_alphabetic()
}

fn is_whitespace(unit: Option<u16>) -> bool {
    unit.and_then(|unit| char::from_u32(unit as u32))
        .is_some_and(char::is_whitespace)
}

struct Masker<'a> {
    source: &'a [u16],
    masked: Vec<u16>,
    syntax: Vec<bool>,
}

impl Masker<'_> {
    fn at(&self, index: usize) -> Option<u16> {
        self.source.get(index).copied()
    }

    fn is(&self, index: usize, character: char) -> bool {
        self.at(index) == Some(unit(character))
    }

    fn len(&self) -> usize {
        self.source.len()
    }

    fn is_escaped(&self, index: usize) -> bool {
        let mut slashes = 0;
        let mut cursor = index;
        while cursor > 0 && self.source[cursor - 1] == BACKSLASH {
            slashes += 1;
            cursor -= 1;
        }
        slashes % 2 == 1
    }

    fn is_line_break(&self, index: usize) -> bool {
        matches!(self.masked[index], NEWLINE | RETURN)
    }

    fn blank(&mut self, from: usize, to: usize) {
        for index in from..to.min(self.masked.len()) {
            if self.is_line_break(index) {
                continue;
            }
            self.masked[index] = unit(' ');
            self.syntax[index] = true;
        }
    }

    /// A neutral subject for Harper at the first character of a masked span.
    fn placeholder(&mut self, from: usize, to: usize) {
        let end = to.min(self.masked.len());
        let mut cursor = from;
        while cursor < end && self.is_line_break(cursor) {
            cursor += 1;
        }
        if cursor < end {
            self.masked[cursor] = unit('X');
        }
    }

    /// Math keeps a neutral subject, so the prose after math that opens a
    /// sentence is not itself the sentence start.
    fn mask_math(&mut self, from: usize, to: usize) {
        self.blank(from, to);
        self.placeholder(from, to);
    }

    fn skip_space(&self, mut from: usize) -> usize {
        while is_whitespace(self.at(from)) {
            from += 1;
        }
        from
    }

    fn find(&self, needle: &[u16], from: usize) -> Option<usize> {
        if needle.is_empty() || from > self.len() {
            return None;
        }
        self.source[from..]
            .windows(needle.len())
            .position(|window| window == needle)
            .map(|at| at + from)
    }

    /// Just past the first `closer` at or after `from`, or the end.
    fn end_after(&self, closer: &str, from: usize) -> usize {
        let closer: Vec<u16> = closer.encode_utf16().collect();
        self.find(&closer, from)
            .map_or(self.len(), |at| at + closer.len())
    }

    fn balanced_group_end(&self, start: usize, open: u16, close: u16) -> usize {
        if self.at(start) != Some(open) {
            return start;
        }
        let mut depth = 0i32;
        for index in start..self.len() {
            if self.is_escaped(index) {
                continue;
            }
            if self.source[index] == open {
                depth += 1;
            }
            if self.source[index] == close {
                depth -= 1;
                if depth == 0 {
                    return index + 1;
                }
            }
        }
        self.len()
    }

    fn text(&self, from: usize, to: usize) -> String {
        String::from_utf16_lossy(&self.source[from.min(to)..to])
    }

    /// `\\([A-Za-z@]+|.)` at `index` (a backslash): the command's name and
    /// how many units the match takes.
    fn command(&self, index: usize) -> Option<(String, usize)> {
        let first = self.at(index + 1)?;
        let named = |code: u16| is_ascii_letter(code) || code == unit('@');
        if named(first) {
            let mut end = index + 1;
            while self.at(end).is_some_and(named) {
                end += 1;
            }
            return Some((self.text(index + 1, end), end - index));
        }
        // `.` takes any one unit but a line terminator.
        if matches!(first, NEWLINE | RETURN | 0x2028 | 0x2029) {
            return None;
        }
        Some((self.text(index + 1, index + 2), 2))
    }

    /// An accent's letter at `at`: `e`, `\i`, `{e}` or `{\i}`, and the units
    /// it takes.
    fn accent_letter(&self, at: usize) -> Option<(char, usize)> {
        let dotless = |at: usize| {
            self.at(at) == Some(BACKSLASH)
                && (self.is(at + 1, 'i') || self.is(at + 1, 'j'))
                && !self.at(at + 2).is_some_and(is_ascii_letter)
        };
        let letter = |at: usize| -> Option<(char, usize)> {
            let first = self.at(at)?;
            if is_ascii_letter(first) {
                Some((first as u8 as char, 1))
            } else if dotless(at) {
                Some((self.source[at + 1] as u8 as char, 2))
            } else {
                None
            }
        };
        if self.at(at) == Some(OPEN) {
            let mut cursor = at + 1;
            while self.is(cursor, ' ') || self.is(cursor, '\t') {
                cursor += 1;
            }
            let (base, taken) = letter(cursor)?;
            cursor += taken;
            while self.is(cursor, ' ') || self.is(cursor, '\t') {
                cursor += 1;
            }
            return (self.at(cursor) == Some(CLOSE)).then_some((base, cursor + 1 - at));
        }
        letter(at)
    }

    /// The source span of a TeX accent and the letter it prints, as
    /// `texAccent` finds it.
    fn tex_accent(
        &self,
        start: usize,
        command: &str,
        mut argument: usize,
    ) -> Option<(usize, usize, u16)> {
        let mark = ACCENT_MARKS
            .iter()
            .find(|(name, _)| *name == command)
            .map(|(_, mark)| *mark)?;
        // TeX skips spaces after a command named by letters (`\H o`), not
        // after `\'`.
        if command.len() == 1 && command.as_bytes()[0].is_ascii_alphabetic() {
            while self.is(argument, ' ') || self.is(argument, '\t') {
                argument += 1;
            }
        }
        let (base, taken) = self.accent_letter(argument)?;
        let mut from = start;
        let mut to = argument + taken;
        if from > 0
            && self.at(from - 1) == Some(OPEN)
            && !self.is_escaped(from - 1)
            && self.at(to) == Some(CLOSE)
        {
            from -= 1;
            to += 1;
        }
        let composed: Vec<u16> = format!("{base}{mark}")
            .nfc()
            .collect::<String>()
            .encode_utf16()
            .collect();
        let letter = if composed.len() == 1 {
            composed[0]
        } else {
            unit(base)
        };
        Some((from, to, letter))
    }

    fn mask_markdown_tables(&mut self) {
        // Each line's span in units, and its text without a trailing \r.
        let mut lines: Vec<(usize, usize, String)> = Vec::new();
        let mut from = 0;
        for (index, &unit) in self.source.iter().enumerate() {
            if unit == NEWLINE {
                lines.push((from, index, self.text(from, index)));
                from = index + 1;
            }
        }
        lines.push((from, self.len(), self.text(from, self.len())));
        for line in &mut lines {
            if line.2.ends_with('\r') {
                line.2.pop();
            }
        }
        let is_delimiter = |line: &str| {
            let trimmed = line.trim();
            if !trimmed.contains('|') {
                return false;
            }
            let inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
            let inner = inner.strip_suffix('|').unwrap_or(inner);
            inner.split('|').all(|cell| {
                let cell = cell.trim();
                let cell = cell.strip_prefix(':').unwrap_or(cell);
                let cell = cell.strip_suffix(':').unwrap_or(cell);
                cell.len() >= 3 && cell.chars().all(|c| c == '-')
            })
        };
        let mut index = 1;
        while index < lines.len() {
            if !is_delimiter(&lines[index].2) || !lines[index - 1].2.contains('|') {
                index += 1;
                continue;
            }
            let mut end = index + 1;
            while end < lines.len() && lines[end].2.contains('|') {
                end += 1;
            }
            for row in index - 1..end {
                let (from, to) = (lines[row].0, lines[row].1);
                self.blank(from, to);
            }
            index = end;
        }
    }

    fn run(&mut self) {
        let mut preamble_prose: Vec<(usize, usize)> = Vec::new();
        self.mask_markdown_tables();

        let mut index = 0;
        while index < self.len() {
            if self.is(index, '%') && !self.is_escaped(index) {
                let end = self.find(&[NEWLINE], index).unwrap_or(self.len());
                self.blank(index, end);
                index = end;
                continue;
            }

            if self.is(index, '$') && !self.is_escaped(index) {
                let marker: &[u16] = if self.is(index + 1, '$') {
                    &[36, 36]
                } else {
                    &[36]
                };
                let mut close = self.find(marker, index + marker.len());
                while let Some(at) = close {
                    if !self.is_escaped(at) {
                        break;
                    }
                    close = self.find(marker, at + marker.len());
                }
                let end = close.map_or(self.len(), |at| at + marker.len());
                self.mask_math(index, end);
                index = end;
                continue;
            }

            if self.at(index) != Some(BACKSLASH) {
                index += 1;
                continue;
            }

            let math_closer = if self.is(index + 1, '(') {
                Some("\\)")
            } else if self.is(index + 1, '[') {
                Some("\\]")
            } else {
                None
            };
            if let Some(closer) = math_closer {
                let end = self.end_after(closer, index + 2);
                self.mask_math(index, end);
                index = end;
                continue;
            }

            let Some((command, taken)) = self.command(index) else {
                index += 1;
                continue;
            };
            if let Some((from, to, letter)) = self.tex_accent(index, &command, index + taken) {
                // Blanking `\'` would split `Fr\'echet` in two misspelled
                // halves: fill the accent's span with its letter instead. The
                // padded word is not the real spelling, so it stays syntax.
                for at in from..to {
                    self.masked[at] = letter;
                    self.syntax[at] = true;
                }
                index = to;
                continue;
            }
            let mut cursor = index + taken;
            if self.is(cursor, '*') {
                cursor += 1;
            }

            if command == "begin" {
                cursor = self.skip_space(cursor);
                let group_end = self.balanced_group_end(cursor, OPEN, CLOSE);
                let environment =
                    self.text(cursor + 1, (cursor + 1).max(group_end.saturating_sub(1)));
                if environment == "document" {
                    // The preamble is configuration, but for the title.
                    let mut from = 0;
                    for (title_from, title_to) in preamble_prose.clone() {
                        self.blank(from, title_from);
                        from = from.max(title_to);
                    }
                    self.blank(from, group_end);
                    index = group_end;
                    continue;
                }
                if NON_PROSE_ENVIRONMENTS.contains(&environment.as_str()) {
                    let end = self.end_after(&format!("\\end{{{environment}}}"), group_end);
                    self.blank(index, end);
                    index = end;
                    continue;
                }
            }

            if command == "title" {
                let argument = self.skip_space(cursor);
                if self.at(argument) == Some(OPEN) {
                    let end = self.balanced_group_end(argument, OPEN, CLOSE);
                    preamble_prose.push((argument + 1, (argument + 1).max(end - 1)));
                }
            }

            self.blank(index, cursor);

            let opaque_arguments = if OPAQUE_COMMANDS.contains(&command.as_str()) {
                usize::MAX
            } else {
                NON_PROSE_ARGUMENTS
                    .iter()
                    .find(|(name, _)| *name == command)
                    .map_or(0, |(_, count)| *count)
            };
            let mut groups_masked = 0;
            while opaque_arguments > 0 && cursor < self.len() {
                cursor = self.skip_space(cursor);
                let (open, close) = if self.is(cursor, '[') {
                    (unit('['), unit(']'))
                } else if self.is(cursor, '{') && groups_masked < opaque_arguments {
                    (OPEN, CLOSE)
                } else {
                    break;
                };
                let end = self.balanced_group_end(cursor, open, close);
                self.blank(cursor, end);
                cursor = end;
                if close == CLOSE {
                    groups_masked += 1;
                }
            }
            if REFERENCE_COMMANDS.contains(&command.as_str()) {
                self.placeholder(index, cursor);
            }
            index = cursor.max(index + 1);
        }

        for at in 0..self.masked.len() {
            if self.masked[at] == OPEN || self.masked[at] == CLOSE {
                self.masked[at] = unit(' ');
                self.syntax[at] = true;
            }
        }
    }
}

/// `source`'s prose for Harper (`maskLatexForHarper`).
pub fn mask(source: &str) -> Masked {
    let units: Vec<u16> = source.encode_utf16().collect();
    let mut masker = Masker {
        masked: units.clone(),
        syntax: vec![false; units.len()],
        source: &units,
    };
    masker.run();
    Masked {
        prose: String::from_utf16_lossy(&masker.masked),
        syntax: masker.syntax,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> usize {
        text.encode_utf16().count()
    }

    /// `text` in `prose` where it sits in `source`.
    fn at<'a>(source: &str, prose: &'a str, text: &str) -> String {
        let start = units(&source[..source.find(text).unwrap()]);
        let prose: Vec<u16> = prose.encode_utf16().collect();
        String::from_utf16_lossy(&prose[start..start + units(text)])
    }

    const COLOR_PREAMBLE: &str = "\\documentclass[11pt]{article}\n\\usepackage{fontspec}\n\\setmainfont[UprightFont={*-Regular},BoldFont={*-Bold}]{Songti SC}\n\\definecolor{takeawayaccent}{HTML}{315B78}\n\\hypersetup{linkcolor=takeawayaccent}\n\\newtcolorbox{takeawaybox}[1]{colframe=takeawayaccent}\n\\title{A Clean Title}\n\\begin{document}\n\\pagecolor{takeawaybackground}\n\\color{takeawayaccent}\nThis is introductiom.\n\\end{document}";
    const TABLE: &str = "This is introductiom.\n\n| Method | Description |\n| --- | --- |\n| Baseline | This table cell contains many words that Harper should never treat as one long sentence |\n| Proposed | Another table cell with additional prose that belongs to the table |\n\nVisible prose remains available to Harper.";

    #[test]
    fn masks_syntax_and_keeps_every_offset() {
        let cases: &[(&str, &[&str], &[&str])] = &[
            (
                "\\usepackage{neurips_2025}\n\\author{Yimimg Zhaoo}\n\\bibliographystyle{plainnatt}\n\\title{A sentnce}",
                &["neurips_2025", "Yimimg Zhaoo", "plainnatt"],
                &["A sentnce"],
            ),
            (
                COLOR_PREAMBLE,
                &["UprightFont", "takeawayaccent", "takeawaybackground"],
                &["A Clean Title", "This is introductiom."],
            ),
            (
                "\\textcolor{takeawayaccent}{A sentnce.}\n\\colorbox{takeawaybackground}{Visible prose.}\n\\fcolorbox{takeawayaccent}{takeawaybackground}{More prose.}\n\\href{https://exmple.test}{Readable link.}",
                &["takeaway", "exmple.test"],
                &[
                    "A sentnce.",
                    "Visible prose.",
                    "More prose.",
                    "Readable link.",
                ],
            ),
            (
                TABLE,
                &["Method", "Baseline"],
                &[
                    "This is introductiom.",
                    "Visible prose remains available to Harper.",
                ],
            ),
            (
                "\\section{A sentnce} cites \\citep{smith2024}. $x + y$ % hidden typo\nVisible prose.",
                &["smith2024", "x + y", "hidden typo"],
                &["sentnce", "Visible prose"],
            ),
        ];
        for (source, hidden, visible) in cases {
            let masked = mask(source);
            assert_eq!(units(&masked.prose), units(source));
            for text in *hidden {
                assert!(
                    !masked.prose.contains(text),
                    "{text} shows in {:?}",
                    masked.prose
                );
            }
            for text in *visible {
                assert_eq!(at(source, &masked.prose, text), *text);
            }
        }
    }

    #[test]
    fn keeps_a_tex_accented_word_whole() {
        let cases: &[(&str, &[&str])] = &[
            (
                "Kate\\v{r}ina and Andr\\'e wrote it.",
                &["Kateřřřřřina", "Andrééé"],
            ),
            (
                "Erd\\H{o}s--R\\'enyi, Erd{\\H o}s, G{\\\"o}del, na\\\"{\\i}ve and Fran\\c{c}ois.",
                &[
                    "Erdőőőőős",
                    "Rééényi",
                    "Erdőőőőőős",
                    "Gööööödel",
                    "naïïïïïïve",
                    "Françççççois",
                ],
            ),
            (
                "\\b{o} keeps a letter with no precomposed form.",
                &["ooooo"],
            ),
        ];
        for (source, words) in cases {
            let masked = mask(source);
            assert_eq!(units(&masked.prose), units(source));
            for word in *words {
                assert!(
                    masked.prose.contains(word),
                    "{word} not in {:?}",
                    masked.prose
                );
            }
            let slash = units(&source[..source.find('\\').unwrap()]);
            assert!(masked.syntax[slash]);
        }
    }

    #[test]
    fn a_reference_leaves_a_neutral_subject() {
        let source = "Results follow. \\Cref{fig:loss} shows the curve.";
        let masked = mask(source);
        let from = units(&source[..source.find("\\Cref").unwrap()]);
        let rest: String = masked
            .prose
            .encode_utf16()
            .skip(from)
            .map(|u| u as u8 as char)
            .collect();
        assert!(rest.trim_start().starts_with('X'));
        assert!(rest[1..].trim_start().starts_with("shows"));
        let masked = mask("See \\autoref{tab:ece}.\n\\bibitem{knuth1997art} D. Knuth.");
        assert!(!masked.prose.contains("tab:ece") && !masked.prose.contains("knuth1997art"));
    }

    #[test]
    fn math_keeps_a_subject_and_offsets_count_utf16_units() {
        let source = "$g\\equiv1$ shares 😀 the update.";
        let masked = mask(source);
        assert!(masked.prose.starts_with('X'));
        assert_eq!(units(&masked.prose), units(source));
        assert_eq!(at(source, &masked.prose, "the update."), "the update.");
    }
}
