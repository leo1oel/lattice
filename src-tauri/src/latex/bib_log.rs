//! The bibliography tool's own log (`main.blg`): BibTeX's and biber's errors
//! and warnings, which never reach TeX's log. A syntax error in a `.bib` file
//! left only "Citation undefined" in the problem list, nowhere near its cause.

use super::build_log::{diagnostic, normalize_log_path};
use crate::models::Diagnostic;
use regex::Regex;
use std::fs;
use std::path::Path;

/// Enough to point at every problem in a broken `.bib` without burying the
/// TeX errors beside them.
const LIMIT: usize = 40;

/// What the bibliography run for `root_document` reported, when this build
/// still has one. A `.blg` outlives the bibliography that made it, so it
/// counts only while the document still asks for one: BibTeX's `\bibdata` in
/// the `.aux`, or biblatex's `.bcf`.
pub(super) fn bibliography_diagnostics(root_document: &Path) -> Vec<Diagnostic> {
    let Ok(log) = fs::read_to_string(root_document.with_extension("blg")) else {
        return Vec::new();
    };
    let aux = fs::read_to_string(root_document.with_extension("aux")).unwrap_or_default();
    if !aux.contains("\\bibdata") && !root_document.with_extension("bcf").is_file() {
        return Vec::new();
    }
    parse_bib_log(&log)
}

pub(super) fn parse_bib_log(log: &str) -> Vec<Diagnostic> {
    let mut diagnostics =
        if log.starts_with("This is BibTeX") { parse_bibtex(log) } else { parse_biber(log) };
    diagnostics.truncate(LIMIT);
    diagnostics
}

/// BibTeX ends an error with where it was, on the same line or the next:
/// "I was expecting a `,' or a `}'---line 4 of file refs.bib". A warning
/// starts with `Warning--` and may be followed by "--line 9 of file refs.bib".
/// Only a `.bib` line is somewhere to go; a line of the `.aux` (an unreadable
/// database, say) is not, so that message stands without a place.
fn parse_bibtex(log: &str) -> Vec<Diagnostic> {
    let error = Regex::new(r"^(.*?)---line (\d+) of file (.+)$").unwrap();
    let warning_place = Regex::new(r"^--line (\d+) of file (.+)$").unwrap();
    let lines: Vec<&str> = log.lines().collect();
    let mut diagnostics = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(message) = line.strip_prefix("Warning--") {
            let place = lines.get(index + 1).and_then(|next| warning_place.captures(next.trim()));
            let (file, number) = place.map_or((None, None), |place| bib_line(&place[2], &place[1]));
            diagnostics.push(diagnostic(file, number, "warning", message.trim().to_string()));
        } else if let Some(found) = error.captures(line) {
            // The message may sit on the line above its location.
            let message = match found[1].trim() {
                "" if index > 0 => lines[index - 1].trim(),
                message => message,
            };
            let (file, number) = bib_line(&found[3], &found[2]);
            diagnostics.push(diagnostic(file, number, "error", message.to_string()));
        }
    }
    diagnostics
}

/// A BibTeX location, when it is a line of a `.bib` file.
fn bib_line(file: &str, number: &str) -> (Option<String>, Option<u32>) {
    let file = normalize_log_path(file);
    if !file.to_ascii_lowercase().ends_with(".bib") {
        return (None, None);
    }
    (Some(file), number.parse().ok())
}

/// biber writes `[time] Module.pm:line> LEVEL - message`. Its `.bib` syntax
/// errors name the UTF-8 copy it parsed (`/tmp/…/refs.bib_1234.utf8, line 4,
/// …`), whose lines are the original's, so they are placed in the data source
/// of the same file name.
fn parse_biber(log: &str) -> Vec<Diagnostic> {
    let message = Regex::new(r"(?m)^\[\d+\] [^>\n]*> (ERROR|WARN) - (.+)$").unwrap();
    let source = Regex::new(r"(?m)> INFO - Found BibTeX data source '([^'\n]+)'").unwrap();
    let copy =
        Regex::new(r"^BibTeX subsystem: (?:.*/)?([^/]+?)(?:_\d+)?(?:\.utf8)?, line (\d+), (.+)$")
            .unwrap();
    let sources: Vec<String> =
        source.captures_iter(log).map(|capture| normalize_log_path(&capture[1])).collect();
    message
        .captures_iter(log)
        .map(|capture| {
            let level = if &capture[1] == "ERROR" { "error" } else { "warning" };
            let text = capture[2].trim();
            let placed = copy.captures(text).and_then(|parts| {
                let name = &parts[1];
                let file = sources.iter().find(|source| {
                    Path::new(source).file_name().is_some_and(|file| file == name)
                })?;
                Some((file.clone(), parts[2].parse().ok(), parts[3].trim().to_string()))
            });
            match placed {
                Some((file, line, text)) => diagnostic(Some(file), line, level, text),
                None => diagnostic(None, None, level, text.to_string()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// main.blg of a real BibTeX run (TeX Live 2026) over a `.bib` entry with
    /// a missing comma, citing a key that is not in it; built-in counts cut.
    const BIBTEX_LOG: &str = "This is BibTeX, Version 0.99e (TeX Live 2026)
Capacity: max_strings=200000, hash_size=200000, hash_prime=170003
The top-level auxiliary file: main.aux
The style file: plain.bst
Database file #1: refs.bib
I was expecting a `,' or a `}'---line 4 of file refs.bib
 :
 :   journal={J},
(Error may have been on previous line)
I'm skipping whatever remains of this entry
Warning--I didn't find a database entry for \"missing\"
Warning--empty journal in cats
Warning--empty year in cats
You've used 1 entry,
            2118 wiz_defined-function locations,
            501 strings with 4009 characters,
and the built_in function-call counts, 219 in all, are:
(There was 1 error message)
";

    fn summary(diagnostics: &[Diagnostic]) -> Vec<(&str, Option<&str>, Option<u32>, &str)> {
        diagnostics
            .iter()
            .map(|item| {
                (item.level.as_str(), item.file.as_deref(), item.line, item.message.as_str())
            })
            .collect()
    }

    #[test]
    fn reads_bibtex_errors_with_their_bib_line_and_its_warnings() {
        assert_eq!(
            summary(&parse_bib_log(BIBTEX_LOG)),
            [
                ("error", Some("refs.bib"), Some(4), "I was expecting a `,' or a `}'"),
                ("warning", None, None, "I didn't find a database entry for \"missing\""),
                ("warning", None, None, "empty journal in cats"),
                ("warning", None, None, "empty year in cats"),
            ]
        );
        // A message above its location, a warning with one, and a line of the
        // .aux, which is nowhere the writer edits.
        let log = "This is BibTeX, Version 0.99e (TeX Live 2026)\n\
                   Repeated entry---line 12 of file bib/refs.bib\n\
                   I couldn't open database file nosuch.bib\n\
                   ---line 3 of file main.aux\n\
                   Warning--I'm ignoring cats's extra \"title\" field\n\
                   --line 7 of file ./bib/refs.bib\n";
        assert_eq!(
            summary(&parse_bib_log(log)),
            [
                ("error", Some("bib/refs.bib"), Some(12), "Repeated entry"),
                ("error", None, None, "I couldn't open database file nosuch.bib"),
                (
                    "warning",
                    Some("bib/refs.bib"),
                    Some(7),
                    "I'm ignoring cats's extra \"title\" field"
                ),
            ]
        );
    }

    /// Written to biber's log format rather than captured: biber would not
    /// start on the Mac these tests were written on.
    #[test]
    fn reads_biber_errors_and_places_syntax_errors_in_their_data_source() {
        let log = "[0] Config.pm:307> INFO - This is Biber 2.19\n\
                   [140] bibtex.pm:1519> INFO - Found BibTeX data source 'bib/refs.bib'\n\
                   [145] Utils.pm:410> ERROR - BibTeX subsystem: /var/folders/xy/T/biber_tmp_Ab12/refs.bib_81234.utf8, line 4, syntax error: found \"journal\", expected end of entry (\"}\" or \")\") (skipping to next \"@\")\n\
                   [150] Utils.pm:411> WARN - I didn't find a database entry for 'missing' (section 0)\n\
                   [160] Biber.pm:131> INFO - WARNINGS: 1\n";
        assert_eq!(
            summary(&parse_bib_log(log)),
            [
                (
                    "error",
                    Some("bib/refs.bib"),
                    Some(4),
                    "syntax error: found \"journal\", expected end of entry (\"}\" or \")\") (skipping to next \"@\")"
                ),
                ("warning", None, None, "I didn't find a database entry for 'missing' (section 0)"),
            ]
        );
    }

    #[test]
    fn reads_a_blg_only_while_the_document_still_has_a_bibliography() {
        let root = crate::test_support::TempDir::new("bib-log");
        let document = root.write("paper/main.tex", "");
        root.write("paper/main.blg", BIBTEX_LOG);
        assert!(bibliography_diagnostics(&document).is_empty());
        root.write("paper/main.aux", "\\bibstyle{plain}\n\\bibdata{refs}\n");
        assert_eq!(bibliography_diagnostics(&document).len(), 4);
    }
}
