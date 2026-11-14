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

use super::{EditorPanel, highlight_palette};

/// The toolbar's buttons and its padding.
const BUTTON: f32 = 28.;
const PAD: f32 = 3.;
/// Its height, for placing it above the selection.
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
    /// The source view's bounds, and the toolbar's width, as last drawn.
    view: Rc<Cell<Option<Bounds<Pixels>>>>,
    width: Rc<Cell<Pixels>>,
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
    /// How many highlights the last paint painted.
    painted: usize,
    _paint: Option<gpui::Task<()>>,
}

/// The paint's layers: the tints, and the ink, underlines and faded
/// wrappers.
const PAINT: &str = "highlight-paint";
const PAINT_MARKS: &str = "highlight-paint-marks";

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
    fn toolbar_selection(&self, cx: &App) -> Option<Range<usize>> {
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let selection = editor.selections.newest_anchor();
        let (start, end) = (
            selection.start.to_offset(&snapshot).0,
            selection.end.to_offset(&snapshot).0,
        );
        (start != end).then(|| start.min(end)..start.max(end))
    }

    /// The pointer went down in the source (a selection may be dragged out)
    /// or came up (the drag settled): the toolbar waits for it.
    pub(super) fn toolbar_pointer(
        &mut self,
        down: bool,
        position: gpui::Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if down
            && self.toolbar.last.is_some()
            && self.toolbar.areas.borrow().iter().any(|area| area.contains(&position))
        {
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

    /// Paint the `.tex` file's highlights (`highlights::paint`).
    pub(super) fn paint_highlights(&mut self, cx: &mut Context<Self>) {
        if self.toolbar_kind() != Some(Kind::Latex) {
            return;
        }
        let dark = cx.palette().appearance == lattice_ui::Appearance::Dark;
        let text = self.buffer.read(cx).text();
        let (washes, marks) = highlights::paint(&text, dark);
        self.toolbar.painted_dark = Some(dark);
        self.toolbar.painted = washes.len();
        self.lattice.update(cx, |lattice, cx| {
            lattice.set_highlights(PAINT, washes, cx);
            lattice.set_marks(PAINT_MARKS, marks, cx);
        });
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
    pub(super) fn dismiss_toolbar(&mut self, cx: &mut Context<Self>) {
        self.toolbar.dismissed = self.toolbar_selection(cx);
        self.toolbar.menu = None;
        self.toolbar.link = None;
        cx.notify();
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
                            MultiBufferOffset(change.range.start)..MultiBufferOffset(change.range.end),
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
            ToolbarAction::Latex(format) => Some(format_toggle::toggle_inline(&text, range, format)),
            ToolbarAction::Quote => Some(format_toggle::toggle_quote(&text, range)),
            ToolbarAction::Heading(command) => Some(format_toggle::set_heading(&text, range, command)),
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
        }
        cx.notify();
    }

    fn open_menu(&mut self, menu: Menu, window: &mut Window, cx: &mut Context<Self>) {
        if self.toolbar.menu == Some(menu) {
            self.toolbar.menu = None;
            cx.notify();
            return;
        }
        self.toolbar.menu = Some(menu);
        self.toolbar.palette = Default::default();
        if menu == Menu::Highlight {
            let focus = cx.focus_handle();
            window.focus(&focus, cx);
            self.toolbar.palette.focus = Some(focus);
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
        if self.toolbar.painted_dark.is_some_and(|painted| painted != dark) {
            self.paint_highlights(cx);
        }
        let view_cell = self.toolbar.view.clone();
        let tracker = canvas(move |bounds, _, _| view_cell.set(Some(bounds)), |_, _, _, _| {})
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
        let (Some(view), Some(editor)) = (self.toolbar.view.get(), self.lattice.read(cx).painted().bounds)
        else {
            cx.on_next_frame(window, |_, _, cx| cx.notify());
            return Some(tracker);
        };
        // The selection's first line on screen: its start, and its end on
        // that line.
        let text = self.buffer.read(cx).text();
        let line_end = text[range.start..]
            .find('\n')
            .map_or(text.len(), |at| range.start + at)
            .min(range.end);
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
        let estimate = px(if kind == Kind::Markdown { MARKDOWN_WIDTH } else { LATEX_WIDTH });
        let max_width = (view.size.width - px(16.)).max(px(0.));
        let measured = self.toolbar.width.get();
        let width = if measured > px(0.) { measured } else { estimate.min(max_width) };
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
            start.top() - px(GAP) - px(HEIGHT)
        };
        let bar = match kind {
            Kind::Latex => self.latex_tools(&text, range.clone(), cx),
            Kind::Markdown => self.markdown_tools(&text, range.clone(), cx),
        };
        let palette = cx.palette().clone();
        let width_cell = self.toolbar.width.clone();
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
                    move |bounds, _, _| {
                        width_cell.set(bounds.size.width);
                        areas.borrow_mut().push(bounds);
                    },
                    |_, _, _, _| {},
                )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            );
        let menu = self.toolbar.menu.map(|menu| self.toolbar_menu(menu, &text, range.clone(), window, cx));
        let from = if below { PopFrom::Below } else { PopFrom::Above };
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
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            if this.toolbar.menu.is_some() || this.toolbar.last.is_some() {
                                this.dismiss_toolbar(cx)
                            }
                        }))
                        .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                            if event.keystroke.key == "escape" {
                                cx.stop_propagation();
                                this.dismiss_toolbar(cx);
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
                                        this.top(px(HEIGHT + GAP))
                                    } else {
                                        this.bottom(px(GAP))
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

    /// The LaTeX toolbar's buttons.
    fn latex_tools(&mut self, text: &str, range: Range<usize>, cx: &mut Context<Self>) -> AnyElement {
        let formats = format_toggle::selection_formats(text, range.clone());
        let editable = true;
        let mut bar = div().flex().items_center();
        let inline = [
            (format_toggle::InlineFormat::Bold, Icon::BOLD, t!("Bold")),
            (format_toggle::InlineFormat::Italic, Icon::ITALIC, t!("Italic")),
            (format_toggle::InlineFormat::Underline, Icon::UNDERLINE, t!("Underline")),
            (
                format_toggle::InlineFormat::Strikethrough,
                Icon::STRIKETHROUGH,
                t!("Strikethrough"),
            ),
        ];
        if editable {
            for (index, (format, icon, label)) in inline.into_iter().enumerate() {
                let pressed = formats.inline.contains(&format);
                bar = bar.child(tool(
                    ("latex-format", index),
                    icon,
                    label,
                    Some(pressed),
                    false,
                    cx.listener(move |this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Latex(format), window, cx)
                    }),
                    cx,
                ));
            }
            bar = bar.child(tool(
                "latex-quote",
                Icon::QUOTE,
                t!("Quote"),
                Some(formats.quote),
                false,
                cx.listener(|this, _, window, cx| this.toolbar_action(ToolbarAction::Quote, window, cx)),
                cx,
            ));
        }
        bar = bar.child(tool(
            "latex-annotate",
            Icon::MESSAGE_SQUARE_TEXT,
            t!("Annotate"),
            None,
            editable,
            cx.listener(|this, _, window, cx| this.toolbar_action(ToolbarAction::Annotate, window, cx)),
            cx,
        ));
        if editable {
            let menu = self.toolbar.menu;
            bar = bar
                .child(tool(
                    "latex-link",
                    Icon::LINK,
                    t!("Link"),
                    Some(formats.link || menu == Some(Menu::Link)),
                    true,
                    cx.listener(|this, _, window, cx| this.open_menu(Menu::Link, window, cx)),
                    cx,
                ))
                .child(tool(
                    "latex-heading",
                    Icon::HEADING,
                    t!("Heading level"),
                    Some(formats.heading.is_some() || menu == Some(Menu::Heading)),
                    false,
                    cx.listener(|this, _, window, cx| this.open_menu(Menu::Heading, window, cx)),
                    cx,
                ))
                .child(self.highlight_split(cx));
        }
        bar.into_any_element()
    }

    /// The highlighter: the pen applies the last highlighter (the bar under
    /// it is its colour), the caret opens the palette.
    fn highlight_split(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let last = highlight_palette::prefs(cx).last.clone();
        let last_highlight = highlight_palette::meaning_of_color(&last, cx);
        let label: SharedString =
            t!("Highlight: {lastHighlight}", lastHighlight = last_highlight).into();
        let pen_color = last.clone();
        let open = self.toolbar.menu == Some(Menu::Highlight);
        let pen = div()
            .id("latex-highlight-pen")
            .relative()
            .size(px(BUTTON))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|this| this.bg(palette.accent_soft))
            .child(Icon::HIGHLIGHTER.element(px(14.), palette.text_secondary))
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .right(px(8.))
                    .bottom(px(3.))
                    .h(px(3.))
                    .rounded_full()
                    .bg(highlight_palette::hex_color(&last))
                    .border(px(0.5))
                    .border_color(palette.text.opacity(0.24)),
            )
            .tooltip(move |_, cx| LatticeTooltip::view(label.clone(), None, cx))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.toolbar_action(ToolbarAction::Highlight(pen_color.clone()), window, cx)
            }));
        let caret = div()
            .id("latex-highlight-caret")
            .w(px(16.))
            .h(px(BUTTON))
            .ml(px(-2.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .when(open, |this| this.bg(palette.accent_soft))
            .hover(|this| this.bg(palette.accent_soft))
            .child(Icon::CHEVRON_DOWN.element(px(12.), if open { palette.text } else { palette.text_secondary }))
            .tooltip(|_, cx| LatticeTooltip::view(SharedString::from(t!("Highlight color")), None, cx))
            .on_click(cx.listener(|this, _, window, cx| this.open_menu(Menu::Highlight, window, cx)));
        separated(div().flex().items_center().child(pen).child(caret), &palette).into_any_element()
    }

    /// The Markdown toolbar's buttons.
    fn markdown_tools(&mut self, text: &str, range: Range<usize>, cx: &mut Context<Self>) -> AnyElement {
        let format = markdown_format::selection_format(text, range);
        let palette = cx.palette().clone();
        let formats = !format.in_code;
        let current = block_label(format.block);
        let open = self.toolbar.menu == Some(Menu::Block);
        let block = div()
            .id("markdown-block-type")
            .h(px(BUTTON))
            .flex()
            .items_center()
            .gap(px(2.))
            .pl(px(8.))
            .pr(px(6.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_role(TextRole::Body, cx)
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(palette.text)
            .when(open, |this| this.bg(palette.hover))
            .hover(|this| this.bg(palette.hover))
            .child(current)
            .child(Icon::CHEVRON_DOWN.element(px(12.), palette.text.opacity(0.7)))
            .on_click(cx.listener(|this, _, window, cx| this.open_menu(Menu::Block, window, cx)));
        let mut bar = div().flex().flex_wrap().items_center().gap(px(1.)).child(block).child(divider(&palette));
        if formats {
            let marks = [
                (MdFormat::Bold, Icon::BOLD, t!("Bold")),
                (MdFormat::Italic, Icon::ITALIC, t!("Italic")),
                (MdFormat::Underline, Icon::UNDERLINE, t!("Underline")),
                (MdFormat::Strike, Icon::STRIKETHROUGH, t!("Strikethrough")),
                (MdFormat::Code, Icon::CODE, t!("Inline code")),
                (MdFormat::Highlight, Icon::HIGHLIGHTER, t!("Highlight")),
            ];
            for (index, (mark, icon, label)) in marks.into_iter().enumerate() {
                bar = bar.child(md_tool(
                    ("markdown-format", index),
                    icon,
                    label,
                    Some(format.inline.contains(&mark)),
                    cx.listener(move |this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Markdown(mark), window, cx)
                    }),
                    cx,
                ));
            }
            bar = bar
                .child(divider(&palette))
                .child(md_tool(
                    "markdown-link",
                    Icon::LINK,
                    t!("Insert link"),
                    Some(format.inline.contains(&MdFormat::Link)),
                    cx.listener(|this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Markdown(MdFormat::Link), window, cx)
                    }),
                    cx,
                ))
                .child(md_tool(
                    "markdown-math",
                    Icon::RADICAL,
                    t!("Convert selection to inline math"),
                    Some(format.inline.contains(&MdFormat::Math)),
                    cx.listener(|this, _, window, cx| {
                        this.toolbar_action(ToolbarAction::Markdown(MdFormat::Math), window, cx)
                    }),
                    cx,
                ))
                .child(divider(&palette));
        }
        bar.child(md_tool(
            "markdown-annotate",
            Icon::MESSAGE_SQUARE_TEXT,
            t!("Annotate"),
            None,
            cx.listener(|this, _, window, cx| this.toolbar_action(ToolbarAction::Annotate, window, cx)),
            cx,
        ))
        .into_any_element()
    }

    /// The open menu: the link field, the heading levels, the highlight
    /// palette or the block types.
    fn toolbar_menu(
        &mut self,
        menu: Menu,
        text: &str,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let surface = |content: AnyElement, width: Option<f32>| {
            div()
                .occlude()
                .when_some(width, |this, width| this.w(px(width)))
                .p(px(5.))
                .rounded(RADIUS_PANEL)
                .bg(palette.raised)
                .shadow(Elevation::Popover.shadows(&palette))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(content)
                .into_any_element()
        };
        match menu {
            Menu::Link => {
                let Some((field, _)) = &self.toolbar.link else {
                    return div().into_any_element();
                };
                let filled = !field.read(cx).value().trim().is_empty();
                let field = field.clone();
                let apply_field = field.clone();
                let content = div()
                    .flex()
                    .items_end()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(SPACING_2)
                            .text_size(px(11.))
                            .text_color(palette.text_secondary.opacity(0.8))
                            .child(t!("Link URL"))
                            .child(Field::new(&field).compact()),
                    )
                    .child(
                        div()
                            .id("latex-link-apply")
                            .h(px(28.))
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .rounded(px(6.))
                            .text_size(px(11.))
                            .text_color(if filled { palette.text } else { palette.disabled_ink })
                            .bg(if filled { palette.tinted } else { palette.disabled_surface })
                            .when(filled, |this| {
                                this.cursor_pointer().hover(|this| this.bg(palette.tinted_hover))
                            })
                            .child(t!("Apply"))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let url = apply_field.read(cx).value().trim().to_string();
                                if !url.is_empty() {
                                    this.toolbar_action(ToolbarAction::Link(url), window, cx);
                                }
                            })),
                    )
                    .into_any_element();
                surface(content, Some(250.))
            }
            Menu::Heading => {
                let current = format_toggle::selection_formats(text, range).heading;
                let levels = [
                    ("part", t!("Part")),
                    ("chapter", t!("Chapter")),
                    ("section", t!("Section")),
                    ("subsection", t!("Subsection")),
                    ("subsubsection", t!("Subsubsection")),
                ];
                let rows = levels.into_iter().enumerate().map(|(index, (command, label))| {
                    let on = current.as_deref() == Some(command);
                    div()
                        .id(("latex-heading-level", index))
                        .h(px(28.))
                        .px(SPACING_3)
                        .flex()
                        .items_center()
                        .justify_between()
                        .rounded(px(6.))
                        .text_size(px(11.))
                        .cursor_pointer()
                        .text_color(if on { palette.text } else { palette.text_secondary })
                        .when(on, |this| this.bg(palette.toolbar_active))
                        .hover(|this| this.bg(palette.accent_soft).text_color(palette.text))
                        .child(label)
                        .child(
                            div()
                                .font_family(cx.lattice().fonts.editor.clone())
                                .text_color(palette.text_secondary.opacity(0.8))
                                .child(format!("\\{command}")),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.toolbar_action(ToolbarAction::Heading(command), window, cx)
                        }))
                });
                surface(div().flex().flex_col().children(rows).into_any_element(), Some(180.))
            }
            Menu::Highlight => {
                let around = highlights::highlight_around(text, range.clone())
                    .map(|highlight| highlight.color.unwrap_or_default());
                let sample = text[range].split_whitespace().collect::<Vec<_>>().join(" ");
                let colors = highlights::document_colors(text);
                highlight_palette::palette(self, around, sample, colors, window, cx)
            }
            Menu::Block => {
                let current = markdown_format::selection_format(text, range).block;
                let mut list = div().flex().flex_col().min_w(px(180.));
                for (index, (block, separated)) in BLOCKS.iter().enumerate() {
                    if *separated {
                        list = list.child(div().my(px(4.)).h(px(1.)).bg(palette.line));
                    }
                    let block = *block;
                    let on = block == current;
                    list = list.child(
                        div()
                            .id(("markdown-block", index))
                            .h(px(28.))
                            .px(SPACING_3)
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .text_role(TextRole::Body, cx)
                            .text_color(palette.text)
                            .hover(|this| this.bg(palette.hover))
                            .child(
                                div()
                                    .w(px(14.))
                                    .flex()
                                    .justify_center()
                                    .when(on, |this| this.child(Icon::CHECK.element(px(13.), palette.text))),
                            )
                            .child(block_label(block))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.toolbar_action(ToolbarAction::Block(block), window, cx)
                            })),
                    );
                }
                surface(list.into_any_element(), None)
            }
        }
    }
}

/// The block types the Markdown toolbar's menu offers, and whether a rule
/// goes before each (`TOOLBAR_BLOCK_TYPES`).
const BLOCKS: [(BlockType, bool); 12] = [
    (BlockType::Text, false),
    (BlockType::Heading(1), true),
    (BlockType::Heading(2), false),
    (BlockType::Heading(3), false),
    (BlockType::Heading(4), false),
    (BlockType::Heading(5), false),
    (BlockType::Heading(6), false),
    (BlockType::BulletList, true),
    (BlockType::OrderedList, false),
    (BlockType::TaskList, false),
    (BlockType::Quote, true),
    (BlockType::CodeBlock, false),
];

fn block_label(block: BlockType) -> SharedString {
    match block {
        BlockType::Text => t!("Text").into(),
        BlockType::Heading(1) => t!("Heading 1").into(),
        BlockType::Heading(2) => t!("Heading 2").into(),
        BlockType::Heading(3) => t!("Heading 3").into(),
        BlockType::Heading(4) => t!("Heading 4").into(),
        BlockType::Heading(5) => t!("Heading 5").into(),
        BlockType::Heading(_) => t!("Heading 6").into(),
        BlockType::BulletList => t!("Bullet List").into(),
        BlockType::OrderedList => t!("Ordered List").into(),
        BlockType::TaskList => t!("Task List").into(),
        BlockType::Quote => t!("Quote").into(),
        BlockType::CodeBlock => t!("Code Block").into(),
    }
}

/// A rule before a group of tools (`.latex-selection-tool.separated`).
fn separated(element: gpui::Div, palette: &lattice_ui::palette::Palette) -> gpui::Div {
    element
        .ml(px(3.))
        .pl(px(3.))
        .border_l_1()
        .border_color(palette.line)
}

fn divider(palette: &lattice_ui::palette::Palette) -> AnyElement {
    div().w(px(1.)).h(px(16.)).mx(px(2.)).bg(palette.line).into_any_element()
}

/// One LaTeX tool: a 28px button with its 14px icon, a tooltip, pressed
/// when the selection already has its format.
fn tool(
    id: impl Into<gpui::ElementId>,
    icon: Icon,
    label: &'static str,
    pressed: Option<bool>,
    separated_before: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let on = pressed == Some(true);
    let button = div()
        .id(id.into())
        .size(px(BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |this| this.bg(palette.toolbar_active))
        .hover(|this| this.bg(palette.accent_soft))
        .child(icon.element(px(14.), if on { palette.text } else { palette.text_secondary }))
        .tooltip(move |_, cx| LatticeTooltip::view(SharedString::from(label), None, cx))
        .on_click(on_click);
    let wrap = div().flex();
    if separated_before {
        separated(wrap, &palette).child(button).into_any_element()
    } else {
        wrap.child(button).into_any_element()
    }
}

/// One Markdown tool (`.lx-md-toolbar-button`): 15px icons, the hover fill.
fn md_tool(
    id: impl Into<gpui::ElementId>,
    icon: Icon,
    label: &'static str,
    pressed: Option<bool>,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let on = pressed == Some(true);
    div()
        .id(id.into())
        .h(px(BUTTON))
        .min_w(px(BUTTON))
        .px(px(4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .when(on, |this| this.bg(palette.toolbar_active))
        .hover(|this| this.bg(palette.hover))
        .child(icon.element(px(15.), if on { palette.text } else { palette.text_secondary }))
        .tooltip(move |_, cx| LatticeTooltip::view(SharedString::from(label), None, cx))
        .on_click(on_click)
        .into_any_element()
}
