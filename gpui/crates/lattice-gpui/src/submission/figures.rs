//! The figure inventory, opened from the submission checklist: the Tauri
//! app's `FigureInventoryDialog` (`src/project/figure-inventory-dialog.tsx`,
//! `figure-inventory.css`) as a sheet over the window, 760px wide.
//!
//! Every literal `\includegraphics` in the project's `.tex` files (`scan`),
//! grouped by the image it draws: each use's place, caption, labels (and any
//! defined twice) and the references to them. A group opens to inspect and
//! replace: the image previewed with its pixel size and the DPI each use
//! gives it at a physical width, a project image to put in its place, the
//! exact arguments that would change, then the write. Each file is written
//! only if it still holds the text the plan was made from (lattice-core's
//! `apply_editor_transaction` with the expected content), after the open
//! edits are saved, and every file written can be undone, until the project
//! changes, even after the sheet closes.

pub mod scan;
mod view;

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
};

use gpui::{App, AppContext as _, Context, EventEmitter, ImageSource, RenderImage, Task};
use lattice_i18n::t;

use scan::{FigureEdit, FigureUse};

/// What the sheet asks of the window.
pub enum FiguresEvent {
    Close,
    /// Open a project file (closing the sheet), at a line when given.
    Open {
        path: String,
        line: Option<u32>,
    },
}

/// The window's undoable figure writes for its open project: held by the
/// window, they outlive the sheet, so navigating away and coming back keeps
/// them, and go when the window opens another project.
pub type FigureUndo = Rc<RefCell<Vec<FigureEdit>>>;

/// Saves the open edits; resolves false when one could not be saved.
pub type SaveEdits = Rc<dyn Fn(&mut App) -> Task<bool>>;

/// An image's preview, once read.
#[derive(Clone)]
enum Preview {
    Loading,
    Raster {
        path: PathBuf,
        width: u32,
        height: u32,
    },
    Vector(Option<ImageSource>),
    Failed,
}

pub struct FigureInventory {
    root: PathBuf,
    /// Every project file, for resolving names and offering replacements.
    paths: Vec<String>,
    /// The `.tex` sources as read, with the editor's buffer laid over its file.
    sources: BTreeMap<String, String>,
    overlay: Option<(String, String)>,
    /// `sources` with the overlay laid over, and what the scan found in
    /// them: computed when either changes, not on every frame.
    live: BTreeMap<String, String>,
    inventory: scan::Inventory,
    unreadable: Vec<String>,
    loading: bool,
    revision: u64,
    error: Option<String>,
    busy: bool,
    selected: Option<String>,
    target: Option<String>,
    plan: Option<Vec<FigureEdit>>,
    previews: HashMap<String, Preview>,
    save: SaveEdits,
    undo: FigureUndo,
    _load: Option<Task<()>>,
}

impl EventEmitter<FiguresEvent> for FigureInventory {}

impl FigureInventory {
    /// `overlay` is the editor in front's file and text, read in place of
    /// what is on disk.
    pub fn new(
        root: PathBuf,
        paths: Vec<String>,
        overlay: Option<(String, String)>,
        save: SaveEdits,
        undo: FigureUndo,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut sheet = Self {
            root,
            paths,
            sources: BTreeMap::new(),
            overlay,
            live: BTreeMap::new(),
            inventory: scan::Inventory::default(),
            unreadable: Vec::new(),
            loading: true,
            revision: 0,
            error: None,
            busy: false,
            selected: None,
            target: None,
            plan: None,
            previews: HashMap::new(),
            save,
            undo,
            _load: None,
        };
        sheet.reload(cx);
        sheet
    }

    /// Read the `.tex` sources again, off the main thread.
    fn reload(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        let revision = self.revision;
        self.loading = true;
        let root = self.root.clone();
        let tex: Vec<String> = self
            .paths
            .iter()
            .filter(|path| path.to_ascii_lowercase().ends_with(".tex"))
            .cloned()
            .collect();
        self._load = Some(cx.spawn(async move |this, cx| {
            let (sources, unreadable) = cx
                .background_spawn(async move {
                    let mut sources = BTreeMap::new();
                    let mut unreadable = Vec::new();
                    for path in tex {
                        match std::fs::read_to_string(root.join(&path)) {
                            Ok(text) => {
                                sources.insert(path, text);
                            }
                            Err(_) => unreadable.push(path),
                        }
                    }
                    (sources, unreadable)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.revision == revision {
                    this.sources = sources;
                    this.unreadable = unreadable;
                    this.loading = false;
                    this.rescan();
                    cx.notify();
                }
            })
            .ok();
        }));
        self.rescan();
        cx.notify();
    }

    /// Lay the editor's buffer over its file and scan the result again.
    fn rescan(&mut self) {
        self.live = self.sources.clone();
        if let Some((path, text)) = &self.overlay
            && path.to_ascii_lowercase().ends_with(".tex")
            && !self.loading
        {
            self.live.insert(path.clone(), text.clone());
        }
        self.inventory = if self.loading {
            scan::Inventory::default()
        } else {
            scan::scan(&self.live, &self.paths)
        };
    }

    /// Read `path`'s preview once: a raster's pixel size, a PDF's first
    /// page; an SVG is drawn as it is, an EPS is not drawn.
    fn ensure_preview(&mut self, path: &str, cx: &mut Context<Self>) {
        if self.previews.contains_key(path) {
            return;
        }
        self.previews.insert(path.to_string(), Preview::Loading);
        let absolute = self.root.join(path);
        let key = path.to_string();
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".svg") {
            self.previews
                .insert(key, Preview::Vector(Some(ImageSource::from(absolute))));
            return;
        }
        if lower.ends_with(".eps") {
            self.previews.insert(key, Preview::Vector(None));
            return;
        }
        if lower.ends_with(".pdf") {
            let engine = crate::pdf::PdfEngine::global(cx).ok();
            cx.spawn(async move |this, cx| {
                let drawn = match engine {
                    Some(engine) => {
                        crate::first_pages::draw_first_page(&engine, &absolute, cx).await
                    }
                    None => None,
                };
                this.update(cx, |this, cx| {
                    this.previews.insert(
                        key,
                        Preview::Vector(
                            drawn.map(|image: Arc<RenderImage>| ImageSource::Render(image)),
                        ),
                    );
                    cx.notify();
                })
                .ok();
            })
            .detach();
            return;
        }
        cx.spawn(async move |this, cx| {
            let read = absolute.clone();
            let size = cx
                .background_spawn(async move { image::image_dimensions(&read).ok() })
                .await;
            this.update(cx, |this, cx| {
                this.previews.insert(
                    key,
                    match size {
                        Some((width, height)) => Preview::Raster {
                            path: absolute,
                            width,
                            height,
                        },
                        None => Preview::Failed,
                    },
                );
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn preview_plan(&mut self, uses: &[FigureUse], cx: &mut Context<Self>) {
        let Some(target) = self.target.clone() else {
            return;
        };
        match scan::replacement(&self.live, uses, &target) {
            Ok(plan) => {
                self.plan = Some(plan);
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }

    /// Save the open edits, check every file still holds the text the plan
    /// was made from, then write each one; each file written joins the undo.
    fn write(&mut self, edits: Vec<FigureEdit>, restoring: bool, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        let saved = (self.save)(cx);
        let root = self.root.clone();
        cx.spawn(async move |this, cx| {
            if !saved.await {
                this.update(cx, |this, cx| {
                    this.busy = false;
                    cx.notify();
                })
                .ok();
                return;
            }
            let written = cx
                .background_spawn(async move {
                    let mut applied = Vec::new();
                    for edit in &edits {
                        let disk = std::fs::read_to_string(root.join(&edit.path)).unwrap_or_default();
                        if disk != edit.before {
                            return (applied, Some(t!("A source file changed. Refresh and preview the replacement again.").to_string()));
                        }
                    }
                    for edit in edits {
                        match lattice_core::project::apply_editor_transaction(
                            &root,
                            edit.path.clone(),
                            edit.after.clone(),
                            None,
                            Some(edit.before.clone()),
                        ) {
                            Ok(_) => applied.push(edit),
                            Err(error) => return (applied, Some(error)),
                        }
                    }
                    (applied, None)
                })
                .await;
            this.update(cx, |this, cx| {
                let (applied, error) = written;
                let mut edits = this.undo.borrow_mut();
                for edit in applied {
                    let earlier = edits.iter().position(|item| item.path == edit.path);
                    let before = earlier.map(|at| edits.remove(at).before);
                    if !restoring {
                        edits.push(FigureEdit {
                            before: before.unwrap_or(edit.before),
                            ..edit
                        });
                    }
                }
                drop(edits);
                this.error = error;
                this.busy = false;
                this.plan = None;
                // The open edits were saved before the write, and the editor
                // takes what was written from the disk: the disk is the text
                // to read from here on, not the buffer as it was.
                this.overlay = None;
                this.reload(cx);
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn undo(&mut self, cx: &mut Context<Self>) {
        let edits: Vec<FigureEdit> = self
            .undo
            .borrow()
            .iter()
            .cloned()
            .map(|edit| FigureEdit {
                path: edit.path,
                before: edit.after,
                after: edit.before,
            })
            .collect();
        self.write(edits, true, cx);
    }

    /// Whether the sources are read and nothing is being written.
    pub(crate) fn settled(&self) -> bool {
        !self.loading && !self.busy
    }

    /// Every literal graphics command the sheet lists.
    pub(crate) fn uses(&self) -> &[FigureUse] {
        &self.inventory.uses
    }

    pub(crate) fn can_undo(&self) -> bool {
        !self.undo.borrow().is_empty()
    }

    pub(crate) fn last_error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// What the open card's controls do in turn: inspect `asset`'s uses,
    /// choose `target`, preview the replacement, then write it.
    pub(crate) fn replace(&mut self, asset: &str, target: &str, cx: &mut Context<Self>) {
        let uses: Vec<FigureUse> = self
            .uses()
            .iter()
            .filter(|use_| use_.asset.as_deref() == Some(asset))
            .cloned()
            .collect();
        self.selected = Some(asset.to_string());
        self.target = Some(target.to_string());
        self.preview_plan(&uses, cx);
        if let Some(plan) = self.plan.clone() {
            self.write(plan, false, cx);
        }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(FiguresEvent::Close);
        }
    }

    fn navigate(&mut self, path: String, line: Option<u32>, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(FiguresEvent::Open { path, line });
        }
    }
}
