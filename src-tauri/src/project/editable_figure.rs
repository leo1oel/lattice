//! Editable external figures: a drawing program's source file and the files
//! it rendered from it (a PDF and the `.tex` that includes it), named by the
//! manifest it put on the clipboard (docs/editable-figures.md). They are
//! copied into one project folder under one shared name, so the entry file's
//! references to its siblings still hold after a rename.

use super::paths::{
    available_path, relative_to, safe_path, validate_entry_name, validate_user_entry,
};
use crate::util::err;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Larger files are refused rather than read whole into memory.
const MAX_FIGURE_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The file types figures are drawn in, opened without asking.
const DRAWING_EXTENSIONS: [&str; 10] =
    ["reactio", "cdxml", "cdx", "svg", "drawio", "dio", "ipe", "excalidraw", "ggb", "odg"];

/// Never opened from a figure: a project can come from anyone and its `.tex`
/// names the file, so it must not be able to run something.
const RUNNABLE_EXTENSIONS: [&str; 45] = [
    "app",
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msix",
    "scr",
    "cpl",
    "dll",
    "so",
    "dylib",
    "bin",
    "run",
    "sh",
    "bash",
    "zsh",
    "fish",
    "csh",
    "ksh",
    "command",
    "tool",
    "ps1",
    "py",
    "pyw",
    "pl",
    "rb",
    "php",
    "js",
    "mjs",
    "cjs",
    "vbs",
    "vbe",
    "wsf",
    "hta",
    "jar",
    "scpt",
    "applescript",
    "workflow",
    "action",
    "terminal",
    "url",
    "webloc",
    "desktop",
    "lnk",
];

/// What opening a figure's source file takes.
#[derive(Debug, PartialEq)]
enum SourceKind {
    Drawing,
    AskFirst,
    Refused,
}

/// By extension, whatever its case; a file with none may be a program.
fn source_kind(path: &Path) -> SourceKind {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return SourceKind::Refused;
    };
    let extension = extension.to_ascii_lowercase();
    if DRAWING_EXTENSIONS.contains(&extension.as_str()) {
        SourceKind::Drawing
    } else if RUNNABLE_EXTENSIONS.contains(&extension.as_str())
        || matches!(extension.as_str(), "html" | "htm" | "xhtml" | "pkg" | "dmg" | "deb" | "rpm")
        || extension == "appimage"
    {
        SourceKind::Refused
    } else {
        SourceKind::AskFirst
    }
}

/// One file of a figure: a path on disk, or its name and base64 bytes (from
/// a source that cannot write files, such as a web page).
#[derive(Debug, Clone, Deserialize)]
pub struct FigureFile {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
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
    let name = match (&file.path, &file.name) {
        (Some(path), _) => Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        (None, Some(name)) => name.clone(),
        (None, None) => String::new(),
    };
    validate_entry_name(&name)
        .map(str::to_string)
        .map_err(|_| "The figure names a file without a usable name.".to_string())
}

fn bytes_of(file: &FigureFile) -> Result<Vec<u8>, String> {
    if let Some(path) = &file.path {
        let path = Path::new(path);
        let size =
            fs::metadata(path).map_err(|_| format!("{} could not be read.", path.display()))?.len();
        if !path.is_absolute() || !path.is_file() {
            return Err(format!("{} could not be read.", path.display()));
        }
        if size > MAX_FIGURE_FILE_BYTES {
            return Err(format!("{} is too large to import.", path.display()));
        }
        return fs::read(path).map_err(err);
    }
    let data = file.data.as_deref().ok_or("The figure names a file without its contents.")?;
    STANDARD.decode(data.trim()).map_err(|error| format!("Could not decode the figure: {error}"))
}

/// `name` with `stem` swapped for `next` when it starts with `stem.`.
fn renamed(name: &str, stem: &str, next: &str) -> String {
    match name.strip_prefix(stem).filter(|rest| rest.starts_with('.')) {
        Some(rest) => format!("{next}{rest}"),
        None => name.to_string(),
    }
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
    for file in &files {
        named.push((file_name_of(file)?, bytes_of(file)?));
    }
    let entry = validate_entry_name(&manifest.entry)
        .map_err(|_| "The figure names no file to include.".to_string())?;
    if !named[1..].iter().any(|(name, _)| name == entry) {
        return Err("The figure's file to include is not among its files.".to_string());
    }
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
    // One name for the whole set: the first `stem`, `stem-2`, … that none of its files has yet.
    let stem =
        Path::new(entry).file_stem().and_then(|stem| stem.to_str()).unwrap_or("figure").to_string();
    let next = std::iter::once(stem.clone())
        .chain((2..).map(|number| format!("{stem}-{number}")))
        .find(|candidate| {
            named.iter().all(|(name, _)| {
                let file = renamed(name, &stem, candidate);
                // LaTeX looks in the project root before `\\graphicspath`.
                !target.join(&file).exists() && !root.join(&file).exists()
            })
        })
        .expect("an unbounded suffix search always finds a free name");
    let mut renames: Vec<(String, String)> =
        named.iter().map(|(name, _)| (name.clone(), renamed(name, &stem, &next))).collect();
    // A file outside the shared name keeps its own, made free on its own.
    let mut reserved = BTreeSet::<PathBuf>::new();
    for (from, to) in renames.iter_mut() {
        if to == from && target.join(&*to).exists() {
            let free = available_path(&target, from.as_str(), true, &reserved);
            *to = free
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(from.as_str())
                .to_string();
        }
        reserved.insert(target.join(&*to));
    }
    let canonical_root = root.canonicalize().map_err(err)?;
    let mut written = Vec::with_capacity(named.len());
    for ((name, bytes), (_, to)) in named.iter().zip(&renames) {
        let bytes = if name == entry {
            let text = String::from_utf8(bytes.clone())
                .map_err(|_| "The figure's file to include is not text.".to_string())?;
            rewrite_names(&text, &renames).into_bytes()
        } else {
            bytes.clone()
        };
        let destination = target.join(to);
        fs::write(&destination, bytes).map_err(err)?;
        written.push(relative_to(&canonical_root, &destination)?);
    }
    let directory = relative_to(&canonical_root, &target.canonicalize().map_err(err)?)?;
    Ok(ImportedFigure {
        directory,
        entry: renamed(entry, &stem, &next),
        source: written[0].clone(),
        packages,
    })
}

/// A figure's source file, inside the project and safe to open; `None` when
/// its type needs the person's say-so, which `allow_other` carries.
pub fn figure_source_to_open(
    root: &Path, source: &str, allow_other: bool,
) -> Result<Option<PathBuf>, String> {
    let path = safe_path(root, source)?;
    if !path.is_file() {
        return Err(format!("{source} could not be found."));
    }
    match source_kind(&path) {
        SourceKind::Drawing => Ok(Some(path)),
        SourceKind::AskFirst if allow_other => Ok(Some(path)),
        SourceKind::AskFirst => Ok(None),
        SourceKind::Refused => Err(format!("{source} cannot be opened from a figure.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    const ENTRY: &str = "% editable-figure source: scheme.reactio\n\\includegraphics{scheme.pdf}\n% myscheme.pdf stays\n";

    fn manifest(fixture: &Fixture) -> FigureManifest {
        let at = |name: &str, body: &str| FigureFile {
            path: Some(
                fixture.outside(&format!("drawings/{name}"), body).to_string_lossy().to_string(),
            ),
            name: None,
            data: None,
        };
        FigureManifest {
            version: 1,
            source: at("scheme.reactio", "{}"),
            outputs: vec![at("scheme.pdf", "%PDF-1.4"), at("scheme.tex", ENTRY)],
            entry: "scheme.tex".into(),
            packages: vec!["graphicx".into(), "tikz".into(), "bad}pkg".into()],
        }
    }

    #[test]
    fn copies_the_files_into_the_folder() {
        let fixture = Fixture::folder("figure-copy", "paper");
        let imported =
            import_editable_figure(&fixture.root, &manifest(&fixture), "figures").unwrap();
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
    }

    #[test]
    fn a_second_paste_takes_a_new_name_for_every_file() {
        let fixture = Fixture::folder("figure-rename", "paper");
        fixture.write("figures/scheme.pdf", "older");
        let imported =
            import_editable_figure(&fixture.root, &manifest(&fixture), "figures").unwrap();
        assert_eq!(imported.entry, "scheme-2.tex");
        assert_eq!(imported.source, "figures/scheme-2.reactio");
        assert_eq!(fixture.read("figures/scheme.pdf"), "older");
        assert_eq!(
            fixture.read("figures/scheme-2.tex"),
            "% editable-figure source: scheme-2.reactio\n\\includegraphics{scheme-2.pdf}\n% myscheme.pdf stays\n"
        );
    }

    #[test]
    fn takes_files_carried_in_the_manifest() {
        let fixture = Fixture::folder("figure-inline", "paper");
        let inline = |name: &str, body: &str| FigureFile {
            path: None,
            name: Some(name.into()),
            data: Some(STANDARD.encode(body)),
        };
        let manifest = FigureManifest {
            version: 1,
            source: inline("scheme.reactio", "{}"),
            outputs: vec![inline("scheme.pdf", "%PDF-1.4"), inline("scheme.tex", ENTRY)],
            entry: "scheme.tex".into(),
            packages: vec![],
        };
        import_editable_figure(&fixture.root, &manifest, "figures").unwrap();
        assert_eq!(fixture.read("figures/scheme.reactio"), "{}");
    }

    #[test]
    fn refuses_unsafe_names_and_newer_versions() {
        let fixture = Fixture::folder("figure-refuse", "paper");
        let mut bad = manifest(&fixture);
        bad.outputs[0] = FigureFile {
            path: None,
            name: Some("../escape.pdf".into()),
            data: Some(String::new()),
        };
        assert!(import_editable_figure(&fixture.root, &bad, "figures").is_err());
        let mut newer = manifest(&fixture);
        newer.version = 2;
        assert!(import_editable_figure(&fixture.root, &newer, "figures").is_err());
        let mut missing = manifest(&fixture);
        missing.entry = "other.tex".into();
        assert!(import_editable_figure(&fixture.root, &missing, "figures").is_err());
        assert!(import_editable_figure(&fixture.root, &manifest(&fixture), "../out").is_err());
        assert!(!fixture.path("figures/escape.pdf").exists());
    }

    #[test]
    fn a_name_taken_in_the_project_root_is_left_alone() {
        let fixture = Fixture::folder("figure-root-clash", "paper");
        fixture.write("scheme.pdf", "%PDF-other");
        let imported =
            import_editable_figure(&fixture.root, &manifest(&fixture), "figures").unwrap();
        assert_eq!(imported.entry, "scheme-2.tex");
        assert_eq!(fixture.read("scheme.pdf"), "%PDF-other");
    }

    #[test]
    fn opens_drawings_asks_for_others_and_refuses_programs() {
        let fixture = Fixture::project("figure-open");
        fs::create_dir_all(fixture.root.join("figures")).unwrap();
        for name in ["a.reactio", "b.drawio", "c.AI", "run.command", "tool.PY", "binary"] {
            fs::write(fixture.root.join("figures").join(name), "x").unwrap();
        }
        let open = |name: &str, allow| figure_source_to_open(&fixture.root, name, allow);
        assert!(open("figures/a.reactio", false).unwrap().is_some());
        assert!(open("figures/b.drawio", false).unwrap().is_some());
        assert_eq!(open("figures/c.AI", false), Ok(None));
        assert!(open("figures/c.AI", true).unwrap().is_some());
        assert!(open("figures/run.command", true).is_err());
        assert!(open("figures/tool.PY", true).is_err());
        assert!(open("figures/binary", true).is_err());
        assert!(open("figures/missing.reactio", true).is_err());
        assert!(open("../a.reactio", true).is_err());
    }
}
