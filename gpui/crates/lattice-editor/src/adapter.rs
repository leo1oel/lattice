//! [`LatticeEditor`]: Zed's editor over one buffer, with every Lattice
//! extension point on it.
//!
//! The view is the editor over its ground and current line (painted here,
//! `current_line.rs`, as the Tauri app draws its line), inset by Lattice's
//! source gutter (`gutter_column.rs`: line numbers and fold markers, in place
//! of Zed's gutter) and by the room the host keeps at its right edge (the
//! outline rail's), with an overlay on top of it, laid over the whole view,
//! and Lattice's overlay scrollbar at its right edge (`scrollbar.rs`; Zed's
//! own is turned off): the overlay paints gutter marks and remote carets in the
//! editor's coordinates, runs the pointer for hover cards (Zed's editor
//! hovers only for its language servers), and holds the open card. Marks,
//! highlights and block widgets are Zed's own, set through the editor's
//! highlight and block APIs (`decorations.rs`, `blocks.rs`); completions go
//! to Zed's menu through one provider (`completion.rs`).
//!
//! The overlay re-reads the editor's layout every frame it draws, and the
//! view draws again whenever the editor notifies (a scroll, an edit, a
//! resize), so what it paints never trails the text.

use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, HashSet},
    ops::Range,
    rc::Rc,
    time::Instant,
};

use editor::{
    Editor, EditorEvent, HighlightKey,
    display_map::{BlockPlacement, BlockProperties, BlockStyle, CustomBlockId},
};
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable,
    HitboxBehavior, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render,
    SharedString, Styled as _, Subscription, TextRun, Window, canvas, div, point, px, size,
};
use language::{Buffer, BufferEvent, BufferSnapshot};
use lattice_ui::ActiveLattice as _;

mod current_line;
mod gutter_column;
mod overlay;
mod pointer;
mod scrollbar;

use gutter_column::{GutterLayout, GutterPointer};
pub use gutter_column::{PaintedGutter, PaintedLine};
pub use overlay::{Painted, PaintedCursor};
use pointer::Hover;

use crate::{
    blocks::{BlockSide, BlockWidget},
    completion::{CompletionSource, Offered, Provider, Sources},
    decorations::{self, Highlight, Mark},
    folds::{FoldRange, FoldSource},
    gutter::GutterMark,
    hover::HoverProvider,
    remote_cursors::RemoteCursor,
};

/// What the editor asks of its host.
#[derive(Clone, Debug, PartialEq)]
pub enum LatticeEditorEvent {
    /// Open the project-relative `path` at the 1-based `line` (a card's
    /// "Go to entry", a reference card's source).
    OpenLocation { path: String, line: u32 },
}

struct AnchoredGutterMark {
    anchor: language::Anchor,
    mark: GutterMark,
}

struct AnchoredCursor {
    cursor: RemoteCursor,
    anchor: language::Anchor,
    /// When it arrived or last moved: its tag shows for a moment from then.
    since: Instant,
}

pub struct LatticeEditor {
    editor: Entity<Editor>,
    buffer: Entity<Buffer>,
    /// Each mark layer's keys, one per distinct style.
    marks: HashMap<&'static str, Vec<HighlightKey>>,
    highlights: HashSet<&'static str>,
    gutter: BTreeMap<&'static str, Vec<AnchoredGutterMark>>,
    blocks: HashMap<&'static str, HashSet<CustomBlockId>>,
    hover_providers: Vec<Rc<dyn HoverProvider>>,
    hover: Hover,
    sources: Sources,
    offered: Offered,
    cursors: Vec<AnchoredCursor>,
    hovered_cursor: Option<SharedString>,
    painted: Rc<RefCell<Painted>>,
    scroll: scrollbar::EditorScroll,
    /// The language's fold source, and what it answered since the last edit.
    folds: Option<FoldSource>,
    fold_cache: RefCell<HashMap<u32, Option<FoldRange>>>,
    /// The source gutter's geometry as of the last render (`None` before
    /// the first), the pointer over it and what it painted.
    gutter_layout: Option<GutterLayout>,
    gutter_pointer: GutterPointer,
    painted_gutter: Rc<RefCell<PaintedGutter>>,
    /// The room the text leaves at the editor's right edge.
    end_clearance: Pixels,
    /// The editor element's bounds as last laid out.
    editor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<LatticeEditorEvent> for LatticeEditor {}

impl LatticeEditor {
    /// Zed's editor over `buffer`, with the adapter's completion provider.
    pub fn new(buffer: Entity<Buffer>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            let mut editor = Editor::for_buffer(buffer.clone(), None, window, cx);
            // Lattice's gutter stands in for Zed's (`gutter_column.rs`).
            editor.set_show_gutter(false, cx);
            editor.set_offset_content(false, cx);
            editor
        });
        let sources: Sources = Rc::default();
        let offered: Offered = Rc::default();
        editor.update(cx, |zed, _| {
            zed.set_completion_provider(Some(Rc::new(Provider {
                sources: sources.clone(),
                editor: editor.downgrade(),
                offered: offered.clone(),
            })));
        });
        let subscriptions = vec![
            // The overlay follows the editor's layout.
            cx.observe(&editor, |_, _, cx| cx.notify()),
            cx.subscribe(&editor, |this, _, event: &EditorEvent, _| {
                if matches!(event, EditorEvent::Blurred) {
                    this.hovered_cursor = None;
                }
            }),
            // An edit closes the card, as typing into a key closes the
            // Tauri app's.
            cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                if matches!(event, BufferEvent::Edited { .. }) {
                    this.fold_cache.get_mut().clear();
                    this.dismiss_hover(cx);
                }
            }),
        ];
        Self {
            editor,
            buffer,
            marks: HashMap::new(),
            highlights: HashSet::new(),
            gutter: BTreeMap::new(),
            blocks: HashMap::new(),
            hover_providers: Vec::new(),
            hover: Hover::Idle,
            sources,
            offered,
            cursors: Vec::new(),
            hovered_cursor: None,
            painted: Rc::default(),
            scroll: scrollbar::EditorScroll::default(),
            folds: None,
            fold_cache: RefCell::default(),
            gutter_layout: None,
            gutter_pointer: GutterPointer::default(),
            painted_gutter: Rc::default(),
            end_clearance: px(0.),
            editor_bounds: Rc::default(),
            _subscriptions: subscriptions,
        }
    }

    /// Zed's editor itself: selections, scrolling, search and Vim.
    pub fn editor(&self) -> &Entity<Editor> {
        &self.editor
    }

    pub fn buffer(&self) -> &Entity<Buffer> {
        &self.buffer
    }

    /// What the overlay painted last frame.
    pub fn painted(&self) -> Painted {
        self.painted.borrow().clone()
    }

    /// What the source gutter painted last frame.
    pub fn painted_gutter(&self) -> PaintedGutter {
        self.painted_gutter.borrow().clone()
    }

    /// Fold lines as `source` says (`None`: nothing folds; the gutter keeps
    /// its fold column).
    pub fn set_fold_source(&mut self, source: Option<FoldSource>, cx: &mut Context<Self>) {
        self.folds = source;
        self.fold_cache.get_mut().clear();
        cx.notify();
    }

    /// The room the text leaves at the right edge.
    pub fn end_clearance(&self) -> Pixels {
        self.end_clearance
    }

    /// Keep `clearance` free at the editor's right edge: the text wraps
    /// short of it, as CodeMirror's does beside the outline rail.
    pub fn set_end_clearance(&mut self, clearance: Pixels, cx: &mut Context<Self>) {
        if self.end_clearance != clearance {
            self.end_clearance = clearance;
            cx.notify();
        }
    }

    /// The editor element's bounds, within the view's `bounds`: inset by the
    /// gutter, and at the right by the clearance (less what Zed keeps
    /// itself).
    fn editor_bounds(&self, bounds: Bounds<Pixels>) -> Option<Bounds<Pixels>> {
        let layout = self.gutter_layout?;
        let left = bounds.left() + layout.text_start();
        let right = bounds.right() - layout.element_end(self.end_clearance);
        let pad = gutter_column::CONTENT_PADDING;
        Some(Bounds {
            origin: point(left, bounds.top() + pad),
            size: size(
                (right - left).max(px(0.)),
                (bounds.size.height - pad * 2.).max(px(0.)),
            ),
        })
    }

    /// The buffer row in the middle of the editor, as of the last frame:
    /// where the reader is.
    pub fn middle_line(&self, window: &mut Window, cx: &mut App) -> Option<u32> {
        let bounds = self.editor_bounds.get()?;
        crate::geometry::Frame::read(&self.editor, bounds, window, cx)
            .map(|frame| frame.middle_buffer_row())
    }

    /// Measure the gutter in the buffer font: a digit's advance, and as many
    /// digits as the document needs past four.
    fn measure_gutter(&mut self, window: &mut Window, cx: &mut App) -> GutterLayout {
        let (font, font_size) = gutter_column::buffer_font(cx);
        let run = TextRun {
            len: 1,
            font,
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let ch = window
            .text_system()
            .shape_line("0".into(), font_size, &[run], None)
            .width;
        let lines = self.buffer.read(cx).max_point().row + 1;
        let layout = GutterLayout {
            ch,
            digits: gutter_column::digits_for(lines),
        };
        self.gutter_layout = Some(layout);
        layout
    }

    fn multi_anchor(&self, anchor: language::Anchor, cx: &App) -> Option<editor::Anchor> {
        self.editor
            .read(cx)
            .buffer()
            .read(cx)
            .snapshot(cx)
            .anchor_in_buffer(anchor)
    }

    fn multi_range(
        &self,
        range: Range<usize>,
        text: &BufferSnapshot,
        cx: &App,
    ) -> Option<Range<editor::Anchor>> {
        let start = self.multi_anchor(text.anchor_before(range.start.min(text.len())), cx)?;
        let end = self.multi_anchor(text.anchor_after(range.end.min(text.len())), cx)?;
        Some(start..end)
    }

    // ---- marks and highlights ---------------------------------------------

    /// Replace `layer`'s marks.
    pub fn set_marks(&mut self, layer: &'static str, marks: Vec<Mark>, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).snapshot();
        let groups = decorations::group_by_style(&marks);
        let previous = self.marks.remove(layer).unwrap_or_default();
        let mut keys = Vec::with_capacity(groups.len());
        let resolved: Vec<_> = groups
            .into_iter()
            .enumerate()
            .map(|(index, (style, ranges))| {
                let key = HighlightKey::ConsoleAnsiHighlight(decorations::slot(layer, index));
                let ranges: Vec<_> = ranges
                    .into_iter()
                    .filter_map(|range| self.multi_range(range, &text, cx))
                    .collect();
                (key, style, ranges)
            })
            .collect();
        self.editor.update(cx, |editor, cx| {
            for key in previous {
                editor.clear_highlights(key, cx);
            }
            for (key, style, ranges) in resolved {
                editor.highlight_text(key, ranges, style.highlight_style(), cx);
                keys.push(key);
            }
        });
        if !keys.is_empty() {
            self.marks.insert(layer, keys);
        }
    }

    /// The ranges `layer`'s marks cover now, in buffer offsets.
    pub fn mark_ranges(&self, layer: &'static str, cx: &App) -> Vec<Range<usize>> {
        let Some(keys) = self.marks.get(layer) else {
            return Vec::new();
        };
        let editor = self.editor.read(cx);
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        let mut ranges: Vec<Range<usize>> = keys
            .iter()
            .filter_map(|key| editor.text_highlights(*key, cx))
            .flat_map(|(_, ranges)| ranges.iter())
            .map(|range| {
                use editor::ToOffset as _;
                range.start.to_offset(&snapshot).0..range.end.to_offset(&snapshot).0
            })
            .collect();
        ranges.sort_by_key(|range| (range.start, range.end));
        ranges
    }

    /// Replace `layer`'s highlights (washes behind the text).
    pub fn set_highlights(
        &mut self,
        layer: &'static str,
        mut highlights: Vec<Highlight>,
        cx: &mut Context<Self>,
    ) {
        let text = self.buffer.read(cx).snapshot();
        let key = HighlightKey::ConsoleAnsiHighlight(decorations::slot(layer, usize::MAX));
        highlights.sort_by_key(|highlight| (highlight.range.start, highlight.range.end));
        let (ranges, colors): (Vec<_>, Vec<_>) = highlights
            .into_iter()
            .filter_map(|highlight| {
                Some((
                    self.multi_range(highlight.range, &text, cx)?,
                    highlight.color,
                ))
            })
            .unzip();
        let empty = ranges.is_empty();
        self.editor.update(cx, |editor, cx| {
            if empty {
                editor.clear_background_highlights(key, cx);
            } else {
                editor.highlight_background(
                    key,
                    &ranges,
                    move |index, _| colors.get(*index).copied().unwrap_or_default(),
                    cx,
                );
            }
        });
        if empty {
            self.highlights.remove(layer);
        } else {
            self.highlights.insert(layer);
        }
    }

    // ---- gutter marks ------------------------------------------------------

    /// Replace `layer`'s gutter marks.
    pub fn set_gutter_marks(
        &mut self,
        layer: &'static str,
        marks: Vec<GutterMark>,
        cx: &mut Context<Self>,
    ) {
        let text = self.buffer.read(cx).snapshot();
        let max_row = text.max_point().row;
        let anchored: Vec<_> = marks
            .into_iter()
            .map(|mark| AnchoredGutterMark {
                anchor: text.anchor_before(language::Point::new(mark.line.min(max_row), 0)),
                mark,
            })
            .collect();
        if anchored.is_empty() {
            self.gutter.remove(layer);
        } else {
            self.gutter.insert(layer, anchored);
        }
        cx.notify();
    }

    // ---- block widgets -----------------------------------------------------

    /// Replace `layer`'s block widgets.
    pub fn set_blocks(
        &mut self,
        layer: &'static str,
        blocks: Vec<BlockWidget>,
        cx: &mut Context<Self>,
    ) {
        let text = self.buffer.read(cx).snapshot();
        let max_row = text.max_point().row;
        let properties: Vec<_> = blocks
            .into_iter()
            .filter_map(|block| {
                let row = block.line.min(max_row);
                let point = match block.side {
                    BlockSide::Above => language::Point::new(row, 0),
                    BlockSide::Below => language::Point::new(row, text.line_len(row)),
                };
                let anchor = self.multi_anchor(text.anchor_before(point), cx)?;
                let render = block.render.clone();
                let lines = block.lines.max(1);
                Some(BlockProperties {
                    placement: match block.side {
                        BlockSide::Above => BlockPlacement::Above(anchor),
                        BlockSide::Below => BlockPlacement::Below(anchor),
                    },
                    height: Some(lines),
                    style: BlockStyle::Flex,
                    // Zed measures a block's content and resizes the block to
                    // it, so a widget shorter than its lines would shrink to
                    // one: hold it to its lines (a taller one still grows).
                    render: std::sync::Arc::new(move |context| {
                        let height = context.line_height * lines as f32;
                        div()
                            .min_h(height)
                            .child(render(context))
                            .into_any_element()
                    }),
                    priority: 0,
                })
            })
            .collect();
        let previous = self.blocks.remove(layer).unwrap_or_default();
        let ids = self.editor.update(cx, |editor, cx| {
            if !previous.is_empty() {
                editor.remove_blocks(previous.into_iter().collect(), None, cx);
            }
            editor.insert_blocks(properties, None, cx)
        });
        if !ids.is_empty() {
            self.blocks.insert(layer, ids.into_iter().collect());
        }
    }

    /// Remove everything `layer` set: marks, highlights, gutter marks, blocks.
    pub fn clear_layer(&mut self, layer: &'static str, cx: &mut Context<Self>) {
        self.set_marks(layer, Vec::new(), cx);
        if self.highlights.contains(layer) {
            self.set_highlights(layer, Vec::new(), cx);
        }
        self.set_gutter_marks(layer, Vec::new(), cx);
        self.set_blocks(layer, Vec::new(), cx);
    }

    // ---- completion sources ------------------------------------------------

    pub fn add_completion_source(&mut self, source: Rc<dyn CompletionSource>) {
        self.sources.borrow_mut().push(source);
    }

    /// The labels the completion menu was last given, in order.
    pub fn offered_completions(&self) -> Vec<SharedString> {
        self.offered.borrow().clone()
    }

    // ---- remote cursors ----------------------------------------------------

    /// Replace the remote carets. A caret that moved, or arrived, shows its
    /// name for a moment.
    pub fn set_remote_cursors(&mut self, cursors: Vec<RemoteCursor>, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).snapshot();
        let max_row = text.max_point().row;
        let now = Instant::now();
        let previous = std::mem::take(&mut self.cursors);
        self.cursors = cursors
            .into_iter()
            .map(|cursor| {
                let row = cursor.row.min(max_row);
                let column = cursor.column.min(text.line_len(row));
                let anchor = text.anchor_before(language::Point::new(row, column));
                // Same caret, same place, same look: its tag stays as it was.
                let since = previous
                    .iter()
                    .find(|old| old.cursor == cursor)
                    .map_or(now, |old| old.since);
                AnchoredCursor {
                    cursor,
                    anchor,
                    since,
                }
            })
            .collect();
        cx.notify();
    }
}

impl Focusable for LatticeEditor {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl Render for LatticeEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let card = self.render_card(window, cx);
        let scrollbar = self.render_scrollbar(window, cx);
        let layout = self.measure_gutter(window, cx);
        let fades = self.gutter_fades(window, cx);
        let this = cx.entity();
        let under = cx.entity();
        let gutter = cx.entity();
        let gutter_paint = cx.entity();
        let editor_bounds = self.editor_bounds.clone();
        let lattice = cx.lattice();
        let ground = lattice_ui::editor_theme::ground(lattice.code_theme, &lattice.palette);
        div()
            .relative()
            .size_full()
            // The editor element may reach past the right edge (see
            // `GutterLayout::element_end`): the view clips it.
            .overflow_hidden()
            // Zed's editor is clear (the code theme leaves its ground to the
            // adapter): the ground, then the current line under the text.
            .bg(ground)
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        under.update(cx, |this, cx| this.paint_current_line(bounds, window, cx));
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            // Any key closes the card, as typing does in the Tauri app.
            .capture_key_down(cx.listener(|this, _, _, cx| this.dismiss_hover(cx)))
            // Zed scrolls only under its own text: the gutter and the padding
            // strips pass the wheel on, as CodeMirror's scroller takes it
            // over its gutter.
            .on_scroll(cx.listener(|this, event, _, cx| this.scroll_by_wheel(event, cx)))
            .child(
                div()
                    .absolute()
                    .top(gutter_column::CONTENT_PADDING)
                    .bottom(gutter_column::CONTENT_PADDING)
                    .left(layout.text_start())
                    .right(layout.element_end(self.end_clearance))
                    .child(self.editor.clone())
                    .child(
                        canvas(
                            move |bounds, _, _| editor_bounds.set(Some(bounds)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                    ),
            )
            .child(
                canvas(
                    move |bounds, window, cx| {
                        gutter.update(cx, |this, cx| this.prepaint_gutter(bounds, window, cx))
                    },
                    move |bounds, prepainted, window, cx| {
                        gutter_paint.update(cx, |this, cx| {
                            this.paint_gutter(bounds, prepainted, fades, window, cx)
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .child(
                canvas(
                    |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                    move |bounds, hitbox, window, cx| {
                        this.update(cx, |this, cx| {
                            this.paint_overlay(bounds, &hitbox, window, cx)
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .child(scrollbar)
            .children(card)
    }
}
