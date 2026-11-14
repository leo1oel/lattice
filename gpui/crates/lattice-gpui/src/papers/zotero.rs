//! The Zotero library inside Add papers (`zotero-browser.tsx`, `zotero.ts`):
//! its folders as a tree to open and search, and the papers of the folder in
//! view, to tick and add. Lattice finds the library and reads a copy of its
//! database (lattice-core's `zotero`), so nothing needs turning on in Zotero
//! and it works whether or not Zotero is open; a library kept somewhere
//! Lattice cannot find is chosen by its folder.
//!
//! A paper Papers already holds (same DOI, arXiv id or citation key) is
//! marked, and can be ticked only for what it lacks: the annotations its PDF
//! holds in Zotero, which go to its note (`notes.rs`), and its PDF when
//! Papers has none of it. What is added is what is ticked in the list in
//! view: a tick a search or the subfolder switch hides is neither counted
//! nor added, and opening another folder starts with nothing ticked. The
//! ticked papers go to Add papers' queue, each with its PDF attachment and
//! annotations for the import to bring.
//!
//! Each item's BibTeX is read once, with the library; the folder in view's
//! papers are matched against Papers again only when the folder, the
//! subfolder switch or the Papers list changes, and the folders' counts
//! once per read, so a keystroke in a search box redraws without either.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Subscription, Task, Window};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::{
    papers::PaperSummary,
    zotero::{ZoteroCollection, ZoteroLibrary},
};
use lattice_i18n::t;

use super::{
    PapersPanel,
    model::{ReferenceRecord, find_in_library, keeps_no_pdf, parse_pasted_references},
};

pub mod notes;
mod view;

/// One folder row of the tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderRow {
    pub key: String,
    pub name: String,
    pub depth: usize,
    pub has_children: bool,
    pub expanded: bool,
}

fn children_of(collections: &[ZoteroCollection]) -> HashMap<&str, Vec<&str>> {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for collection in collections {
        if let Some(parent) = collection.parent.as_deref() {
            children.entry(parent).or_default().push(&collection.key);
        }
    }
    children
}

/// `folder` and, with `subfolders`, every collection below it.
fn folder_keys<'a>(
    children: &HashMap<&'a str, Vec<&'a str>>,
    folder: &'a str,
    subfolders: bool,
) -> HashSet<&'a str> {
    let mut keys = HashSet::from([folder]);
    if subfolders {
        let mut queue = vec![folder];
        while let Some(key) = queue.pop() {
            for child in children.get(key).into_iter().flatten() {
                if keys.insert(child) {
                    queue.push(child);
                }
            }
        }
    }
    keys
}

/// The items a folder lists, by index, each once: My Library ("") lists
/// them all.
pub fn folder_items(library: &ZoteroLibrary, folder: &str, subfolders: bool) -> Vec<usize> {
    if folder.is_empty() {
        return (0..library.items.len()).collect();
    }
    let children = children_of(&library.collections);
    let keys = folder_keys(&children, folder, subfolders);
    (0..library.items.len())
        .filter(|at| {
            library.items[*at]
                .collections
                .iter()
                .any(|key| keys.contains(key.as_str()))
        })
        .collect()
}

/// How many items each folder lists, as `folder_items` lists them.
pub fn folder_counts(library: &ZoteroLibrary, subfolders: bool) -> HashMap<String, usize> {
    let children = children_of(&library.collections);
    let mut filed: HashMap<&str, Vec<usize>> = HashMap::new();
    for (at, item) in library.items.iter().enumerate() {
        for key in &item.collections {
            filed.entry(key.as_str()).or_default().push(at);
        }
    }
    library
        .collections
        .iter()
        .map(|collection| {
            let keys = folder_keys(&children, &collection.key, subfolders);
            let items: HashSet<usize> = keys
                .iter()
                .filter_map(|key| filed.get(key))
                .flatten()
                .copied()
                .collect();
            (collection.key.clone(), items.len())
        })
        .collect()
}

/// The collections in tree order with their depth; a parent Zotero did not
/// list puts its children at the top.
fn collection_tree(collections: &[ZoteroCollection]) -> Vec<(&ZoteroCollection, usize)> {
    let keys: HashSet<&str> = collections
        .iter()
        .map(|collection| collection.key.as_str())
        .collect();
    let mut children: HashMap<Option<&str>, Vec<&ZoteroCollection>> = HashMap::new();
    for collection in collections {
        let parent = collection
            .parent
            .as_deref()
            .filter(|parent| keys.contains(parent));
        children.entry(parent).or_default().push(collection);
    }
    let mut ordered = Vec::new();
    fn visit<'a>(
        parent: Option<&str>,
        depth: usize,
        children: &HashMap<Option<&str>, Vec<&'a ZoteroCollection>>,
        ordered: &mut Vec<(&'a ZoteroCollection, usize)>,
    ) {
        for collection in children.get(&parent).into_iter().flatten() {
            ordered.push((*collection, depth));
            visit(Some(&collection.key), depth + 1, children, ordered);
        }
    }
    visit(None, 0, &children, &mut ordered);
    ordered
}

/// The folder rows to draw: the tree with only `expanded` folders open, or,
/// for a search, every folder whose name holds `query` with the folders
/// above it, opened so each match shows.
pub fn folder_rows(
    collections: &[ZoteroCollection],
    expanded: &HashSet<String>,
    query: &str,
) -> Vec<FolderRow> {
    let tree = collection_tree(collections);
    let parents: HashSet<&str> = tree
        .iter()
        .filter_map(|(collection, _)| collection.parent.as_deref())
        .collect();
    let needle = query.trim().to_lowercase();
    let row = |collection: &ZoteroCollection, depth: usize, expanded: bool| FolderRow {
        key: collection.key.clone(),
        name: collection.name.clone(),
        depth,
        has_children: parents.contains(collection.key.as_str()),
        expanded,
    };
    if !needle.is_empty() {
        let by_key: HashMap<&str, &ZoteroCollection> = tree
            .iter()
            .map(|(collection, _)| (collection.key.as_str(), *collection))
            .collect();
        let mut shown: HashSet<&str> = HashSet::new();
        for (collection, _) in &tree {
            if !collection.name.to_lowercase().contains(&needle) {
                continue;
            }
            let mut at = Some(*collection);
            while let Some(current) = at {
                if !shown.insert(&current.key) {
                    break;
                }
                at = current
                    .parent
                    .as_deref()
                    .and_then(|parent| by_key.get(parent).copied());
            }
        }
        return tree
            .iter()
            .filter(|(collection, _)| shown.contains(collection.key.as_str()))
            .map(|(collection, depth)| row(collection, *depth, true))
            .collect();
    }
    let mut rows = Vec::new();
    let mut hidden_below = usize::MAX;
    for (collection, depth) in tree {
        if depth > hidden_below {
            continue;
        }
        hidden_below = usize::MAX;
        let open = expanded.contains(&collection.key);
        rows.push(row(collection, depth, open));
        if !open {
            hidden_below = depth;
        }
    }
    rows
}

/// A paper as its row shows it.
#[derive(Clone, Debug)]
pub struct ZoteroPaper {
    /// Its place in the library's items.
    pub item: usize,
    pub citation_key: String,
    pub title: String,
    pub byline: String,
    pub pdf: Option<String>,
    pub annotations: usize,
    /// The paper Papers already holds, if any.
    pub existing: Option<PaperSummary>,
}

impl ZoteroPaper {
    /// A held paper whose Zotero PDF would be its first.
    pub fn brings_pdf(&self) -> bool {
        self.pdf.is_some() && self.existing.as_ref().is_some_and(keeps_no_pdf)
    }

    /// It can be ticked to add it, or, once in Papers, to bring its
    /// annotations or its PDF.
    pub fn can_tick(&self) -> bool {
        self.existing.is_none() || self.annotations > 0 || self.brings_pdf()
    }
}

/// What the browser hands Add papers: the ticked papers, read from the
/// library at `data_dir` (none: the one Lattice found).
pub enum ZoteroBrowserEvent {
    Add {
        papers: Vec<ZoteroPaper>,
        library: Rc<ZoteroLibrary>,
        data_dir: Option<String>,
    },
    Back,
}

pub struct ZoteroBrowser {
    papers: Entity<PapersPanel>,
    pub(super) library: Option<Rc<ZoteroLibrary>>,
    pub(super) error: Option<String>,
    pub(super) chosen_dir: Option<String>,
    pub(super) expanded: HashSet<String>,
    pub(super) folder_query: Entity<InputState>,
    pub(super) paper_query: Entity<InputState>,
    /// The folder in view ("" for My Library); none before one is opened.
    pub(super) folder: Option<String>,
    pub(super) subfolders: bool,
    /// Ticked papers by citation key.
    pub(super) ticked: HashSet<String>,
    /// In a narrow sheet, the papers stand in place of the folders.
    pub(super) papers_pane: bool,
    /// Each item's record, by its place in the library's items.
    records: Vec<Option<ReferenceRecord>>,
    listed: RefCell<Option<Listed>>,
    /// The folders' counts for this read, by the subfolder switch.
    counts: RefCell<HashMap<bool, Rc<HashMap<String, usize>>>>,
    _read: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

/// The folder in view's papers, as matched against the Papers list at
/// `revision`.
struct Listed {
    folder: String,
    subfolders: bool,
    revision: u64,
    papers: Rc<Vec<ZoteroPaper>>,
}

impl EventEmitter<ZoteroBrowserEvent> for ZoteroBrowser {}

impl ZoteroBrowser {
    pub fn new(papers: Entity<PapersPanel>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let folder_query =
            cx.new(|cx| InputState::new(window, cx).placeholder(t!("Search folders")));
        let paper_query = cx.new(|cx| InputState::new(window, cx).placeholder(t!("Search papers")));
        let subscriptions = vec![
            cx.subscribe(&folder_query, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe(&paper_query, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.observe(&papers, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            papers,
            library: None,
            error: None,
            chosen_dir: None,
            expanded: HashSet::new(),
            folder_query,
            paper_query,
            folder: None,
            subfolders: false,
            ticked: HashSet::new(),
            papers_pane: false,
            records: Vec::new(),
            listed: RefCell::default(),
            counts: RefCell::default(),
            _read: None,
            _subscriptions: subscriptions,
        };
        this.read(cx);
        this
    }

    /// One read of one snapshot; opening a folder filters it.
    pub(super) fn read(&mut self, cx: &mut Context<Self>) {
        self.folder = None;
        self.library = None;
        self.error = None;
        self.records.clear();
        self.listed.take();
        self.counts.take();
        let chosen = self.chosen_dir.clone();
        let read = cx.background_spawn(async move {
            let library = lattice_core::zotero::library(chosen.as_deref())?;
            let records: Vec<Option<ReferenceRecord>> = library
                .items
                .iter()
                .map(|item| {
                    parse_pasted_references(&item.bibtex)
                        .into_iter()
                        .next()
                        .and_then(|reference| reference.record)
                })
                .collect();
            Ok::<_, String>((library, records))
        });
        self._read = Some(cx.spawn(async move |this, cx| {
            let library = read.await;
            this.update(cx, |this, cx| {
                match library {
                    Ok((library, records)) => {
                        this.library = Some(Rc::new(library));
                        this.records = records;
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn choose_dir(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(t!("Choose Zotero folder…").into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(dir) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.chosen_dir = Some(dir.to_string_lossy().into_owned());
                this.ticked.clear();
                this.read(cx);
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn open_folder(
        &mut self,
        folder: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.folder.as_deref() != Some(folder.as_str()) {
            self.ticked.clear();
        }
        self.folder = Some(folder);
        self.papers_pane = true;
        self.paper_query
            .update(cx, |query, cx| query.set_value("", window, cx));
        cx.notify();
    }

    pub(super) fn toggle_folder(&mut self, key: String, cx: &mut Context<Self>) {
        // A search opens every folder it shows; the writer's own choice
        // stays as it was for when the search clears.
        if !self.folder_query.read(cx).value().trim().is_empty() {
            return;
        }
        if !self.expanded.remove(&key) {
            self.expanded.insert(key);
        }
        cx.notify();
    }

    /// How many items each folder lists, under the subfolder switch.
    pub(super) fn folder_counts(&self) -> Rc<HashMap<String, usize>> {
        let Some(library) = &self.library else {
            return Rc::default();
        };
        self.counts
            .borrow_mut()
            .entry(self.subfolders)
            .or_insert_with(|| Rc::new(folder_counts(library, self.subfolders)))
            .clone()
    }

    /// The papers of the folder in view, each with what Papers holds of it.
    pub(super) fn folder_papers(&self, cx: &App) -> Rc<Vec<ZoteroPaper>> {
        let (Some(library), Some(folder)) = (&self.library, &self.folder) else {
            return Rc::default();
        };
        let held = self.papers.read(cx);
        if let Some(listed) = self.listed.borrow().as_ref()
            && listed.folder == *folder
            && listed.subfolders == self.subfolders
            && listed.revision == held.list_revision
        {
            return listed.papers.clone();
        }
        let papers: Rc<Vec<ZoteroPaper>> = folder_items(library, folder, self.subfolders)
            .into_iter()
            .map(|at| {
                let item = &library.items[at];
                let record = self.records.get(at).and_then(Option::as_ref);
                ZoteroPaper {
                    item: at,
                    citation_key: item.citation_key.clone(),
                    title: record
                        .as_ref()
                        .map(|record| record.title.clone())
                        .filter(|title| !title.is_empty())
                        .unwrap_or_else(|| item.citation_key.clone()),
                    byline: record
                        .as_ref()
                        .map(|record| record.byline.clone())
                        .unwrap_or_default(),
                    pdf: item.pdf.clone(),
                    annotations: item.annotations,
                    existing: record
                        .and_then(|record| find_in_library(&held.papers, &record.identity))
                        .cloned(),
                }
            })
            .collect::<Vec<_>>()
            .into();
        *self.listed.borrow_mut() = Some(Listed {
            folder: folder.clone(),
            subfolders: self.subfolders,
            revision: held.list_revision,
            papers: papers.clone(),
        });
        papers
    }

    /// The folder's papers the paper search keeps.
    pub(super) fn shown_papers(&self, cx: &App) -> Vec<ZoteroPaper> {
        let needle = self.paper_query.read(cx).value().trim().to_lowercase();
        self.folder_papers(cx)
            .iter()
            .filter(|paper| {
                needle.is_empty()
                    || format!("{} {} {}", paper.title, paper.byline, paper.citation_key)
                        .to_lowercase()
                        .contains(&needle)
            })
            .cloned()
            .collect()
    }

    pub(super) fn tick(&mut self, papers: &[ZoteroPaper], on: bool, cx: &mut Context<Self>) {
        for paper in papers {
            if on && paper.can_tick() {
                self.ticked.insert(paper.citation_key.clone());
            } else {
                self.ticked.remove(&paper.citation_key);
            }
        }
        cx.notify();
    }

    /// The ticked papers in the list in view.
    pub(super) fn ticked_here(&self, cx: &App) -> Vec<ZoteroPaper> {
        self.shown_papers(cx)
            .into_iter()
            .filter(|paper| paper.can_tick() && self.ticked.contains(&paper.citation_key))
            .collect()
    }

    pub(super) fn add(&mut self, cx: &mut Context<Self>) {
        let papers = self.ticked_here(cx);
        let Some(library) = self.library.clone() else {
            return;
        };
        if papers.is_empty() {
            return;
        }
        cx.emit(ZoteroBrowserEvent::Add {
            papers,
            library,
            data_dir: self.chosen_dir.clone(),
        });
    }

    pub(super) fn back(&mut self, cx: &mut Context<Self>) {
        cx.emit(ZoteroBrowserEvent::Back);
    }

    /// Whether the library was read, and why not when it could not be.
    pub fn read_state(&self) -> (bool, Option<&str>) {
        (self.library.is_some(), self.error.as_deref())
    }

    /// How many are ticked in view, for the sheet to keep them from a
    /// stray click outside.
    pub fn ticked_count(&self, cx: &App) -> usize {
        self.ticked_here(cx).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection(key: &str, name: &str, parent: Option<&str>) -> ZoteroCollection {
        ZoteroCollection {
            key: key.into(),
            name: name.into(),
            parent: parent.map(Into::into),
        }
    }

    #[test]
    fn folders_open_as_a_tree_and_a_search_shows_each_match_with_its_parents() {
        let collections = vec![
            collection("A", "Thesis", None),
            collection("B", "Chapter 1", Some("A")),
            collection("C", "Transformers", Some("B")),
            collection("D", "Reading", None),
        ];
        let names = |rows: Vec<FolderRow>| {
            rows.into_iter()
                .map(|row| (row.name, row.depth))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(folder_rows(&collections, &HashSet::new(), "")),
            [("Thesis".to_string(), 0), ("Reading".to_string(), 0)]
        );
        let open = HashSet::from(["A".to_string()]);
        assert_eq!(
            names(folder_rows(&collections, &open, "")),
            [
                ("Thesis".to_string(), 0),
                ("Chapter 1".to_string(), 1),
                ("Reading".to_string(), 0)
            ]
        );
        assert_eq!(
            names(folder_rows(&collections, &HashSet::new(), "trans")),
            [
                ("Thesis".to_string(), 0),
                ("Chapter 1".to_string(), 1),
                ("Transformers".to_string(), 2)
            ]
        );
    }

    /// Counted by hand: an item filed in a folder and its subfolder counts
    /// once for the folder, and a subfolder's items count for its parent only
    /// with subfolders on.
    #[test]
    fn a_folder_counts_each_item_once() {
        let item = |key: &str, folders: &[&str]| lattice_core::zotero::ZoteroItem {
            key: key.into(),
            bibtex: String::new(),
            citation_key: key.into(),
            pdf: None,
            collections: folders.iter().map(|folder| folder.to_string()).collect(),
            annotations: 0,
        };
        let library = ZoteroLibrary {
            collections: vec![
                collection("A", "Thesis", None),
                collection("B", "Chapter 1", Some("A")),
                collection("D", "Reading", None),
            ],
            items: vec![item("x", &["A", "B"]), item("y", &["B"]), item("z", &["D"])],
        };
        let with = folder_counts(&library, true);
        assert_eq!((with["A"], with["B"], with["D"]), (2, 2, 1));
        let without = folder_counts(&library, false);
        assert_eq!((without["A"], without["B"], without["D"]), (1, 2, 1));
    }
}
