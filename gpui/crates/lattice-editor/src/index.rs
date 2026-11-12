//! What the project defines that the editor's cards and completions read:
//! its citation keys (with each entry's title, authors, venue) and its
//! labels (with what each names), from `lattice-core`'s indexes, the ones
//! the Tauri app's `list_citations` and `list_references` commands return.
//!
//! The index is read off the main thread when the project opens and again
//! after a save or a change on disk; a read that finishes after a newer one
//! started is dropped.

use std::{path::PathBuf, sync::Arc, time::Duration};

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
}

#[derive(Clone, Default)]
struct Loaded {
    citations: Arc<[Citation]>,
    references: Arc<[Reference]>,
    primary_bibliography: Option<String>,
}

pub struct ProjectIndex {
    root: PathBuf,
    loaded: Loaded,
    /// Bumped by every read; a read that finishes under an older number is
    /// dropped.
    generation: u64,
    loading: Option<Task<()>>,
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
        };
        this.read(Duration::ZERO, cx);
        this
    }

    /// Read the index again once things settle (after a save or an outside edit).
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.read(REFRESH_SETTLE, cx);
    }

    /// Whether a read is under way.
    pub fn loading(&self) -> bool {
        self.loading.is_some()
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
                    this.loaded = loaded;
                    this.loading = None;
                    cx.notify();
                }
            })
            .ok();
        }));
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
    Loaded {
        citations: citations.into(),
        references: references.into(),
        primary_bibliography,
    }
}
