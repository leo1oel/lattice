//! The source editor's selection toolbar, as the Tauri app draws it over a
//! LaTeX or Markdown selection (`src/editor/latex/latex-selection-toolbar.tsx`,
//! `selection-toolbar-placement.ts`, `src/canvas/markdown-source-toolbar.tsx`,
//! `source-selection-edits.ts`).
//!
//! Over a `.tex` selection: Bold, Italic, Underline, Strikethrough and Quote
//! (pressed when the selection already has the format, and pressing again
//! takes it off, `lattice_editor::latex::format_toggle`), Annotate, then
//! Link (a URL field, Apply writes `\href`), the heading level menu, and the
//! highlighter: the pen applies the last highlighter at once, the caret
//! opens the palette (`highlight_palette.rs`). Over a `.md` selection: the
//! block type menu, the inline formats writing Markdown syntax
//! (`lattice_editor::markdown_format`), Insert link, inline math and
//! Annotate; inside a fenced code block only the block menu and Annotate.
//!
//! It stands centred over the selection's first line (under it when the
//! line is within 52px of the editor's top), kept 8px inside the editor,
//! and grows in from the selection on the pop tier. It waits while the
//! pointer is still dragging a selection out, goes on a press outside it or
//! Esc, and stays gone until the selection changes. Pressing a button never
//! takes the editor's focus or selection.

use std::{cell::Cell, ops::Range, rc::Rc};

use editor::{MultiBufferOffset, SelectionEffects, ToOffset as _, scroll::Autoscroll};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Pixels, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_editor::{
    latex::{format_toggle, highlights},
    markdown_format::{self, BlockType, InlineFormat as MdFormat},
    text_edit::TextEdit,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Field, LatticeTooltip, PopFrom, pop_in},
    tokens::{RADIUS_PANEL, SPACING_2, SPACING_3},
};

mod menus;
mod tools;

use super::{EditorPanel, highlight_palette};

/// The toolbar's buttons and its padding.
const BUTTON: f32 = 28.;
const PAD: f32 = 3.;
/// Its height on one row, before it is measured.
const HEIGHT: f32 = BUTTON + PAD * 2.;
/// About its width, before it is measured: the Markdown one carries the
/// block menu too.
const LATEX_WIDTH: f32 = 350.;
const MARKDOWN_WIDTH: f32 = 420.;
/// Closer than this to the editor's top, it goes under the selection.
const ROOM_ABOVE: f32 = 52.;
const GAP: f32 = 8.;

/// Which of the toolbar's menus is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Menu {
    Link,
    Heading,
    Highlight,
    Block,
    /// Rewrite with an instruction (`proofread/instruction_menu.rs`).
    Rewrite,
}

/// What a toolbar's button asks of the selection.
#[derive(Clone, Debug)]
pub(super) enum ToolbarAction {
    Latex(format_toggle::InlineFormat),
    Quote,
    Heading(&'static str),
    Link(String),
    Highlight(String),
    Unhighlight,
    Markdown(MdFormat),
    Block(BlockType),
    Annotate,
}

#[derive(Default)]
pub(super) struct ToolbarState {
    /// The selection the writer dismissed the toolbar on: it stays gone
    /// until the selection changes.
    dismissed: Option<Range<usize>>,
    /// The pointer is down in the source: a selection may still be dragged.
    dragging: bool,
    pub(super) menu: Option<Menu>,
    link: Option<(Entity<InputState>, Subscription)>,
    /// The source view's bounds, and the toolbar's size, as last drawn.
    view: Rc<Cell<Option<Bounds<Pixels>>>>,
    size: Rc<Cell<Option<gpui::Size<Pixels>>>>,
    /// What it last read of the selection.
    read: Option<SelectionRead>,
    /// Where the toolbar and its open menu were drawn: a press there is not
    /// the start of a selection.
    areas: Rc<std::cell::RefCell<Vec<Bounds<Pixels>>>>,
    /// Bumped each time it shows anew, which replays its entrance.
    shown: u64,
    last: Option<Range<usize>>,
    pub(super) palette: highlight_palette::PaletteState,
    /// The appearance the highlights were last painted for, and the paint
    /// that waits for typing to pause.
    painted_dark: Option<bool>,
    /// How many highlights the last paint painted, and the bytes it read.
    painted: usize,
    painted_window: Range<usize>,
    _paint: Option<gpui::Task<()>>,
}

/// What the toolbar read of the selection, kept while neither the text nor
/// the selection changes, so drawing it again reads nothing again.
struct SelectionRead {
    version: clock::Global,
    range: Range<usize>,
    /// The end of the selection's first line.
    line_end: usize,
    formats: Formats,
    /// The highlight palette's: the highlight around the selection (its
    /// colour, "" for an uncoloured one), the selected text and the
    /// document's colours, once the palette opens.
    palette: Option<(Option<String>, String, Vec<String>)>,
}

#[derive(Clone)]
enum Formats {
    Latex(format_toggle::SelectionFormats),
    Markdown(markdown_format::SelectionFormat),
}

/// The paint's layers: the tints, and the ink, underlines and faded
/// wrappers.
const PAINT: &str = "highlight-paint";
const PAINT_MARKS: &str = "highlight-paint-marks";
/// How far past the lines the editor shows the paint reads (the Tauri
/// paint's `MARGIN`), so a long document costs what its view costs.
const PAINT_MARGIN: usize = 2000;

/// The file's kind of toolbar.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Latex,
    Markdown,
}

impl EditorPanel {
    fn toolbar_kind(&self) -> Option<Kind> {
        let path = self.relative.to_ascii_lowercase();
        if path.ends_with(".tex") {
            Some(Kind::Latex)
        } else if path.ends_with(".md") {
            Some(Kind::Markdown)
        } else {
            None
        }
    }

    /// The selection, as bytes of the buffer; none when nothing is selected.
    pub(super) fn toolbar_selection(&self, cx: &App) -> Option<Range<usize>> {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        let (start, end) = (
            selection.start.to_offset(&snapshot).0,
            selection.end.to_offset(&snapshot).0,
        );
        (start != end).then(|| start.min(end)..start.max(end))
    }

    /// Read what the selection is, unless it was read already for this text.
    fn read_selection(&mut self, kind: Kind, range: Range<usize>, cx: &App) -> &mut SelectionRead {
        let version = self.buffer.read(cx).version();
        let fresh = self
            .toolbar
            .read
            .as_ref()
            .is_some_and(|read| read.version == version && read.range == range);
        if !fresh {
            let text = self.buffer.read(cx).text();
            let line_end = text[range.start..]
                .find('\n')
                .map_or(text.len(), |at| range.start + at)
                .min(range.end);
            let formats = match kind {
                Kind::Latex => {
                    Formats::Latex(format_toggle::selection_formats(&text, range.clone()))
                }
                Kind::Markdown => {
                    Formats::Markdown(markdown_format::selection_format(&text, range.clone()))
                }
            };
            self.toolbar.read = Some(SelectionRead {
                version,
                range,
                line_end,
                formats,
                palette: None,
            });
        }
        self.toolbar.read.as_mut().expect("read above")
    }

    /// Whether `position` is on the toolbar or its open menu, as last drawn.
    fn on_toolbar(&self, position: gpui::Point<Pixels>) -> bool {
        self.toolbar.last.is_some()
            && self
                .toolbar
                .areas
                .borrow()
                .iter()
                .any(|area| area.contains(&position))
    }

    /// The pointer went down in the source (a selection may be dragged out)
    /// or came up anywhere (the drag settled): the toolbar waits for it.
    pub(super) fn toolbar_pointer(
        &mut self,
        down: bool,
        position: gpui::Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if down && self.on_toolbar(position) {
            return;
        }
        if self.toolbar.dragging != down {
            self.toolbar.dragging = down;
            if down {
                self.toolbar.menu = None;
            }
            cx.notify();
        }
    }

    /// The bytes of the lines the editor shows.
    fn shown_bytes(&self, cx: &mut Context<Self>) -> Range<usize> {
        use editor::{DisplayPoint, display_map::DisplayRow};
        self.editor.update(cx, |editor, cx| {
            let snapshot = editor.display_snapshot(cx);
            let top = editor.scroll_position(cx).y.max(0.);
            let rows = editor.visible_line_count().unwrap_or(200.);
            let offset_at = |row: f64| {
                let row = DisplayRow(row.floor() as u32).min(snapshot.max_point().row());
                let point = DisplayPoint::new(row, 0).to_point(&snapshot);
                snapshot.buffer_snapshot().point_to_offset(point).0
            };
            offset_at(top)..offset_at(top + rows + 1.)
        })
    }

    /// Paint the `.tex` file's highlights (`highlights::paint`) around the
    /// lines the editor shows.
    pub(super) fn paint_highlights(&mut self, cx: &mut Context<Self>) {
        if self.toolbar_kind() != Some(Kind::Latex) {
            return;
        }
        let dark = cx.palette().appearance == lattice_ui::Appearance::Dark;
        let shown = self.shown_bytes(cx);
        let buffer = self.buffer.read(cx);
        let start = buffer.clip_offset(
            shown.start.saturating_sub(PAINT_MARGIN),
            language::Bias::Left,
        );
        let end = buffer.clip_offset(
            (shown.end + PAINT_MARGIN).min(buffer.len()),
            language::Bias::Right,
        );
        let text = buffer.text_for_range(start..end).collect::<String>();
        let (washes, marks) = highlights::paint(&text, start, dark);
        self.toolbar.painted_dark = Some(dark);
        self.toolbar.painted = washes.len();
        self.toolbar.painted_window = start..end;
        self.lattice.update(cx, |lattice, cx| {
            lattice.set_highlights(PAINT, washes, cx);
            lattice.set_marks(PAINT_MARKS, marks, cx);
        });
    }

    /// Paint the highlights again once the lines the editor shows (scrolled,
    /// resized or folded) go past what was read.
    pub(super) fn highlights_shown(&mut self, cx: &mut Context<Self>) {
        if self.toolbar_kind() != Some(Kind::Latex) {
            return;
        }
        let (shown, painted) = (self.shown_bytes(cx), &self.toolbar.painted_window);
        if shown.start < painted.start || shown.end > painted.end {
            self.paint_highlights(cx);
        }
    }

    /// Paint the highlights again once typing pauses.
    pub(super) fn highlights_edited(&mut self, cx: &mut Context<Self>) {
        if self.toolbar_kind() != Some(Kind::Latex) {
            return;
        }
        self.toolbar._paint = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(150))
                .await;
            this.update(cx, |this, cx| this.paint_highlights(cx)).ok();
        }));
    }

    /// How many highlights are painted in the source, for scripted checks.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn highlights_painted(&self, _: &App) -> usize {
        self.toolbar.painted
    }

    /// Whether the selection is bold, as the toolbar's Bold shows it.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn toolbar_pressed_bold(&self, cx: &App) -> bool {
        self.toolbar_selection(cx).is_some_and(|range| {
            format_toggle::selection_formats(&self.buffer.read(cx).text(), range)
                .inline
                .contains(&format_toggle::InlineFormat::Bold)
        })
    }

    /// Press one of the toolbar's tools by name (scripted runs): `bold`,
    /// `pen`, `unhighlight`, or a block such as `heading-1` in Markdown.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scripted_toolbar(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let markdown = self.toolbar_kind() == Some(Kind::Markdown);
        let action = match name {
            "bold" if markdown => ToolbarAction::Markdown(MdFormat::Bold),
            "bold" => ToolbarAction::Latex(format_toggle::InlineFormat::Bold),
            "pen" => ToolbarAction::Highlight(highlight_palette::prefs(cx).last.clone()),
            "unhighlight" => ToolbarAction::Unhighlight,
            "heading-1" => ToolbarAction::Block(BlockType::Heading(1)),
            _ => return,
        };
        self.toolbar_action(action, window, cx);
    }

    /// Put the toolbar away until the selection changes.
    /// The palette's Rewrite selection…: the toolbar again, with its Rewrite
    /// menu open (`openRewriteMenu`).
    pub(super) fn open_rewrite_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_proofread(cx) || self.toolbar_selection(cx).is_none() {
            return;
        }
        self.toolbar.dismissed = None;
        self.toolbar.menu = None;
        self.open_menu(Menu::Rewrite, window, cx);
        cx.notify();
    }

    pub(super) fn dismiss_toolbar(&mut self, cx: &mut Context<Self>) {
        self.toolbar.dismissed = self.toolbar_selection(cx);
        self.toolbar.menu = None;
        self.toolbar.link = None;
        self.proofread.instruction = None;
        cx.notify();
    }

    /// Give the editor its keys back from a menu that took them.
    fn refocus_editor(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    /// Whether the toolbar is showing, for scripted checks.
    pub fn selection_toolbar_shown(&self) -> bool {
        self.toolbar.last.is_some()
    }

    /// Apply `edit` as one undo step and select what it says, scrolled into
    /// view, giving the editor its keys back.
    fn apply_text_edit(&mut self, edit: TextEdit, window: &mut Window, cx: &mut Context<Self>) {
        let editor = self.editor.clone();
        editor.update(cx, |editor, cx| {
            editor.buffer().update(cx, |buffer, cx| {
                buffer.edit(
                    edit.changes.iter().map(|change| {
                        (
                            MultiBufferOffset(change.range.start)
                                ..MultiBufferOffset(change.range.end),
                            change.insert.as_str(),
                        )
                    }),
                    None,
                    cx,
                );
            });
            let (anchor, head) = (MultiBufferOffset(edit.anchor), MultiBufferOffset(edit.head));
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::fit()),
                window,
                cx,
                |selections| selections.select_ranges([anchor.min(head)..anchor.max(head)]),
            );
        });
        window.focus(&editor.focus_handle(cx), cx);
    }

    /// Do what a toolbar button asks of the selection.
    pub(super) fn toolbar_action(
        &mut self,
        action: ToolbarAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(range) = self.toolbar_selection(cx) else {
            return;
        };
        self.toolbar.menu = None;
        self.toolbar.link = None;
        if let ToolbarAction::Annotate = action {
            self.dismiss_toolbar(cx);
            self.annotate_selection(window, cx);
            return;
        }
        let text = self.buffer.read(cx).text();
        let edit = match action {
            ToolbarAction::Latex(format) => {
                Some(format_toggle::toggle_inline(&text, range, format))
            }
            ToolbarAction::Quote => Some(format_toggle::toggle_quote(&text, range)),
            ToolbarAction::Heading(command) => {
                Some(format_toggle::set_heading(&text, range, command))
            }
            ToolbarAction::Link(url) => format_toggle::link_target(&url)
                .map(|url| format_toggle::set_link(&text, range, &url)),
            ToolbarAction::Highlight(color) => {
                highlight_palette::remember(&color, cx);
                highlights::highlight_edit(&text, range, Some(&color))
            }
            ToolbarAction::Unhighlight => highlights::highlight_edit(&text, range, None),
            ToolbarAction::Markdown(format) => markdown_format::toggle_inline(&text, range, format),
            ToolbarAction::Block(block) => markdown_format::set_block(&text, range, block),
            ToolbarAction::Annotate => None,
        };
        if let Some(edit) = edit {
            self.apply_text_edit(edit, window, cx);
        } else {
            self.refocus_editor(window, cx);
        }
        cx.notify();
    }

    fn open_menu(&mut self, menu: Menu, window: &mut Window, cx: &mut Context<Self>) {
        self.toolbar.link = None;
        self.toolbar.palette = Default::default();
        self.refocus_editor(window, cx);
        if self.toolbar.menu == Some(menu) {
            self.toolbar.menu = None;
            cx.notify();
            return;
        }
        self.toolbar.menu = Some(menu);
        if menu == Menu::Highlight {
            let focus = cx.focus_handle();
            window.focus(&focus, cx);
            self.toolbar.palette.focus = Some(focus);
        }
        if menu == Menu::Rewrite {
            self.open_instruction_menu(window, cx);
        }
        if menu == Menu::Link {
            let field = cx.new(|cx| InputState::new(window, cx).default_value("https://"));
            field.update(cx, |field, cx| field.focus(window, cx));
            let sub = cx.subscribe_in(&field, window, |this, field, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let url = field.read(cx).value().trim().to_string();
                    if !url.is_empty() {
                        this.toolbar_action(ToolbarAction::Link(url), window, cx);
                    }
                }
            });
            self.toolbar.link = Some((field, sub));
        }
        cx.notify();
    }

    /// The toolbar over the selection, in the source view; none while
    /// there is nothing to show.
    pub(super) fn selection_toolbar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        // The appearance changed: the paint follows.
        let dark = cx.palette().appearance == lattice_ui::Appearance::Dark;
        if self
            .toolbar
            .painted_dark
            .is_some_and(|painted| painted != dark)
        {
            self.paint_highlights(cx);
        }
        let view_cell = self.toolbar.view.clone();
        let this = cx.entity().downgrade();
        let shown = this.clone();
        let tracker = canvas(
            move |bounds, _, cx| {
                view_cell.set(Some(bounds));
                // Read after the editor has laid out this frame's lines.
                cx.defer(move |cx| {
                    shown.update(cx, |this, cx| this.highlights_shown(cx)).ok();
                });
            },
            move |_, _, window, _| {
                // A drag settles wherever the pointer comes up, in the source
                // or past its edge.
                window.on_mouse_event(move |event: &gpui::MouseUpEvent, phase, _, cx| {
                    if phase == gpui::DispatchPhase::Capture {
                        this.update(cx, |this, cx| {
                            this.toolbar_pointer(false, event.position, cx)
                        })
                        .ok();
                    }
                });
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element();
        let selection = self.toolbar_selection(cx);
        if selection != self.toolbar.dismissed {
            self.toolbar.dismissed = None;
        }
        let shown = (|| {
            let kind = self.toolbar_kind()?;
            let range = selection.clone()?;
            if self.toolbar.dismissed.is_some()
                || self.toolbar.dragging
                || self.composing_annotation()
                || !self.editor.focus_handle(cx).contains_focused(window, cx)
                    && self.toolbar.menu.is_none()
            {
                return None;
            }
            Some((kind, range))
        })();
        let Some((kind, range)) = shown else {
            self.toolbar.last = None;
            self.toolbar.menu = None;
            return Some(tracker);
        };
        if self.toolbar.last.is_none() {
            self.toolbar.shown += 1;
        }
        self.toolbar.last = Some(range.clone());
        let (Some(view), Some(editor)) = (
            self.toolbar.view.get(),
            self.lattice.read(cx).painted().bounds,
        ) else {
            cx.on_next_frame(window, |_, _, cx| cx.notify());
            return Some(tracker);
        };
        // The selection's first line on screen: its start, and its end on
        // that line.
        let read = self.read_selection(kind, range.clone(), cx);
        let (line_end, formats) = (read.line_end, read.formats.clone());
        let (start, end) = self.lattice.update(cx, |lattice, cx| {
            (
                lattice.offset_bounds(range.start, window, cx),
                lattice.offset_bounds(line_end, window, cx),
            )
        });
        let (Some(start), Some(end)) = (start, end) else {
            return Some(tracker);
        };
        let top_edge = view.top().max(editor.top());
        if start.bottom() < top_edge || start.top() > view.bottom() {
            return Some(tracker);
        }
        let estimate = px(if kind == Kind::Markdown {
            MARKDOWN_WIDTH
        } else {
            LATEX_WIDTH
        });
        let max_width = (view.size.width - px(16.)).max(px(0.));
        let measured = self.toolbar.size.get();
        let width = measured.map_or(estimate.min(max_width), |size| size.width);
        let height = measured.map_or(px(HEIGHT), |size| size.height);
        let center = if (start.top() - end.top()).abs() < px(1.) {
            (start.left() + end.right()) / 2.
        } else {
            start.left() + (view.size.width / 5.).clamp(px(20.), px(72.))
        };
        let half = width / 2.;
        let center = center
            .max(view.left() + half + px(GAP))
            .min(view.right() - half - px(GAP));
        let below = start.top() - top_edge < px(ROOM_ABOVE);
        let top = if below {
            start.bottom() + px(GAP)
        } else {
            start.top() - px(GAP) - height
        };
        let bar = match &formats {
            Formats::Latex(formats) => self.latex_tools(formats, cx),
            Formats::Markdown(format) => self.markdown_tools(format, cx),
        };
        let palette = cx.palette().clone();
        let size_cell = self.toolbar.size.clone();
        let panel = cx.entity_id();
        self.toolbar.areas.borrow_mut().clear();
        let areas = self.toolbar.areas.clone();
        let menu_areas = self.toolbar.areas.clone();
        let toolbar = div()
            .id("selection-toolbar")
            .flex()
            .flex_wrap()
            .items_center()
            .max_w(max_width)
            .p(px(PAD))
            .rounded(RADIUS_PANEL)
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, window, cx| {
                // A press here keeps the editor's focus and selection.
                window.prevent_default();
                cx.stop_propagation();
            })
            .child(bar)
            .child(
                canvas(
                    move |bounds, window, _| {
                        // A new size places it anew.
                        if size_cell.replace(Some(bounds.size)) != Some(bounds.size) {
                            window.on_next_frame(move |_, cx| cx.notify(panel));
                        }
                        areas.borrow_mut().push(bounds);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        let menu = self
            .toolbar
            .menu
            .map(|menu| self.toolbar_menu(menu, kind, &formats, range.clone(), window, cx));
        let from = if below {
            PopFrom::Below
        } else {
            PopFrom::Above
        };
        let left = center - width / 2. - view.left();
        let id = self.toolbar.shown as usize;
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(tracker)
                .child(
                    div()
                        .absolute()
                        .left(left)
                        .top(top - view.top())
                        .on_mouse_down_out(cx.listener(
                            |this, event: &gpui::MouseDownEvent, _, cx| {
                                if (this.toolbar.menu.is_some() || this.toolbar.last.is_some())
                                    && !this.on_toolbar(event.position)
                                {
                                    this.dismiss_toolbar(cx)
                                }
                            },
                        ))
                        .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                            if event.keystroke.key == "escape" {
                                cx.stop_propagation();
                                this.dismiss_toolbar(cx);
                                this.refocus_editor(window, cx);
                            }
                        }))
                        .child(pop_in(("selection-toolbar-in", id), from, toolbar))
                        .children(menu.map(|menu| {
                            // Its menus stand 8px clear of it, on its side away
                            // from the text.
                            div()
                                .absolute()
                                .left_0()
                                .map(|this| {
                                    if below {
                                        this.top(height + px(GAP))
                                    } else {
                                        this.bottom(height + px(GAP))
                                    }
                                })
                                .child(menu)
                                .child(
                                    canvas(
                                        move |bounds, _, _| menu_areas.borrow_mut().push(bounds),
                                        |_, _, _, _| {},
                                    )
                                    .absolute()
                                    .top_0()
                                    .left_0()
                                    .size_full(),
                                )
                        })),
                )
                .into_any_element(),
        )
    }
}
