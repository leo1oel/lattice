//! What keeps one change from sinking the whole marked PDF, and what the
//! writer reads when it still does not build.
//!
//! The bibliography first. `latexdiff --flatten` puts `<root>.bbl` in place
//! of `\bibliography` when it finds one beside the root document. The older
//! version seldom has one: review mode's bases are only `.tex` and `.bib`,
//! and a `.bbl` is usually left out of Git. So the whole bibliography read as
//! added, and its natbib header, `\expandafter\ifx\csname urlstyle\endcsname`,
//! came out as `\csname \DIFadd{urlstyle}\endcsname`: "Missing \endcsname
//! inserted", with every markup latexdiff offers. The bibliography is BibTeX's
//! output, not the writer's text, so the newer version's stands on both sides
//! and is never marked.
//!
//! Then any other construct latexdiff's marks break: when TeX stops inside
//! one change's marks, that change alone is shown unmarked and the build runs
//! again, so the others keep theirs.

use super::input_loop;
use crate::models::Diagnostic;
use std::fs;
use std::path::Path;

/// The commands latexdiff wraps changed text in, and whether the text is the newer version's.
const WRAPPERS: [(&str, bool); 4] =
    [(r"\DIFaddFL{", true), (r"\DIFdelFL{", false), (r"\DIFadd{", true), (r"\DIFdel{", false)];

/// A fragment of the line TeX stopped on shorter than this names no place.
const SHORTEST_FRAGMENT: usize = 6;

/// The longest fragment quoted when the line is not in any source file.
const LONGEST_QUOTE: usize = 60;

/// Give the older version the newer one's `<root>.bbl`, or none when the
/// newer has none, so latexdiff flattens the same bibliography into both.
pub(super) fn same_bibliography(older: &Path, newer: &Path, document: &str) -> Result<(), String> {
    let bibliography = Path::new(document).with_extension("bbl");
    let (from, to) = (newer.join(&bibliography), older.join(&bibliography));
    let _ = fs::remove_file(&to);
    if from.is_file() {
        fs::copy(&from, &to).map_err(|error| {
            format!("Could not read {}: {error}", bibliography.to_string_lossy())
        })?;
    }
    Ok(())
}

/// `tex` with the marks taken off every change whose text spans `line`
/// (counted from 1): added text stays, plain, and deleted text goes. `None`
/// when no change spans it, so its marks are not what stopped TeX. Only the
/// document's body is touched; the preamble's definitions name the wrappers too.
pub(super) fn unmark_at(tex: &str, line: u32) -> Option<(String, usize)> {
    let body = tex.find(r"\begin{document}")?;
    let newlines: Vec<usize> = tex.match_indices('\n').map(|(at, _)| at).collect();
    let line_at = |offset: usize| newlines.partition_point(|&at| at < offset) as u32 + 1;
    let mut spans = Vec::new();
    let mut at = body;
    while let Some((start, open, added)) = next_wrapper(tex, at) {
        let Some(end) = closing_brace(tex, start + open) else { break };
        if line_at(start) <= line && line <= line_at(end) {
            spans.push((start, open, end, added));
        }
        at = end + 1;
    }
    if spans.is_empty() {
        return None;
    }
    let mut unmarked = tex.to_string();
    for &(start, open, end, added) in spans.iter().rev() {
        let kept = if added { &tex[start + open..end] } else { "" };
        unmarked.replace_range(start..=end, kept);
    }
    Some((unmarked, spans.len()))
}

/// The first wrapper at or after `from`: where it starts, how long its
/// opening (`\DIFadd{`) is, and whether it holds added text.
fn next_wrapper(tex: &str, from: usize) -> Option<(usize, usize, bool)> {
    WRAPPERS
        .iter()
        .filter_map(|&(open, added)| {
            tex[from..].find(open).map(|at| (from + at, open.len(), added))
        })
        .min_by_key(|&(start, _, _)| start)
}

/// The brace closing the group opened just before `from`, past escaped
/// braces and comments (latexdiff's own `%DIFAUXCMD` lines among them).
fn closing_brace(tex: &str, from: usize) -> Option<usize> {
    let bytes = tex.as_bytes();
    let (mut depth, mut index) = (1usize, from);
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 1,
            b'%' => {
                index = tex[index..].find('\n').map_or(bytes.len(), |newline| index + newline);
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// The writer's words for a marked build that did not finish: where TeX
/// stopped, in the paper's own files when the line can be found there.
/// `marked` is the marked document's path in `newer`; `tex` its text.
pub(super) fn build_failure(
    newer: &Path, document: &str, marked: &str, tex: &str, error: Option<&Diagnostic>,
) -> String {
    let Some(error) = error else {
        return "The PDF with changes marked did not build.".to_string();
    };
    let detail = error.message.trim_end_matches('.');
    let plain = || format!("The PDF with changes marked did not build: {}", error.message);
    let (Some(file), Some(line)) = (error.file.as_deref(), error.line) else { return plain() };
    // latexmk runs in the marked document's folder, so the log names files from there.
    let folder = Path::new(marked).parent().unwrap_or(Path::new(""));
    let marked_name = Path::new(marked).file_name().map(|name| name.to_string_lossy());
    if marked_name.as_deref() == Some(file) {
        let text = tex.lines().nth(line.saturating_sub(1) as usize).unwrap_or("");
        let Some(fragment) = longest_fragment(text) else { return plain() };
        return match find_line(newer, document, &fragment) {
            Some((file, line)) => format!(
                "The PDF with changes marked did not build: TeX stopped at line {line} of {file} ({detail})."
            ),
            None => format!(
                "The PDF with changes marked did not build: TeX stopped near “{}” ({detail}).",
                quoted(&fragment)
            ),
        };
    }
    let stem = marked_name.as_deref().and_then(|name| name.strip_suffix(".tex"));
    // The marked document's own outputs (its .aux, its .bbl) are not the writer's.
    if stem.is_some_and(|stem| file.starts_with(&format!("{stem}."))) {
        return plain();
    }
    let shown = if Path::new(file).is_absolute() {
        Path::new(file).file_name().map_or(file.to_string(), |name| name.to_string_lossy().into())
    } else {
        folder.join(file).to_string_lossy().replace('\\', "/")
    };
    format!("The PDF with changes marked did not build: TeX stopped at line {line} of {shown} ({detail}).")
}

/// The longest stretch of the line between latexdiff's commands and braces:
/// the writer's own text, as it is in a source file.
fn longest_fragment(line: &str) -> Option<String> {
    let line = line.find("%DIF").map_or(line, |comment| &line[..comment]);
    let mut fragments = Vec::new();
    let mut rest = line;
    while let Some(at) = rest.find(r"\DIF") {
        fragments.push(&rest[..at]);
        let name = rest[at + 1..]
            .find(|c: char| !c.is_ascii_alphabetic())
            .map_or(rest.len(), |end| at + 1 + end);
        rest = &rest[name..];
    }
    fragments.push(rest);
    fragments
        .iter()
        .flat_map(|fragment| fragment.split(['{', '}']))
        .map(str::trim)
        .filter(|fragment| fragment.chars().count() >= SHORTEST_FRAGMENT)
        .max_by_key(|fragment| fragment.chars().count())
        .map(str::to_string)
}

/// The first line holding `fragment`, as (file relative to `newer`, line
/// from 1), in the files latexdiff flattened: the root document, the files
/// it reads, then its bibliography.
fn find_line(newer: &Path, document: &str, fragment: &str) -> Option<(String, u32)> {
    let bibliography =
        Path::new(document).with_extension("bbl").to_string_lossy().replace('\\', "/");
    input_loop::flattened(newer, document).into_iter().chain([bibliography]).find_map(|file| {
        let text = fs::read_to_string(newer.join(&file)).ok()?;
        let line = text.lines().position(|line| line.contains(fragment))?;
        Some((file, line as u32 + 1))
    })
}

fn quoted(fragment: &str) -> String {
    if fragment.chars().count() <= LONGEST_QUOTE {
        return fragment.to_string();
    }
    let cut: String = fragment.chars().take(LONGEST_QUOTE).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn error(file: &str, line: u32, message: &str) -> Diagnostic {
        Diagnostic {
            file: Some(file.to_string()),
            line: Some(line),
            column: None,
            end_line: None,
            end_column: None,
            level: "error".to_string(),
            message: message.to_string(),
            code: None,
            params: Default::default(),
        }
    }

    /// natbib's header, as every `.bbl` from a natbib style starts.
    const BBL: &str = "\\begin{thebibliography}{1}\n\\providecommand{\\natexlab}[1]{#1}\n\\providecommand{\\url}[1]{\\texttt{#1}}\n\\expandafter\\ifx\\csname urlstyle\\endcsname\\relax\n  \\providecommand{\\doi}[1]{doi: #1}\\else\n  \\providecommand{\\doi}{doi: \\begingroup \\urlstyle{rm}\\Url}\\fi\n\n\\bibitem[He et~al.(2016)]{he2016}\nKaiming He.\n\\newblock Deep residual learning.\n\n\\end{thebibliography}\n";

    #[test]
    fn both_versions_flatten_the_newer_bibliography() {
        let (older, newer) = (TempDir::new("bbl-older"), TempDir::new("bbl-newer"));
        newer.write("paper/main.bbl", BBL);
        older.write("paper/main.tex", "x");
        same_bibliography(&older, &newer, "paper/main.tex").unwrap();
        assert_eq!(fs::read_to_string(older.join("paper/main.bbl")).unwrap(), BBL);

        // One the newer version no longer has is taken from the older too.
        fs::remove_file(newer.join("paper/main.bbl")).unwrap();
        same_bibliography(&older, &newer, "paper/main.tex").unwrap();
        assert!(!older.join("paper/main.bbl").exists());
    }

    /// The captain's paper: the bibliography read as added, its header marked.
    #[test]
    fn a_change_marked_inside_csname_is_shown_unmarked() {
        let tex = "\\providecommand{\\DIFaddFL}[1]{\\DIFadd{#1}}\n\\begin{document}\nText \\DIFadd{kept marked}.\n\\expandafter\\ifx\\csname \\DIFadd{urlstyle}\\endcsname\\relax\n\\end{document}\n";
        let (unmarked, count) = unmark_at(tex, 4).unwrap();
        assert_eq!(count, 1);
        assert!(unmarked.contains("\\csname urlstyle\\endcsname"), "{unmarked}");
        // The other change and the preamble's definition keep their marks.
        assert!(unmarked.contains("Text \\DIFadd{kept marked}."));
        assert!(unmarked.starts_with("\\providecommand{\\DIFaddFL}[1]{\\DIFadd{#1}}"));
        assert!(unmark_at(tex, 3).is_some() && unmark_at(tex, 5).is_none());
    }

    /// TeX names the line where it read the argument's closing brace.
    #[test]
    fn a_change_over_several_lines_is_found_from_any_of_them() {
        let tex = "\\begin{document}\n\\begin{equation*}\n  \\DIFadd{x = \\text{a}\n  + y % a comment with a } brace\n}\\end{equation*}\nBefore \\DIFdel{old \\{ words} after.\n\\end{document}\n";
        let (unmarked, _) = unmark_at(tex, 5).unwrap();
        assert!(unmarked.contains("\\begin{equation*}\n  x = \\text{a}\n  + y % a comment with a } brace\n\\end{equation*}"), "{unmarked}");
        // Deleted text goes with its marks.
        let (unmarked, _) = unmark_at(tex, 6).unwrap();
        assert!(unmarked.contains("Before  after."), "{unmarked}");
    }

    #[test]
    fn the_failure_names_the_writer_s_file_and_line() {
        let newer = TempDir::new("failure-newer");
        newer.write("main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\bibliography{refs}\n\\end{document}\n");
        newer.write("sections/intro.tex", "Intro.\nWe use \\badmacro here.\n");
        // An older draft the paper no longer reads, holding the same line.
        newer.write("sections/a-draft.tex", "We use \\badmacro here.\n");
        newer.write("main.bbl", BBL);
        newer.write("main-changes.tex", "ignored\n");
        let tex = "\\begin{document}\nIntro.\nWe use \\badmacro \\DIFadd{now} here.\n\\expandafter\\ifx\\csname \\DIFadd{urlstyle}\\endcsname\\relax\n\\DIFadd{zz}\n";
        let fail = |line, file: &str| {
            build_failure(
                &newer,
                "main.tex",
                "main-changes.tex",
                tex,
                Some(&error(file, line, "Missing \\endcsname inserted.")),
            )
        };
        assert_eq!(fail(3, "main-changes.tex"), "The PDF with changes marked did not build: TeX stopped at line 2 of sections/intro.tex (Missing \\endcsname inserted).");
        assert_eq!(fail(4, "main-changes.tex"), "The PDF with changes marked did not build: TeX stopped at line 4 of main.bbl (Missing \\endcsname inserted).");
        // Nothing of the writer's on the line: TeX's own words.
        assert_eq!(
            fail(5, "main-changes.tex"),
            "The PDF with changes marked did not build: Missing \\endcsname inserted."
        );
        assert_eq!(
            fail(7, "main-changes.aux"),
            "The PDF with changes marked did not build: Missing \\endcsname inserted."
        );
        assert_eq!(fail(12, "cvpr.sty"), "The PDF with changes marked did not build: TeX stopped at line 12 of cvpr.sty (Missing \\endcsname inserted).");
        assert_eq!(
            build_failure(&newer, "main.tex", "main-changes.tex", tex, None),
            "The PDF with changes marked did not build."
        );

        // Deleted text is in no file of the newer version: it is quoted.
        let deleted = "\\begin{document}\n\\DIFdel{A sentence the writer took out of the paper}\n";
        assert_eq!(
            build_failure(&newer, "main.tex", "main-changes.tex", deleted, Some(&error("main-changes.tex", 2, "Undefined control sequence."))),
            "The PDF with changes marked did not build: TeX stopped near “A sentence the writer took out of the paper” (Undefined control sequence)."
        );
    }
}
