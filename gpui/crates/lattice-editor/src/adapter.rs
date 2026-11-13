//! [`LatticeEditor`]: Zed's editor over one buffer, with every Lattice
//! extension point on it.
//!
//! The view is the editor over its ground and current line (painted here,
//! `current_line.rs`, as the Tauri app draws its line), with an overlay on
//! top of it, laid over the same bounds, and Lattice's overlay scrollbar at
//! its right edge (`scrollbar.rs`; Zed's own is turned off): the overlay paints gutter marks and remote carets in the
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
    cell::RefCell,
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
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, HitboxBehavior,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Window, canvas, div,
};
use language::{Buffer, BufferEvent, BufferSnapshot};
use lattice_ui::ActiveLattice as _;

mod current_line;
mod overlay;
mod pointer;
mod scrollbar;

pub use overlay::{Painted, PaintedCursor};
use pointer::Hover;

use crate::{
    blocks::{BlockSide, BlockWidget},
    completion::{CompletionSource, Offered, Provider, Sources},
    decorations::{self, Highlight, Mark},
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
    scrollbar: scrollbar::Scrollbar,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<LatticeEditorEvent> for LatticeEditor {}

impl LatticeEditor {
    /// Zed's editor over `buffer`, with the adapter's completion provider.
    pub fn new(buffer: Entity<Buffer>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| Editor::for_buffer(buffer.clone(), None, window, cx));
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
            cx.subscribe(&editor, |this, _, event: &EditorEvent, cx| match event {
                EditorEvent::Blurred => this.hovered_cursor = None,
                // The overlay scrollbar shows while the text scrolls.
                EditorEvent::ScrollPositionChanged { .. } => this.note_scroll(cx),
                _ => {}
            }),
            // An edit closes the card, as typing into a key closes the
            // Tauri app's.
            cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                if matches!(event, BufferEvent::Edited { .. }) {
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
            scrollbar: scrollbar::Scrollbar::default(),
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
        let this = cx.entity();
        let under = cx.entity();
        let lattice = cx.lattice();
        let ground = lattice_ui::editor_theme::ground(lattice.code_theme, &lattice.palette);
        div()
            .relative()
            .size_full()
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
            .child(self.editor.clone())
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
