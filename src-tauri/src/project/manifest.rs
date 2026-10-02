//! Opening a folder as a project and keeping `.research/project.json` honest:
//! root documents, compile roots, TeX magic comments, and project settings.
//! Also the editor-comments sidecar.

use super::create::{default_brief, default_manifest, Venue, RESEARCH_GITIGNORE};
use super::history::{
    prune_conversation_checkpoints, MAX_CHECKPOINTS_PER_SESSION, MAX_CHECKPOINT_BYTES,
};
use super::paths::safe_path;
use super::tree::{build_artifact_ignore_lines, scan_tree, TreeView};
use crate::models::{ProjectManifest, ProjectSnapshot, RootDocument};
use crate::util::err;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

const MANIFEST_PATH: &str = ".research/project.json";
const EDITOR_COMMENTS_PATH: &str = ".research/editor-comments.json";

pub fn open(root: &Path) -> Result<ProjectSnapshot, String> {
    let root = root.canonicalize().map_err(err)?;
    if !root.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }

    for directory in [".research/history", ".research/papers", ".research/sessions"] {
        fs::create_dir_all(root.join(directory)).map_err(err)?;
    }
    if let Err(error) =
        prune_conversation_checkpoints(&root, MAX_CHECKPOINTS_PER_SESSION, MAX_CHECKPOINT_BYTES)
    {
        eprintln!("Could not prune old conversation checkpoints: {error}");
    }
    let research_ignore = root.join(".research/.gitignore");
    if !research_ignore.exists() {
        fs::write(&research_ignore, RESEARCH_GITIGNORE).map_err(err)?;
    }
    // A folder Lattice did not create gets the same artifact ignores a new
    // project is born with. Version tracking usually starts here, so without
    // them the first commit adopts every .log and .fls in the folder, and from
    // then on each build dirties them and each agent turn diffs them.
    for line in [".research/checkpoints/".to_string(), ".research/cache/".to_string()]
        .into_iter()
        .chain(build_artifact_ignore_lines())
    {
        ensure_ignore_line(&root.join(".gitignore"), &line)?;
    }

    let mut manifest = if root.join(MANIFEST_PATH).exists() {
        read_manifest(&root)?
    } else {
        adopt_folder(&root)?
    };
    if apply_tex_magic_comments(&root, &mut manifest)? {
        write_manifest(&root, &manifest)?;
    }
    if manifest.word_budget.is_none() && manifest.page_budget.is_none() {
        if let Ok(venue) = Venue::parse(&manifest.venue) {
            (manifest.word_budget, manifest.page_budget) = venue.budgets();
            write_manifest(&root, &manifest)?;
        }
    }

    Ok(ProjectSnapshot {
        root: root.to_string_lossy().to_string(),
        manifest,
        files: scan_tree(&root, TreeView::Project)?,
    })
}

/// Write down a manifest for a folder Lattice did not create.
fn adopt_folder(root: &Path) -> Result<ProjectManifest, String> {
    let name = root.file_name().and_then(|value| value.to_str()).unwrap_or("Research project");
    let mut manifest = default_manifest(name);
    // A folder Lattice did not create may hold no LaTeX at all (Markdown
    // notes, say): record no root document rather than invent main.tex.
    match detect_root_document(root) {
        Some(relative) => {
            manifest.root_documents[0].name = document_name(&relative, "Root");
            manifest.root_documents[0].path = relative;
        }
        None => manifest.root_documents.clear(),
    }
    if !root.join("references.bib").exists() {
        if let Some(entry) = WalkDir::new(root)
            .max_depth(3)
            .into_iter()
            .filter_map(Result::ok)
            .find(|entry| entry.path().extension().is_some_and(|ext| ext == "bib"))
        {
            manifest.primary_bibliography =
                entry.path().strip_prefix(root).map_err(err)?.to_string_lossy().to_string();
        }
    }
    write_manifest(root, &manifest)?;
    if !root.join(".research/brief.md").exists() {
        fs::write(root.join(".research/brief.md"), default_brief(name)).map_err(err)?;
    }
    Ok(manifest)
}

pub(super) fn ensure_ignore_line(path: &Path, line: &str) -> Result<(), String> {
    let current = fs::read_to_string(path).unwrap_or_default();
    if current.lines().any(|existing| existing.trim() == line) {
        return Ok(());
    }
    let separator = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    fs::write(path, format!("{current}{separator}{line}\n")).map_err(err)
}

pub fn read_manifest(root: &Path) -> Result<ProjectManifest, String> {
    serde_json::from_str(&fs::read_to_string(root.join(MANIFEST_PATH)).map_err(err)?).map_err(err)
}

pub fn write_manifest(root: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    write_pretty_json(&root.join(MANIFEST_PATH), manifest)
}

/// Pretty JSON plus a trailing newline — the shape of every `.research` file.
pub(super) fn write_pretty_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
}

/// The comments sidecar, empty until the first comment is written.
pub fn read_editor_comments(root: &Path) -> Result<Vec<EditorComment>, String> {
    let path = root.join(EDITOR_COMMENTS_PATH);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(err)?;
    Ok(serde_json::from_str::<EditorCommentsFile>(&raw).map_err(err)?.comments)
}

pub fn write_editor_comments(root: &Path, comments: Vec<EditorComment>) -> Result<(), String> {
    let file = EditorCommentsFile { schema_version: 1, comments };
    write_pretty_json(&root.join(EDITOR_COMMENTS_PATH), &file)
}

/// The document builds compile: the marked default, else the first listed.
pub(super) fn default_root_document(manifest: &ProjectManifest) -> Option<&RootDocument> {
    manifest
        .root_documents
        .iter()
        .find(|document| document.is_default)
        .or_else(|| manifest.root_documents.first())
}

/// Display name of a root document: its file stem, else `fallback`.
fn document_name(relative: &str, fallback: &str) -> String {
    Path::new(relative).file_stem().and_then(|stem| stem.to_str()).unwrap_or(fallback).to_string()
}

/// Make `relative` the only default root document, listing it if it is new.
/// Returns whether the manifest changed.
fn make_default_root(manifest: &mut ProjectManifest, relative: &str, fallback_name: &str) -> bool {
    let mut changed = false;
    if !manifest.root_documents.iter().any(|document| document.path == relative) {
        manifest.root_documents.push(RootDocument {
            path: relative.to_string(),
            name: document_name(relative, fallback_name),
            is_default: false,
        });
        changed = true;
    }
    for document in &mut manifest.root_documents {
        let is_default = document.path == relative;
        changed |= document.is_default != is_default;
        document.is_default = is_default;
    }
    changed
}

/// Honor `% !TEX root=` / `% !TEX program=` style magic comments when present.
fn apply_tex_magic_comments(root: &Path, manifest: &mut ProjectManifest) -> Result<bool, String> {
    let seed = default_root_document(manifest)
        .map_or_else(|| "main.tex".to_string(), |document| document.path.clone());
    let absolute = match safe_path(root, &seed) {
        Ok(path) if path.is_file() => path,
        _ => return Ok(false),
    };
    let hints = parse_tex_magic_comments(&fs::read_to_string(absolute).unwrap_or_default());
    let mut changed = false;
    if let Some(relative) = hints.root {
        if safe_path(root, &relative).is_ok_and(|path| path.is_file()) {
            changed |= make_default_root(manifest, &relative, "Root");
        }
    }
    if let Some(engine) = hints.engine.filter(|engine| *engine != manifest.engine) {
        manifest.engine = engine;
        changed = true;
    }
    Ok(changed)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct TexMagicHints {
    /// Forward-slashed path as written.
    root: Option<String>,
    /// Manifest engine name (`pdf`, `xelatex`, `lualatex`).
    engine: Option<String>,
}

fn parse_tex_magic_comments(content: &str) -> TexMagicHints {
    let mut hints = TexMagicHints::default();
    for line in content.lines().take(40) {
        let trimmed = line.trim();
        let Some(rest) = ["% !TEX", "% !TeX", "%!TEX", "%!TeX"]
            .into_iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
        else {
            continue;
        };
        let Some((key, value)) = rest.trim().trim_start_matches(':').trim().split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "root" => hints.root = Some(value.replace('\\', "/")),
            "program" | "ts-program" => {
                hints.engine = match value.to_ascii_lowercase().as_str() {
                    "xelatex" | "xetex" => Some("xelatex".to_string()),
                    "lualatex" | "luatex" => Some("lualatex".to_string()),
                    "pdflatex" | "latex" | "pdftex" => Some("pdf".to_string()),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    hints
}

pub fn has_latexmkrc(root: &Path) -> bool {
    root.join("latexmkrc").is_file() || root.join(".latexmkrc").is_file()
}

pub fn latexmk_engine_arg(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "xelatex" => "-pdfxe",
        "lualatex" => "-pdflua",
        _ => "-pdf",
    }
}

/// Collapse `.` / `..` segments lexically. `safe_path` refuses `..` outright,
/// but a `% !TEX root = ../main.tex` written in a chapter file is the normal
/// way to name a root one directory up — resolve it here first, and refuse
/// only paths that climb above the project root (`pop` on an empty stack).
fn normalize_relative(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// Which document should a build compile while `open_path` is the file in the
/// editor? Overleaf's rule, extended with TeX magic comments: a `% !TEX root=`
/// in the open file wins, then the open file itself if it declares a document
/// class. `None` means the open file casts no vote (a chapter, a style file,
/// Markdown) and the manifest default stands.
pub fn resolve_compile_root(root: &Path, open_path: &str) -> Option<String> {
    let relative = open_path.trim().replace('\\', "/");
    if !relative.to_ascii_lowercase().ends_with(".tex") {
        return None;
    }
    let absolute = safe_path(root, &relative).ok()?;
    if !absolute.is_file() {
        return None;
    }
    let content = fs::read_to_string(&absolute).ok()?;
    if let Some(magic) = parse_tex_magic_comments(&content).root {
        let parent = Path::new(&relative).parent().and_then(|value| value.to_str()).unwrap_or("");
        // The TeX convention resolves the magic path against the file that
        // declares it; project-root-relative comes second because that is what
        // `apply_tex_magic_comments` has always accepted.
        let candidates =
            [normalize_relative(&format!("{parent}/{magic}")), normalize_relative(&magic)];
        if let Some(candidate) = candidates.into_iter().flatten().find(|candidate| {
            candidate.to_ascii_lowercase().ends_with(".tex")
                && safe_path(root, candidate).is_ok_and(|path| path.is_file())
        }) {
            return Some(candidate);
        }
    }
    declares_document_class(&content).then_some(relative)
}

/// A `\documentclass` on any line, ignoring what follows an unescaped `%` so a
/// commented-out preamble in a chapter file does not turn it into a root.
fn declares_document_class(content: &str) -> bool {
    content.lines().any(|line| line.split('%').next().unwrap_or("").contains("\\documentclass"))
}

/// Record `path` as the document builds compile from now on, upserting it into
/// the root-documents list. Written to the manifest rather than kept as a
/// one-shot override so everything that resolves the default root — the PDF
/// preview, SyncTeX, clean, the outline, the next session — follows the
/// document that was actually built.
pub fn set_compile_root(root: &Path, path: &str) -> Result<ProjectManifest, String> {
    let relative = path.trim().replace('\\', "/");
    let mut manifest = read_manifest(root)?;
    if manifest
        .root_documents
        .iter()
        .any(|document| document.is_default && document.path == relative)
    {
        return Ok(manifest);
    }
    make_default_root(&mut manifest, &relative, &relative);
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// Pick the best root `.tex` for foreign / Overleaf-style trees.
fn detect_root_document(root: &Path) -> Option<String> {
    let tex_files = || {
        WalkDir::new(root).max_depth(4).into_iter().filter_map(Result::ok).filter(|entry| {
            entry.path().is_file() && entry.path().extension().is_some_and(|ext| ext == "tex")
        })
    };
    // Honor `% !TEX root=` first when it points at a real file.
    for entry in tex_files() {
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        if let Some(candidate) = parse_tex_magic_comments(&content).root {
            if safe_path(root, &candidate).is_ok_and(|path| path.is_file()) {
                return Some(candidate);
            }
        }
    }

    let mut best: Option<(i32, String)> = None;
    for entry in tex_files() {
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        let content = fs::read_to_string(path).unwrap_or_default();
        let file_name =
            path.file_name().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        let mut score = match file_name.as_str() {
            "main.tex" => 120,
            "paper.tex" | "manuscript.tex" | "root.tex" | "article.tex" => 90,
            _ => 0,
        };
        if content.contains("\\documentclass") {
            score += 80;
        }
        // A conflict copy is byte-identical to the real file when it is made,
        // so on score alone it can win the tie and quietly become the document
        // that gets compiled — edits to the real file then never reach the PDF.
        if crate::overleaf::is_conflict_copy(&file_name) {
            score -= 500;
        }
        if content.contains("\\begin{document}") {
            score += 20;
        }
        // Prefer shallower files when scores tie.
        score -= relative.matches('/').count() as i32 * 3;
        if best.as_ref().is_none_or(|(best_score, _)| score > *best_score) {
            best = Some((score, relative));
        }
    }
    best.map(|(_, path)| path)
}

/// Apply what the settings dialog and budget editor change; `None` keeps a
/// setting and a `Some(None)` budget clears it.
pub fn update_manifest_settings(
    root: &Path, engine: Option<String>, trusted: Option<bool>, word_budget: Option<Option<u32>>,
    page_budget: Option<Option<u32>>,
) -> Result<ProjectManifest, String> {
    let mut manifest = read_manifest(root)?;
    if let Some(engine) = engine {
        let normalized = engine.trim().to_ascii_lowercase();
        if !matches!(normalized.as_str(), "pdf" | "xelatex" | "lualatex") {
            return Err("Choose pdf, xelatex, or lualatex.".to_string());
        }
        manifest.engine = normalized;
    }
    manifest.trusted = trusted.unwrap_or(manifest.trusted);
    manifest.word_budget = word_budget.unwrap_or(manifest.word_budget);
    manifest.page_budget = page_budget.unwrap_or(manifest.page_budget);
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// Replace the project dictionary with single words, unique ignoring ASCII
/// case (the first spelling wins) and sorted.
pub fn set_spelling_words(root: &Path, words: Vec<String>) -> Result<ProjectManifest, String> {
    let mut manifest = read_manifest(root)?;
    let mut normalized: Vec<String> = Vec::new();
    for word in words.iter().map(|word| word.trim()).filter(|word| !word.is_empty()) {
        if word.chars().count() > 80 || word.chars().any(char::is_whitespace) {
            return Err("Project dictionary terms must be single words of at most 80 characters."
                .to_string());
        }
        if !normalized.iter().any(|existing| existing.eq_ignore_ascii_case(word)) {
            normalized.push(word.to_string());
        }
    }
    normalized.sort_by_key(|word| word.to_ascii_lowercase());
    manifest.spelling_words = normalized;
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCommentReply {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorComment {
    pub id: String,
    pub path: String,
    pub from: u32,
    pub to: u32,
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    pub body: String,
    pub author_id: String,
    pub author_name: String,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub replies: Vec<EditorCommentReply>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCommentsFile {
    pub schema_version: u32,
    pub comments: Vec<EditorComment>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;

    const ARTICLE: &str = "\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n";

    fn root_paths(manifest: &ProjectManifest) -> Vec<(&str, bool)> {
        manifest
            .root_documents
            .iter()
            .map(|document| (document.path.as_str(), document.is_default))
            .collect()
    }

    #[test]
    fn opening_a_folder_ignores_the_build_artifacts_it_will_recompile() {
        let fixture = Fixture::folder("adopted-ignores", "imported");
        fixture.write("main.tex", "\\documentclass{article}\n");
        // What an Overleaf import arrives with: a .gitignore that knows nothing about LaTeX.
        fixture.write(".gitignore", "node_modules/\n");

        open(&fixture.root).unwrap();

        let ignore = fixture.read(".gitignore");
        for line in [
            "*.aux",
            "*.log",
            "*.fls",
            "*.fdb_latexmk",
            "*.run.xml",
            "*-SAVE-ERROR",
            "node_modules/",
        ] {
            assert!(
                ignore.lines().any(|existing| existing.trim() == line),
                "{line} missing from {ignore}"
            );
        }
        // Opening twice must not append a second copy of the same rules.
        open(&fixture.root).unwrap();
        assert_eq!(fixture.read(".gitignore"), ignore);
    }

    #[test]
    fn opening_a_folder_claims_only_root_documents_it_has() {
        let fixture = Fixture::folder("markdown-only", "notes");
        fixture.write("ideas.md", "# Ideas\n");
        let roots = || root_paths(&open(&fixture.root).unwrap().manifest).len();
        assert_eq!(roots(), 0);

        // Adding LaTeX later is still detected on the next open.
        fixture.write("paper.tex", ARTICLE);
        fs::remove_file(fixture.path(MANIFEST_PATH)).unwrap();
        let reopened = open(&fixture.root).unwrap();
        assert_eq!(root_paths(&reopened.manifest), vec![("paper.tex", true)]);

        // With a .tex present, a named root that is merely absent is kept.
        write_manifest(&fixture.root, &default_manifest("notes")).unwrap();
        let snapshot = open(&fixture.root).unwrap();
        assert_eq!(root_paths(&snapshot.manifest), vec![("main.tex", true)]);
    }

    #[test]
    fn the_open_file_wins_the_compile_when_it_is_a_root_and_is_recorded() {
        let fixture = Fixture::folder("compile-root", "papers");
        fixture.write("main.tex", ARTICLE);
        fixture.write("second.tex", ARTICLE);
        fixture.write("chapters/intro.tex", "\\section{Intro}\n");
        // A commented-out preamble does not turn a chapter into a root.
        fixture.write("chapters/outro.tex", "% \\documentclass{article}\ntext\n");
        // `../main.tex` is the TeX convention: relative to the declaring file.
        // `safe_path` alone refuses `..`, which is why this needs its own case.
        fixture.write("chapters/one.tex", "% !TEX root = ../main.tex\n\\section{One}\n");
        open(&fixture.root).unwrap();

        for (open_path, compiled) in [
            // The open file declares a document class: it is the compile target.
            ("second.tex", Some("second.tex")),
            // A chapter casts no vote; the manifest default stands.
            ("chapters/intro.tex", None),
            ("chapters/outro.tex", None),
            // Non-.tex files never vote.
            ("notes.md", None),
            ("chapters/one.tex", Some("main.tex")),
        ] {
            assert_eq!(
                resolve_compile_root(&fixture.root, open_path).as_deref(),
                compiled,
                "{open_path}"
            );
        }

        // Recording the compiled document upserts it as the only default.
        let manifest = set_compile_root(&fixture.root, "second.tex").unwrap();
        assert_eq!(root_paths(&manifest), vec![("main.tex", false), ("second.tex", true)]);
        // Written down, not just returned: the next read agrees.
        assert_eq!(root_paths(&read_manifest(&fixture.root).unwrap()), root_paths(&manifest));
        // Re-recording the current default neither duplicates nor reorders.
        let again = set_compile_root(&fixture.root, "second.tex").unwrap();
        assert_eq!(root_paths(&again), root_paths(&manifest));
    }

    #[test]
    fn root_documents_are_detected_from_magic_comments_and_names() {
        for (label, files, expected) in [
            // A byte-identical conflict copy loses to the real file on its name.
            (
                "detect-conflict-copy",
                vec![("neurips_2026.tex", ARTICLE), ("neurips_2026 (local conflict 20260724-1308).tex", ARTICLE)],
                "neurips_2026.tex",
            ),
            (
                "detect-root",
                vec![
                    ("sections/intro.tex", "Intro text\n"),
                    ("paper.tex", "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n"),
                ],
                "paper.tex",
            ),
            (
                "detect-magic-root",
                vec![
                    ("main.tex", "% !TEX root = manuscript.tex\n\\input{manuscript}\n"),
                    ("manuscript.tex", ARTICLE),
                ],
                "manuscript.tex",
            ),
        ] {
            let fixture = Fixture::folder(label, "proj");
            for (path, contents) in files {
                fixture.write(path, contents);
            }
            assert_eq!(detect_root_document(&fixture.root).as_deref(), Some(expected), "{label}");
        }
    }

    #[test]
    fn magic_comments_and_engines_map_to_latexmk_arguments() {
        let hints = parse_tex_magic_comments(
            "% !TEX root = paper.tex\n% !TEX program = xelatex\n\\documentclass{article}\n",
        );
        let expected =
            TexMagicHints { root: Some("paper.tex".into()), engine: Some("xelatex".into()) };
        assert_eq!(hints, expected);
        for (engine, argument) in
            [("pdf", "-pdf"), ("xelatex", "-pdfxe"), ("lualatex", "-pdflua"), ("unknown", "-pdf")]
        {
            assert_eq!(latexmk_engine_arg(engine), argument, "{engine}");
        }
    }

    #[test]
    fn settings_and_the_project_dictionary_can_be_updated() {
        let fixture = Fixture::project("manifest-settings");
        let root = &fixture.root;
        let updated = update_manifest_settings(
            root,
            Some("xelatex".into()),
            Some(true),
            Some(Some(5000)),
            Some(Some(9)),
        )
        .unwrap();
        assert_eq!(updated.engine, "xelatex");
        assert!(updated.trusted);
        assert_eq!((updated.word_budget, updated.page_budget), (Some(5000), Some(9)));
        assert!(update_manifest_settings(root, Some("tectonic".into()), None, None, None).is_err());
        let words = ["TexLab", "VLM", "texlab"].map(String::from).to_vec();
        assert_eq!(set_spelling_words(root, words).unwrap().spelling_words, vec!["TexLab", "VLM"]);
        assert_eq!(read_manifest(root).unwrap().engine, "xelatex");
    }
}
