//! Which conference template a document loads, read from its source.
//!
//! A project folder often holds several venues' style files — last year's
//! `neurips.sty` beside this year's ICLR kit — and the manifest's venue is
//! only what the project was created or adopted as (adoption defaults to
//! NeurIPS). Neither says what a document is. Its own preamble does: the
//! `\documentclass`, `\usepackage` and `\RequirePackage` lines of the root
//! file, of the files its preamble `\input`s, and of the project's own style
//! files those load (author kits ship templates beside the document, and
//! people wrap them, as in `\input{iclr2027/iclr2027_conference.sty}`).

use super::build_log::conference_template_venue;
use crate::project;
use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// Files read at most, so a cycle or a huge tree of inputs cannot stall the
/// TeX doctor.
const MAX_FILES: usize = 64;

/// The conference whose template `document` (project-relative) loads, by its
/// display name ("NeurIPS"), or `None` when its preamble loads none.
pub(crate) fn document_venue(root: &Path, document: &str) -> Option<&'static str> {
    let mut scan = Scan { root, seen: HashSet::new() };
    scan.file(document).venue
}

struct Scan<'a> {
    root: &'a Path,
    seen: HashSet<String>,
}

#[derive(Default)]
struct Found {
    venue: Option<&'static str>,
    /// `\begin{document}` was reached: packages end there, and a body may
    /// quote `\usepackage{neurips}` in a verbatim example.
    body: bool,
}

impl Scan<'_> {
    fn file(&mut self, relative: &str) -> Found {
        if self.seen.len() >= MAX_FILES || !self.seen.insert(relative.to_string()) {
            return Found::default();
        }
        let Some(text) = project::safe_path(self.root, relative)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
        else {
            return Found::default();
        };
        for line in text.lines() {
            let line = strip_comment(line);
            if line.contains("\\begin{document}") {
                return Found { venue: None, body: true };
            }
            for command in commands().captures_iter(line) {
                let found = match &command[1] {
                    "input" | "include" => self.input(&command[3]),
                    kind => {
                        let names: Vec<&str> = command[3].split(',').map(str::trim).collect();
                        let class = kind == "documentclass" || kind == "LoadClass";
                        self.packages(&names, if class { "cls" } else { "sty" })
                    }
                };
                if found.venue.is_some() || found.body {
                    return found;
                }
            }
        }
        Found::default()
    }

    /// A conference template among `names`, else what the project's own
    /// `name.extension` wrappers load.
    fn packages(&mut self, names: &[&str], extension: &str) -> Found {
        if let Some(venue) = names.iter().find_map(|name| conference_template_venue(name)) {
            return Found { venue: Some(venue), body: false };
        }
        for name in names.iter().filter(|name| !name.is_empty()) {
            let local = format!("{name}.{extension}");
            if project::safe_path(self.root, &local).is_ok_and(|path| path.is_file()) {
                let found = self.file(&local);
                if found.venue.is_some() {
                    return Found { venue: found.venue, body: false };
                }
            }
        }
        Found::default()
    }

    /// TeX resolves `\input` against the project folder, adding `.tex` when
    /// the name as written is not a file.
    fn input(&mut self, name: &str) -> Found {
        let (name, root) = (name.trim(), self.root);
        let exists =
            |relative: &str| project::safe_path(root, relative).is_ok_and(|path| path.is_file());
        if let Some(venue) = Path::new(name)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|_| name.ends_with(".sty") || name.ends_with(".cls"))
            .and_then(conference_template_venue)
        {
            return Found { venue: Some(venue), body: false };
        }
        if exists(name) {
            self.file(name)
        } else if exists(&format!("{name}.tex")) {
            self.file(&format!("{name}.tex"))
        } else {
            Found::default()
        }
    }
}

/// `\documentclass`, `\LoadClass`, `\usepackage`, `\RequirePackage`, `\input`
/// and `\include`, with their braced argument (comma-separated for packages).
fn commands() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\\(documentclass|LoadClass|usepackage|RequirePackage|input|include)\b\s*(\[[^\]]*\])?\s*\{([^}]*)\}",
        )
        .expect("preamble command regex")
    })
}

/// `line` up to its first unescaped `%`.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'%' => return &line[..index],
            _ => index += 1,
        }
    }
    line
}
