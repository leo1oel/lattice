// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/model/types.ts), with Lattice's patch (patches/@danfessler__trellis@0.2.0.patch).

//! The serializable document: a tree of splits, panels and at most one
//! stage, the floating and hidden panels, and the views' records. The JSON
//! shape is Trellis's own, so a document the Tauri app persisted reads here.

/// A document's views, in the order they were added (a JSON object's order).
pub type Views = indexmap::IndexMap<String, ViewRecord>;

use serde::{Deserialize, Serialize};

/// A rectangle. In the document, rects are fractions of their container (0–1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const ZERO: Rect = Rect {
        x: 0.,
        y: 0.,
        w: 0.,
        h: 0.,
    };

    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }

    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x <= self.x + self.w && p.y >= self.y && p.y <= self.y + self.h
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Point {
        Point { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
}

impl Axis {
    pub fn cross(self) -> Axis {
        match self {
            Axis::X => Axis::Y,
            Axis::Y => Axis::X,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

impl Edge {
    pub fn axis(self) -> Axis {
        match self {
            Edge::Left | Edge::Right => Axis::X,
            Edge::Top | Edge::Bottom => Axis::Y,
        }
    }

    /// Whether the edge comes first along its axis (left, top).
    pub fn before(self) -> bool {
        matches!(self, Edge::Left | Edge::Top)
    }

    pub fn opposite(self) -> Edge {
        match self {
            Edge::Left => Edge::Right,
            Edge::Right => Edge::Left,
            Edge::Top => Edge::Bottom,
            Edge::Bottom => Edge::Top,
        }
    }
}

/// View parameters: any plain JSON object.
pub type Params = serde_json::Map<String, serde_json::Value>;

/// A weighted row (`x`) or column (`y`) of panels, splits and at most one stage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SplitNode {
    pub id: String,
    pub axis: Axis,
    /// Relative sizes. Normalized to sum to 1.
    pub weights: Vec<f64>,
    pub children: Vec<LayoutNode>,
}

/// A tab group of one or more views. The unit users drag, dock and float.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PanelNode {
    pub id: String,
    pub views: Vec<String>,
    pub selected: String,
}

impl PanelNode {
    pub fn single(id: impl Into<String>, view: impl Into<String>) -> PanelNode {
        let view = view.into();
        PanelNode {
            id: id.into(),
            views: vec![view.clone()],
            selected: view,
        }
    }
}

/// The primary region. Never collapses; default destination for new views.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StageNode {
    pub id: String,
    /// A split or a panel, never another stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child: Option<Box<LayoutNode>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LayoutNode {
    Split(SplitNode),
    Panel(PanelNode),
    Stage(StageNode),
}

impl LayoutNode {
    pub fn id(&self) -> &str {
        match self {
            LayoutNode::Split(s) => &s.id,
            LayoutNode::Panel(p) => &p.id,
            LayoutNode::Stage(s) => &s.id,
        }
    }

    pub fn as_panel(&self) -> Option<&PanelNode> {
        match self {
            LayoutNode::Panel(p) => Some(p),
            _ => None,
        }
    }

    pub fn as_split(&self) -> Option<&SplitNode> {
        match self {
            LayoutNode::Split(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_stage(&self) -> Option<&StageNode> {
        match self {
            LayoutNode::Stage(s) => Some(s),
            _ => None,
        }
    }

    pub fn is_panel(&self) -> bool {
        matches!(self, LayoutNode::Panel(_))
    }

    pub fn is_split(&self) -> bool {
        matches!(self, LayoutNode::Split(_))
    }

    pub fn is_stage(&self) -> bool {
        matches!(self, LayoutNode::Stage(_))
    }

    /// A stage's child, if any.
    pub fn stage_child(&self) -> Option<&LayoutNode> {
        match self {
            LayoutNode::Stage(s) => s.child.as_deref(),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FloatingLayer {
    Stage,
    Overlay,
}

/// A float's fields that Trellis's `sanitize` repairs (a `z` saved as `null`,
/// a missing `rect`, an unknown `layer`) read as something it can repair.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FloatingPanel {
    pub panel: PanelNode,
    /// Fractions of the stage (layer `stage`) or of the workspace (layer `overlay`).
    #[serde(default = "default_float_rect")]
    pub rect: Rect,
    #[serde(default = "not_a_number", deserialize_with = "number_or_nan")]
    pub z: f64,
    #[serde(default = "overlay", deserialize_with = "layer_or_overlay")]
    pub layer: FloatingLayer,
}

fn default_float_rect() -> Rect {
    Rect::new(0.25, 0.25, 0.5, 0.5)
}

fn not_a_number() -> f64 {
    f64::NAN
}

fn overlay() -> FloatingLayer {
    FloatingLayer::Overlay
}

fn number_or_nan<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

fn layer_or_overlay<'de, D: serde::Deserializer<'de>>(d: D) -> Result<FloatingLayer, D::Error> {
    Ok(
        FloatingLayer::deserialize(serde_json::Value::deserialize(d)?)
            .unwrap_or(FloatingLayer::Overlay),
    )
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RestoreTarget {
    Floating {
        rect: Rect,
        layer: FloatingLayer,
    },
    Docked {
        beside: String,
        edge: Edge,
        share: f64,
    },
    Tab {
        panel: String,
        /// Lattice patch: the tab's place in the group it was hidden from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HiddenPanel {
    pub panel: PanelNode,
    /// Without one, it comes back as a float.
    #[serde(default = "float_back")]
    pub restore: RestoreTarget,
}

fn float_back() -> RestoreTarget {
    RestoreTarget::Floating {
        rect: default_float_rect(),
        layer: overlay(),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ViewRecord {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Params>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Framing {
    pub id: String,
    pub name: String,
    pub frame: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Navigation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framings: Option<Vec<Framing>>,
}

/// The complete, serializable workspace state. Persist it; hand it back later.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LayoutDocument {
    #[serde(default = "schema_one")]
    pub schema: u32,
    /// Your own layout version. A mismatch discards a persisted document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<serde_json::Value>,
    #[serde(default)]
    pub root: Option<LayoutNode>,
    #[serde(default)]
    pub floating: Vec<FloatingPanel>,
    #[serde(default)]
    pub hidden: Vec<HiddenPanel>,
    #[serde(default)]
    pub views: Views,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigation: Option<Navigation>,
}

fn schema_one() -> u32 {
    1
}

impl Default for LayoutDocument {
    fn default() -> Self {
        LayoutDocument {
            schema: 1,
            version: None,
            root: None,
            floating: Vec::new(),
            hidden: Vec::new(),
            views: Views::new(),
            navigation: None,
        }
    }
}

/// Where `open()` puts a view.
#[derive(Clone, Debug, PartialEq)]
pub enum Placement {
    Stage,
    Float,
    Side,
    Tab,
    Beside {
        beside: String,
        edge: Edge,
        share: Option<f64>,
    },
    Into {
        into: String,
        index: Option<usize>,
    },
    FloatAt {
        rect: Rect,
        layer: Option<FloatingLayer>,
    },
}

/// Where users may drop a view. Every region is allowed by default.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Allow {
    pub stage: bool,
    pub side: bool,
    pub floating: bool,
}

impl Default for Allow {
    fn default() -> Self {
        Allow {
            stage: true,
            side: true,
            floating: true,
        }
    }
}

/// How a view's content behaves below its `min_size`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scaling {
    /// Scales content down and keeps it usable.
    #[default]
    Interactive,
    /// Scales it down and ignores input until it's back at full size.
    Inert,
    /// Never scales: content lays out at whatever size its panel has.
    Off,
}

/// Tab bar mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TabbarMode {
    /// Sits above the content.
    #[default]
    Always,
    /// Hidden while the view is alone in its panel.
    Auto,
    /// Always hidden (rearrange from the menu or API).
    Never,
    /// Laid over the top of a lone view, whose content draws its own title bar.
    Overlay,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl Default for ViewRules {
    fn default() -> Self {
        ViewRules {
            placement: None,
            allow: None,
            singleton: false,
            closable: true,
            min_size: None,
            scaling: Scaling::default(),
            tabbar: TabbarMode::default(),
        }
    }
}

/// A view type's rules.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewRules {
    pub placement: Option<Placement>,
    pub allow: Option<Allow>,
    /// At most one instance; `open()` focuses the existing one.
    pub singleton: bool,
    pub closable: bool,
    /// Content lays out at no less than this size.
    pub min_size: Option<Size>,
    pub scaling: Scaling,
    pub tabbar: TabbarMode,
}
