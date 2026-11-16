//! One pass over a `.tex` file that answers, for each `\\label`, which
//! environment and section it sits in and on which line.

use super::{command_argument_at, LABELLED_ENVIRONMENTS, SUBFLOAT_ENVIRONMENTS};
use std::collections::HashMap;

/// Commands whose title names a label outside any labelled environment, as
/// [`Landmarks::nearest_section_title`] reads them.
const SECTION_COMMANDS: &[&str] =
    &["\\part", "\\chapter", "\\section", "\\subsection", "\\subsubsection", "\\paragraph"];

/// Where each environment a label can sit in opens and closes, and where each
/// sectioning command appears, found in one pass over a file.
///
/// Every label used to search the whole text before it, once for each of 17
/// environments and 6 sectioning commands, which made a large file's label
/// scan quadratic in its length (issue 1025: up to 38 s for a 3 MB chapter,
/// on every save).
/// The answers are the same as those searches gave: the offsets here are
/// exactly the matches `str::rfind`/`str::find` would return, since none of
/// the needles can overlap itself.
pub(super) struct Landmarks {
    /// `\begin{name}` and `\end{name}` offsets, ascending, keyed by name.
    environments: HashMap<&'static str, EnvironmentMarks>,
    /// Offsets of each [`SECTION_COMMANDS`] entry, ascending, in that order.
    sections: Vec<Vec<usize>>,
}

#[derive(Default)]
struct EnvironmentMarks {
    begins: Vec<usize>,
    ends: Vec<usize>,
}

impl Landmarks {
    pub(super) fn scan(source: &str) -> Self {
        let mut environments: HashMap<&'static str, EnvironmentMarks> = LABELLED_ENVIRONMENTS
            .iter()
            .map(|(name, _)| *name)
            .chain(SUBFLOAT_ENVIRONMENTS.iter().copied())
            .map(|name| (name, EnvironmentMarks::default()))
            .collect();
        let longest = environments.keys().map(|name| name.len()).max().unwrap_or(0);
        for (marker, is_begin) in [("\\begin{", true), ("\\end{", false)] {
            for (at, _) in source.match_indices(marker) {
                let name_from = at + marker.len();
                // Only a name we track counts, so the closing brace is looked
                // for no further than the longest of them.
                let window =
                    &source.as_bytes()[name_from..source.len().min(name_from + longest + 1)];
                let Some(length) = window.iter().position(|byte| *byte == b'}') else { continue };
                let Some(marks) = std::str::from_utf8(&window[..length])
                    .ok()
                    .and_then(|name| environments.get_mut(name))
                else {
                    continue;
                };
                if is_begin {
                    marks.begins.push(at);
                } else {
                    marks.ends.push(at);
                }
            }
        }
        let sections = SECTION_COMMANDS
            .iter()
            .map(|command| source.match_indices(command).map(|(at, _)| at).collect())
            .collect();
        Self { environments, sections }
    }

    /// The `name` environment around `position`: its last `\begin` before
    /// `position`, unless an `\end` closes it before `position`, through its
    /// first `\end` after.
    pub(super) fn enclosing_environment(
        &self, position: usize, name: &str,
    ) -> Option<(usize, usize)> {
        let marks = self.environments.get(name)?;
        let opening = "\\begin{".len() + name.len() + 1;
        let closing = "\\end{".len() + name.len() + 1;
        let start = last_ending_by(&marks.begins, opening, position)?;
        if last_ending_by(&marks.ends, closing, position).is_some_and(|end| end > start) {
            return None;
        }
        let after = marks.ends.partition_point(|end| *end < position);
        let finish = *marks.ends.get(after)? + closing;
        Some((start, finish))
    }

    /// The title of the closest sectioning command before `position`, when
    /// it opens within 1,200 bytes of it.
    pub(super) fn nearest_section_title(&self, source: &str, position: usize) -> Option<String> {
        SECTION_COMMANDS
            .iter()
            .zip(&self.sections)
            .filter_map(|(command, offsets)| {
                let start = last_ending_by(offsets, command.len(), position)?;
                let (title, _) = command_argument_at(source, start + command.len())?;
                (position.saturating_sub(start) < 1_200)
                    .then_some((start, crate::util::collapse_whitespace(&title)))
            })
            .max_by_key(|(start, _)| *start)
            .map(|(_, title)| title)
    }
}

/// The last of the ascending `offsets` whose `length`-byte match ends by
/// `position`: what `source[..position].rfind(needle)` returns.
fn last_ending_by(offsets: &[usize], length: usize, position: usize) -> Option<usize> {
    let count = offsets.partition_point(|offset| offset + length <= position);
    count.checked_sub(1).map(|index| offsets[index])
}

/// Line numbers for offsets that only grow, counting each newline once
/// instead of rescanning the text before every label.
#[derive(Default)]
pub(super) struct LineCounter {
    offset: usize,
    newlines: u32,
}

impl LineCounter {
    pub(super) fn line_at(&mut self, source: &str, position: usize) -> u32 {
        let position = position.min(source.len());
        if position < self.offset {
            *self = Self::default();
        }
        self.newlines +=
            source.as_bytes()[self.offset..position].iter().filter(|byte| **byte == b'\n').count()
                as u32;
        self.offset = position;
        self.newlines + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use std::time::Instant;

    /// The prefix searches the landmarks replace, kept as the reference answer.
    fn searched_environment(source: &str, position: usize, name: &str) -> Option<(usize, usize)> {
        let opening = format!("\\begin{{{name}}}");
        let closing = format!("\\end{{{name}}}");
        let start = source.get(..position)?.rfind(&opening)?;
        if source.get(..position)?.rfind(&closing).is_some_and(|end| end > start) {
            return None;
        }
        let finish = position + source.get(position..)?.find(&closing)? + closing.len();
        Some((start, finish))
    }

    fn searched_section_title(source: &str, position: usize) -> Option<String> {
        let before = source.get(..position)?;
        SECTION_COMMANDS
            .iter()
            .filter_map(|command| {
                let start = before.rfind(command)?;
                let (title, _) = command_argument_at(source, start + command.len())?;
                (position.saturating_sub(start) < 1_200)
                    .then_some((start, crate::util::collapse_whitespace(&title)))
            })
            .max_by_key(|(start, _)| *start)
            .map(|(_, title)| title)
    }

    /// A chapter of `labels` labelled floats, equations, panels and sections
    /// padded with prose to about `bytes`, the same text for the same sizes.
    fn chapter(labels: usize, bytes: usize) -> String {
        let blocks = [
            "\\section{Results {for} part N}\\label{sec:N}\n",
            "\\begin{figure}\n  \\centering\n  \\includegraphics[width=\\linewidth]{figures/N}\n  \\caption{Figure N}\n  \\label{fig:N}\n\\end{figure}\n",
            "\\begin{table*}\n  \\caption{Table N}\\label{tab:N}\n  \\begin{tabular}{lc} a & b \\\\ \\end{tabular}\n\\end{table*}\n",
            "\\begin{equation}\n  E_N = m c^2 \\label{eq:N}\n\\end{equation}\n",
            "\\begin{align*}\n  x &= N \\\\ y &= \\partial N \\label{eq:a:N}\n\\end{align*}\n",
            "\\begin{figure}\n  \\begin{subfigure}{.5\\linewidth}\\caption{Left N}\\label{fig:l:N}\\end{subfigure}\n  \\begin{minipage}{.5\\linewidth}\\label{fig:r:N}\\end{minipage}\n  \\caption{Both N}\\label{fig:b:N}\n\\end{figure}\n",
            "\\paragraph{Aside N} \\label{par:N} \\begin{gather}\\end{gather}\n",
            "% \\begin{figure} left open in a comment, as drafts do \\label{cmt:N}\n",
        ];
        let filler =
            "Lorem ipsum dolor sit amet, \\emph{consectetur} adipiscing elit \\cite{key}; \
            sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n";
        let mut source = String::with_capacity(bytes + 4096);
        let mut written = 0;
        let mut index = 0;
        while written < labels {
            let block = blocks[index % blocks.len()].replace('N', &index.to_string());
            written += block.matches("\\label").count();
            source.push_str(&block);
            index += 1;
            let target = bytes * written / labels;
            while source.len() < target {
                source.push_str(filler);
            }
        }
        source
    }

    #[test]
    fn landmarks_answer_what_the_prefix_searches_did() {
        let mut source = chapter(400, 120_000);
        // Unbalanced and unusual openings: an `\end` with no `\begin`, a
        // `\begin` never closed, a name past the longest tracked one, `\part`
        // inside `\partial`, and a label at the very end.
        source.push_str("\\end{figure}\\label{x:1}\\begin{equation}\\label{x:2}\\begin{figure**}");
        source.push_str("\\begin{verylongenvironmentname}\\part{P}$\\partial$\\label{x:3}\\label");
        let names = LABELLED_ENVIRONMENTS
            .iter()
            .map(|(name, _)| *name)
            .chain(SUBFLOAT_ENVIRONMENTS.iter().copied())
            .collect::<Vec<_>>();
        let landmarks = Landmarks::scan(&source);
        let mut lines = LineCounter::default();
        let positions = source.match_indices("\\label").map(|(at, _)| at).collect::<Vec<_>>();
        assert!(positions.len() > 400);
        for position in positions.into_iter().chain([0, source.len()]) {
            for name in &names {
                assert_eq!(
                    landmarks.enclosing_environment(position, name),
                    searched_environment(&source, position, name),
                    "{name} around offset {position}"
                );
            }
            assert_eq!(
                landmarks.nearest_section_title(&source, position),
                searched_section_title(&source, position),
                "section around offset {position}"
            );
            assert_eq!(
                lines.line_at(&source, position),
                crate::project::line_number_at(&source, position)
            );
        }
    }

    /// Times the post-save scans of one large chapter. Run with
    /// `cargo test --release -p lattice-core reference_scan_time -- --ignored --nocapture`.
    /// On an M-series Mac the label scan took 0.23 s for 1 MB and 2.5 s for
    /// 3 MB with a prefix search per label, and takes 0.03 s and 0.11 s with
    /// the landmarks. `REFERENCE_SCAN_DUMP=<prefix>` writes the index as JSON,
    /// to compare two builds' answers.
    #[test]
    #[ignore = "a timing bench, not a check"]
    fn reference_scan_time() {
        for (labels, bytes) in [(500, 1_000_000), (2_000, 3_000_000)] {
            let fixture = Fixture::project("reference-scan-time");
            fixture.write("chapter.tex", chapter(labels, bytes));
            let started = Instant::now();
            let index = crate::project::references(&fixture.root).unwrap();
            println!(
                "{labels} labels in {} KB: {} references in {:?}",
                bytes / 1000,
                index.references.len(),
                started.elapsed()
            );
            let started = Instant::now();
            crate::project::unused_symbols(&fixture.root).unwrap();
            println!("  unused symbols in {:?}", started.elapsed());
            let started = Instant::now();
            crate::project::list_todos(&fixture.root).unwrap();
            println!("  todos in {:?}", started.elapsed());
            if let Ok(dump) = std::env::var("REFERENCE_SCAN_DUMP") {
                let json = serde_json::to_string_pretty(&index.references).unwrap();
                std::fs::write(format!("{dump}-{labels}.json"), json).unwrap();
            }
        }
    }
}
