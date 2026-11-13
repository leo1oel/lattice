//! Export for arXiv, checked first: the Tauri app's sheet
//! (`src/project/arxiv-export-dialog.tsx`), its rows (`arxiv-export.ts`) and
//! its look (`.arxiv-export-*` and `.arxiv-check-*` in `dialogs.css`).
//!
//! It says what will be sent (the archive's name, its files, size and top
//! level, the files left out), runs the checks as one list of rows, each
//! with a status and a muted detail, and names the result on its button. A
//! warning (TODO comments, a non-pdfLaTeX engine, a file named in another
//! case than the disk's) never blocks the export; a failure (missing files,
//! no `.bbl`, a package that does not build alone, over arXiv's limit)
//! does.
//!
//! The pack and every check are lattice-core's (`latex::check_arxiv`), on
//! the background executor: what the last build read, with comments out
//! and `\input` merged as the switches say, reported as soon as it is
//! staged, then built alone in a clean folder. Each check saves the open
//! edits first. The export (`latex::export_arxiv`) writes that same pack,
//! and is refused when the project changed after its checks, which checks
//! again. Closing the sheet, or a switch starting a newer check, stops the
//! test build rather than leaving it to finish for nobody.

mod rows;
mod view;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

use futures::StreamExt as _;
use gpui::{App, ClipboardItem, Context, EventEmitter, Global, ScrollHandle, Task, Window};
use lattice_core::latex::{self, ArxivCheck, ArxivChecks, ArxivOptions, ArxivPackage};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use crate::notices::{self, Notice, NoticeAction};
use rows::{archive_name, check_rows, pending_rows};

/// Each project's checks, by its folder, so a newer check (or the sheet
/// closing) stops the test build of the one before, as the Tauri app keeps
/// them on the project's state.
#[derive(Default)]
struct ArxivChecksByProject(HashMap<PathBuf, Arc<ArxivChecks>>);

impl Global for ArxivChecksByProject {}

fn checks_for(root: &Path, cx: &mut App) -> Arc<ArxivChecks> {
    cx.default_global::<ArxivChecksByProject>()
        .0
        .entry(root.to_path_buf())
        .or_default()
        .clone()
}

/// Where the sheet is.
enum Phase {
    /// A check under way; the last pack stays on screen while its
    /// replacement stages, its test build no longer speaking for it.
    Checking(Option<ArxivCheck>),
    Checked(ArxivCheck),
    Error(String),
}

/// What the sheet asks of the window.
pub enum ArxivEvent {
    Close,
}

impl EventEmitter<ArxivEvent> for ArxivExportSheet {}

/// Saves the open edits; resolves false when one could not be saved.
pub type SaveEdits = Rc<dyn Fn(&mut App) -> Task<bool>>;
/// Builds the paper and resolves once the build is over.
pub type BuildPaper = Rc<dyn Fn(&mut Window, &mut App) -> Task<()>>;

pub struct ArxivExportSheet {
    root: PathBuf,
    project_name: String,
    options: ArxivOptions,
    phase: Phase,
    /// Each check's number: the reply (or staged pack) of one the switches
    /// have since replaced must not land over the newer one's.
    generation: u64,
    files_open: bool,
    review_open: bool,
    building: bool,
    exporting: bool,
    save: SaveEdits,
    build: BuildPaper,
    checks: Arc<ArxivChecks>,
    scroll: ScrollHandle,
    _check: Option<Task<()>>,
    _staged: Option<Task<()>>,
}

impl ArxivExportSheet {
    pub fn new(
        root: PathBuf,
        project_name: String,
        save: SaveEdits,
        build: BuildPaper,
        cx: &mut Context<Self>,
    ) -> Self {
        let checks = checks_for(&root, cx);
        let sheet = Self {
            root,
            project_name,
            options: ArxivOptions {
                strip_comments: true,
                merge_inputs: true,
            },
            phase: Phase::Checking(None),
            generation: 0,
            files_open: false,
            review_open: false,
            building: false,
            exporting: false,
            save,
            build,
            checks,
            scroll: ScrollHandle::new(),
            _check: None,
            _staged: None,
        };
        // The first check saves through the window, which is opening the
        // sheet right now: it starts once that is done.
        cx.spawn(async move |sheet, cx| sheet.update(cx, |sheet, cx| sheet.check(cx)).ok())
            .detach();
        sheet
    }

    fn pack(&self) -> Option<&ArxivPackage> {
        match &self.phase {
            Phase::Checking(Some(ArxivCheck::Package(pack)))
            | Phase::Checked(ArxivCheck::Package(pack)) => Some(pack),
            _ => None,
        }
    }

    fn current_check(&self) -> Option<&ArxivCheck> {
        match &self.phase {
            Phase::Checking(check) => check.as_ref(),
            Phase::Checked(check) => Some(check),
            Phase::Error(_) => None,
        }
    }

    pub fn running(&self) -> bool {
        matches!(self.phase, Phase::Checking(_))
    }

    /// The rows on screen, for the scenario.
    pub fn rows(&self) -> Vec<CheckRow> {
        self.pack().map(check_rows).unwrap_or_else(pending_rows)
    }

    /// Whatever starts a new check says so first: the last pack stays while
    /// its replacement stages, without its test build.
    fn recheck(&mut self, cx: &mut Context<Self>) {
        let previous = std::mem::replace(&mut self.phase, Phase::Checking(None));
        self.phase = Phase::Checking(match previous {
            Phase::Checking(check) => check.map(without_build),
            Phase::Checked(check) => Some(without_build(check)),
            Phase::Error(_) => None,
        });
        self.check(cx);
    }

    fn check(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let saved = (self.save)(cx);
        let root = self.root.clone();
        let options = self.options;
        let checks = self.checks.clone();
        let (staged_tx, mut staged_rx) = futures::channel::mpsc::unbounded::<ArxivCheck>();
        self._staged = Some(cx.spawn(async move |this, cx| {
            while let Some(staged) = staged_rx.next().await {
                let landed = this.update(cx, |this, cx| {
                    if this.generation == generation && this.running() {
                        this.phase = Phase::Checking(Some(staged));
                        cx.notify();
                    }
                });
                if landed.is_err() {
                    return;
                }
            }
        }));
        self._check = Some(cx.spawn(async move |this, cx| {
            if !saved.await {
                this.update(cx, |this, cx| {
                    if this.generation == generation {
                        this.phase = Phase::Error(t!("Save your edits before exporting.").into());
                        cx.notify();
                    }
                })
                .ok();
                return;
            }
            let checked = cx
                .background_executor()
                .spawn(async move {
                    latex::check_arxiv(&root, options, &checks, |staged| {
                        staged_tx.unbounded_send(staged.clone()).ok();
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.phase = match checked {
                    Ok(check) => Phase::Checked(check),
                    Err(error) => Phase::Error(error),
                };
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn set_options(&mut self, update: impl FnOnce(&mut ArxivOptions), cx: &mut Context<Self>) {
        update(&mut self.options);
        self.recheck(cx);
    }

    /// The build reports its own failure; either way, check what it left.
    fn build_first(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.building = true;
        let built = (self.build)(window, cx);
        cx.spawn(async move |this, cx| {
            built.await;
            this.update(cx, |this, cx| {
                this.building = false;
                this.recheck(cx);
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn copy_log(&self, cx: &mut Context<Self>) {
        let Some(log) = self
            .pack()
            .and_then(|pack| pack.compile.as_ref()?.log.clone())
        else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(log));
        notices::show(Notice::new(ToastLevel::Success, t!("Build log copied")), cx);
    }

    fn export(&mut self, cx: &mut Context<Self>) {
        let Some(digest) = self.pack().map(|pack| pack.digest.clone()) else {
            return;
        };
        let name = archive_name(&self.project_name);
        let directory = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| self.root.clone());
        let chosen = cx.prompt_for_new_path(&directory, Some(name.as_str()));
        let root = self.root.clone();
        let options = self.options;
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(zip_path))) = chosen.await else {
                return;
            };
            this.update(cx, |this, cx| {
                this.exporting = true;
                cx.notify();
            })
            .ok();
            let written = cx
                .background_executor()
                .spawn({
                    let zip_path = zip_path.clone();
                    async move { latex::export_arxiv(&root, options, &digest, &zip_path) }
                })
                .await;
            this.update(cx, |this, cx| {
                this.exporting = false;
                match written {
                    Err(error) => {
                        notices::show(
                            Notice::new(ToastLevel::Error, t!("Could not export for arXiv"))
                                .detail(error),
                            cx,
                        );
                        // The pack changed after its checks, most likely:
                        // check what is there now.
                        this.recheck(cx);
                    }
                    Ok(()) => {
                        let shown = zip_path.clone();
                        notices::show(
                            Notice::new(
                                ToastLevel::Success,
                                t!("Exported {fileName}", fileName = name),
                            )
                            .action(NoticeAction::new(t!("Show in Finder"), move |_, cx| {
                                cx.reveal_path(&shown)
                            })),
                            cx,
                        );
                        cx.emit(ArxivEvent::Close);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(ArxivEvent::Close);
    }
}

impl Drop for ArxivExportSheet {
    fn drop(&mut self) {
        // Closing stops the test build rather than leaving it to finish for nobody.
        self.checks.cancel();
    }
}

fn without_build(check: ArxivCheck) -> ArxivCheck {
    match check {
        ArxivCheck::Package(mut pack) => {
            pack.compile = None;
            ArxivCheck::Package(pack)
        }
        unbuilt => unbuilt,
    }
}

pub use rows::{CheckRow, CheckState};
