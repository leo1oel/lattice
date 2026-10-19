//! Local, immutable template snapshots. Only explicitly selected source/assets
//! cross this boundary; project state, hidden files and executable config do not.
use super::{create, manifest, paths};
use crate::models::RootDocument;
use crate::util::err;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FILES: usize = 2000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTemplate {
    pub id: String,
    pub name: String,
    pub source_url: String,
    pub version: String,
    pub files: Vec<String>,
    pub root: String,
    pub engine: String,
    pub preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSource {
    pub files: Vec<String>,
    pub root: String,
    pub engine: String,
}

fn allowed(path: &str) -> bool {
    let path = Path::new(path);
    paths::stays_inside(path)
        && path.components().all(|part| match part {
            std::path::Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            _ => false,
        })
        && matches!(
            path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref(),
            Some(
                "tex"
                    | "bib"
                    | "sty"
                    | "cls"
                    | "bst"
                    | "bbx"
                    | "cbx"
                    | "def"
                    | "clo"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "pdf"
                    | "eps"
                    | "svg"
                    | "otf"
                    | "ttf"
            )
        )
}

// Bound decompression as well as final storage. Do not follow links in folders
// or ZIPs, even when they point at another reusable-looking source file.
fn source_files(source: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let mut total = 0;
    let mut add = |name: String, reader: &mut dyn Read| -> Result<(), String> {
        if !allowed(&name) {
            return Ok(());
        }
        let mut bytes = Vec::new();
        reader.take(MAX_BYTES - total + 1).read_to_end(&mut bytes).map_err(err)?;
        total += bytes.len() as u64;
        if total > MAX_BYTES || files.len() >= MAX_FILES {
            return Err("Templates are limited to 2,000 files and 100 MB.".into());
        }
        if files.insert(name, bytes).is_some() {
            return Err("The template contains duplicate file paths.".into());
        }
        Ok(())
    };
    if source.is_dir() {
        for entry in WalkDir::new(source).follow_links(false).into_iter().filter_entry(|entry| {
            entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
        }) {
            let entry = entry.map_err(err)?;
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry
                .path()
                .strip_prefix(source)
                .map_err(err)?
                .to_str()
                .ok_or("Template paths must be UTF-8.")?
                .to_string();
            if allowed(&name) {
                let path = paths::safe_path(source, &name)?;
                add(name, &mut fs::File::open(path).map_err(err)?)?;
            }
        }
    } else {
        let mut zip = zip::ZipArchive::new(fs::File::open(source).map_err(err)?).map_err(err)?;
        if zip.len() > MAX_FILES {
            return Err("The ZIP has too many entries.".into());
        }
        for index in 0..zip.len() {
            let mut file = zip.by_index(index).map_err(err)?;
            let name =
                super::archive::safe_zip_entry_name(&file).ok_or("Unsafe ZIP entry path.")?;
            if file.is_file() && !file.is_symlink() {
                add(name, &mut file)?;
            }
        }
    }
    Ok(files)
}

pub fn inspect(source: &Path) -> Result<TemplateSource, String> {
    let files = source_files(source)?;
    let saved = manifest::read_manifest(source).ok();
    let root = saved
        .as_ref()
        .and_then(|m| m.root_documents.iter().find(|r| r.is_default))
        .map(|r| r.path.clone())
        .filter(|path| files.contains_key(path))
        .or_else(|| files.keys().find(|path| path.ends_with("main.tex")).cloned())
        .or_else(|| files.keys().find(|path| path.ends_with(".tex")).cloned())
        .ok_or("Choose a folder or ZIP containing LaTeX source files.")?;
    let engine = saved.map(|m| m.engine).unwrap_or_else(|| "pdf".into());
    Ok(TemplateSource { files: files.into_keys().collect(), root, engine })
}

fn template_dir(store: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    Uuid::parse_str(id).map_err(err)?;
    paths::safe_path(store, id)
}

pub fn list(store: &Path) -> Result<Vec<LocalTemplate>, String> {
    if !store.exists() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(store).map_err(err)? {
        let entry = entry.map_err(err)?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if Uuid::parse_str(&id).is_err() {
            continue;
        }
        let path = paths::safe_path(&template_dir(store, &id)?, "template.json")?;
        let item: LocalTemplate =
            serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
        if item.id != id {
            return Err("Template identity does not match its folder.".into());
        }
        items.push(item);
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

fn validate(item: &LocalTemplate) -> Result<(), String> {
    if item.name.trim().is_empty()
        || item.name.chars().count() > 300
        || item.version.chars().count() > 300
    {
        return Err("Enter a template name and a short version.".into());
    }
    if !item.source_url.is_empty() {
        let url = reqwest::Url::parse(&item.source_url).map_err(err)?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Use an HTTP(S) source URL without credentials.".into());
        }
    }
    if !matches!(item.engine.as_str(), "pdf" | "xelatex" | "lualatex")
        || !item.root.ends_with(".tex")
        || !item.files.contains(&item.root)
        || item.files.iter().any(|file| !allowed(file))
        || item.preview.as_ref().is_some_and(|file| !item.files.contains(file))
    {
        return Err(
            "Select the compile root, preview and reusable files, and a supported engine.".into()
        );
    }
    Ok(())
}

pub fn save(store: &Path, source: &Path, mut item: LocalTemplate) -> Result<LocalTemplate, String> {
    validate(&item)?;
    let files = source_files(source)?;
    if item.files.iter().any(|file| !files.contains_key(file)) {
        return Err("A selected source file has disappeared. Review the source again.".into());
    }
    fs::create_dir_all(store).map_err(err)?;
    item.id = Uuid::new_v4().to_string();
    let staging = store.join(format!(".{}", item.id));
    fs::create_dir(&staging).map_err(err)?;
    let result = (|| {
        fs::create_dir(staging.join("files")).map_err(err)?;
        for name in &item.files {
            let dest = paths::creation_path(&staging.join("files"), name)?;
            fs::write(dest, &files[name]).map_err(err)?;
        }
        fs::write(staging.join("template.json"), serde_json::to_vec_pretty(&item).map_err(err)?)
            .map_err(err)?;
        fs::rename(&staging, store.join(&item.id)).map_err(err)?;
        Ok(item)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

pub fn instantiate(
    store: &Path, id: &str, parent: &Path, name: &str,
) -> Result<std::path::PathBuf, String> {
    let folder = template_dir(store, id)?;
    let item: LocalTemplate = serde_json::from_slice(
        &fs::read(paths::safe_path(&folder, "template.json")?).map_err(err)?,
    )
    .map_err(err)?;
    validate(&item)?;
    let files = source_files(&paths::safe_path(&folder, "files")?)?;
    if item.files.iter().any(|file| !files.contains_key(file)) {
        return Err("Template files are missing.".into());
    }
    let name = name.trim();
    if !paths::is_plain_segment(name) {
        return Err("Choose a simple project name without path separators.".into());
    }
    let root = parent.join(name);
    // Claim a fresh directory atomically. Never overwrite an existing project.
    fs::create_dir(&root).map_err(err)?;
    let result = (|| {
        for file in &item.files {
            fs::write(paths::creation_path(&root, file)?, &files[file]).map_err(err)?;
        }
        let mut manifest = create::default_manifest(name);
        manifest.venue = "custom".into();
        manifest.page_budget = None;
        manifest.engine = item.engine;
        manifest.keep_engine = true;
        if let Some(bib) = item.files.iter().find(|file| file.ends_with(".bib")) {
            manifest.primary_bibliography = bib.clone();
        }
        manifest.root_documents = item
            .files
            .iter()
            .filter(|file| {
                **file == item.root
                    || (file.ends_with(".tex")
                        && manifest::declares_document_class(&String::from_utf8_lossy(
                            &files[*file],
                        )))
            })
            .map(|file| RootDocument {
                path: file.clone(),
                name: file.clone(),
                is_default: *file == item.root,
            })
            .collect();
        manifest::write_manifest(&root, &manifest)?;
        Ok(root.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::Fixture;
    use std::io::Write;

    fn template() -> LocalTemplate {
        LocalTemplate {
            id: String::new(),
            name: "实验室模板".into(),
            source_url: "https://example.edu/template".into(),
            version: "2026".into(),
            files: vec![
                "主稿.tex".into(),
                "appendix.tex".into(),
                "poster.tex".into(),
                "figures/图.png".into(),
                "school.cls".into(),
            ],
            root: "主稿.tex".into(),
            engine: "xelatex".into(),
            preview: Some("figures/图.png".into()),
        }
    }

    #[test]
    fn selected_snapshot_creates_independent_projects_and_retains_source_bytes() {
        let fixture = Fixture::empty("local-templates");
        let source = fixture.path("source");
        for (path, body) in [
            ("主稿.tex", "\\documentclass{school}\n中文标题"),
            ("appendix.tex", "附录"),
            ("poster.tex", "% draft\n\\documentclass{article}"),
            ("school.cls", "style"),
            ("figures/图.png", "image"),
            ("old.tex", "private draft"),
            (".research/sessions/session.tex", "private"),
            (".env", "SECRET"),
            ("credentials.json", "private"),
            (".git/config", "private"),
        ] {
            fixture.write(&format!("source/{path}"), body);
        }
        let preview = inspect(&source).unwrap();
        assert_eq!(preview.files.len(), 6);
        let store = fixture.path("templates");
        let saved = save(&store, &source, template()).unwrap();
        assert_eq!(list(&store).unwrap()[0].name, "实验室模板");
        fs::write(source.join("主稿.tex"), "future version").unwrap();
        let a = instantiate(&store, &saved.id, &fixture.root, "稿件一").unwrap();
        let b = instantiate(&store, &saved.id, &fixture.root, "稿件二").unwrap();
        let first = manifest::read_manifest(&a).unwrap();
        let second = manifest::read_manifest(&b).unwrap();
        assert_ne!(first.project_id, second.project_id);
        assert!(!first.trusted);
        assert_eq!(first.engine, "xelatex");
        assert!(first.keep_engine);
        let roots: Vec<_> = first.root_documents.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(roots, ["主稿.tex", "poster.tex"]);
        assert!(a.join("appendix.tex").is_file());
        assert_eq!(first.primary_bibliography, "references.bib");
        assert_eq!(first.root_documents.iter().find(|r| r.is_default).unwrap().path, "主稿.tex");
        assert!(first.page_budget.is_none());
        assert!(!a.join("old.tex").exists());
        assert!(!a.join(".research/sessions").exists());
        assert!(!a.join(".env").exists());
        assert_eq!(fs::read(a.join("主稿.tex")).unwrap(), fs::read(b.join("主稿.tex")).unwrap());
        assert!(fs::read_to_string(a.join("主稿.tex")).unwrap().contains("中文标题"));
        fs::write(a.join("主稿.tex"), "edit one").unwrap();
        assert_ne!(fs::read(a.join("主稿.tex")).unwrap(), fs::read(b.join("主稿.tex")).unwrap());
        assert!(instantiate(&store, &saved.id, &fixture.root, "稿件一").is_err());
        assert_eq!(fs::read_to_string(a.join("主稿.tex")).unwrap(), "edit one");
        let updated = save(&store, &source, template()).unwrap();
        let c = instantiate(&store, &updated.id, &fixture.root, "稿件三").unwrap();
        assert_eq!(fs::read_to_string(c.join("主稿.tex")).unwrap(), "future version");
    }

    #[test]
    fn name_limit_counts_characters_not_bytes() {
        let fixture = Fixture::empty("local-template-name-limit");
        let source = fixture.path("source");
        fixture.write("source/main.tex", "\\documentclass{article}");
        let store = fixture.path("templates");
        let mut item = template();
        item.files = vec!["main.tex".into()];
        item.root = "main.tex".into();
        item.preview = None;
        item.name = "稿".repeat(300);
        assert!(save(&store, &source, item.clone()).is_ok());
        item.name = "稿".repeat(301);
        assert!(save(&store, &source, item).is_err());
    }

    #[test]
    fn zip_review_filters_state_and_rejects_traversal_links_and_missing_roots() {
        let fixture = Fixture::empty("template-zip");
        let path = fixture.path("template.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for name in
            ["paper/main.tex", "paper/.research/notes.tex", "paper/.env", "paper/figure.png"]
        {
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"source").unwrap();
        }
        zip.finish().unwrap();
        let source = inspect(&path).unwrap();
        assert_eq!(source.files, vec!["paper/figure.png", "paper/main.tex"]);
        assert_eq!(source.root, "paper/main.tex");
        let mut item = template();
        item.root = source.root;
        item.files = source.files;
        item.preview = None;
        let store = fixture.path("store");
        let saved = save(&store, &path, item.clone()).unwrap();
        let root = instantiate(&store, &saved.id, &fixture.root, "zip-paper").unwrap();
        assert!(root.join("paper/main.tex").is_file());
        item.files.push("../secret.tex".into());
        assert!(save(&store, &path, item.clone()).is_err());
        item.files.clear();
        assert!(save(&store, &path, item).is_err());
        fixture.write("folder/main.tex", "source");
        std::os::unix::fs::symlink(
            fixture.path("folder/main.tex"),
            fixture.path("folder/link.tex"),
        )
        .unwrap();
        assert_eq!(inspect(&fixture.path("folder")).unwrap().files, vec!["main.tex"]);
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file("../escape.tex", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"source").unwrap();
        zip.finish().unwrap();
        assert!(inspect(&path).is_err());
    }

    #[test]
    fn blank_article_has_no_conference_style_or_budget() {
        let fixture = Fixture::empty("blank-article");
        let root = create::create_with_venue(&fixture.root, "Blank", create::Venue::Blank).unwrap();
        let manifest = manifest::read_manifest(&root).unwrap();
        assert_eq!(manifest.venue, "blank");
        assert!(manifest.page_budget.is_none());
        assert_eq!(manifest.engine, "lualatex");
        // Still free to fall back to pdfLaTeX if the writer adds pdfTeX-only code.
        assert!(!manifest.keep_engine);
        // Nothing LuaLaTeX warns about or rejects: no inputenc/fontenc, no \\pdfoutput.
        let main = fs::read_to_string(root.join("main.tex")).unwrap();
        assert!(main.contains("\\documentclass{article}"));
        for pdftex_only in ["inputenc", "fontenc", "\\pdfoutput"] {
            assert!(!main.contains(pdftex_only), "{pdftex_only}");
        }
        assert!(!root.join("neurips_2026.sty").exists());
    }
}
