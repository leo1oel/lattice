//! What the project defines that the editor's cards and completions read:
//! its citation keys (with each entry's title, authors, venue) and its
//! labels (with what each names), from `lattice-core`'s indexes, the ones
//! the Tauri app's `list_citations` and `list_references` commands return.
//!
//! The index is read off the main thread when the project opens and again
//! after a save or a change on disk; a read that finishes after a newer one
//! started is dropped.
//!
//! Beside them, what the cards' previews read (`latex/previews.rs`): the
//! project's files, for the figure an `\includegraphics` path names, and its
//! TeX sources, for their `\graphicspath` roots and the macros KaTeX sets
//! equations with (`use-latex-structure.ts`'s `macroSources`); and the last
//! build's label numbers ([`ProjectIndex::set_compiled_build`]).

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use crate::latex::{
    compiled_labels::{self, CompiledBuild, CompiledLabel},
    previews::MacroSources,
};

use gpui::{AppContext as _, Context, Task};

/// A bibliography entry, as a citation card shows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Citation {
    pub key: String,
    pub title: String,
    /// The author list as BibTeX writes it, braces kept: `{Google Brain}` is
    /// one name.
    pub authors: String,
    pub year: String,
    pub venue: String,
    pub arxiv_id: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
}

/// A label and what it names, as a reference card shows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reference {
    pub label: String,
    /// `figure`, `table`, `equation`, `section` or `reference`.
    pub kind: String,
    pub title: String,
    pub snippet: String,
    /// Project-relative.
    pub path: String,
    /// 1-based.
    pub line: u32,
    /// A figure's graphic, project-relative, when it names a project file.
    pub image_path: Option<String>,
}

#[derive(Clone, Default)]
struct Loaded {
    citations: Arc<[Citation]>,
    references: Arc<[Reference]>,
    primary_bibliography: Option<String>,
    /// Every file of the project tree, project-relative.
    paths: Arc<[String]>,
    graphics_roots: Arc<[String]>,
    macros: MacroSources,
}

/// The last build's numbers, read once per build.
#[derive(Default)]
struct Compiled {
    build: Option<CompiledBuild>,
    labels: Arc<HashMap<String, CompiledLabel>>,
    reading: Option<Task<()>>,
}

pub struct ProjectIndex {
    root: PathBuf,
    loaded: Loaded,
    /// Bumped by every read; a read that finishes under an older number is
    /// dropped.
    generation: u64,
    loading: Option<Task<()>>,
    compiled: Compiled,
    /// The manuscript's root document, project-relative: a figure's path is
    /// read from its folder first.
    root_document: String,
}

/// How long a burst of saves and file changes settles before the index is
/// read again.
const REFRESH_SETTLE: Duration = Duration::from_millis(400);

impl ProjectIndex {
    /// The index of the project at `root`, read now in the background.
    pub fn new(root: PathBuf, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            root,
            loaded: Loaded::default(),
            generation: 0,
            loading: None,
            compiled: Compiled::default(),
            root_document: String::new(),
        };
        this.read(Duration::ZERO, cx);
        this
    }

    /// Read the index again once things settle (after a save or an outside edit).
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.read(REFRESH_SETTLE, cx);
    }

    fn read(&mut self, settle: Duration, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let root = self.root.clone();
        self.loading = Some(cx.spawn(async move |this, cx| {
            if !settle.is_zero() {
                cx.background_executor().timer(settle).await;
            }
            let loaded = cx.background_spawn(async move { load(&root) }).await;
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    let mut loaded = loaded;
                    // Unchanged sources keep their generation, so the
                    // equations KaTeX set with their macros stay cached.
                    if loaded.macros.sources == this.loaded.macros.sources {
                        loaded.macros = this.loaded.macros.clone();
                    }
                    this.loaded = loaded;
                    this.loading = None;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// A read is under way (the first, when nothing has been read yet).
    pub fn is_loading(&self) -> bool {
        self.loading.is_some()
    }

    pub fn citations(&self) -> &[Citation] {
        &self.loaded.citations
    }

    pub fn references(&self) -> &[Reference] {
        &self.loaded.references
    }

    /// The entry for `key`, matched without regard to case, as BibTeX does.
    pub fn citation(&self, key: &str) -> Option<&Citation> {
        self.loaded
            .citations
            .iter()
            .find(|citation| citation.key.eq_ignore_ascii_case(key))
    }

    /// What `label` names; the last definition wins, as in the Tauri app's
    /// reference card.
    pub fn reference(&self, label: &str) -> Option<&Reference> {
        self.loaded
            .references
            .iter()
            .rev()
            .find(|reference| reference.label == label)
    }

    /// Every file of the project tree, project-relative.
    pub fn paths(&self) -> &[String] {
        &self.loaded.paths
    }

    /// The `\graphicspath` roots the project's sources name.
    pub fn graphics_roots(&self) -> &[String] {
        &self.loaded.graphics_roots
    }

    /// The project's TeX sources, for the macros KaTeX sets its equations with.
    pub fn macro_sources(&self) -> &MacroSources {
        &self.loaded.macros
    }

    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// The manuscript's root document, project-relative; empty before the
    /// host names one.
    pub fn root_document(&self) -> &str {
        &self.root_document
    }

    pub fn set_root_document(&mut self, root: String) {
        self.root_document = root;
    }

    /// The last build that wrote a PDF (`None` before one): its `.aux` files
    /// are read for what it numbered each label, once per build.
    pub fn set_compiled_build(&mut self, build: Option<CompiledBuild>, cx: &mut Context<Self>) {
        if self.compiled.build == build {
            return;
        }
        self.compiled.build = build.clone();
        let Some(build) = build else {
            self.compiled.labels = Arc::default();
            self.compiled.reading = None;
            cx.notify();
            return;
        };
        let root = self.root.clone();
        self.compiled.reading = Some(cx.spawn(async move |this, cx| {
            let wanted = build.clone();
            let labels = cx
                .background_spawn(
                    async move { compiled_labels::read_compiled_labels(&root, &build) },
                )
                .await;
            this.update(cx, |this, cx| {
                if this.compiled.build.as_ref() == Some(&wanted) {
                    this.compiled.labels = Arc::new(labels);
                    this.compiled.reading = None;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// What the last build numbered `label`.
    pub fn compiled_label(&self, label: &str) -> Option<&CompiledLabel> {
        self.compiled.labels.get(label)
    }

    /// Where `key`'s entry is in the primary bibliography: its path and the
    /// 1-based line, read from disk now (`use-source-navigation.ts`'s
    /// `gotoDefinition`).
    pub fn citation_entry(&self, key: &str) -> Option<(String, u32)> {
        let bibliography = self.loaded.primary_bibliography.clone()?;
        let source = std::fs::read_to_string(self.root.join(&bibliography)).ok()?;
        Some((
            bibliography,
            crate::latex::syntax::bibliography_entry_line(&source, key).unwrap_or(1),
        ))
    }
}

fn load(root: &std::path::Path) -> Loaded {
    use lattice_core::project;
    let citations = match project::citations(root) {
        Ok(index) => index
            .citations
            .into_iter()
            .map(|citation| Citation {
                key: citation.key,
                title: citation.title,
                authors: if citation.bibtex_authors.is_empty() {
                    citation.authors
                } else {
                    citation.bibtex_authors
                },
                year: citation.year,
                venue: citation.venue,
                arxiv_id: citation.arxiv_id,
                doi: citation.doi,
                url: citation.url,
            })
            .collect(),
        Err(error) => {
            log::warn!("could not read the project's citation keys: {error}");
            Vec::new()
        }
    };
    let references = match project::references(root) {
        Ok(index) => index
            .references
            .into_iter()
            .map(|reference| Reference {
                label: reference.label,
                kind: reference.kind,
                title: reference.title,
                snippet: reference.snippet,
                path: reference.path,
                line: reference.line,
                image_path: reference.image_path,
            })
            .collect(),
        Err(error) => {
            log::warn!("could not read the project's labels: {error}");
            Vec::new()
        }
    };
    let primary_bibliography = project::read_manifest(root)
        .ok()
        .map(|manifest| manifest.primary_bibliography)
        .filter(|path| !path.is_empty());
    let (paths, sources) = project_files(root);
    Loaded {
        citations: citations.into(),
        references: references.into(),
        primary_bibliography,
        graphics_roots: crate::latex::graphics::graphics_roots(sources.iter().map(String::as_str))
            .into(),
        paths: paths.into(),
        macros: MacroSources::new(sources.into()),
    }
}

/// The most TeX sources read for macros and `\graphicspath`, and the
/// largest: what the Visual Markdown editor's page is given (`markdown.rs`).
const TEX_SOURCES_MAX: usize = 64;
const TEX_SOURCE_BYTES_MAX: u64 = 512 * 1024;

/// The project tree's files, and its TeX sources' text.
fn project_files(root: &std::path::Path) -> (Vec<String>, Vec<String>) {
    use lattice_core::project::{TreeView, read_file, scan_tree, tree_files};
    let tree = match scan_tree(root, TreeView::Project) {
        Ok(tree) => tree,
        Err(error) => {
            log::warn!("could not list the project's files: {error}");
            return Default::default();
        }
    };
    let files = tree_files(&tree);
    let sources = files
        .iter()
        .filter(|node| {
            node.size <= TEX_SOURCE_BYTES_MAX && node.path.to_ascii_lowercase().ends_with(".tex")
        })
        .take(TEX_SOURCES_MAX)
        .filter_map(|node| read_file(root, &node.path).ok())
        .collect();
    (
        files.into_iter().map(|node| node.path.clone()).collect(),
        sources,
    )
}
