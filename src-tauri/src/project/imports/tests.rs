use super::*;
use crate::project::test_support::Fixture;

fn paths<P: AsRef<Path>>(files: impl IntoIterator<Item = P>) -> Vec<String> {
    files.into_iter().map(|path| path.as_ref().to_string_lossy().to_string()).collect()
}

/// The tree's import as a drop or paste makes it: taken names keep both.
fn import_files_with_copy(
    root: &Path, sources: &[String], target_directory: &str, copy_existing: bool,
) -> Result<Vec<ImportedProjectFile>, String> {
    let request = ImportRequest {
        sources,
        target_directory,
        copy_existing,
        conflict: Some(NameConflict::KeepBoth),
    };
    super::import_files(root, request, &mut |_, _| {}).map(|import| import.files)
}

fn import_files(
    root: &Path, sources: &[String], target_directory: &str,
) -> Result<Vec<ImportedProjectFile>, String> {
    import_files_with_copy(root, sources, target_directory, false)
}

fn routes(files: &[ImportedProjectFile]) -> Vec<(&str, &str)> {
    files.iter().map(|file| (file.path.as_str(), file.kind.as_str())).collect()
}

#[test]
fn imported_assets_are_copied_renamed_on_collision_and_follow_the_drop_target() {
    let fixture = Fixture::project("import-assets");
    let root = &fixture.root;
    let source = fixture.outside("result.png", b"png-bytes");
    let sources = paths([source]);
    // Dropping on a folder the project does not have yet (opened projects
    // are not guaranteed a "figures" skeleton) creates it; the Project
    // pane background is the project root.
    for (target, imported) in [
        ("figures", "figures/result.png"),
        ("figures", "figures/result-2.png"),
        ("assets", "assets/result.png"),
        ("", "result.png"),
        ("assets/", "assets/result-2.png"),
    ] {
        assert_eq!(import_assets(root, &sources, target).unwrap(), vec![imported], "{target}");
    }
    for target in ["main.tex", ".research"] {
        assert!(import_assets(root, &sources, target).is_err(), "{target}");
    }
    let unsupported = paths([fixture.outside("notes.txt", b"text")]);
    assert!(import_assets(root, &unsupported, "figures").is_err());
}

#[test]
fn agent_composer_files_carry_bytes_for_figures_and_text_sources() {
    let fixture = Fixture::empty("agent-composer-files");
    let sources =
        paths([fixture.outside("plot.png", b"png-bytes"), fixture.outside("notes.md", b"# Notes")]);
    let files = read_agent_composer_files(&sources).unwrap();
    let summary = files
        .iter()
        .map(|file| (file.name.as_str(), file.mime_type.as_str(), file.bytes_base64.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            ("plot.png", "image/png", STANDARD.encode(b"png-bytes")),
            ("notes.md", "text/markdown", STANDARD.encode(b"# Notes")),
        ]
    );
    let error =
        read_agent_composer_files(&paths([fixture.outside("archive.zip", b"zip")])).unwrap_err();
    assert!(error.contains("archive.zip"), "{error}");
    assert!(read_agent_composer_files(&[]).is_err());
}

#[test]
fn copied_project_entries_duplicate_contents_without_overwriting_sources() {
    let fixture = Fixture::project("copy-project-entries");
    let root = &fixture.root;
    fs::create_dir_all(fixture.path("notes/empty")).unwrap();
    fixture.write("notes/draft.tex", "Original draft");
    fixture.write("notes/image.png", [0, 255, 42]);
    let source = paths([fixture.path("notes")]);
    let copied = import_files_with_copy(root, &source, "", true).unwrap();
    assert_eq!(
        routes(&copied),
        vec![("notes-2/draft.tex", "text"), ("notes-2/image.png", "binary")]
    );
    assert_eq!(fixture.read("notes-2/draft.tex"), "Original draft");
    assert_eq!(fs::read(fixture.path("notes-2/image.png")).unwrap(), [0, 255, 42]);
    assert!(fixture.path("notes-2/empty").is_dir());
    assert_eq!(fixture.read("notes/draft.tex"), "Original draft");
    let file = paths([fixture.path("notes/draft.tex")]);
    for (target, copy) in [("notes", "notes/draft-2.tex"), ("notes-2", "notes-2/draft-2.tex")] {
        assert_eq!(import_files_with_copy(root, &file, target, true).unwrap()[0].path, copy);
    }
    let error = import_files_with_copy(root, &source, "notes/empty", true).unwrap_err();
    assert!(error.contains("inside itself"), "{error}");
    assert!(!fixture.path("notes/empty/notes").exists());
}

#[test]
fn imported_files_route_by_content_and_keep_figures_binary() {
    let fixture = Fixture::project("import-any-files");
    let root = &fixture.root;
    let all = paths([
        fixture.outside("data.csv", "a,b\n1,2\n"),
        fixture.outside("bundle.zip", b"PK\x03\x04rest"),
        fixture.outside("sketch.tldr", "{\"tldrawFileFormatVersion\":1}"),
        fixture.outside("data.lattice-sheet", "{}\n"),
        // Text bytes under a figure extension stay on the figure route.
        fixture.outside("diagram.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
    ]);

    let imported = import_files(root, &all, "data").unwrap();
    assert_eq!(
        routes(&imported),
        vec![
            ("data/data.csv", "text"),
            ("data/bundle.zip", "binary"),
            ("data/sketch.tldr", "board"),
            ("data/data.lattice-sheet", "spreadsheet"),
            ("data/diagram.svg", "binary"),
        ]
    );
    assert_eq!(fixture.read("data/data.csv"), "a,b\n1,2\n");
    assert!(fixture.path("data/bundle.zip").is_file());

    // Collisions rename; files already inside the project only register.
    assert_eq!(import_files(root, &all[..1], "data").unwrap()[0].path, "data/data-2.csv");
    let inside = paths([fixture.path("data/data.csv")]);
    assert_eq!(import_files(root, &inside, "").unwrap()[0].path, "data/data.csv");
    assert!(!fixture.path("data.csv").exists());
    for target in [".research", "main.tex"] {
        assert!(import_files(root, &all[..1], target).is_err(), "{target}");
    }
}

#[test]
fn imported_folders_keep_their_visible_hierarchy_without_following_links() {
    let fixture = Fixture::project("import-folder");
    let root = &fixture.root;
    let source =
        fixture.outside("dataset.v1/README.md", "# Dataset\n").parent().unwrap().to_path_buf();
    fs::create_dir_all(source.join("nested/empty")).unwrap();
    fixture.outside("dataset.v1/nested/results.csv", "score\n1\n");
    fixture.outside("dataset.v1/nested/archive.zip", b"PK\x03\x04rest");
    fixture.outside("dataset.v1/.DS_Store", b"metadata");
    fixture.outside("dataset.v1/.cache/private.txt", "private");

    let sources = paths([source]);
    let imported = import_files(root, &sources, "sections").unwrap();
    assert_eq!(
        routes(&imported),
        vec![
            ("sections/dataset.v1/README.md", "text"),
            ("sections/dataset.v1/nested/archive.zip", "binary"),
            ("sections/dataset.v1/nested/results.csv", "text"),
        ]
    );
    assert_eq!(fixture.read("sections/dataset.v1/nested/results.csv"), "score\n1\n");
    assert!(fixture.path("sections/dataset.v1/nested/empty").is_dir());
    assert!(!fixture.path("sections/dataset.v1/.DS_Store").exists());
    assert!(!fixture.path("sections/dataset.v1/.cache").exists());

    let imported_again = import_files(root, &sources, "sections").unwrap();
    assert!(imported_again.iter().all(|file| file.path.starts_with("sections/dataset.v1-2/")));
    assert!(fixture.path("sections/dataset.v1-2/nested/empty").is_dir());

    let error = import_files(root, &paths([&fixture.parent]), "").unwrap_err();
    assert!(error.contains("contains the current project"), "{error}");

    // Symbolic links are never followed, inside a folder or at the top.
    use crate::test_support::symlink;
    let source = fixture.outside("dataset/visible.txt", "visible").parent().unwrap().to_path_buf();
    let secret = fixture.outside("outside/secret.txt", "secret");
    symlink(secret.parent().unwrap(), source.join("linked-directory")).unwrap();
    symlink(&secret, source.join("linked-file")).unwrap();

    let imported = import_files(root, &paths([&source]), "").unwrap();
    assert_eq!(routes(&imported), vec![("dataset/visible.txt", "text")]);
    assert!(!fixture.path("dataset/linked-directory").exists());
    assert!(!fixture.path("dataset/linked-file").exists());

    let top_level_link = fixture.parent.join("linked-dataset");
    symlink(&source, &top_level_link).unwrap();
    let error = import_files(root, &paths([top_level_link]), "").unwrap_err();
    assert!(error.contains("symbolic link"), "{error}");
}

#[test]
fn imported_sources_are_transactional_and_renamed_on_collision() {
    let fixture = Fixture::project("import-sources");
    let root = &fixture.root;
    let source = paths([fixture.outside("notes.tex", "\\section{Imported}\n")]);

    assert_eq!(import_sources(root, &source, "").unwrap(), vec!["notes.tex"]);
    assert_eq!(import_sources(root, &source, "").unwrap(), vec!["notes-2.tex"]);
    assert_eq!(fixture.read("notes.tex"), "\\section{Imported}\n");
    let inside = paths([fixture.path("notes.tex")]);
    assert_eq!(import_sources(root, &inside, "").unwrap(), vec!["notes.tex"]);

    // Boards are text (tldraw JSON) and must import like other sources;
    // the frontend offers them to this path.
    for (name, contents) in
        [("sketch.tldr", "{\"tldrawFileFormatVersion\":1}"), ("data.lattice-sheet", "{}\n")]
    {
        let source = paths([fixture.outside(name, contents)]);
        assert_eq!(import_sources(root, &source, "").unwrap(), vec![name]);
    }
    let unsupported = paths([fixture.outside("result.png", b"png")]);
    assert!(import_sources(root, &unsupported, "").is_err());
    let invalid_utf8 = paths([fixture.outside("invalid.bib", [0xff, 0xfe])]);
    assert!(import_sources(root, &invalid_utf8, "").is_err());
}

#[test]
fn clipboard_images_are_saved_and_byte_writes_skip_paper_bundles() {
    let fixture = Fixture::project("clipboard-image");
    let png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];
    let path =
        import_image_bytes(&fixture.root, "figures", "paste.png", &STANDARD.encode(png)).unwrap();
    assert_eq!(path, "figures/paste.png");
    assert!(fixture.path("figures/paste.png").is_file());

    let error =
        write_bytes(&fixture.root, ".research/papers/2401.00001/paper_assets/figure.png", "QQ==")
            .unwrap_err();
    assert!(error.contains("cannot be written directly"));
}
