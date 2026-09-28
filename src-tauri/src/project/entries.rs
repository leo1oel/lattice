//! Creating, renaming, moving, and deleting files and folders from the
//! Project pane, keeping the manifest and search index in step.

use super::err;
use super::history::{
    apply_transaction, new_transaction, persist_transaction, refresh_search_index, HistoryContext,
};
use super::manifest::{default_root_document, read_manifest, write_manifest};
use super::paths::{
    creation_path, extension, safe_path, source_kind, validate_entry_name, validate_user_entry,
};
use super::tree::tex_build_outputs;
use crate::models::FileChange;
use crate::project_fs::ProjectDir;
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
        "New source files must use .tex, .bib, .md, .sty, .cls, .txt, .html, .tsx, .ts, .jsx, .js, .tldr, or .lattice-sheet."
            .to_string()
    })?;
    Ok((path.to_string_lossy().to_string(), seed))
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
    relocate_entry(root, relative, &parent.join(&normalized_name).to_string_lossy())
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
        Path::new(target_directory).join(file_name).to_string_lossy().to_string()
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
    let moved_tex_file = source.is_file()
        && source.extension().is_some_and(|value| value.eq_ignore_ascii_case("tex"));

    let original_manifest = read_manifest(root)?;
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
    if moved_tex_file {
        // A compiled PDF stops looking like a build artifact as soon as its
        // neighboring .tex file moves away, which exposed stale outputs such
        // as root/main.pdf in the project tree. Outputs at both paths are
        // invalid after a source move, so force the next build to recreate
        // them in the correct location.
        for source_path in [relative, destination_relative] {
            if let Err(error) = remove_tex_build_artifacts(root, source_path) {
                eprintln!("Could not remove stale build outputs for {source_path}: {error}");
            }
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
        Ok(suffix) => Path::new(new_path).join(suffix).to_string_lossy().to_string(),
        Err(_) => path.to_string(),
    }
}

pub fn delete_entry(root: &Path, relative: &str) -> Result<(), String> {
    validate_user_entry(relative)?;
    let manifest = read_manifest(root)?;
    let requested = Path::new(relative);
    // Only what a build would actually reach for: every .tex compiled once
    // joins `root_documents`, so guarding all of them made drafts undeletable.
    let compiled = default_root_document(&manifest).map(|document| document.path.as_str());
    if compiled.into_iter().chain([manifest.primary_bibliography.as_str()]).any(|path| {
        let protected = Path::new(path);
        protected == requested || protected.starts_with(requested)
    }) {
        return Err(
            "The document being compiled and its bibliography cannot be deleted.".to_string()
        );
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
    forget_deleted_root_documents(root, relative)
}

/// Drop manifest root documents whose file has just been deleted, so builds and
/// SyncTeX never resolve through a file that is gone. The compiled document is
/// refused above, so the default always survives.
fn forget_deleted_root_documents(root: &Path, deleted: &str) -> Result<(), String> {
    let mut manifest = read_manifest(root)?;
    let deleted_path = Path::new(deleted);
    let before = manifest.root_documents.len();
    manifest.root_documents.retain(|document| !Path::new(&document.path).starts_with(deleted_path));
    if manifest.root_documents.len() == before {
        return Ok(());
    }
    write_manifest(root, &manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::history::history;
    use crate::project::manifest::set_compile_root;
    use crate::project::test_support::Fixture;
    use crate::project::tree::{collab_project_inventory_v2, scan_tree, TreeView};

    fn inventory_has(root: &Path, path: &str, content_kind: &str) -> bool {
        collab_project_inventory_v2(root)
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == path && file.content_kind == content_kind)
    }

    fn tree_kind(root: &Path, path: &str) -> Option<String> {
        let nodes = scan_tree(root, TreeView::Inventory).unwrap();
        nodes.into_iter().find(|node| node.path == path).map(|node| node.kind)
    }

    #[test]
    fn project_entries_can_be_created_and_deleted_but_roots_are_protected() {
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
        // What a build would actually reach for is still refused.
        for protected in ["main.tex", "references.bib"] {
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
    fn project_entries_can_be_renamed_and_moved_and_manifest_paths_follow_them() {
        let fixture = Fixture::project("relocate-project-entries");
        let root = &fixture.root;
        let default_root = || read_manifest(root).unwrap().root_documents[0].path.clone();
        assert_eq!(rename_entry(root, "main.tex", "paper").unwrap(), "paper.tex");
        assert_eq!(default_root(), "paper.tex");
        create_entry(root, "sections/method", "file").unwrap();
        assert_eq!(rename_entry(root, "sections", "chapters").unwrap(), "chapters");
        assert!(fixture.path("chapters/method.tex").exists());
        assert!(rename_entry(root, "paper.tex", "references.bib").is_err());

        assert_eq!(move_entry(root, "paper.tex", "chapters").unwrap(), "chapters/paper.tex");
        assert_eq!(default_root(), "chapters/paper.tex");
        assert_eq!(move_entry(root, "chapters/paper.tex", "").unwrap(), "paper.tex");
        create_entry(root, "chapters/nested", "folder").unwrap();
        assert!(move_entry(root, "chapters", "chapters/nested").is_err());
        assert!(move_entry(root, "paper.tex", ".research").is_err());
    }

    #[test]
    fn moving_a_tex_file_removes_stale_build_outputs_from_both_locations() {
        let fixture = Fixture::project("move-tex-build-outputs");
        let root = &fixture.root;
        create_entry(root, "sections", "folder").unwrap();
        // biber's leftovers are not single extensions, and `main.gz` shares the
        // stem without being an artifact: moving a source must not eat it.
        let stale = ["main.pdf", "main.aux", "main.bcf", "main.run.xml", "main.bbl-SAVE-ERROR"];
        for path in stale.iter().chain(&["main.gz", "sections/main.pdf"]) {
            fixture.write(path, b"stale");
        }

        assert_eq!(move_entry(root, "main.tex", "sections").unwrap(), "sections/main.tex");
        for path in stale.iter().chain(&["sections/main.pdf"]) {
            assert!(!fixture.path(path).exists(), "{path}");
        }
        assert!(fixture.path("main.gz").exists());

        fixture.write("sections/main.pdf", b"compiled nested PDF");
        fixture.write("main.pdf", b"stale root PDF");
        assert_eq!(move_entry(root, "sections/main.tex", "").unwrap(), "main.tex");
        assert!(!fixture.path("sections/main.pdf").exists());
        assert!(!fixture.path("main.pdf").exists());
    }
}
