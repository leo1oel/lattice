//! The outline rail on the source editor's right edge, as the Tauri app
//! draws it (`src/editor/latex/latex-outline-rail.tsx`, `.latex-outline-rail`
//! in `editor-workspace.css`): one mark per heading, shorter for each level
//! down, the section being read in the accent (the captain's call for the
//! rail; the Tauri app marks it in the weft's olive). A pointer resting on
//! the marks opens the outline (`outline_panel.rs`): numbers, titles and the
//! PDF page each heading landed on, and a row sends the editor (and the PDF)
//! there. Which headings it marks is `rail_outline.rs`.
//!
//! - Fewer than two marks, or an editor narrower than 360px, and there is no
//!   rail; the text keeps the room it would take.
//! - "Being read" is the middle of the editor, where every jump centres its
//!   target. The section a row jumped to stays current until the writer
//!   scrolls, types or clicks (`release`), as a jump near the end of the
//!   document cannot centre it.
//! - The marks: a 24px column 20px under the editor's top and 10px in from
//!   its right edge (the scrollbar's lane), 4px and 6px of padding, a row of
//!   up to 8px per mark (shrinking to 2px), each mark a 2px pill 14, 8 or 4px
//!   long at the column's right, in the secondary ink at 60%, full under the
//!   pointer or while the outline is open.
//! - The outline opens after the pointer rests 120ms on the marks (so one
//!   passing to the scrollbar does not open it) and closes 200ms after it
//!   leaves the marks and the outline; a click toggles it.

use std::{path::PathBuf, rc::Rc, time::Duration};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, Render, ScrollHandle, StatefulInteractiveElement as _,
    Styled as _, Task, Window, div, px,
};
use lattice_editor::LatticeEditor;
use lattice_ui::ActiveLattice as _;

use super::rail_outline::{RailOutline, rail_outline, section_at};
use crate::outline::Heading;

/// Below this width the source keeps the room the rail would take.
pub const MIN_RAIL_EDITOR_WIDTH: Pixels = px(360.);
/// The room the text leaves the rail: `--space-16` + `--space-2`.
pub const RAIL_CLEARANCE: Pixels = px(36.);
/// The pointer's rest before the outline opens, and its grace outside it.
const OPEN_DELAY: Duration = Duration::from_millis(120);
const CLOSE_DELAY: Duration = Duration::from_millis(200);
/// Where the rail stands in the editor: 20px under the top, 12px over the
/// bottom, 10px in from the right (the scrollbar's lane).
const TOP: Pixels = px(20.);
const BOTTOM: Pixels = px(12.);
const LEFT: Pixels = px(12.);
const RIGHT: Pixels = px(10.);
/// The marks' column (`--hit-area-min`), its padding, a mark's row.
const MARKS_WIDTH: Pixels = px(24.);
const MARKS_PAD_Y: Pixels = px(4.);
const MARKS_PAD_X: Pixels = px(6.);
const MARK_ROW: Pixels = px(8.);
const MARK_ROW_MIN: Pixels = px(2.);
const MARK_HEIGHT: Pixels = px(2.);

/// What the rail asks of its editor panel.
pub enum OutlineRailEvent {
    /// A row: open `path` at the 1-based `line` and show it in the PDF.
    Jump { path: String, line: u32 },
}

/// The pages each heading landed on, for one outline and one build.
struct Pages {
    key: (Vec<(String, u32)>, usize),
    pages: Vec<Option<u32>>,
}

pub struct OutlineRail {
    lattice: Entity<LatticeEditor>,
    root: PathBuf,
    path: String,
    manuscript: Rc<[Heading]>,
    manuscript_root: String,
    /// The file's text as of the last pause in typing.
    source: String,
    outline: RailOutline,
    /// The entry a row jumped to, current until the writer moves on.
    pinned: Option<usize>,
    narrow: bool,
    pub(super) open: bool,
    /// Bumped on each opening, so the entrance plays again.
    pub(super) opened: usize,
    over_marks: bool,
    over_panel: bool,
    timer: Option<Task<()>>,
    /// The builds finished so far, which key the pages.
    builds: usize,
    pages: Option<Pages>,
    pages_task: Option<Task<()>>,
    pub(super) list: ScrollHandle,
    /// The marks' bounds as last drawn.
    marks_bounds: std::rc::Rc<std::cell::Cell<Option<gpui::Bounds<Pixels>>>>,
}

impl EventEmitter<OutlineRailEvent> for OutlineRail {}

impl OutlineRail {
    pub fn new(
        lattice: Entity<LatticeEditor>,
        root: PathBuf,
        path: String,
        cx: &mut Context<Self>,
    ) -> Self {
        // Every scroll and edit redraws the editor: the current section
        // follows it.
        cx.observe(&lattice, |_, _, cx| cx.notify()).detach();
        Self {
            lattice,
            root,
            path,
            manuscript: Rc::from([]),
            manuscript_root: String::new(),
            source: String::new(),
            outline: RailOutline::default(),
            pinned: None,
            narrow: false,
            open: false,
            opened: 0,
            over_marks: false,
            over_panel: false,
            timer: None,
            builds: 0,
            pages: None,
            pages_task: None,
            list: ScrollHandle::new(),
            marks_bounds: Default::default(),
        }
    }

    /// The manuscript's outline and its root document, as last read.
    pub fn set_manuscript(
        &mut self,
        headings: Rc<[Heading]>,
        root: String,
        cx: &mut Context<Self>,
    ) {
        if Rc::ptr_eq(&self.manuscript, &headings) && self.manuscript_root == root {
            return;
        }
        self.manuscript = headings;
        self.manuscript_root = root;
        self.rebuild(cx);
    }

    /// The file's text after a pause in typing, and where it is now.
    pub fn set_source(&mut self, path: String, source: String, cx: &mut Context<Self>) {
        if self.path == path && self.source == source {
            return;
        }
        self.path = path;
        self.source = source;
        self.rebuild(cx);
    }

    /// A build finished: the pages are read again when the outline opens.
    pub fn build_finished(&mut self, cx: &mut Context<Self>) {
        self.builds += 1;
        cx.notify();
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let outline = rail_outline(
            &self.path,
            &self.manuscript,
            &self.manuscript_root,
            &self.source,
        );
        if outline != self.outline {
            self.outline = outline;
            self.pinned = None;
            if self.outline.marks.len() < 2 {
                self.close(cx);
            }
            cx.notify();
        }
    }

    /// Whether the rail shows: two marks or more, in an editor wide enough.
    pub fn shown(&self) -> bool {
        self.outline.marks.len() >= 2 && !self.narrow
    }

    /// The editor's width, which decides whether the rail has room.
    pub fn set_editor_width(&mut self, width: Pixels, cx: &mut Context<Self>) {
        let narrow = width > px(0.) && width < MIN_RAIL_EDITOR_WIDTH;
        if narrow != self.narrow {
            self.narrow = narrow;
            if narrow {
                self.close(cx);
            }
            cx.notify();
        }
    }

    /// The writer moved on by hand (a wheel, a click, a key): a jump's hold
    /// on the current section ends.
    pub fn release(&mut self, cx: &mut Context<Self>) {
        if self.pinned.take().is_some() {
            cx.notify();
        }
    }

    /// Whether the pointer is on the marks or the open outline.
    pub fn hovered(&self) -> bool {
        self.over_marks || self.over_panel
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Where the marks were last drawn.
    pub fn marks_bounds(&self) -> Option<gpui::Bounds<Pixels>> {
        self.marks_bounds.get()
    }

    pub fn outline(&self) -> &RailOutline {
        &self.outline
    }

    /// The file the rail is on, project-relative.
    pub(super) fn path(&self) -> &str {
        &self.path
    }

    /// The entry shown as current.
    pub fn current(&self, window: &mut Window, cx: &mut App) -> Option<usize> {
        if let Some(pinned) = self
            .pinned
            .filter(|pinned| *pinned < self.outline.entries.len())
        {
            return Some(pinned);
        }
        let line = self
            .lattice
            .update(cx, |lattice, cx| lattice.middle_line(window, cx))?
            + 1;
        section_at(&self.outline.entries, &self.path, line)
    }

    /// Open the outline (`true`) or close it after `delay`.
    fn settle(&mut self, open: bool, delay: Duration, cx: &mut Context<Self>) {
        if delay.is_zero() {
            self.timer = None;
            self.set_open(open, cx);
            return;
        }
        self.timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                this.timer = None;
                this.set_open(open, cx);
            })
            .ok();
        }));
    }

    pub fn toggle(&mut self, cx: &mut Context<Self>) {
        let open = !self.open;
        self.settle(open, Duration::ZERO, cx);
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.timer = None;
        self.set_open(false, cx);
    }

    fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if open == self.open || (open && !self.shown()) {
            return;
        }
        self.open = open;
        if open {
            self.opened += 1;
            self.read_pages(cx);
        } else {
            self.over_panel = false;
        }
        cx.notify();
    }

    pub(super) fn set_over(
        &mut self,
        marks: Option<bool>,
        panel: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        let was = self.hovered();
        if let Some(marks) = marks {
            self.over_marks = marks;
        }
        if let Some(panel) = panel {
            self.over_panel = panel;
        }
        let now = self.hovered();
        if now == was {
            return;
        }
        if now {
            let delay = if self.open {
                Duration::ZERO
            } else {
                OPEN_DELAY
            };
            self.settle(true, delay, cx);
        } else {
            self.settle(false, CLOSE_DELAY, cx);
        }
        cx.notify();
    }

    /// Read the PDF page of each heading from the build's SyncTeX data, once
    /// per outline and build.
    fn read_pages(&mut self, cx: &mut Context<Self>) {
        let headings: Vec<(String, u32)> = self
            .outline
            .entries
            .iter()
            .map(|entry| (entry.heading.path.clone(), entry.heading.line))
            .collect();
        let key = (headings.clone(), self.builds);
        if self.pages.as_ref().is_some_and(|pages| pages.key == key) {
            return;
        }
        let root = self.root.clone();
        let reading = cx.background_spawn(async move {
            let lines: Vec<lattice_core::latex::SourceLine> = headings
                .into_iter()
                .map(|(path, line)| lattice_core::latex::SourceLine { path, line })
                .collect();
            lattice_core::latex::heading_pages(&root, &lines).unwrap_or_default()
        });
        self.pages_task = Some(cx.spawn(async move |this, cx| {
            let pages = reading.await;
            this.update(cx, |this, cx| {
                this.pages = Some(Pages { key, pages });
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn choose(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(entry) = self.outline.entries.get(index) else {
            return;
        };
        let (path, line) = (entry.heading.path.clone(), entry.heading.line);
        self.pinned = Some(index);
        self.close(cx);
        cx.emit(OutlineRailEvent::Jump { path, line });
    }

    pub(super) fn page_of(&self, index: usize) -> Option<u32> {
        let pages = self.pages.as_ref()?;
        let current: Vec<(String, u32)> = self
            .outline
            .entries
            .iter()
            .map(|entry| (entry.heading.path.clone(), entry.heading.line))
            .collect();
        if pages.key.0 != current || pages.key.1 != self.builds {
            return None;
        }
        pages.pages.get(index).copied().flatten()
    }

    fn render_marks(&self, current: Option<usize>, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let lit = self.over_marks || self.open;
        let ink = if lit {
            palette.text_secondary
        } else {
            palette
                .text_secondary
                .opacity(0.6 * palette.text_secondary.a)
        };
        let current_mark =
            current.and_then(|entry| self.outline.mark_of.get(entry).copied().flatten());
        let accent = palette.accent;
        let marks: Vec<AnyElement> = self
            .outline
            .marks
            .iter()
            .enumerate()
            .map(|(mark, entry)| {
                let depth = self.outline.entries[*entry].depth;
                let width = match depth {
                    0 => px(14.),
                    1 => px(8.),
                    _ => px(4.),
                };
                div()
                    .flex()
                    .flex_shrink(1.)
                    .items_center()
                    .justify_end()
                    .h(MARK_ROW)
                    .min_h(MARK_ROW_MIN)
                    .child(div().w(width).h(MARK_HEIGHT).rounded_full().bg(
                        if current_mark == Some(mark) {
                            accent
                        } else {
                            ink
                        },
                    ))
                    .into_any_element()
            })
            .collect();
        div()
            .id("outline-rail-marks")
            .relative()
            .flex()
            .flex_col()
            .flex_none()
            .w(MARKS_WIDTH)
            .min_h_0()
            .max_h_full()
            .px(MARKS_PAD_X)
            .py(MARKS_PAD_Y)
            .overflow_hidden()
            .rounded(px(4.))
            .children(marks)
            .children(lattice_ui::parity::probe("editor/outline-rail"))
            .child({
                let slot = self.marks_bounds.clone();
                gpui::canvas(move |bounds, _, _| slot.set(Some(bounds)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
            })
            .on_hover(
                cx.listener(|this, hovered: &bool, _, cx| this.set_over(Some(*hovered), None, cx)),
            )
            .on_click(cx.listener(|this, _, _, cx| this.toggle(cx)))
            .into_any_element()
    }
}

impl Render for OutlineRail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.shown() {
            return div().into_any_element();
        }
        let current = self.current(window, cx);
        let marks = self.render_marks(current, cx);
        let panel = self.render_panel(current, window, cx);
        div()
            .absolute()
            .top(TOP)
            .bottom(BOTTOM)
            .left(LEFT)
            .right(RIGHT)
            .flex()
            .flex_col()
            .items_end()
            .child(marks)
            .children(panel)
            .into_any_element()
    }
}
