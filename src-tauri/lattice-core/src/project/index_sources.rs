//! Reading the manuscript's `.tex` and `.bib` files for the label and citation
//! indexes. One file the index cannot read (a GBK thesis template, a Latin-1
//! JabRef export) used to fail the whole scan, and the editor then checked no
//! label or citation for the rest of the session. The indexes now read every
//! file they can and name the ones they skipped; edits that must see the whole
//! manuscript still refuse, naming the file, through [`IndexSources::complete`].

use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;

/// Why a source is missing from an index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub enum SkipReason {
    /// Text in an encoding other than UTF-8; converting the file fixes it.
    NotUtf8,
    /// Any other read failure (permissions, a file vanishing mid-scan).
    Unreadable { message: String },
}

/// A project file an index left out, so its labels or keys are unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSource {
    pub path: String,
    #[serde(flatten)]
    pub reason: SkipReason,
}

impl SkippedSource {
    /// The refusal an edit gives when it cannot see this file.
    fn message(&self) -> String {
        match &self.reason {
            SkipReason::NotUtf8 => format!(
                "{} is not UTF-8 text. Convert it to UTF-8 so Lattice can read it.",
                self.path
            ),
            SkipReason::Unreadable { message } => {
                format!("Could not read {}: {message}", self.path)
            }
        }
    }
}

/// The `(relative path, contents)` an index read, and the files it skipped.
#[derive(Debug, Default)]
pub(crate) struct IndexSources {
    pub sources: Vec<(String, String)>,
    pub skipped: Vec<SkippedSource>,
}

impl IndexSources {
    /// Read `path` as UTF-8, filing it under `relative` as a source or a skip.
    pub(super) fn read(&mut self, relative: String, path: &Path) {
        match read_utf8(path) {
            Ok(contents) => self.sources.push((relative, contents)),
            Err(reason) => self.skipped.push(SkippedSource { path: relative, reason }),
        }
    }

    /// Every source, or the first skipped file's refusal: for renames and
    /// removals, which would otherwise leave that file's occurrences behind.
    pub(crate) fn complete(self) -> Result<Vec<(String, String)>, String> {
        match self.skipped.first() {
            Some(skipped) => Err(skipped.message()),
            None => Ok(self.sources),
        }
    }
}

fn read_utf8(path: &Path) -> Result<String, SkipReason> {
    let bytes = fs::read(path)
        .map_err(|error: io::Error| SkipReason::Unreadable { message: error.to_string() })?;
    String::from_utf8(bytes).map_err(|_| SkipReason::NotUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use crate::project::{citations, read_asset, read_file, references, Symbol};

    const LATIN1_DRAFT: &[u8] = b"\\section{R\xe9sum\xe9}\\label{sec:old}\n";
    const GBK_SECTION: &[u8] = b"\\section{\xd6\xd0\xce\xc4}\n";

    fn not_utf8(path: &str) -> SkippedSource {
        SkippedSource { path: path.to_string(), reason: SkipReason::NotUtf8 }
    }

    #[test]
    fn a_latin1_draft_leaves_out_only_its_own_labels() {
        let fixture = Fixture::project("index-latin1-tex");
        fixture.write("main.tex", "\\section{Intro}\\label{sec:intro}\n");
        fixture.write("archive/old-draft.tex", LATIN1_DRAFT);

        let index = references(&fixture.root).unwrap();

        let labels = index.references.iter().map(|item| item.label.as_str()).collect::<Vec<_>>();
        assert_eq!(labels, ["sec:intro"]);
        assert_eq!(index.skipped, [not_utf8("archive/old-draft.tex")]);
    }

    #[test]
    fn a_latin1_bibliography_is_named_instead_of_failing_or_vanishing() {
        let fixture = Fixture::project("index-latin1-bib");
        // The primary bibliography used to fail the whole scan; any other
        // `.bib` was filed as binary by the tree and dropped without a word.
        fixture.write("references.bib", b"@misc{e, title = {Caf\xe9}}\n");
        fixture.write("extra.bib", b"@misc{x, title = {Na\xefve}}\n");
        fixture.write("more.bib", "@misc{k, title = {Kept}}\n");

        let index = citations(&fixture.root).unwrap();

        let keys = index.citations.iter().map(|citation| citation.key.as_str()).collect::<Vec<_>>();
        assert_eq!(keys, ["k"]);
        assert_eq!(index.skipped, [not_utf8("references.bib"), not_utf8("extra.bib")]);
    }

    #[test]
    fn a_rename_refuses_naming_the_file_it_cannot_read() {
        let fixture = Fixture::project("index-latin1-rename");
        fixture.write("main.tex", "\\label{sec:intro} See \\ref{sec:intro}.\n");
        fixture.write("archive/old-draft.tex", LATIN1_DRAFT);

        let error = Symbol::Label.rename(&fixture.root, "sec:intro", "sec:start").unwrap_err();

        assert!(error.starts_with("archive/old-draft.tex is not UTF-8 text."), "{error}");
        assert_eq!(fixture.read("main.tex"), "\\label{sec:intro} See \\ref{sec:intro}.\n");
    }

    #[test]
    fn a_gbk_source_says_it_is_not_utf8_rather_than_binary() {
        let fixture = Fixture::project("index-gbk-open");
        fixture.write("chapter.tex", GBK_SECTION);
        fixture.write("data.tex", b"\\section{a}\0\n");

        // The editor's read, and the asset read the file tree routes it to.
        let opened = read_file(&fixture.root, "chapter.tex").unwrap_err();
        let previewed = read_asset(&fixture.root, "chapter.tex").map(|_| ()).unwrap_err();

        assert!(opened.starts_with("This file is not UTF-8 text"), "{opened}");
        assert_eq!(previewed, opened);
        assert!(read_file(&fixture.root, "data.tex").unwrap_err().contains("binary"));
    }
}
