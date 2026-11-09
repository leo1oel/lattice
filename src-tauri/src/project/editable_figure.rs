//! Editable external figures: a drawing program's source file and the files
//! it rendered from it (a PDF and the `.tex` that includes it), named by the
//! manifest it put on the clipboard (docs/editable-figures.md). They are
//! copied into one project folder under one shared name, so the entry file's
//! references to its siblings still hold after a rename.

use super::paths::{relative_to, safe_path, validate_entry_name, validate_user_entry};
use crate::util::err;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The most a pasted figure may carry, all its files together.
const MAX_FIGURE_BYTES: usize = 64 * 1024 * 1024;

/// The file types figures are drawn in, opened in the program the system has for them.
const DRAWING_EXTENSIONS: [&str; 9] =
    ["reactio", "cdxml", "cdx", "drawio", "dio", "ipe", "excalidraw", "ggb", "odg"];

/// What a figure's rendered files may be.
const OUTPUT_EXTENSIONS: [&str; 7] = ["tex", "pdf", "pdf_tex", "png", "jpg", "svg", "eps"];

/// Tries before giving up on a name that keeps being taken while writing.
const WRITE_ATTEMPTS: usize = 8;

/// Numbered names tried for one file before giving up.
const MAX_NAME_NUMBER: u32 = 10_000;

fn extension_of(path: &Path) -> String {
    path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase()
}

/// How a figure's source file is shown: a project names the file, and a paste
/// can come from anyone, so only drawing formats run in another program.
/// SVG opens only once the user agrees each time: its default program is
/// often a browser, which runs the script it may hold.
#[derive(Debug, PartialEq)]
pub enum FigureSourceOpening {
    Open(PathBuf),
    /// SVG the user has not agreed to open this time.
    Ask,
    Reveal(PathBuf),
}

/// One file of a figure: its name and base64 bytes. A paste is untrusted, so
/// a manifest can never name a path on disk to read.
#[derive(Debug, Clone, Deserialize)]
pub struct FigureFile {
    pub name: String,
    pub data: String,
}

/// The clipboard manifest, version 1.
#[derive(Debug, Clone, Deserialize)]
pub struct FigureManifest {
    pub version: u32,
    pub source: FigureFile,
    pub outputs: Vec<FigureFile>,
    pub entry: String,
    #[serde(default)]
    pub packages: Vec<String>,
}

/// Where the figure landed, relative to the project root.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFigure {
    /// The folder holding the figure's files (`figures`).
    pub directory: String,
    /// The entry file's name in that folder, to include (`scheme.tex`).
    pub entry: String,
    /// The source file's path, the one to open for editing.
    pub source: String,
    /// The packages the entry needs, as the manifest named them.
    pub packages: Vec<String>,
}

fn file_name_of(file: &FigureFile) -> Result<String, String> {
    validate_entry_name(&file.name)
        .map(str::to_string)
        .map_err(|_| "The figure names a file without a usable name.".to_string())
}

fn bytes_of(file: &FigureFile, budget: &mut usize) -> Result<Vec<u8>, String> {
    let data = file.data.trim();
    // Checked before decoding, so an oversized paste is never held twice.
    if data.len() / 4 * 3 > *budget + 3 {
        return Err(TOO_LARGE.to_string());
    }
    let bytes =
        STANDARD.decode(data).map_err(|error| format!("Could not decode the figure: {error}"))?;
    *budget = budget.checked_sub(bytes.len()).ok_or(TOO_LARGE)?;
    Ok(bytes)
}

const TOO_LARGE: &str = "The figure is too large to import.";

/// Only file types a figure is made of come in from a paste.
fn check_types(named: &[(String, Vec<u8>)], entry: &str) -> Result<(), String> {
    let kind = |name: &str| extension_of(Path::new(name));
    let source = kind(&named[0].0);
    let source_allowed = source == "svg" || DRAWING_EXTENSIONS.contains(&source.as_str());
    let outputs_allowed =
        named[1..].iter().all(|(name, _)| OUTPUT_EXTENSIONS.contains(&kind(name).as_str()));
    if !source_allowed || !outputs_allowed || kind(entry) != "tex" {
        return Err("The figure carries a file type Lattice does not import.".to_string());
    }
    Ok(())
}

/// Whether anything is at `path`, a link that leads nowhere included.
fn taken(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

fn carries_stem(name: &str, stem: &str) -> bool {
    name.strip_prefix(stem).is_some_and(|rest| rest.starts_with('.'))
}

/// `name` with `stem` swapped for `next` when it starts with `stem.`.
fn renamed(name: &str, stem: &str, next: &str) -> String {
    if carries_stem(name, stem) {
        format!("{next}{}", &name[stem.len()..])
    } else {
        name.to_string()
    }
}

/// `name`, then `name-2`, `name-3`, … (before the extension).
fn numbered(name: &str) -> impl Iterator<Item = String> + '_ {
    let (base, rest) =
        name.rfind('.').filter(|&dot| dot > 0).map_or((name, ""), |dot| name.split_at(dot));
    std::iter::once(name.to_string())
        .chain((2..MAX_NAME_NUMBER).map(move |number| format!("{base}-{number}{rest}")))
}

const NO_FREE_NAME: &str = "No free name was found for the figure.";

/// Where each file goes. Files carrying the entry's stem move together, so the
/// entry's references hold; any other file finds a free name of its own, since
/// no shared name could ever free it. LaTeX looks in the project root before
/// `\\graphicspath`, so a name taken there counts too.
fn plan_names(
    root: &Path, target: &Path, names: &[&str], stem: &str,
) -> Result<(String, Vec<(String, String)>), String> {
    let free = |file: &str| !taken(&target.join(file)) && !taken(&root.join(file));
    let next = numbered(stem)
        .find(|candidate| {
            names
                .iter()
                .filter(|name| carries_stem(name, stem))
                .all(|name| free(&renamed(name, stem, candidate)))
        })
        .ok_or(NO_FREE_NAME)?;
    let mut used: BTreeSet<String> = names
        .iter()
        .map(|name| renamed(name, stem, &next))
        .filter(|name| carries_stem(name, &next))
        .collect();
    let mut renames = Vec::with_capacity(names.len());
    for name in names {
        let to = if carries_stem(name, stem) {
            renamed(name, stem, &next)
        } else {
            let to = numbered(name)
                .find(|candidate| free(candidate) && !used.contains(candidate))
                .ok_or(NO_FREE_NAME)?;
            used.insert(to.clone());
            to
        };
        renames.push(((*name).to_string(), to));
    }
    Ok((next, renames))
}

/// Creates a new file, never through a link and never over anything.
fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    OpenOptions::new().write(true).create_new(true).open(path)?.write_all(bytes)
}

/// Writes the whole set, or nothing: what this try created goes if one fails.
fn write_all_new(
    target: &Path, files: &[(String, Vec<u8>)], entry: &str, renames: &[(String, String)],
) -> Result<(), WriteFailure> {
    let mut created = Vec::with_capacity(files.len());
    let mut outcome = Ok(());
    for ((name, bytes), (_, to)) in files.iter().zip(renames) {
        let rewritten = if name == entry {
            let text = std::str::from_utf8(bytes).map_err(|_| WriteFailure::NotText);
            match text {
                Ok(text) => rewrite_names(text, renames).into_bytes(),
                Err(failure) => {
                    outcome = Err(failure);
                    break;
                }
            }
        } else {
            bytes.clone()
        };
        let destination = target.join(to);
        match write_new(&destination, &rewritten) {
            Ok(()) => created.push(destination),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                outcome = Err(WriteFailure::NameTaken);
                break;
            }
            Err(error) => {
                // A file may exist half written.
                let _ = fs::remove_file(&destination);
                outcome = Err(WriteFailure::Other(err(error)));
                break;
            }
        }
    }
    if outcome.is_err() {
        for path in created {
            let _ = fs::remove_file(path);
        }
    }
    outcome
}

enum WriteFailure {
    NameTaken,
    NotText,
    Other(String),
}

/// `text` with each whole file name of `renames` replaced: a name preceded
/// by a letter, digit, `_` or `-` is part of a longer name and kept.
fn rewrite_names(text: &str, renames: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (from, to) in renames.iter().filter(|(from, to)| from != to) {
        let mut next = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(index) = rest.find(from.as_str()) {
            let joined = rest[..index]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            next.push_str(&rest[..index]);
            next.push_str(if joined { from } else { to });
            rest = &rest[index + from.len()..];
        }
        next.push_str(rest);
        out = next;
    }
    out
}

/// Copy a pasted figure into `target_directory` (created when missing).
pub fn import_editable_figure(
    root: &Path, manifest: &FigureManifest, target_directory: &str,
) -> Result<ImportedFigure, String> {
    if manifest.version != 1 {
        return Err(
            "This figure was made for a newer version of the editable-figure format.".to_string()
        );
    }
    validate_user_entry(target_directory)?;
    let files: Vec<&FigureFile> =
        std::iter::once(&manifest.source).chain(&manifest.outputs).collect();
    let mut named = Vec::with_capacity(files.len());
    let mut budget = MAX_FIGURE_BYTES;
    for file in &files {
        named.push((file_name_of(file)?, bytes_of(file, &mut budget)?));
    }
    let entry = validate_entry_name(&manifest.entry)
        .map_err(|_| "The figure names no file to include.".to_string())?;
    if !named[1..].iter().any(|(name, _)| name == entry) {
        return Err("The figure's file to include is not among its files.".to_string());
    }
    check_types(&named, entry)?;
    let packages: Vec<String> = manifest
        .packages
        .iter()
        .filter(|name| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        .cloned()
        .collect();

    let target = safe_path(root, target_directory)?;
    fs::create_dir_all(&target).map_err(err)?;
    let stem =
        Path::new(entry).file_stem().and_then(|stem| stem.to_str()).unwrap_or("figure").to_string();
    let names: Vec<&str> = named.iter().map(|(name, _)| name.as_str()).collect();
    let canonical_root = root.canonicalize().map_err(err)?;
    let directory = relative_to(&canonical_root, &target.canonicalize().map_err(err)?)?;
    for _ in 0..WRITE_ATTEMPTS {
        let (next, renames) = plan_names(root, &target, &names, &stem)?;
        match write_all_new(&target, &named, entry, &renames) {
            Ok(()) => {
                let source = relative_to(&canonical_root, &target.join(&renames[0].1))?;
                return Ok(ImportedFigure {
                    directory,
                    entry: renamed(entry, &stem, &next),
                    source,
                    packages,
                });
            }
            // Something took a name since it was chosen: choose again.
            Err(WriteFailure::NameTaken) => continue,
            Err(WriteFailure::NotText) => {
                return Err("The figure's file to include is not text.".to_string())
            }
            Err(WriteFailure::Other(message)) => return Err(message),
        }
    }
    Err(NO_FREE_NAME.to_string())
}

/// A figure's source file, inside the project, and how to show it: a drawing
/// format opens, SVG opens when `agreed`, anything else is only revealed in
/// the file manager.
pub fn figure_source_to_open(
    root: &Path, source: &str, agreed: bool,
) -> Result<FigureSourceOpening, String> {
    let path = safe_path(root, source)?;
    if !path.is_file() {
        return Err(format!("{source} could not be found."));
    }
    let kind = extension_of(&path);
    Ok(if DRAWING_EXTENSIONS.contains(&kind.as_str()) || (kind == "svg" && agreed) {
        FigureSourceOpening::Open(path)
    } else if kind == "svg" {
        FigureSourceOpening::Ask
    } else {
        FigureSourceOpening::Reveal(path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    const ENTRY: &str = "% editable-figure source: scheme.reactio\n\\includegraphics{scheme.pdf}\n% myscheme.pdf stays\n";

    fn inline(name: &str, body: &str) -> FigureFile {
        FigureFile { name: name.into(), data: STANDARD.encode(body) }
    }

    fn manifest() -> FigureManifest {
        FigureManifest {
            version: 1,
            source: inline("scheme.reactio", "{}"),
            outputs: vec![inline("scheme.pdf", "%PDF-1.4"), inline("scheme.tex", ENTRY)],
            entry: "scheme.tex".into(),
            packages: vec!["graphicx".into(), "tikz".into(), "bad}pkg".into()],
        }
    }

    #[test]
    fn copies_the_files_into_the_folder() {
        let fixture = Fixture::folder("figure-copy", "paper");
        let imported = import_editable_figure(&fixture.root, &manifest(), "figures").unwrap();
        assert_eq!(
            imported,
            ImportedFigure {
                directory: "figures".into(),
                entry: "scheme.tex".into(),
                source: "figures/scheme.reactio".into(),
                packages: vec!["graphicx".into(), "tikz".into()],
            }
        );
        assert_eq!(fixture.read("figures/scheme.tex"), ENTRY);
        assert_eq!(fixture.read("figures/scheme.pdf"), "%PDF-1.4");
        assert_eq!(fixture.read("figures/scheme.reactio"), "{}");
    }

    #[test]
    fn a_second_paste_takes_a_new_name_for_every_file() {
        let fixture = Fixture::folder("figure-rename", "paper");
        fixture.write("figures/scheme.pdf", "older");
        let imported = import_editable_figure(&fixture.root, &manifest(), "figures").unwrap();
        assert_eq!(imported.entry, "scheme-2.tex");
        assert_eq!(imported.source, "figures/scheme-2.reactio");
        assert_eq!(fixture.read("figures/scheme.pdf"), "older");
        assert_eq!(
            fixture.read("figures/scheme-2.tex"),
            "% editable-figure source: scheme-2.reactio\n\\includegraphics{scheme-2.pdf}\n% myscheme.pdf stays\n"
        );
    }

    #[test]
    fn pasting_a_source_outside_the_shared_name_twice_finishes() {
        let fixture = Fixture::folder("figure-other-stem", "paper");
        let entry =
            "% editable-figure source: Document 1.reactio\n\\includegraphics{Document_1.pdf}\n";
        let paste = FigureManifest {
            version: 1,
            source: inline("Document 1.reactio", "{}"),
            outputs: vec![inline("Document_1.pdf", "%PDF-1.4"), inline("Document_1.tex", entry)],
            entry: "Document_1.tex".into(),
            packages: vec![],
        };
        import_editable_figure(&fixture.root, &paste, "figures").unwrap();
        let second = import_editable_figure(&fixture.root, &paste, "figures").unwrap();
        assert_eq!(second.entry, "Document_1-2.tex");
        assert_eq!(second.source, "figures/Document 1-2.reactio");
        assert_eq!(
            fixture.read("figures/Document_1-2.tex"),
            "% editable-figure source: Document 1-2.reactio\n\\includegraphics{Document_1-2.pdf}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_link_is_a_taken_name_and_is_not_followed() {
        let fixture = Fixture::folder("figure-link", "paper");
        fs::create_dir_all(fixture.path("figures")).unwrap();
        let outside = fixture.root.parent().unwrap().join("figure-link-outside.pdf");
        let _ = fs::remove_file(&outside);
        std::os::unix::fs::symlink(&outside, fixture.path("figures/scheme.pdf")).unwrap();
        let imported = import_editable_figure(&fixture.root, &manifest(), "figures").unwrap();
        assert_eq!(imported.entry, "scheme-2.tex");
        assert!(!outside.exists());
    }

    #[test]
    fn a_name_taken_while_writing_leaves_nothing_of_that_try() {
        let fixture = Fixture::folder("figure-race", "paper");
        fixture.write("figures/b.pdf", "older");
        let files = vec![("a.reactio".to_string(), vec![1]), ("b.pdf".to_string(), vec![2])];
        let renames = vec![
            ("a.reactio".to_string(), "a.reactio".to_string()),
            ("b.pdf".to_string(), "b.pdf".to_string()),
        ];
        let result = write_all_new(&fixture.path("figures"), &files, "none", &renames);
        assert!(matches!(result, Err(WriteFailure::NameTaken)));
        assert!(!fixture.path("figures/a.reactio").exists());
        assert_eq!(fixture.read("figures/b.pdf"), "older");
    }

    #[test]
    fn refuses_unsafe_names_and_newer_versions() {
        let fixture = Fixture::folder("figure-refuse", "paper");
        let mut bad = manifest();
        bad.outputs[0] = inline("../escape.pdf", "");
        assert!(import_editable_figure(&fixture.root, &bad, "figures").is_err());
        let mut newer = manifest();
        newer.version = 2;
        assert!(import_editable_figure(&fixture.root, &newer, "figures").is_err());
        let mut missing = manifest();
        missing.entry = "other.tex".into();
        assert!(import_editable_figure(&fixture.root, &missing, "figures").is_err());
        assert!(import_editable_figure(&fixture.root, &manifest(), "../out").is_err());
        assert!(!fixture.path("figures/escape.pdf").exists());
    }

    #[test]
    fn a_manifest_cannot_name_a_path_on_disk() {
        let json = r#"{"version":1,"source":{"path":"/Users/me/.ssh/id_ed25519"},"outputs":[],"entry":"a.tex"}"#;
        assert!(serde_json::from_str::<FigureManifest>(json).is_err());
    }

    #[test]
    fn only_figure_file_types_come_in() {
        let fixture = Fixture::folder("figure-types", "paper");
        let refused = |change: &dyn Fn(&mut FigureManifest)| {
            let mut paste = manifest();
            change(&mut paste);
            import_editable_figure(&fixture.root, &paste, "figures").is_err()
        };
        assert!(refused(&|paste| paste.source = inline("run.command", "x")));
        assert!(refused(&|paste| paste.source = inline("open-me.inetloc", "<plist/>")));
        assert!(refused(&|paste| paste.outputs[0] = inline("run.command", "#!/bin/sh")));
        assert!(refused(&|paste| paste.source = inline("scheme.tex", "x")));
        assert!(refused(&|paste| paste.outputs[0] = inline("scheme.html", "x")));
        assert!(refused(&|paste| {
            paste.outputs[0] = inline("scheme.png", "x");
            paste.entry = "scheme.png".into();
        }));
        assert!(!fixture.path("figures").join("run.command").exists());
        assert!(!fixture.path("figures").join("open-me.inetloc").exists());
        let mut drawing = manifest();
        drawing.source = inline("scheme.svg", "<svg/>");
        assert!(import_editable_figure(&fixture.root, &drawing, "figures").is_ok());
    }

    #[test]
    fn caps_what_a_figure_carries() {
        let mut budget = 3;
        assert_eq!(bytes_of(&inline("a", "abc"), &mut budget).unwrap(), b"abc");
        assert_eq!(budget, 0);
        assert!(bytes_of(&inline("b", "d"), &mut budget).is_err());
        assert!(bytes_of(&inline("c", "abcdefghijklmnop"), &mut 3).is_err());
    }

    #[test]
    fn a_name_taken_in_the_project_root_is_left_alone() {
        let fixture = Fixture::folder("figure-root-clash", "paper");
        fixture.write("scheme.pdf", "%PDF-other");
        let imported = import_editable_figure(&fixture.root, &manifest(), "figures").unwrap();
        assert_eq!(imported.entry, "scheme-2.tex");
        assert_eq!(fixture.read("scheme.pdf"), "%PDF-other");
    }

    #[test]
    fn opens_drawings_asks_for_svg_and_only_reveals_the_rest() {
        let fixture = Fixture::project("figure-open");
        fs::create_dir_all(fixture.root.join("figures")).unwrap();
        let names = "a.reactio b.DRAWIO c.svg d.fileloc open-me.inetloc run.command binary";
        for name in names.split(' ') {
            fs::write(fixture.root.join("figures").join(name), "x").unwrap();
        }
        let shown = |name: &str, agreed| figure_source_to_open(&fixture.root, name, agreed);
        let opens = |name, agreed| matches!(shown(name, agreed), Ok(FigureSourceOpening::Open(_)));
        assert!(opens("figures/a.reactio", false) && opens("figures/b.DRAWIO", false));
        assert_eq!(shown("figures/c.svg", false), Ok(FigureSourceOpening::Ask));
        assert!(opens("figures/c.svg", true));
        for name in ["d.fileloc", "open-me.inetloc", "run.command", "binary"] {
            for agreed in [false, true] {
                let shown = shown(&format!("figures/{name}"), agreed);
                assert!(matches!(shown, Ok(FigureSourceOpening::Reveal(_))), "{name}");
            }
        }
        assert!(shown("figures/missing.reactio", false).is_err());
        assert!(shown("../a.reactio", true).is_err());
    }
}
