//! Creating, renaming, moving, and deleting files and folders from the
//! Project pane, keeping the manifest and search index in step.

use super::deleted_root::forget_deleted_root_documents;
use super::history::{
    apply_transaction, new_transaction, persist_transaction, refresh_search_index, HistoryContext,
};
use super::manifest::{read_manifest, write_manifest};
use super::paths::{
    creation_path, extension, safe_path, source_kind, validate_entry_name, validate_user_entry,
};
use super::tree::tex_build_outputs;
use crate::models::FileChange;
use crate::project_fs::ProjectDir;
use crate::util::err;
use std::fs;
use std::path::Path;

pub fn create_entry(root: &Path, relative: &str, kind: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let (normalized, seed) = match kind {
        "file" => new_source_file(relative).map(|(path, seed)| (path, Some(seed)))?,
        "folder" => (relative.trim().to_string(), None),
        _ => return Err("Choose a source file or folder.".to_string()),
    };
    let path = creation_path(root, &normalized)?;
    if path.exists() {
        return Err("A file or folder already exists at that path.".to_string());
    }
    match seed {
        Some(seed) => {
            let label = format!("Create {normalized}");
            apply_transaction(root, &label, vec![(normalized.clone(), seed.to_string())])?;
        }
        None => fs::create_dir_all(path).map_err(err)?,
    }
    Ok(normalized)
}

/// Where a new source file goes (a bare name becomes `.tex`) and the text it starts with.
fn new_source_file(relative: &str) -> Result<(String, &'static str), String> {
    let path = Path::new(relative.trim());
    let path = if extension(path).is_none() { path.with_extension("tex") } else { path.into() };
    let seed = source_kind(&path).and_then(|kind| kind.seed).ok_or_else(|| {
        "Choose a supported source or configuration extension, such as .tex, .md, .py, .rs, .sh, .json, or .toml."
            .to_string()
    })?;
    Ok((path.to_string_lossy().replace('\\', "/"), seed))
}

const OPEN_SLIDE_DECK_SEED: &str = r#"import type { Page, SlideMeta } from '@open-slide/core';

const Cover: Page = () => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f7f7f5',
      color: '#171717',
    }}
  >
    <h1 style={{ fontSize: 144, letterSpacing: '-0.04em' }}>Untitled deck</h1>
  </div>
);

export const meta: SlideMeta = { title: 'Untitled deck' };
export default [Cover] satisfies Page[];
"#;

/// Create a native open-slide deck as one undoable project transaction.
pub fn create_open_slide_deck(root: &Path, deck_id: &str) -> Result<String, String> {
    let valid_id = !deck_id.is_empty()
        && deck_id != ".research"
        && deck_id.split('-').all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        });
    if !valid_id {
        return Err("Deck ids must use kebab-case letters and numbers.".to_string());
    }

    let deck_directory = format!("slides/{deck_id}");
    let entry = format!("{deck_directory}/index.tsx");
    if root.join(&deck_directory).exists() {
        return Err("A slide deck already exists with that id.".to_string());
    }
    let label = format!("Create open-slide deck {deck_id}");
    if let Err(error) =
        apply_transaction(root, &label, vec![(entry.clone(), OPEN_SLIDE_DECK_SEED.to_string())])
    {
        // atomic_write may have made these parents before a later history
        // failure. Remove only empty directories, preserving concurrent work.
        let _ = fs::remove_dir(root.join(&deck_directory));
        let _ = fs::remove_dir(root.join("slides"));
        return Err(error);
    }
    Ok(entry)
}

/// A user-addressable entry that still exists.
fn existing_entry(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    validate_user_entry(relative)?;
    let source = safe_path(root, relative)?;
    if !source.exists() {
        return Err("That file or folder no longer exists.".to_string());
    }
    Ok(source)
}

pub fn rename_entry(root: &Path, relative: &str, new_name: &str) -> Result<String, String> {
    validate_user_entry(relative)?;
    let requested_name = validate_entry_name(new_name)?;
    let source = existing_entry(root, relative)?;
    // A bare new name keeps the file's extension.
    let normalized_name = match source.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if source.is_file() && Path::new(requested_name).extension().is_none() => {
            format!("{requested_name}.{extension}")
        }
        _ => requested_name.to_string(),
    };
    let parent = Path::new(relative).parent().unwrap_or_else(|| Path::new(""));
    relocate_entry(
        root,
        relative,
        &parent.join(&normalized_name).to_string_lossy().replace('\\', "/"),
    )
}

pub fn move_entry(root: &Path, relative: &str, target_directory: &str) -> Result<String, String> {
    existing_entry(root, relative)?;
    let file_name = Path::new(relative)
        .file_name()
        .ok_or_else(|| "Choose a file or folder to move.".to_string())?;
    let target_directory = target_directory.trim().trim_end_matches(['/', '\\']);
    let destination_relative = if target_directory.is_empty() {
        file_name.to_string_lossy().to_string()
    } else {
        validate_user_entry(target_directory)?;
        if !safe_path(root, target_directory)?.is_dir() {
            return Err("Choose an existing project folder.".to_string());
        }
        Path::new(target_directory).join(file_name).to_string_lossy().replace('\\', "/")
    };
    relocate_entry(root, relative, &destination_relative)
}

fn relocate_entry(
    root: &Path, relative: &str, destination_relative: &str,
) -> Result<String, String> {
    if destination_relative == relative {
        return Ok(destination_relative.to_string());
    }
    validate_user_entry(destination_relative)?;
    let source = existing_entry(root, relative)?;
    if source.is_dir() && Path::new(destination_relative).starts_with(Path::new(relative)) {
        return Err("A folder cannot be moved inside itself.".to_string());
    }
    if safe_path(root, destination_relative)?.exists() {
        return Err("A file or folder already exists with that name.".to_string());
    }
    let original_manifest = read_manifest(root)?;
    // Only a document Lattice has compiled owns the outputs beside it. Any
    // other `.tex` may sit next to a same-named file it never wrote, such as
    // the PDF of a standalone figure or a hand-kept arXiv `.bbl`.
    let moved_compiled_document = source.is_file()
        && original_manifest.root_documents.iter().any(|document| document.path == relative);
    let mut updated_manifest = original_manifest.clone();
    let renamed = |path: &str| renamed_relative_path(path, relative, destination_relative);
    for document in &mut updated_manifest.root_documents {
        document.path = renamed(&document.path);
    }
    updated_manifest.primary_bibliography = renamed(&updated_manifest.primary_bibliography);

    ProjectDir::open(root)?.rename(relative, destination_relative)?;
    if let Err(error) = write_manifest(root, &updated_manifest) {
        if let Ok(project) = ProjectDir::open(root) {
            let _ = project.rename(destination_relative, relative);
        }
        let _ = write_manifest(root, &original_manifest);
        return Err(error);
    }
    if let Err(error) = crate::overleaf::record_relocation(root, relative, destination_relative) {
        ProjectDir::open(root)?.rename(destination_relative, relative)?;
        write_manifest(root, &original_manifest)?;
        return Err(error);
    }
    if moved_compiled_document {
        // A compiled PDF stops looking like a build artifact as soon as its
        // neighboring .tex file moves away, which exposed stale outputs such
        // as root/main.pdf in the project tree. Only the source path is
        // cleared: whatever already sits at the destination was never this
        // document's output, and the next build overwrites it if it is.
        if let Err(error) = remove_tex_build_artifacts(root, relative) {
            eprintln!("Could not remove stale build outputs for {relative}: {error}");
        }
    }
    refresh_search_index(root, &[root.join(relative), root.join(destination_relative)]);
    Ok(destination_relative.to_string())
}

fn remove_tex_build_artifacts(root: &Path, relative: &str) -> Result<(), String> {
    let tex_path = root.join(relative);
    for extension in tex_build_outputs() {
        match fs::remove_file(tex_path.with_extension(extension)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string())
            }
            _ => {}
        }
    }
    Ok(())
}

fn renamed_relative_path(path: &str, old_path: &str, new_path: &str) -> String {
    match Path::new(path).strip_prefix(old_path) {
        Ok(suffix) if suffix.as_os_str().is_empty() => new_path.to_string(),
        Ok(suffix) => Path::new(new_path).join(suffix).to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string(),
    }
}

pub fn delete_entry(root: &Path, relative: &str) -> Result<(), String> {
    validate_user_entry(relative)?;
    let manifest = read_manifest(root)?;
    // The bibliography stays: Add paper and the reference tools write into it.
    // Any .tex may go, the compiled one included (see
    // `forget_deleted_root_documents` for what builds next).
    if Path::new(&manifest.primary_bibliography).starts_with(relative) {
        return Err("The primary bibliography cannot be deleted.".to_string());
    }
    let path = existing_entry(root, relative)?;
    let before = if path.is_dir() { None } else { fs::read_to_string(&path).ok() };
    ProjectDir::open(root)?.remove(relative)?;
    refresh_search_index(root, &[root.join(relative)]);
    if let Some(before) = before {
        let change = FileChange { path: relative.to_string(), before: Some(before), after: None };
        let context = HistoryContext::user("delete", "project");
        let record = new_transaction(&format!("Delete {relative}"), vec![change], context);
        persist_transaction(root, &record)?;
    }
    let mut manifest = read_manifest(root)?;
    if forget_deleted_root_documents(root, &mut manifest, relative) {
        write_manifest(root, &manifest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::history::history;
    use crate::project::manifest::{choose_root_document, default_root_document, set_compile_root};
    use crate::project::test_support::Fixture;
    use crate::project::tree::{scan_tree, tree_files, TreeView};

    fn inventory_has(root: &Path, path: &str, content_kind: &str) -> bool {
        let nodes = scan_tree(root, TreeView::Inventory).unwrap();
        tree_files(&nodes).iter().any(|file| file.path == path && file.content_kind == content_kind)
    }

    fn tree_kind(root: &Path, path: &str) -> Option<String> {
        let nodes = scan_tree(root, TreeView::Inventory).unwrap();
        nodes.into_iter().find(|node| node.path == path).map(|node| node.kind)
    }

    #[test]
    fn project_entries_can_be_created_and_deleted_but_the_bibliography_is_protected() {
        let fixture = Fixture::project("project-entries");
        let root = &fixture.root;
        assert_eq!(create_entry(root, "sections/method", "file").unwrap(), "sections/method.tex");
        create_entry(root, "figures/generated", "folder").unwrap();
        assert!(fixture.path("figures/generated").is_dir());
        // A draft opened during a build joins the root documents, yet stays
        // deletable, and deleting it drops it from the manifest.
        set_compile_root(root, "sections/method.tex").unwrap();
        set_compile_root(root, "main.tex").unwrap();
        assert_eq!(read_manifest(root).unwrap().root_documents.len(), 2);
        delete_entry(root, "sections/method.tex").unwrap();
        assert!(!fixture.path("sections/method.tex").exists());
        let manifest = read_manifest(root).unwrap();
        let roots = manifest.root_documents.iter().map(|document| document.path.as_str());
        assert_eq!(roots.collect::<Vec<_>>(), vec!["main.tex"]);
        // The bibliography, and a folder holding it, is still refused.
        fixture.write("refs/library.bib", "");
        let mut manifest = read_manifest(root).unwrap();
        manifest.primary_bibliography = "refs/library.bib".to_string();
        write_manifest(root, &manifest).unwrap();
        for protected in ["refs/library.bib", "refs"] {
            assert!(delete_entry(root, protected).is_err(), "{protected}");
        }
        assert!(create_entry(root, ".research/private.txt", "file").is_err());
        assert!(create_entry(root, "binary.exe", "file").is_err());
        // Each source kind gets its seed; boards and spreadsheets seed empty
        // because their editors initialize the store themselves.
        for (path, seed, kind) in [
            ("notes.md", "# Notes\n", "markdown"),
            ("extra.bib", "% Bibliography\n", "bib"),
            ("supplement.html", "", "text"),
            ("sketch.tldr", "", "tldr"),
            ("data.lattice-sheet", "", "spreadsheet"),
        ] {
            assert_eq!(create_entry(root, path, "file").unwrap(), path);
            assert_eq!(fixture.read(path), seed, "{path}");
            assert_eq!(tree_kind(root, path).as_deref(), Some(kind), "{path}");
            assert!(inventory_has(root, path, "text"), "{path}");
        }
    }

    fn default_root(root: &Path) -> Option<String> {
        let manifest = read_manifest(root).unwrap();
        default_root_document(&manifest).map(|document| document.path.clone())
    }

    #[test]
    fn the_compiled_document_can_be_deleted_and_the_only_other_full_document_takes_over() {
        let fixture = Fixture::project("delete-compiled-root");
        let root = &fixture.root;
        fixture.write(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\\input{intro}\\end{document}\n",
        );
        fixture.write("intro.tex", "Included by main.\n");
        fixture.write(
            "thesis/thesis.tex",
            "\\documentclass{report}\n\\begin{document}\\end{document}\n",
        );
        // Neither a standalone figure nor an Overleaf conflict copy is a paper.
        fixture.write(
            "figure.tex",
            "\\documentclass{standalone}\n\\begin{document}x\\end{document}\n",
        );
        fixture.write("main (local conflict 2026-11-13 10.00).tex", "\\documentclass{article}\n");
        choose_root_document(root, "main.tex").unwrap();
        assert_eq!(default_root(root).as_deref(), Some("main.tex"));

        delete_entry(root, "main.tex").unwrap();
        assert!(!fixture.path("main.tex").exists());
        assert_eq!(default_root(root).as_deref(), Some("thesis/thesis.tex"));
        // The writer did not choose it, so the open document can still win a build.
        let manifest = read_manifest(root).unwrap();
        assert!(manifest.root_documents.iter().all(|document| !document.chosen));
        // A file the old root included goes like any other.
        delete_entry(root, "intro.tex").unwrap();
        assert!(!fixture.path("intro.tex").exists());
    }

    #[test]
    fn deleting_the_compiled_document_leaves_no_root_when_the_next_one_is_ambiguous() {
        for (label, others) in
            [("delete-root-none", &[][..]), ("delete-root-several", &["a.tex", "b/b.tex"][..])]
        {
            let fixture = Fixture::project(label);
            let root = &fixture.root;
            fixture.write("main.tex", "\\documentclass{article}\n");
            for other in others {
                fixture.write(other, "\\documentclass{article}\n");
            }
            set_compile_root(root, "main.tex").unwrap();
            delete_entry(root, "main.tex").unwrap();
            assert_eq!(default_root(root), None, "{label}");
        }
    }

    #[test]
    fn deleting_the_folder_holding_the_compiled_document_reassigns_it_too() {
        let fixture = Fixture::project("delete-root-folder");
        let root = &fixture.root;
        fixture.write("paper/main.tex", "\\documentclass{article}\n");
        fixture.write("slides.tex", "\\documentclass{beamer}\n");
        fs::remove_file(fixture.path("main.tex")).ok();
        choose_root_document(root, "paper/main.tex").unwrap();
        delete_entry(root, "paper").unwrap();
        assert_eq!(default_root(root).as_deref(), Some("slides.tex"));
    }

    #[test]
    fn code_and_configuration_sources_can_be_created_imported_and_searched() {
        let fixture = Fixture::project("code-config-sources");
        let canonical_root = fixture.root.canonicalize().unwrap();
        let root = &canonical_root;
        for extension in [
            "rs", "go", "c", "cc", "cpp", "h", "hpp", "java", "rb", "pl", "r", "sh", "bash", "zsh",
            "json", "yaml", "yml", "toml", "xml", "css", "scss", "sql", "mjs", "cjs",
        ] {
            let path = format!("src/source.{extension}");
            assert_eq!(create_entry(root, &path, "file").unwrap(), path);
            assert!(inventory_has(root, &path, "text"));
            let content = format!("code_config_fixture_{extension}\n");
            let source =
                fixture.outside(&format!("imported.{}", extension.to_ascii_uppercase()), &content);
            let paths = vec![source.to_string_lossy().to_string()];
            let imported = super::super::import_sources(root, &paths, "src").unwrap();
            assert_eq!(super::super::read_file(root, &imported[0]).unwrap(), content);
            assert!(super::super::search_files(root, &format!("code_config_fixture_{extension}"))
                .unwrap()
                .iter()
                .any(|hit| hit.path == imported[0]));
            assert_eq!(super::super::read_agent_composer_files(&paths).unwrap().len(), 1);
        }
        assert!(create_entry(root, "program.exe", "file").is_err());
        assert!(create_entry(root, "../escape.rs", "file").is_err());
    }

    #[test]
    fn python_sources_can_be_created_imported_read_and_searched() {
        let fixture = Fixture::project("python-sources");
        let canonical_root = fixture.root.canonicalize().unwrap();
        let root = &canonical_root;
        let created = create_entry(root, "scripts/plot.py", "file").unwrap();
        assert_eq!(created, "scripts/plot.py");
        assert_eq!(super::super::read_file(root, &created).unwrap(), "");
        assert!(inventory_has(root, "scripts/plot.py", "text"));

        let content = "def render_figure():\n    return 42\n";
        let source = fixture.outside("analysis.PY", content);
        let sources = vec![source.to_string_lossy().to_string()];
        let imported = super::super::import_sources(root, &sources, "scripts").unwrap();
        assert_eq!(imported, vec!["scripts/analysis.PY"]);
        assert_eq!(super::super::read_file(root, &imported[0]).unwrap(), content);
        assert!(super::super::search_files(root, "render_figure").unwrap().iter().any(|hit| {
            hit.path == "scripts/analysis.PY" && hit.snippet.contains("def render_figure")
        }));
        let attachments = super::super::read_agent_composer_files(&sources).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].mime_type, "text/x-python");
    }

    #[test]
    fn open_slide_decks_are_transactional_native_tsx_sources() {
        let fixture = Fixture::project("open-slide-deck");
        let root = &fixture.root;
        fixture.write("open-slide.config.ts", "export default {};\n");
        fixture.write("slides/.folders.json", "{}\n");

        let entry_path = create_open_slide_deck(root, "research-update-2").unwrap();
        assert_eq!(entry_path, "slides/research-update-2/index.tsx");
        let entry = fixture.read(&entry_path);
        assert!(entry.contains("import type { Page, SlideMeta } from '@open-slide/core'"));
        assert!(entry.contains("export const meta: SlideMeta"));
        assert!(entry.contains("export default [Cover] satisfies Page[]"));
        assert!(!fixture.path("slides/research-update-2/notes.md").exists());
        assert!(inventory_has(root, &entry_path, "text"));
        assert!(inventory_has(root, "open-slide.config.ts", "text"));

        for invalid in [
            "",
            ".research",
            "../escape",
            "deck/name",
            "Deck",
            "deck_name",
            "-deck",
            "deck-",
            "deck--name",
        ] {
            assert!(create_open_slide_deck(root, invalid).is_err(), "{invalid}");
        }
        assert!(create_open_slide_deck(root, "research-update-2").is_err());
        assert_eq!(history(root).unwrap().len(), 1);
    }

    #[test]
    fn renames_and_moves_carry_manifest_paths_and_clear_stale_build_outputs() {
        let fixture = Fixture::project("relocate-project-entries");
        let root = &fixture.root;
        let default_root = || read_manifest(root).unwrap().root_documents[0].path.clone();
        create_entry(root, "sections/method", "file").unwrap();
        // biber's leftovers are not single extensions, and `main.gz` shares the
        // stem without being an artifact: moving a source must not eat it.
        let stale = ["main.pdf", "main.aux", "main.bcf", "main.run.xml", "main.bbl-SAVE-ERROR"];
        for path in stale.iter().chain(&["main.gz", "sections/main.pdf"]) {
            fixture.write(path, b"stale");
        }
        assert_eq!(move_entry(root, "main.tex", "sections").unwrap(), "sections/main.tex");
        assert_eq!(default_root(), "sections/main.tex");
        for path in stale {
            assert!(!fixture.path(path).exists(), "{path}");
        }
        assert!(fixture.path("main.gz").exists());
        // The destination's same-named PDF was never this document's output.
        assert_eq!(fixture.read("sections/main.pdf"), "stale");
        fixture.write("sections/main.pdf", b"compiled nested PDF");
        fixture.write("main.pdf", b"root PDF");
        assert_eq!(move_entry(root, "sections/main.tex", "").unwrap(), "main.tex");
        assert!(!fixture.path("sections/main.pdf").exists());
        assert_eq!(fixture.read("main.pdf"), "root PDF");

        assert_eq!(rename_entry(root, "main.tex", "paper").unwrap(), "paper.tex");
        assert_eq!(default_root(), "paper.tex");
        assert_eq!(rename_entry(root, "sections", "chapters").unwrap(), "chapters");
        assert!(fixture.path("chapters/method.tex").exists());
        assert!(rename_entry(root, "paper.tex", "references.bib").is_err());
        create_entry(root, "chapters/nested", "folder").unwrap();
        assert!(move_entry(root, "chapters", "chapters/nested").is_err());
        assert!(move_entry(root, "paper.tex", ".research").is_err());
    }

    #[test]
    fn renaming_a_source_that_was_never_compiled_keeps_same_named_files() {
        let fixture = Fixture::project("relocate-keeps-figure-outputs");
        let root = &fixture.root;
        // A standalone TikZ figure and the PDF the main document includes.
        fixture.write("figures/plot.tex", b"\\documentclass{standalone}");
        fixture.write("figures/plot.pdf", b"figure");
        assert_eq!(
            rename_entry(root, "figures/plot.tex", "plot-src").unwrap(),
            "figures/plot-src.tex"
        );
        assert_eq!(fixture.read("figures/plot.pdf"), "figure");

        fixture.write("figures/diagram.pdf", b"diagram");
        fixture.write("figures/notes.tex", b"notes");
        assert_eq!(
            rename_entry(root, "figures/notes.tex", "diagram").unwrap(),
            "figures/diagram.tex"
        );
        assert_eq!(fixture.read("figures/diagram.pdf"), "diagram");

        // A hand-kept arXiv bibliography beside a draft that was never built.
        fixture.write("draft.tex", b"draft");
        fixture.write("draft.bbl", b"\\begin{thebibliography}");
        assert_eq!(move_entry(root, "draft.tex", "figures").unwrap(), "figures/draft.tex");
        assert!(fixture.path("draft.bbl").exists());
    }
}
