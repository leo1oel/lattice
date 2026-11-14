//! Any two versions compared, in place of the history timeline, ported from
//! the Tauri app's `CompareVersions` (`src/history/compare-versions.tsx`,
//! `compare-versions.css`).
//!
//! The version list is the picker, with From and To columns that cannot
//! cross, so the newer side is always the one below Now; the range between
//! them is washed in the accent at 5%. Until a side is picked, From is the
//! newest version someone saved or named and To is Now. Then the range, the
//! counts before the text (paragraphs, and the prose words added and
//! removed), the changed files as chips, and the open file read as its
//! changed passages, each headed by its section and line (a link to the
//! line while To is Now), with ‹ 1 of n › stepping between them; or as its
//! source diff. "Export PDF with changes…" opens the latexdiff sheet
//! (`export_changes.rs`).
//!
//! Now moves as the files do: a burst the watcher reports reads both sides
//! again after 300 ms, behind what is shown, so the place in the changes
//! stays put.

use std::{path::PathBuf, time::Duration};

use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, ScrollHandle,
    SharedString, Styled as _, Subscription, Task, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::git::{GitLogEntry, GitLogFile};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Segmented},
    tokens::FONT_WEIGHT_SEMIBOLD,
};

use super::{
    body::file_kind_icon,
    diff_view::{FileChange, LoadedDiff},
    export_changes::ExportChangesSheet,
    messages,
    panel::{HistoryPanel, Latest},
    prose::{
        ProsePassage, changed_words, is_prose_file, joined_passage, prose_passages, section_at,
    },
    time,
    widgets::{Control, inline_message, loading_line},
};
use crate::project::ProjectEvent;

mod file;
mod picker;

/// How long a burst of saves settles before Now is read again.
const NOW_SETTLE: Duration = Duration::from_millis(300);

/// The open file between the two sides.
pub struct ComparedFile {
    pub loaded: Option<LoadedDiff>,
    /// Its changed passages, read with the short words between edits joined.
    pub passages: Option<Vec<ProsePassage>>,
    /// Prose words added and removed, counted before the joining.
    pub counts: Option<(usize, usize)>,
    /// The section each passage is in, in step with `passages`.
    pub sections: Vec<Option<String>>,
}

pub struct CompareView {
    panel: WeakEntity<HistoryPanel>,
    /// The panel's versions, as it last read them.
    logged: Vec<GitLogEntry>,
    has_older: bool,
    /// The panel's width, for the picker's narrow columns.
    width: std::rc::Rc<std::cell::Cell<gpui::Pixels>>,
    root: PathBuf,
    pub(super) root_document: Option<String>,
    show_automatic: bool,
    chosen_from: Option<GitLogEntry>,
    chosen_to: Option<GitLogEntry>,
    chosen_path: Option<String>,
    prose: bool,
    stepped: usize,
    files: Latest<Vec<GitLogFile>>,
    file: Latest<ComparedFile>,
    /// Bumped each time Now is read again, so the export's preview is too.
    pub(super) now_read: u64,
    exporting: Option<Entity<ExportChangesSheet>>,
    picker_scroll: ScrollHandle,
    settle: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

/// The newer side when it is the files as they are, not a saved version.
const NOW: &str = "now";

impl CompareView {
    /// Made by the panel, while it is being updated: what it knows comes in
    /// here, and later changes through its notifications.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        panel: Entity<HistoryPanel>,
        project: Option<Entity<crate::project::Project>>,
        logged: Vec<GitLogEntry>,
        has_older: bool,
        width: std::rc::Rc<std::cell::Cell<gpui::Pixels>>,
        root: PathBuf,
        root_document: Option<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut subscriptions = Vec::new();
        subscriptions.push(cx.observe(&panel, |this, panel, cx| {
            let (logged, has_older) = {
                let panel = panel.read(cx);
                (panel.versions.entries.clone(), panel.versions.has_older)
            };
            if this
                .logged
                .iter()
                .map(|entry| &entry.hash)
                .ne(logged.iter().map(|entry| &entry.hash))
            {
                this.logged = logged;
                this.load(cx);
            }
            this.has_older = has_older;
            cx.notify();
        }));
        {
            if let Some(project) = project {
                subscriptions.push(cx.subscribe(&project, |this, _, event, cx| {
                    if let ProjectEvent::FilesChanged(paths) = event {
                        let ours = paths.as_ref().is_some_and(|paths| {
                            paths.iter().all(|path| {
                                path.starts_with(".research/") || path.starts_with(".git/")
                            })
                        });
                        if !ours && this.chosen_to.is_none() {
                            this.settle_then_read_now(cx);
                        }
                    }
                }));
            }
        }
        let mut view = Self {
            panel: panel.downgrade(),
            logged,
            has_older,
            width,
            root,
            root_document,
            show_automatic: false,
            chosen_from: None,
            chosen_to: None,
            chosen_path: None,
            prose: true,
            stepped: 0,
            files: Latest::default(),
            file: Latest::default(),
            now_read: 0,
            exporting: None,
            picker_scroll: ScrollHandle::new(),
            settle: None,
            _subscriptions: subscriptions,
        };
        view.load(cx);
        view
    }

    /// The log with each picked version it no longer holds put back where
    /// its time places it.
    fn entries(&self, _cx: &gpui::App) -> Vec<GitLogEntry> {
        let mut list = self.logged.clone();
        for entry in [&self.chosen_from, &self.chosen_to].into_iter().flatten() {
            if list.iter().any(|candidate| candidate.hash == entry.hash) {
                continue;
            }
            let at = time::parse_ms(&entry.timestamp).unwrap_or(0);
            let index = list
                .iter()
                .position(|candidate| time::parse_ms(&candidate.timestamp).unwrap_or(0) < at)
                .unwrap_or(list.len());
            list.insert(index, entry.clone());
        }
        list
    }

    /// The two sides: From's hash (empty when there is no older version) and To's (or Now).
    fn sides(&self, entries: &[GitLogEntry]) -> (String, String) {
        let to = self
            .chosen_to
            .as_ref()
            .map_or(NOW.to_string(), |entry| entry.hash.clone());
        let after = entries
            .iter()
            .position(|entry| entry.hash == to)
            .map_or(0, |index| index + 1);
        let older = &entries[after.min(entries.len())..];
        let from = self
            .chosen_from
            .as_ref()
            .map(|entry| entry.hash.clone())
            .unwrap_or_else(|| {
                older
                    .iter()
                    .find(|entry| !messages::is_automatic(&entry.message))
                    .or(older.first())
                    .map(|entry| entry.hash.clone())
                    .unwrap_or_default()
            });
        (from, to)
    }

    /// Read the changed files of the pair shown, and the open file's diff.
    fn load(&mut self, cx: &mut Context<Self>) {
        let entries = self.entries(cx);
        let (from, to) = self.sides(&entries);
        if from.is_empty() {
            return;
        }
        let pair = format!("{from}:{to}");
        if !self.files.is(&pair) {
            self.read_files(pair, from, to, false, cx);
        } else {
            self.read_file(false, cx);
        }
    }

    fn read_files(
        &mut self,
        pair: String,
        from: String,
        to: String,
        behind: bool,
        cx: &mut Context<Self>,
    ) {
        let generation = if behind {
            self.files.revalidate(pair)
        } else {
            self.files.start(pair)
        };
        let root = self.root.clone();
        let to_rev = (to != NOW).then_some(to);
        let read = cx.background_executor().spawn(async move {
            lattice_core::git::compare_files(&root, &from, to_rev.as_deref())
        });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                if this.files.settle(generation, result) {
                    this.read_file(behind, cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// The document the project builds opens first; then the first prose
    /// file; then whatever changed.
    fn shown_file(&self) -> Option<&GitLogFile> {
        let changed = self.files.value.as_ref()?;
        changed
            .iter()
            .find(|file| Some(&file.path) == self.chosen_path.as_ref())
            .or_else(|| {
                changed
                    .iter()
                    .find(|file| Some(&file.path) == self.root_document.as_ref())
            })
            .or_else(|| changed.iter().find(|file| is_prose_file(&file.path)))
            .or(changed.first())
    }

    fn read_file(&mut self, behind: bool, cx: &mut Context<Self>) {
        let Some(file) = self.shown_file().cloned() else {
            return;
        };
        let Some(pair) = self.files.key.clone() else {
            return;
        };
        let (from, to) = pair
            .split_once(':')
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .unwrap_or_default();
        let key = format!("{pair}:{}", file.path);
        if self.file.is(&key) && !behind {
            return;
        }
        let generation = if behind {
            self.file.revalidate(key)
        } else {
            self.file.start(key)
        };
        let root = self.root.clone();
        let to_rev = (to != NOW).then_some(to);
        let path = file.path.clone();
        let read = cx.background_executor().spawn(async move {
            let diff = lattice_core::git::compare_file(
                &root,
                &from,
                to_rev.as_deref(),
                &path,
                file.old_path.as_deref(),
            )?;
            let passages = (!diff.binary && is_prose_file(&path))
                .then(|| {
                    prose_passages(
                        diff.before.as_deref().unwrap_or(""),
                        diff.after.as_deref().unwrap_or(""),
                    )
                })
                .flatten();
            let counts = passages.as_ref().map(|passages| changed_words(passages));
            let readable =
                passages.map(|passages| passages.iter().map(joined_passage).collect::<Vec<_>>());
            let source = diff
                .after
                .as_deref()
                .or(diff.before.as_deref())
                .unwrap_or("");
            let sections = readable
                .iter()
                .flatten()
                .map(|passage| section_at(source, passage.line))
                .collect();
            Ok::<_, String>((diff, readable, counts, sections))
        });
        let path = file.path.clone();
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                let result = result.map(|(diff, passages, counts, sections)| {
                    let loaded = (!diff.binary).then(|| {
                        LoadedDiff::new(
                            FileChange {
                                path: path.clone(),
                                before: diff.before.clone(),
                                after: diff.after.clone(),
                            },
                            cx,
                        )
                    });
                    ComparedFile {
                        loaded,
                        passages,
                        counts,
                        sections,
                    }
                });
                if this.file.settle(generation, result) {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn settle_then_read_now(&mut self, cx: &mut Context<Self>) {
        self.settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(NOW_SETTLE).await;
            this.update(cx, |this, cx| {
                let entries = this.entries(cx);
                let (from, to) = this.sides(&entries);
                if from.is_empty() || to != NOW {
                    return;
                }
                this.now_read += 1;
                this.read_files(format!("{from}:{to}"), from, to, true, cx);
                if let Some(sheet) = &this.exporting {
                    let read = this.now_read;
                    sheet.update(cx, |sheet, cx| sheet.files_read_again(read, cx));
                }
            })
            .ok();
        }));
    }

    fn pick(&mut self, from: bool, entry: Option<GitLogEntry>, cx: &mut Context<Self>) {
        if from {
            self.chosen_from = entry;
        } else {
            self.chosen_to = entry;
        }
        self.stepped = 0;
        self.load(cx);
        cx.notify();
    }

    fn side_name(side: &str, entries: &[GitLogEntry]) -> String {
        if side == NOW {
            return t!("Now").into();
        }
        entries
            .iter()
            .find(|entry| entry.hash == side)
            .map(|entry| messages::label(&entry.message))
            .unwrap_or_else(|| side.chars().take(7).collect())
    }

    fn back(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel.upgrade() {
            panel.update(cx, |panel, cx| panel.stop_comparing(cx));
        }
    }

    fn open_line(&mut self, path: String, line: usize, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel.upgrade() {
            panel.update(cx, |panel, cx| panel.open_file(path, Some(line as u32), cx));
        }
    }

    fn start_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let entries = self.entries(cx);
        let (from, to) = self.sides(&entries);
        let Some(root_document) = self.root_document.clone() else {
            return;
        };
        let (from_name, to_name) = (
            Self::side_name(&from, &entries),
            Self::side_name(&to, &entries),
        );
        let changed = self.files.value.clone().unwrap_or_default();
        let to_rev = (to != NOW).then_some(to);
        let view = cx.entity().downgrade();
        let sheet = cx.new(|cx| {
            ExportChangesSheet::new(
                self.root.clone(),
                root_document,
                from,
                to_rev,
                from_name,
                to_name,
                changed,
                view,
                window,
                cx,
            )
        });
        self.exporting = Some(sheet);
        cx.notify();
    }

    /// Whether the shown file's changes have been read.
    pub fn file_loaded(&self) -> bool {
        self.file.value.is_some()
    }

    pub(super) fn close_export(&mut self, cx: &mut Context<Self>) {
        self.exporting = None;
        cx.notify();
    }

    pub(super) fn open_saved(&mut self, path: String, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel.upgrade() {
            panel.update(cx, |panel, cx| panel.open_file(path, None, cx));
        }
    }
}

impl Render for CompareView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let entries = self.entries(cx);
        let (from, to) = self.sides(&entries);
        let can_export = self
            .root_document
            .as_deref()
            .is_some_and(|document| document.to_ascii_lowercase().ends_with(".tex"));

        let top = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .min_w_0()
            .child(
                Control::quiet("compare-back", t!("History"))
                    .icon(Icon::ARROW_LEFT, px(13.))
                    .parity("compare/back")
                    .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
            )
            .when(can_export, |this| {
                this.child(
                    div().min_w_0().child(
                        Button::new("compare-export", t!("Export PDF with changes…"))
                            .compact()
                            .icon(Icon::FILE_DOWN)
                            .tooltip(t!("Export PDF with changes…"))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.start_export(window, cx)),
                            ),
                    ),
                )
            });
        let heading = div()
            .relative()
            .children(lattice_ui::parity::probe("compare/heading"))
            .children(lattice_ui::parity::text_probe(
                "compare/heading",
                0,
                t!("Compare versions"),
            ))
            .text_role(TextRole::Title, cx)
            .text_color(palette.text)
            .child(t!("Compare versions"));

        let picker = self.render_picker(&entries, &from, &to, cx);

        let (from_name, to_name) = (
            Self::side_name(&from, &entries),
            Self::side_name(&to, &entries),
        );
        let compared = self.file.value.as_ref();
        let has_prose = compared.is_some_and(|file| file.passages.is_some());
        let bar = div()
            .relative()
            .children(lattice_ui::parity::probe("compare/bar"))
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap_x(px(12.))
            .gap_y(px(8.))
            .min_w_0()
            .mt(px(4.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .min_w_0()
                    .max_w_full()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text)
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .child(from_name),
                    )
                    .child(Icon::ARROW_RIGHT.element(px(12.), palette.text_secondary))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .child(to_name),
                    ),
            )
            .when(has_prose, |this| {
                this.child(
                    div().ml_auto().child(
                        Segmented::new("compare-mode")
                            .filled()
                            .label(
                                t!("Prose"),
                                self.prose,
                                cx.listener(|this, _, _, cx| {
                                    this.prose = true;
                                    cx.notify();
                                }),
                            )
                            .label(
                                t!("Source"),
                                !self.prose,
                                cx.listener(|this, _, _, cx| {
                                    this.prose = false;
                                    cx.notify();
                                }),
                            ),
                    ),
                )
            });

        let mut out = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .min_w_0()
            .pt(px(12.))
            .pb(px(24.))
            .child(top)
            .child(heading)
            .child(picker)
            .child(bar);
        if !self.files.error.is_empty() {
            out = out.child(inline_message(self.files.error.clone(), true, cx));
        }
        match self.files.value.as_ref() {
            None if self.files.error.is_empty() => {
                out = out.child(loading_line("compare-loading", t!("Comparing…"), cx))
            }
            Some(changed) if changed.is_empty() => {
                out = out.child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(t!("These two versions have the same files.")),
                )
            }
            _ => {}
        }
        let shown = self.shown_file().map(|file| file.path.clone());
        if let Some(changed) = self
            .files
            .value
            .as_ref()
            .filter(|changed| changed.len() > 1)
        {
            let chips = changed.iter().map(|file| {
                let path = file.path.clone();
                Control::chip(
                    SharedString::from(format!("compare-file-{}", file.path)),
                    file.path.clone(),
                )
                .leading(file_kind_icon(&file.kind, cx))
                .on(shown.as_deref() == Some(file.path.as_str()))
                .tooltip(file.path.clone())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.chosen_path = Some(path.clone());
                    this.stepped = 0;
                    this.read_file(false, cx);
                    cx.notify();
                }))
                .into_any_element()
            });
            out = out.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(4.))
                    .min_w_0()
                    .children(chips),
            );
        }
        if let Some(path) = shown {
            if !self.file.error.is_empty() {
                out = out.child(inline_message(self.file.error.clone(), true, cx));
            } else if let Some(file) = compared {
                out = out.child(self.render_file(&path, file, to == NOW, window, cx));
            } else {
                out = out.child(loading_line(
                    "compare-file-loading",
                    t!("Loading diff…"),
                    cx,
                ));
            }
        }
        out.children(self.exporting.clone().map(|sheet| sheet.into_any_element()))
    }
}
