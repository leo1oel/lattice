// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts), with Lattice's patch (patches/@danfessler__trellis@0.2.0.patch).

//! The workspace engine: the document, focus, geometry, motion and every
//! operation on panels, without a UI toolkit. A host (the GPUI view in
//! `crate::view`) feeds it pointer and key input in workspace pixels, asks it
//! for a [`frame::Frame`] each animation frame, and draws that.
//!
//! The DOM parts of Trellis map as follows: a panel's element is a
//! [`frame::PanelFrame`], a view's surface a [`frame::SurfaceFrame`]; what
//! Trellis measured from the DOM (header parts, tab boxes) the host reports
//! ([`Engine::set_tab_boxes`], the header measure passed to
//! [`Engine::frame`]); events go out through [`Engine::drain_events`].

mod dividers;
pub mod frame;
mod geometry;
mod groups;
mod keys;
mod menu;
mod ops;
mod surfaces;

use std::collections::{HashMap, HashSet};

use crate::model::{
    Allow, Entries, FloatingLayer, LayoutDocument, LayoutMetrics, LayoutNode, PanelNode, Params,
    Rect, Scaling, TabbarMode, UNIT, ViewRecord, ViewRules, layout_rects, locate_panel,
    panel_of_view, panels_of, sanitize, view_ids,
};

use super::drag::DragSession;
use super::header::{HeaderMeasure, LabelMode};
use super::keymap::{Keymap, default_keymap};
use super::motion::{LayoutTween, RectSpring};
use super::navigation::Navigator;

pub use dividers::{ResizeDir, ResizeKind};
pub use frame::Frame;
pub use keys::{KeyOutcome, TabKeyOutcome};
pub use menu::{MenuAction, MenuEntry, MenuItem, tidy_menu};
pub use ops::{OpenOptions, Reuse};

#[cfg(test)]
mod tests;

/// Below this size a panel shows only its icon ("frame only").
pub const FRAME_ONLY: (f64, f64) = (160., 64.);
/// Every panel keeps at least this much room (plus the gap), for a tab and
/// its menu button.
pub const PANEL_MIN_W: f64 = 80.;
/// A float's default size.
pub const DEFAULT_FLOAT_SIZE: (f64, f64) = (560., 400.);
/// Defaults for the `detail` option: a nested group collapses into one tile
/// when all its parts are smaller than `size` × `size` on screen.
pub const DETAIL_SIZE: f64 = 48.;
pub const DETAIL_OUTLINE: usize = 2;
/// Content minimum under free navigation, for types with scaling and no
/// minimum of their own.
pub const FREE_MIN: (f64, f64) = (480., 320.);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavigationMode {
    Off,
    Focus,
    Free,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    /// Follow the system's reduced-motion setting (the host reports it).
    System,
    Full,
    Reduced,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Region {
    Stage,
    Side,
    Floating,
}

/// A view type: its rules and its static title.
#[derive(Clone, Debug, Default)]
pub struct ViewType {
    pub title: Option<String>,
    pub rules: ViewRules,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub types: HashMap<String, ViewType>,
    /// Where floating panels live; `None` turns floating off.
    pub floating: Option<FloatingLayer>,
    pub navigation: NavigationMode,
    pub motion: Motion,
    pub keymap: Keymap,
    /// `None` turns collapsing off; else the tile size and outline depth.
    pub detail: Option<(f64, usize)>,
    /// The space between panels and around the layout.
    pub gap: f64,
    pub tabbar_height: f64,
    /// Whether Mod means ⌘ (macOS) for the keymap and its hints.
    pub mac: bool,
    /// Lattice patch: a panel header's width beyond its tabs before it is
    /// first measured, by the selected view's type (4 for others).
    pub header_fallback: HashMap<String, f64>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            types: HashMap::new(),
            floating: Some(FloatingLayer::Overlay),
            navigation: NavigationMode::Focus,
            motion: Motion::System,
            keymap: default_keymap(),
            detail: Some((DETAIL_SIZE, DETAIL_OUTLINE)),
            gap: 6.,
            tabbar_height: 34.,
            mac: cfg!(target_os = "macos"),
            header_fallback: HashMap::new(),
        }
    }
}

/// What the workspace tells its host.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A committed layout change; never mid-drag or mid-animation.
    Change,
    Open(String),
    Close(String),
    Focus(Option<String>),
    Navigate(Option<String>),
    /// Text for a polite live region.
    Announce(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Badge {
    Dot,
    Text(String),
}

pub(crate) struct Leaving {
    pub panel: PanelNode,
    pub from: Rect,
    pub to: Rect,
    pub start: f64,
    pub duration: f64,
}

/// What the engine keeps for a panel's element.
#[derive(Default)]
pub(crate) struct PanelState {
    /// The header's measurement, as last given, and the label mode it shows.
    pub header: Option<HeaderMeasure>,
    pub label_mode: Option<LabelMode>,
    pub labels: Option<Vec<String>>,
    pub label_count: usize,
    pub label_selected: Option<String>,
    pub label_motion: bool,
    pub header_min: Option<f64>,
    /// Each tab's box and the strip's, from the last frame drawn.
    pub tabs: Vec<(String, Rect)>,
    pub tabbar: Option<Rect>,
    pub tablist: Option<Rect>,
    pub frame_only: bool,
}

/// A view's content placement state (Trellis keeps it on the surface record).
#[derive(Clone, Debug, Default)]
pub(crate) struct SurfaceState {
    pub layout: Option<(f64, f64)>,
    pub held: Option<(f64, f64)>,
    pub size: (f64, f64),
    pub scale: f64,
    pub state: ViewState,
}

/// What a view knows about itself.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewState {
    pub visible: bool,
    pub focused: bool,
    pub selected: bool,
    pub placement: ViewPlacement,
    pub interactive: bool,
    pub size: (f64, f64),
    pub scale: f64,
    pub panel_id: String,
}

/// Where a view is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ViewPlacement {
    #[default]
    Docked,
    Stage,
    Floating,
    Hidden,
}

pub struct Engine {
    pub(crate) options: Options,
    pub(crate) doc: LayoutDocument,
    pub(crate) entries: Entries,
    pub(crate) focused_panel: Option<String>,
    pub(crate) focused_view: Option<String>,
    pub(crate) last_stage_panel: Option<String>,
    pub(crate) badges: HashMap<String, Badge>,
    /// Titles a view type computes (Trellis's title functions), pushed by
    /// the host.
    pub(crate) live_titles: HashMap<String, String>,
    pub(crate) panels: HashMap<String, PanelState>,
    pub(crate) surfaces: HashMap<String, SurfaceState>,
    pub(crate) last_rects: HashMap<String, Rect>,
    pub(crate) leaving: HashMap<String, Leaving>,
    /// Panels restoring out of a dock or button (the reverse of leaving).
    pub(crate) entering: HashMap<String, (Rect, f64)>,
    /// New panels fading in, by panel id: when they started.
    pub(crate) appearing: HashMap<String, f64>,
    pub(crate) settling: HashSet<String>,
    pub(crate) viewport: (f64, f64),
    pub(crate) tween: LayoutTween,
    pub(crate) camera: RectSpring,
    pub(crate) nav: Navigator,
    pub(crate) drag: Option<DragSession>,
    pub(crate) suppress_clicks_until: f64,
    pub(crate) gesture: bool,
    /// A pinch or wheel zoom is driving the camera.
    pub(crate) zooming: bool,
    /// Lattice patch: a drag's landing is still under way.
    pub(crate) dropping: bool,
    pub(crate) last_time: f64,
    pub(crate) events: Vec<Event>,
    pub(crate) remembered_floats: HashMap<String, Rect>,
    pub(crate) open_counter: usize,
    pub(crate) collapsed_of: HashMap<String, String>,
    pub(crate) collapsed_groups: Vec<String>,
    pub(crate) hidden_splits: HashSet<String>,
    pub(crate) dividers: dividers::DividerState,
    /// Sorted tabs easing home, by view.
    pub(crate) tab_flips: HashMap<String, super::drag::TabFlip>,
    pub(crate) reduced_system: bool,
    pub(crate) clock: Box<dyn Fn() -> f64>,
}

impl Engine {
    /// A workspace showing `document` (sanitized), in a `width` × `height`
    /// area.
    pub fn new(options: Options, document: LayoutDocument, width: f64, height: f64) -> Engine {
        let start = std::time::Instant::now();
        let mut engine = Engine {
            options,
            doc: LayoutDocument::default(),
            entries: Entries::new(),
            focused_panel: None,
            focused_view: None,
            last_stage_panel: None,
            badges: HashMap::new(),
            live_titles: HashMap::new(),
            panels: HashMap::new(),
            surfaces: HashMap::new(),
            last_rects: HashMap::new(),
            leaving: HashMap::new(),
            entering: HashMap::new(),
            appearing: HashMap::new(),
            settling: HashSet::new(),
            viewport: (width, height),
            tween: LayoutTween::default(),
            camera: RectSpring::new(UNIT),
            nav: Navigator::default(),
            drag: None,
            suppress_clicks_until: 0.,
            gesture: false,
            zooming: false,
            dropping: false,
            last_time: 0.,
            events: Vec::new(),
            remembered_floats: HashMap::new(),
            open_counter: 0,
            collapsed_of: HashMap::new(),
            collapsed_groups: Vec::new(),
            hidden_splits: HashSet::new(),
            dividers: Default::default(),
            tab_flips: HashMap::new(),
            reduced_system: false,
            clock: Box::new(move || start.elapsed().as_secs_f64() * 1000.),
        };
        engine.doc = engine.prepare(&document);
        engine.sync();
        let navigation = engine.doc.navigation.clone();
        engine.nav_restore(navigation.as_ref());
        engine.camera.finish();
        let first = panels_of(engine.doc.root.as_ref())
            .first()
            .map(|p| p.selected.clone())
            .or_else(|| {
                engine
                    .doc
                    .floating
                    .first()
                    .map(|f| f.panel.selected.clone())
            });
        if let Some(first) = first {
            engine.set_focus(Some(&first), false);
        }
        engine
    }

    /// Run on a clock of the host's (tests drive time by hand).
    pub fn with_clock(mut self, clock: impl Fn() -> f64 + 'static) -> Engine {
        self.clock = Box::new(clock);
        self
    }

    pub(crate) fn now(&self) -> f64 {
        (self.clock)()
    }

    // ------------------------------------------------------------ options

    pub fn options(&self) -> &Options {
        &self.options
    }

    pub fn set_options(&mut self, options: Options) {
        let navigation_off = options.navigation == NavigationMode::Off;
        self.options = options;
        if navigation_off {
            self.nav_focus(None, false);
        }
        self.sync();
    }

    /// A view type's minimum changed (a measured one, like the PDF
    /// toolbar's): lay out again.
    pub fn set_min_size(&mut self, kind: &str, size: Option<crate::model::Size>) {
        if let Some(t) = self.options.types.get_mut(kind)
            && t.rules.min_size != size
        {
            t.rules.min_size = size;
            self.sync();
        }
    }

    pub fn set_system_reduced_motion(&mut self, reduced: bool) {
        self.reduced_system = reduced;
    }

    pub(crate) fn reduced(&self) -> bool {
        match self.options.motion {
            Motion::Reduced => true,
            Motion::Full => false,
            Motion::System => self.reduced_system,
        }
    }

    pub(crate) fn floating_layer(&self) -> Option<FloatingLayer> {
        self.options.floating
    }

    pub(crate) fn navigation_on(&self) -> bool {
        self.options.navigation != NavigationMode::Off
    }

    pub(crate) fn gap(&self) -> f64 {
        self.options.gap
    }

    pub(crate) fn tabbar_height(&self) -> f64 {
        self.options.tabbar_height
    }

    pub(crate) fn rules_of(&self, view_id: &str) -> ViewRules {
        self.doc
            .views
            .get(view_id)
            .and_then(|record| self.options.types.get(&record.kind))
            .map(|t| t.rules.clone())
            .unwrap_or_default()
    }

    pub(crate) fn closable(&self, view_id: &str) -> bool {
        self.rules_of(view_id).closable
    }

    pub fn title_of(&self, view_id: &str) -> String {
        let Some(record) = self.doc.views.get(view_id) else {
            return String::new();
        };
        if let Some(title) = &record.title {
            return title.clone();
        }
        if let Some(title) = self.live_titles.get(view_id) {
            return title.clone();
        }
        self.options
            .types
            .get(&record.kind)
            .and_then(|t| t.title.clone())
            .unwrap_or_else(|| record.kind.clone())
    }

    /// The title a view type's title function gives a view now.
    pub fn set_live_title(&mut self, view_id: &str, title: impl Into<String>) {
        self.live_titles.insert(view_id.to_string(), title.into());
    }

    /// A count or label shown in the tab; `Dot` marks unsaved changes.
    pub fn set_badge(&mut self, view_id: &str, badge: Option<Badge>) {
        match badge {
            Some(badge) => self.badges.insert(view_id.to_string(), badge),
            None => self.badges.remove(view_id),
        };
    }

    pub fn badge(&self, view_id: &str) -> Option<&Badge> {
        self.badges.get(view_id)
    }

    // ------------------------------------------------------------ geometry

    // ------------------------------------------------------------ the drag's view of things

    /// The panel following the pointer during a drag.
    pub(crate) fn lifted(&self) -> Option<&PanelNode> {
        self.drag.as_ref().filter(|d| d.active).map(|d| &d.lifted)
    }

    pub(crate) fn drag_active(&self) -> bool {
        self.drag.as_ref().is_some_and(|d| d.active)
    }

    /// World rect overrides for docked nodes and the two slots while dragging.
    pub(crate) fn layout_targets(&self) -> Option<&HashMap<String, Rect>> {
        self.drag
            .as_ref()
            .filter(|d| d.active)
            .map(|d| &d.layout_targets)
    }

    pub(crate) fn find_panel(&self, panel_id: &str) -> Option<PanelNode> {
        if let Some(lifted) = self.lifted()
            && lifted.id == panel_id
        {
            return Some(lifted.clone());
        }
        locate_panel(&self.doc, panel_id)
            .map(|l| l.panel().clone())
            .or_else(|| self.leaving.get(panel_id).map(|l| l.panel.clone()))
    }

    // ------------------------------------------------------------ allow rules

    pub(crate) fn allowed(&self, views: &[String], region: Region) -> bool {
        views.iter().all(|id| {
            let allow: Allow = self.rules_of(id).allow.unwrap_or_default();
            match region {
                Region::Stage => allow.stage,
                Region::Side => allow.side,
                Region::Floating => allow.floating && self.floating_layer().is_some(),
            }
        })
    }

    /// How a panel shows its tab bar: above the content, over it, or not at
    /// all. A tab group always gets a normal bar.
    pub(crate) fn bar_mode(&self, panel: Option<&PanelNode>) -> TabbarMode {
        let Some(panel) = panel else {
            return TabbarMode::Always;
        };
        let modes: Vec<TabbarMode> = panel
            .views
            .iter()
            .map(|v| self.rules_of(v).tabbar)
            .collect();
        if modes.iter().all(|m| *m == TabbarMode::Never) {
            return TabbarMode::Never;
        }
        if panel.views.len() == 1 && modes[0] == TabbarMode::Auto {
            return if self.lifted().is_some_and(|l| l.id == panel.id) {
                TabbarMode::Always
            } else {
                TabbarMode::Never
            };
        }
        if panel.views.len() == 1 && modes[0] == TabbarMode::Overlay {
            return TabbarMode::Overlay;
        }
        TabbarMode::Always
    }

    /// Space the tab bar takes above the content.
    pub(crate) fn bar_height(&self, panel: Option<&PanelNode>) -> f64 {
        if self.bar_mode(panel) == TabbarMode::Always {
            self.tabbar_height()
        } else {
            0.
        }
    }

    pub(crate) fn min_size_of(&self, view_id: &str) -> Option<(f64, f64)> {
        let rules = self.rules_of(view_id);
        if rules.scaling == Scaling::Off {
            return None;
        }
        rules
            .min_size
            .map(|s| (s.width, s.height))
            .or((self.options.navigation == NavigationMode::Free).then_some(FREE_MIN))
    }

    pub(crate) fn usable_at(&self, view_id: &str, scale: f64) -> bool {
        scale >= 0.999 || self.rules_of(view_id).scaling != Scaling::Inert
    }

    // ------------------------------------------------------------ sync and commit

    /// Reconcile the engine's records with the document. Cheap; runs after
    /// every change.
    pub(crate) fn sync(&mut self) {
        self.entries = self.layout_doc(None);
        let mut live: HashSet<String> = view_ids(&self.doc).into_iter().collect();
        if let Some(lifted) = self.lifted() {
            live.extend(lifted.views.iter().cloned());
        }
        for l in self.leaving.values() {
            live.extend(l.panel.views.iter().cloned());
        }
        self.surfaces.retain(|id, _| live.contains(id));
        self.badges.retain(|id, _| live.contains(id));
        for id in &live {
            self.surfaces
                .entry(id.clone())
                .or_insert_with(|| SurfaceState {
                    scale: 1.,
                    ..Default::default()
                });
        }
        let mut panel_ids: HashSet<String> = panels_of(self.doc.root.as_ref())
            .into_iter()
            .map(|p| p.id.clone())
            .collect();
        panel_ids.extend(self.doc.floating.iter().map(|f| f.panel.id.clone()));
        if let Some(lifted) = self.lifted() {
            panel_ids.insert(lifted.id.clone());
        }
        panel_ids.extend(self.leaving.keys().cloned());
        self.panels.retain(|id, _| panel_ids.contains(id));
        for id in panel_ids {
            self.panels.entry(id).or_default();
        }
        self.last_rects
            .retain(|id, _| self.panels.contains_key(id) || id.starts_with("__trellis"));
        self.nav_sync();
    }

    pub(crate) fn commit(
        &mut self,
        next: LayoutDocument,
        animate: bool,
        from: Option<HashMap<String, Rect>>,
    ) {
        self.commit_with(next, animate, from, false);
    }

    pub(crate) fn commit_silent(&mut self, next: LayoutDocument) {
        self.commit_with(next, false, None, true);
    }

    pub(crate) fn commit_with(
        &mut self,
        next: LayoutDocument,
        animate: bool,
        from: Option<HashMap<String, Rect>>,
        silent: bool,
    ) {
        if next == self.doc {
            return;
        }
        let (next, held) = self.abandon_drag(next);
        self.release_resizes();
        let previous = std::mem::replace(&mut self.doc, next);
        if animate && !self.reduced() {
            let mut start = self.last_rects.clone();
            if let Some(from) = from {
                start.extend(from);
            }
            let now = self.now();
            self.tween.begin(start, now);
        }
        let mut open_before = view_ids(&previous);
        open_before.extend(held);
        let before: HashSet<String> = open_before.iter().cloned().collect();
        let after: HashSet<String> = view_ids(&self.doc).into_iter().collect();
        self.sync();
        for id in view_ids(&self.doc) {
            if !before.contains(&id) {
                self.events.push(Event::Open(id));
            }
        }
        let lifted: Vec<String> = self.lifted().map(|l| l.views.clone()).unwrap_or_default();
        for id in open_before {
            if !after.contains(&id) && !lifted.contains(&id) {
                self.events.push(Event::Close(id));
            }
        }
        match self.focused_view.clone() {
            Some(focused) if !after.contains(&focused) && !lifted.contains(&focused) => {
                let fallback = self
                    .last_focus_fallback()
                    .and_then(|v| panel_of_view(&self.doc, &v).cloned())
                    .or_else(|| {
                        panels_of(self.doc.root.as_ref())
                            .first()
                            .map(|p| (*p).clone())
                    })
                    .or_else(|| self.doc.floating.first().map(|f| f.panel.clone()));
                let selected = fallback.map(|p| p.selected);
                self.set_focus(selected.as_deref(), false);
            }
            Some(focused) => {
                if let Some(panel) = panel_of_view(&self.doc, &focused) {
                    self.focused_panel = Some(panel.id.clone());
                }
            }
            None => {}
        }
        if !silent {
            self.events.push(Event::Change);
        }
    }

    fn last_focus_fallback(&self) -> Option<String> {
        let id = self.last_stage_panel.as_ref()?;
        locate_panel(&self.doc, id).map(|l| l.panel().selected.clone())
    }

    /// The document, with the navigation state to persist. A tab torn out
    /// by a drag is back in its panel here, so hosts never build on (or save)
    /// a document whose record no panel holds.
    pub fn document(&self) -> LayoutDocument {
        let mut doc = self
            .torn_tab_home(&self.doc)
            .unwrap_or_else(|| self.doc.clone());
        doc.navigation = Some(self.nav_serialize());
        doc
    }

    /// The document as it is now, without navigation.
    pub fn doc(&self) -> &LayoutDocument {
        &self.doc
    }

    pub(crate) fn prepare(&self, input: &LayoutDocument) -> LayoutDocument {
        sanitize(input, &|_| true)
    }

    /// Replace the document, animating to it unless `animate` is false.
    pub fn set_document(&mut self, next: LayoutDocument, animate: bool) {
        let prepared = self.prepare(&next);
        let navigation = prepared.navigation.clone();
        self.commit(prepared, animate, None);
        self.nav_restore(navigation.as_ref());
    }

    pub fn drain_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// The workspace area's size changed.
    pub fn set_viewport(&mut self, width: f64, height: f64) {
        if (width, height) == self.viewport {
            return;
        }
        self.viewport = (width, height);
        self.tween.stop();
        // Minimums are in pixels, so a new size can change the layout's
        // proportions and scales.
        self.sync();
    }

    pub fn viewport(&self) -> (f64, f64) {
        self.viewport
    }

    /// Layout metrics for laying the tree out, matching what's on screen.
    pub(crate) fn with_metrics<R>(&self, f: impl FnOnce(&LayoutMetrics) -> R) -> R {
        let min = |node: &LayoutNode, axis| self.content_min(node, axis) + self.gap();
        let metrics = LayoutMetrics {
            width: self.viewport.0 - self.pad() * 2.,
            height: self.viewport.1 - self.pad() * 2.,
            min: &min,
        };
        f(&metrics)
    }

    pub(crate) fn layout_rects_of(&self, root: Option<&LayoutNode>) -> Entries {
        self.with_metrics(|m| layout_rects(root, Some(m)))
    }

    /// Lattice patch: the narrowest the workspace can be before the docked
    /// layout has to scale down.
    pub fn min_width(&self) -> f64 {
        match &self.doc.root {
            Some(root) => {
                self.content_min(root, crate::model::Axis::X) + self.gap() + self.pad() * 2.
            }
            None => 0.,
        }
    }

    // ------------------------------------------------------------ focus

    pub(crate) fn set_focus(&mut self, view_id: Option<&str>, emit: bool) {
        let next_panel = view_id
            .and_then(|v| panel_of_view(&self.doc, v))
            .map(|p| p.id.clone());
        if self.focused_view.as_deref() == view_id && self.focused_panel == next_panel {
            return;
        }
        self.focused_view = view_id.map(str::to_string);
        self.focused_panel = next_panel.clone();
        if let Some(panel) = &next_panel
            && self.region_of(panel) == Region::Stage
        {
            self.last_stage_panel = Some(panel.clone());
        }
        if emit {
            self.events.push(Event::Focus(self.focused_view.clone()));
        }
    }

    pub fn focused_view(&self) -> Option<&str> {
        self.focused_view.as_deref()
    }

    pub fn focused_panel(&self) -> Option<&str> {
        self.focused_panel.as_deref()
    }

    /// A view was pressed or took the keyboard (Trellis's focus listeners).
    pub fn focus_view(&mut self, view_id: &str) {
        if !self.doc.views.contains_key(view_id) {
            return;
        }
        self.set_focus(Some(view_id), true);
        self.raise_if_floating(view_id);
        // A view inside a collapsed group can't be seen: zoom to it.
        if let Some(panel) = panel_of_view(&self.doc, view_id).map(|p| p.id.clone())
            && self.collapsed_of.contains_key(&panel)
            && !self.drag_active()
        {
            self.nav_focus(Some(&panel), true);
        }
    }

    pub(crate) fn raise_if_floating(&mut self, view_id: &str) {
        let Some(panel) = panel_of_view(&self.doc, view_id).map(|p| p.id.clone()) else {
            return;
        };
        if self.drag_active() {
            return;
        }
        let raised = crate::model::raise_float(&self.doc, &panel);
        if raised != self.doc {
            self.commit_silent(raised);
        }
    }

    // ------------------------------------------------------------ queries

    pub fn view_record(&self, view_id: &str) -> Option<&ViewRecord> {
        self.doc.views.get(view_id)
    }

    pub fn params(&self, view_id: &str) -> Params {
        self.doc
            .views
            .get(view_id)
            .and_then(|r| r.params.clone())
            .unwrap_or_default()
    }

    pub fn view_state(&self, view_id: &str) -> Option<&ViewState> {
        self.surfaces.get(view_id).map(|s| &s.state)
    }

    pub fn placement_of(&self, view_id: &str) -> ViewPlacement {
        let panel = panel_of_view(&self.doc, view_id).cloned().or_else(|| {
            self.lifted()
                .filter(|l| l.views.iter().any(|v| v == view_id))
                .cloned()
        });
        let Some(panel) = panel else {
            return ViewPlacement::Docked;
        };
        if self.doc.hidden.iter().any(|h| h.panel.id == panel.id) {
            return ViewPlacement::Hidden;
        }
        match self.region_of(&panel.id) {
            Region::Floating => ViewPlacement::Floating,
            Region::Stage => ViewPlacement::Stage,
            Region::Side => ViewPlacement::Docked,
        }
    }

    /// Whether anything is moving (the host keeps asking for frames).
    pub fn moving(&self) -> bool {
        self.camera.moving()
            || self.tween.active()
            || self.drag_active()
            || self.gesture
            || !self.leaving.is_empty()
            || !self.entering.is_empty()
            || !self.appearing.is_empty()
            || self.dividers.springing()
            || self.drag.as_ref().is_some_and(|d| d.target_timer.is_some())
            || self.nav.wheel_timer.is_some()
    }

    pub fn dragging(&self) -> bool {
        self.drag_active()
    }

    /// Clicks right after a drag, sort or marquee are swallowed.
    pub fn suppress_clicks(&self) -> bool {
        self.now() < self.suppress_clicks_until
    }

    pub fn framed(&self) -> Option<&str> {
        self.nav.framed.as_deref()
    }

    pub fn can_go_back(&self) -> bool {
        self.nav.visit_index > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.nav.visit_index + 1 < self.nav.visits.len()
    }

    /// Every docked node's rect as laid out now, in world units.
    pub fn layout_entries(&self) -> &Entries {
        &self.entries
    }

    /// The camera's rect in world units.
    pub fn camera(&self) -> Rect {
        self.camera.value
    }

    /// The panel's screen rect as last drawn.
    pub fn panel_rect(&self, panel_id: &str) -> Option<Rect> {
        self.last_rects.get(panel_id).copied()
    }
}
