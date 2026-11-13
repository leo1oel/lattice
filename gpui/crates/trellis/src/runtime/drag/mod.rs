// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/drag.ts), with Lattice's patch (the pointer's rest, liftedRest, translated labels).

//! Window and tab dragging.
//!
//! The source stays in place at pickup. The lifted window keeps its size
//! over its origin and eases to a compact card as it leaves (280 ms). Drop
//! targets settle for 150 ms and preview as a real reflow of the layout. The
//! source collapses on the first target and never reopens. Seams and the
//! frame band are targets, and release commits the current candidate.
//!
//! Tab-bar drops insert at an index. Allow rules remove targets. Overlay
//! floats treat the whole workspace as their desktop, and the stage is the
//! desktop only when floats live in it.

use std::collections::HashMap;

use crate::model::{
    DockTarget, DockTargetSpec, Entries, FloatingLayer, LayoutDocument, LayoutNode, PanelNode,
    Point, Rect, apply_dock_target, detach_view, find_stage, float_panel, insert_panel,
    remove_panel, reorder_tabs, select_view, uid,
};
use preview::resting_layout;

mod preview;
mod targets;

use super::engine::{Engine, Event, Region};
use super::labels::{Label, label};

pub const DROP_SLOT: &str = "__trellis-drop-slot";
pub const SOURCE_SLOT: &str = "__trellis-source-slot";
const THRESHOLD: f64 = 6.;
/// Lattice patch: the pointer counts as resting once it stays within 3px for
/// 120ms.
const STILL_PX: f64 = 3.;
const STILL_MS: f64 = 120.;
const SETTLE_MS: f64 = 150.;
const PICKUP_MS: f64 = 280.;
const COMPACT: (f64, f64) = (380., 260.);
const DESKTOP_SPLIT_MAX_PX: f64 = 64.;
const MIN_SEAM_HIT_WIDTH: f64 = 8.;
/// Overlay floats pass over panels freely; only this much of a panel's edge
/// docks them.
const OVERLAY_EDGE_BAND: f64 = 0.14;
/// A sorted tab sliding home after the press ends.
pub(crate) const SORT_SETTLE_MS: f64 = 180.;

#[derive(Clone, Debug, PartialEq)]
pub enum DropTarget {
    Dock(DockTargetSpec),
    Tab { panel: String, index: Option<usize> },
    Stage(String),
    Float,
}

impl DropTarget {
    pub fn kind(&self) -> &'static str {
        match self {
            DropTarget::Dock(_) => "dock",
            DropTarget::Tab { .. } => "tab",
            DropTarget::Stage(_) => "stage",
            DropTarget::Float => "float",
        }
    }
}

fn same_target(a: Option<&DropTarget>, b: Option<&DropTarget>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(DropTarget::Dock(a)), Some(DropTarget::Dock(b))) => {
            a.id == b.id && a.edge == b.edge && a.seam == b.seam
        }
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TabSortItem {
    pub id: String,
    pub x: f64,
    pub width: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct TabSort {
    pub row: Rect,
    pub list: Rect,
    pub items: Vec<TabSortItem>,
    pub order: Vec<String>,
    pub grab: f64,
    pub started: bool,
    /// Each tab's offset from its resting place, as last drawn.
    pub offsets: HashMap<String, f64>,
    pub dragged_left: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct DragSession {
    pub start: Point,
    pub active: bool,
    pub origin: LayoutDocument,
    /// The panel following the pointer (a new one after a tab detaches).
    pub lifted: PanelNode,
    /// The lifted panel is part of the document (a whole-panel drag).
    pub in_doc: bool,
    pub pending_tab: Option<String>,
    pub tab_sort: Option<TabSort>,
    pub excluded_host: Option<String>,
    pub tab_origin: Option<Rect>,
    pub tab_rollback: bool,
    pub from_float: Option<FloatingLayer>,
    pub from_frame: bool,
    /// World rects at pickup.
    pub base: HashMap<String, Rect>,
    pub source_screen: Rect,
    /// The document hit testing and previews use; the source is removed once
    /// it collapses.
    pub pdoc: LayoutDocument,
    pub drop_base: Entries,
    pub collapsed: bool,
    pub layout_targets: HashMap<String, Rect>,
    pub floating: Rect,
    pub pickup_at: f64,
    pub compact_from: f64,
    pub compact_to: f64,
    pub compact_amount: f64,
    pub desktop_amount: f64,
    pub desktop_to: f64,
    pub size_tick: f64,
    pub pointer: Point,
    pub still: Option<(Point, f64)>,
    pub grab_x: f64,
    pub grab_y: f64,
    pub target: Option<DropTarget>,
    pub candidate: Option<DropTarget>,
    /// When the candidate takes effect.
    pub target_timer: Option<f64>,
    pub drop_label: String,
}

/// A sorted tab easing home after the sort commits.
#[derive(Clone, Debug)]
pub(crate) struct TabFlip {
    pub from: f64,
    pub start: f64,
}

impl Engine {
    /// A press on a tab (`view`) or on a panel's bar or frame (`view` none),
    /// with button 0 and no modifiers (the host checks those).
    pub fn drag_begin(&mut self, panel_id: &str, view: Option<&str>, p: Point) {
        if self.drag.is_some() {
            return;
        }
        let Some(panel) = self.find_panel(panel_id) else {
            return;
        };
        let float = self.doc.floating.iter().find(|f| f.panel.id == panel.id);
        let tab = view
            .filter(|_| panel.views.len() > 1)
            .map(str::to_string);
        let screen = self.last_rects.get(&panel.id).copied().unwrap_or_default();
        let state = self.panels.get(&panel.id);
        let tab_sort = tab.as_ref().and_then(|tab| {
            let state = state?;
            let items: Vec<TabSortItem> = panel
                .views
                .iter()
                .filter_map(|id| {
                    state
                        .tabs
                        .iter()
                        .find(|(v, _)| v == id)
                        .map(|(_, r)| TabSortItem {
                            id: id.clone(),
                            x: r.x,
                            width: r.w,
                        })
                })
                .collect();
            let grabbed = items.iter().find(|i| i.id == *tab)?;
            Some(TabSort {
                row: state.tabbar?,
                list: state.tablist.or(state.tabbar)?,
                grab: p.x - grabbed.x,
                order: items.iter().map(|i| i.id.clone()).collect(),
                items,
                started: false,
                offsets: HashMap::new(),
                dragged_left: 0.,
            })
        });
        let now = self.now();
        self.drag = Some(DragSession {
            start: p,
            active: false,
            origin: self.doc.clone(),
            lifted: panel.clone(),
            in_doc: true,
            pending_tab: tab,
            tab_sort,
            excluded_host: None,
            tab_origin: None,
            tab_rollback: false,
            from_float: float.map(|f| f.layer),
            from_frame: state.is_some_and(|s| s.frame_only),
            base: HashMap::new(),
            source_screen: screen,
            pdoc: self.doc.clone(),
            drop_base: Entries::new(),
            collapsed: false,
            layout_targets: HashMap::new(),
            floating: screen,
            pickup_at: 0.,
            compact_from: 0.,
            compact_to: 0.,
            compact_amount: 0.,
            desktop_amount: 0.,
            desktop_to: 0.,
            size_tick: now,
            pointer: p,
            still: None,
            grab_x: if screen.w > 0. {
                (p.x - screen.x) / screen.w
            } else {
                0.5
            },
            grab_y: p.y - screen.y,
            target: None,
            candidate: None,
            target_timer: None,
            drop_label: String::new(),
        });
    }

    /// Whether a press is being tracked (a drag may start).
    pub fn drag_pending(&self) -> bool {
        self.drag.is_some()
    }

    /// Whether the press tracked so far is a click: it never lifted and never
    /// sorted a tab.
    pub fn press_is_click(&self) -> bool {
        self.drag
            .as_ref()
            .is_some_and(|d| !d.active && d.tab_sort.as_ref().is_none_or(|s| !s.started))
    }

    pub fn drag_move(&mut self, p: Point) {
        let Some(mut d) = self.drag.take() else {
            return;
        };
        if !d.active {
            if (p.x - d.start.x).hypot(p.y - d.start.y) < THRESHOLD {
                self.drag = Some(d);
                return;
            }
            if d.pending_tab.is_some()
                && let Some(sort) = &d.tab_sort
            {
                if sort.row.contains(p) {
                    self.sort_tab_at_pointer(&mut d, p);
                    self.drag = Some(d);
                    return;
                }
                if let Some(sort) = &mut d.tab_sort {
                    sort.offsets.clear();
                }
            }
            self.drag = Some(d);
            self.activate();
            d = self.drag.take().expect("activated");
        }
        d.pointer = p;
        let now = self.now();
        if d
            .still
            .is_none_or(|(at, _)| (p.x - at.x).hypot(p.y - at.y) > STILL_PX)
        {
            d.still = Some((p, now));
        }
        let next = self.retarget(&d, p);
        self.drag = Some(d);
        self.settle(next);
    }

    /// Whether the pointer has stayed put for a moment (views then lay out
    /// to the drop preview's sizes).
    pub(crate) fn resting(&self) -> bool {
        self.drag
            .as_ref()
            .and_then(|d| d.still)
            .is_some_and(|(_, at)| self.now() - at >= STILL_MS)
    }

    fn sort_tab_at_pointer(&mut self, d: &mut DragSession, p: Point) {
        let Some(sort) = &mut d.tab_sort else { return };
        let Some(dragged) = sort
            .items
            .iter()
            .find(|i| Some(&i.id) == d.pending_tab.as_ref())
            .cloned()
        else {
            return;
        };
        sort.started = true;
        let list = sort.list;
        let left = list.x.max((list.x + list.w - dragged.width).min(p.x - sort.grab));
        let mut x = sort.items[0].x;
        let mut index = 0;
        for id in &sort.order {
            let item = sort.items.iter().find(|i| i.id == *id).expect("sorted");
            // Reorder when the pointer crosses a neighbouring tab's resting
            // centre.
            if *id != dragged.id && p.x > x + item.width / 2. {
                index += 1;
            }
            x += item.width;
        }
        sort.order.retain(|id| *id != dragged.id);
        sort.order.insert(index.min(sort.order.len()), dragged.id.clone());
        let mut x = sort.items[0].x;
        sort.offsets.clear();
        for id in &sort.order {
            let item = sort.items.iter().find(|i| i.id == *id).expect("sorted");
            let at = if *id == dragged.id { left } else { x };
            sort.offsets.insert(id.clone(), at - item.x);
            x += item.width;
        }
        sort.dragged_left = left;
    }

    fn activate(&mut self) {
        let Some(mut d) = self.drag.take() else { return };
        // Active before any document change, so a torn-out view stays mounted
        // while it has no panel.
        d.active = true;
        let mut doc = self.doc.clone();
        if let Some(tab) = d.pending_tab.take() {
            // Tearing a tab out: it becomes its own window at the host's
            // position; cancelling restores.
            let origin = self
                .last_rects
                .get(&d.lifted.id)
                .copied()
                .unwrap_or(d.source_screen);
            let host = d.lifted.clone();
            let order = d
                .tab_sort
                .as_ref()
                .map(|s| s.order.clone())
                .unwrap_or_else(|| host.views.clone());
            doc = reorder_tabs(&doc, &host.id, &order);
            doc = detach_view(&doc, &tab);
            d.lifted = PanelNode::single(uid("panel"), tab);
            d.in_doc = false;
            d.excluded_host = Some(host.id.clone());
            d.tab_origin = Some(origin);
            d.tab_rollback = true;
            d.from_float = d.from_float.or(Some(FloatingLayer::Stage));
            d.from_frame = false;
            d.source_screen = origin;
            d.tab_sort = None;
            self.drag = Some(d);
            self.doc = doc.clone();
            self.sync();
            d = self.drag.take().expect("kept");
        }
        d.pdoc = doc.clone();
        d.drop_base = self.layout_rects_of(doc.root.as_ref());
        d.base = d
            .drop_base
            .iter()
            .map(|(id, e)| (id.clone(), e.rect))
            .collect();
        d.layout_targets = resting_layout(&d, self);
        d.pickup_at = self.now();
        d.floating = d.source_screen;
        self.drag = Some(d);
    }

    // ------------------------------------------------------------ previews

    // ------------------------------------------------------------ pickup

    // ------------------------------------------------------------ end

    /// The press ended: `commit` on release, else cancelled (Escape, blur).
    pub fn drag_end(&mut self, commit: bool) {
        let Some(d) = self.drag.as_ref() else { return };
        let candidate = d.candidate.clone();
        let active = d.active;
        // Release expresses intent immediately, even before the hover delay
        // expires.
        if commit && active {
            self.apply_target(candidate);
        }
        let d = self.drag.take().expect("checked");
        if !d.active {
            return self.end_pending(d, commit);
        }
        self.suppress_clicks_until = self.now() + 350.;
        let lifted = d.lifted.clone();
        let mut from = self.last_rects.clone();
        from.insert(lifted.id.clone(), d.floating);
        let target = if commit { d.target.clone() } else { None };
        let Some(target) = target else {
            // Cancel or no target: restore the original arrangement; the
            // window flies back.
            self.doc = d.origin.clone();
            self.drag_commit(d.origin.clone(), from, Some(lifted.id.clone()));
            return;
        };
        let base = self.doc.clone();
        let without = if d.in_doc {
            remove_panel(&base, &lifted.id)
        } else {
            base
        };
        let layer = self.floating_layer().unwrap_or(FloatingLayer::Overlay);
        let next = match &target {
            DropTarget::Tab { panel, index } => insert_panel(
                &without,
                &lifted,
                &DockTarget::Into {
                    into: panel.clone(),
                    index: *index,
                },
            ),
            DropTarget::Stage(stage) => insert_panel(
                &without,
                &lifted,
                &DockTarget::Into {
                    into: stage.clone(),
                    index: None,
                },
            ),
            DropTarget::Dock(spec) => {
                let root = apply_dock_target(
                    without.root.as_ref(),
                    spec,
                    &LayoutNode::Panel(lifted.clone()),
                    &uid("split"),
                );
                LayoutDocument {
                    root: Some(root),
                    ..without
                }
            }
            DropTarget::Float => {
                let float_layer = if d.from_float == Some(FloatingLayer::Overlay) {
                    FloatingLayer::Overlay
                } else {
                    layer
                };
                let rect = self.float_rect(&d, &without, float_layer);
                float_panel(&without, &lifted, rect, float_layer)
            }
        };
        let repositioning = target == DropTarget::Float && d.from_float.is_some() && !d.tab_rollback;
        self.doc = d.origin.clone();
        let settle = if repositioning || matches!(target, DropTarget::Tab { .. }) {
            None
        } else {
            Some(lifted.id.clone())
        };
        self.drag_commit(next, from, settle);
        let from_kind = if d.from_float.is_some() && !d.tab_rollback {
            Region::Floating
        } else {
            Region::Side
        };
        self.drag_moved(&lifted, from_kind, &target);
        self.events.push(Event::Announce(label(Label::Moved)));
    }

    fn drag_commit(&mut self, next: LayoutDocument, from: HashMap<String, Rect>, settle: Option<String>) {
        if let Some(settle) = settle {
            self.settling.insert(settle);
        }
        // The landing holds the views' layouts until the tween ends.
        self.dropping = !self.reduced();
        if next == self.doc {
            // Nothing changed (a cancelled drag): animate everything back into
            // place.
            if !self.reduced() {
                let now = self.now();
                self.tween.begin(from, now);
            }
            self.sync();
            return;
        }
        self.commit(next, true, Some(from));
    }

    /// Keep the moved view in frame: docking a float widens the frame to
    /// include it; floating a docked view frames its desktop.
    fn drag_moved(&mut self, panel: &PanelNode, from: Region, to: &DropTarget) {
        let stage = find_stage(self.doc.root.as_ref()).map(|s| s.id.clone());
        let floated = *to == DropTarget::Float;
        let tabbed = matches!(to, DropTarget::Tab { .. });
        if floated && from != Region::Floating && stage.is_some() {
            self.nav_include(&[stage.expect("checked")]);
        } else if !floated && !tabbed && from == Region::Floating {
            self.nav_include(&[panel.id.clone()]);
        } else {
            self.ensure_framed_visible(&panel.selected);
        }
        self.focus_view(&panel.selected);
    }

    /// Where a window dropped on the desktop lands, in fractions of its
    /// layer.
    fn float_rect(&self, d: &DragSession, next: &LayoutDocument, layer: FloatingLayer) -> Rect {
        let container = match layer {
            FloatingLayer::Overlay => Rect::new(0., 0., self.viewport.0, self.viewport.1),
            FloatingLayer::Stage => {
                let world = find_stage(next.root.as_ref())
                    .and_then(|s| self.layout_rects_of(next.root.as_ref()).get(&s.id).map(|e| e.rect));
                self.to_screen(world.unwrap_or(crate::model::UNIT))
            }
        };
        let current = (d.from_float.is_some() && !d.tab_rollback)
            .then(|| self.last_rects.get(&d.lifted.id).copied())
            .flatten();
        let original = if d.from_frame {
            d.floating
        } else {
            current.unwrap_or(d.source_screen)
        };
        let min = self.min_size_for(&d.lifted.views);
        let bar = self.bar_height(Some(&d.lifted));
        let (mut w, mut h) = if d.from_float.is_some() && !d.from_frame && !d.tab_rollback {
            (original.w, original.h)
        } else {
            (
                (container.w * 2. / 3.).min(original.w),
                (container.h * 2. / 3.).min(original.h),
            )
        };
        // The unscaled content minimum wins over the drop cap.
        w = w.max(min.0 + self.pad() * 2.);
        h = h.max(min.1 + bar + self.pad() * 2.);
        let grab_y = d.grab_y.min(18. + (d.grab_y - 18.) * (1. - d.compact_amount));
        let x = d.pointer.x - w * d.grab_x;
        let y = d.pointer.y - grab_y;
        Rect::new(
            (x - container.x) / container.w,
            (y - container.y) / container.h,
            w / container.w,
            h / container.h,
        )
    }

    /// A press that never became a drag: a click, or a finished tab sort.
    fn end_pending(&mut self, d: DragSession, commit: bool) {
        let Some(sort) = d.tab_sort else { return };
        let Some(pending) = d.pending_tab else { return };
        if !commit || !sort.started {
            return;
        }
        self.suppress_clicks_until = self.now() + 350.;
        let mut next = reorder_tabs(&self.doc, &d.lifted.id, &sort.order);
        next = select_view(&next, &pending);
        if !self.reduced() {
            // The tabs come to rest from where the sort left them: the
            // dragged one slides from the pointer into its slot.
            let now = self.now();
            let mut x = sort.items[0].x;
            for id in &sort.order {
                let item = sort.items.iter().find(|i| i.id == *id).expect("sorted");
                let shown = item.x + sort.offsets.get(id).copied().unwrap_or(0.);
                if (shown - x).abs() >= 0.5 {
                    self.tab_flips.insert(id.clone(), TabFlip { from: shown - x, start: now });
                }
                x += item.width;
            }
        }
        self.drag_commit_sorted(next);
    }

    fn drag_commit_sorted(&mut self, next: LayoutDocument) {
        self.commit(next, false, None);
    }

    /// While a tab is sorted in its strip: each tab's offset from its resting
    /// place, the dragged one following the pointer.
    pub fn tab_sort_offsets(&self, panel_id: &str) -> Option<(&HashMap<String, f64>, &str)> {
        let d = self.drag.as_ref()?;
        let sort = d.tab_sort.as_ref()?;
        (d.lifted.id == panel_id && sort.started && !d.active)
            .then(|| (&sort.offsets, d.pending_tab.as_deref().unwrap_or_default()))
    }

    /// The drop slot's label ("Add as tab" over a tab target).
    pub fn drop_label(&self) -> &str {
        self.drag.as_ref().map_or("", |d| d.drop_label.as_str())
    }

    /// The kind of drop the pointer is over, while dragging.
    pub fn drop_kind(&self) -> Option<&'static str> {
        self.drag
            .as_ref()
            .filter(|d| d.active)
            .map(|d| d.candidate.as_ref().map_or("none", DropTarget::kind))
    }
}

