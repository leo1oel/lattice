// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The element model. Port of Excalidraw `packages/element/src/types.ts` and
//! `typeChecks.ts` @ 3a317b5. One struct carries the shared fields; `Kind`
//! carries what each element type adds. JSON reading lives in `restore.rs`,
//! writing in `json.rs`; keys we don't model are kept in `extra`.

use super::math::Point;
use serde_json::{Map, Value};

macro_rules! str_enum {
    ($(#[$m:meta])* $name:ident { $($v:ident = $s:literal),* $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($v),* }
        impl $name {
            pub fn as_str(self) -> &'static str { match self { $($name::$v => $s),* } }
            pub fn parse(s: &str) -> Option<$name> { match s { $($s => Some($name::$v),)* _ => None } }
        }
    };
}

str_enum!(FillStyle { Hachure = "hachure", CrossHatch = "cross-hatch", Solid = "solid", Zigzag = "zigzag" });
str_enum!(StrokeStyle { Solid = "solid", Dashed = "dashed", Dotted = "dotted" });
str_enum!(TextAlign { Left = "left", Center = "center", Right = "right" });
str_enum!(VerticalAlign { Top = "top", Middle = "middle", Bottom = "bottom" });
str_enum!(BindMode { Inside = "inside", Orbit = "orbit", Skip = "skip" });
str_enum!(ImageStatus { Pending = "pending", Saved = "saved", Error = "error" });
str_enum!(StrokeVariability { Variable = "variable", Constant = "constant" });
str_enum!(BoundType { Arrow = "arrow", Text = "text" });
str_enum!(
    /// Which end of a linear element (`"start" | "end"` upstream).
    StartOrEnd { Start = "start", End = "end" }
);
str_enum!(Arrowhead {
    Arrow = "arrow", Bar = "bar", Circle = "circle", CircleOutline = "circle_outline",
    Triangle = "triangle", TriangleOutline = "triangle_outline", Diamond = "diamond", DiamondOutline = "diamond_outline",
    CardinalityOne = "cardinality_one", CardinalityMany = "cardinality_many", CardinalityOneOrMany = "cardinality_one_or_many",
    CardinalityExactlyOne = "cardinality_exactly_one", CardinalityZeroOrOne = "cardinality_zero_or_one", CardinalityZeroOrMany = "cardinality_zero_or_many",
});
str_enum!(
    /// `ExcalidrawElement["type"]`.
    ElementType {
        Selection = "selection", Rectangle = "rectangle", StickyNote = "stickynote", Diamond = "diamond", Ellipse = "ellipse",
        Embeddable = "embeddable", Iframe = "iframe", Image = "image", Frame = "frame", MagicFrame = "magicframe",
        Text = "text", Line = "line", Arrow = "arrow", FreeDraw = "freedraw",
    }
);

/// `ROUNDNESS`.
pub mod roundness {
    pub const LEGACY: u8 = 1;
    pub const PROPORTIONAL_RADIUS: u8 = 2;
    pub const ADAPTIVE_RADIUS: u8 = 3;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Roundness {
    pub kind: u8,
    pub value: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundElement {
    pub id: String,
    pub kind: BoundType,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FixedPointBinding {
    pub element_id: String,
    pub fixed_point: [f64; 2],
    pub mode: BindMode,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FixedSegment {
    pub start: Point,
    pub end: Point,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub natural_width: f64,
    pub natural_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrokeOptions {
    pub variability: StrokeVariability,
    pub streamline: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextData {
    pub font_size: f64,
    pub font_family: u32,
    pub base_font_size: Option<f64>,
    pub text: String,
    pub text_align: TextAlign,
    pub vertical_align: VerticalAlign,
    pub container_id: Option<String>,
    pub original_text: String,
    pub auto_resize: bool,
    /// Unitless, a multiple of the font size.
    pub line_height: f64,
    /// Arrow labels: position along the arrow; absent in older files.
    pub label_position: Option<Option<f64>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LinearData {
    pub points: Vec<Point>,
    pub start_binding: Option<FixedPointBinding>,
    pub end_binding: Option<FixedPointBinding>,
    pub start_arrowhead: Option<Arrowhead>,
    pub end_arrowhead: Option<Arrowhead>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct ElbowData {
    pub fixed_segments: Option<Vec<FixedSegment>>,
    pub start_is_special: Option<bool>,
    pub end_is_special: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageData {
    pub file_id: Option<String>,
    pub status: ImageStatus,
    pub scale: [f64; 2],
    pub crop: Option<ImageCrop>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FreeDrawData {
    pub points: Vec<Point>,
    pub pressures: Vec<f64>,
    pub simulate_pressure: bool,
    pub stroke_options: StrokeOptions,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Selection,
    Rectangle,
    StickyNote {
        base_height: f64,
    },
    Diamond,
    Ellipse,
    Embeddable,
    Iframe,
    Image(ImageData),
    Frame {
        name: Option<String>,
    },
    MagicFrame {
        name: Option<String>,
    },
    Text(TextData),
    Line {
        linear: LinearData,
        polygon: bool,
    },
    /// `elbow` is Some for elbow arrows (`elbowed: true`).
    Arrow {
        linear: LinearData,
        elbow: Option<ElbowData>,
    },
    FreeDraw(FreeDrawData),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub stroke_color: String,
    pub background_color: String,
    pub fill_style: FillStyle,
    pub stroke_width: f64,
    pub stroke_style: StrokeStyle,
    pub roundness: Option<Roundness>,
    pub roughness: f64,
    pub opacity: f64,
    pub width: f64,
    pub height: f64,
    /// Radians, clockwise.
    pub angle: f64,
    pub seed: i64,
    pub version: i64,
    pub version_nonce: i64,
    /// Fractional index; None for new elements not yet in a scene.
    pub index: Option<String>,
    pub is_deleted: bool,
    /// Deepest first.
    pub group_ids: Vec<String>,
    pub frame_id: Option<String>,
    pub bound_elements: Option<Vec<BoundElement>>,
    /// Epoch ms.
    pub updated: i64,
    pub created: Option<i64>,
    pub link: Option<String>,
    pub locked: bool,
    pub custom_data: Option<Value>,
    pub kind: Kind,
    /// Keys we don't model, kept for writing back.
    pub extra: Map<String, Value>,
}

impl Kind {
    pub fn element_type(&self) -> ElementType {
        match self {
            Kind::Selection => ElementType::Selection,
            Kind::Rectangle => ElementType::Rectangle,
            Kind::StickyNote { .. } => ElementType::StickyNote,
            Kind::Diamond => ElementType::Diamond,
            Kind::Ellipse => ElementType::Ellipse,
            Kind::Embeddable => ElementType::Embeddable,
            Kind::Iframe => ElementType::Iframe,
            Kind::Image(_) => ElementType::Image,
            Kind::Frame { .. } => ElementType::Frame,
            Kind::MagicFrame { .. } => ElementType::MagicFrame,
            Kind::Text(_) => ElementType::Text,
            Kind::Line { .. } => ElementType::Line,
            Kind::Arrow { .. } => ElementType::Arrow,
            Kind::FreeDraw(_) => ElementType::FreeDraw,
        }
    }
}

impl ElementType {
    pub fn is_linear(self) -> bool {
        matches!(self, ElementType::Arrow | ElementType::Line)
    }
    pub fn is_freedraw(self) -> bool {
        self == ElementType::FreeDraw
    }
    pub fn is_binding(self) -> bool {
        self == ElementType::Arrow
    }
    pub fn uses_adaptive_radius(self) -> bool {
        matches!(
            self,
            ElementType::Rectangle
                | ElementType::Embeddable
                | ElementType::Iframe
                | ElementType::Image
        )
    }
    pub fn uses_proportional_radius(self) -> bool {
        matches!(
            self,
            ElementType::Line | ElementType::Arrow | ElementType::Diamond | ElementType::StickyNote
        )
    }
    pub fn is_eligible_frame_child(self) -> bool {
        matches!(
            self,
            ElementType::Rectangle
                | ElementType::StickyNote
                | ElementType::Diamond
                | ElementType::Ellipse
                | ElementType::Arrow
                | ElementType::Line
                | ElementType::FreeDraw
                | ElementType::Text
                | ElementType::Image
                | ElementType::Frame
                | ElementType::Embeddable
        )
    }
}

impl Element {
    pub fn ty(&self) -> ElementType {
        self.kind.element_type()
    }

    pub fn text(&self) -> Option<&TextData> {
        if let Kind::Text(t) = &self.kind {
            Some(t)
        } else {
            None
        }
    }
    pub fn text_mut(&mut self) -> Option<&mut TextData> {
        if let Kind::Text(t) = &mut self.kind {
            Some(t)
        } else {
            None
        }
    }
    pub fn linear(&self) -> Option<&LinearData> {
        match &self.kind {
            Kind::Line { linear, .. } | Kind::Arrow { linear, .. } => Some(linear),
            _ => None,
        }
    }
    pub fn linear_mut(&mut self) -> Option<&mut LinearData> {
        match &mut self.kind {
            Kind::Line { linear, .. } | Kind::Arrow { linear, .. } => Some(linear),
            _ => None,
        }
    }
    pub fn elbow(&self) -> Option<&ElbowData> {
        if let Kind::Arrow { elbow: Some(e), .. } = &self.kind {
            Some(e)
        } else {
            None
        }
    }
    pub fn elbow_mut(&mut self) -> Option<&mut ElbowData> {
        if let Kind::Arrow { elbow: Some(e), .. } = &mut self.kind {
            Some(e)
        } else {
            None
        }
    }
    pub fn freedraw(&self) -> Option<&FreeDrawData> {
        if let Kind::FreeDraw(f) = &self.kind {
            Some(f)
        } else {
            None
        }
    }
    pub fn image(&self) -> Option<&ImageData> {
        if let Kind::Image(i) = &self.kind {
            Some(i)
        } else {
            None
        }
    }
    pub fn image_mut(&mut self) -> Option<&mut ImageData> {
        if let Kind::Image(i) = &mut self.kind {
            Some(i)
        } else {
            None
        }
    }
    /// Points of linear and freedraw elements, relative to `x`, `y`.
    pub fn points(&self) -> Option<&[Point]> {
        match &self.kind {
            Kind::Line { linear, .. } | Kind::Arrow { linear, .. } => Some(&linear.points),
            Kind::FreeDraw(f) => Some(&f.points),
            _ => None,
        }
    }
    pub fn points_mut(&mut self) -> Option<&mut Vec<Point>> {
        match &mut self.kind {
            Kind::Line { linear, .. } | Kind::Arrow { linear, .. } => Some(&mut linear.points),
            Kind::FreeDraw(f) => Some(&mut f.points),
            _ => None,
        }
    }
    pub fn frame_name(&self) -> Option<&str> {
        match &self.kind {
            Kind::Frame { name } | Kind::MagicFrame { name } => name.as_deref(),
            _ => None,
        }
    }

    // typeChecks.ts
    pub fn is_image(&self) -> bool {
        matches!(self.kind, Kind::Image(_))
    }
    pub fn is_initialized_image(&self) -> bool {
        self.image()
            .is_some_and(|i| i.file_id.as_deref().is_some_and(|f| !f.is_empty()))
    }
    pub fn is_embeddable(&self) -> bool {
        matches!(self.kind, Kind::Embeddable)
    }
    pub fn is_iframe(&self) -> bool {
        matches!(self.kind, Kind::Iframe)
    }
    pub fn is_iframe_like(&self) -> bool {
        matches!(self.kind, Kind::Iframe | Kind::Embeddable)
    }
    pub fn is_text(&self) -> bool {
        matches!(self.kind, Kind::Text(_))
    }
    pub fn is_sticky_note(&self) -> bool {
        matches!(self.kind, Kind::StickyNote { .. })
    }
    pub fn is_frame(&self) -> bool {
        matches!(self.kind, Kind::Frame { .. })
    }
    pub fn is_magic_frame(&self) -> bool {
        matches!(self.kind, Kind::MagicFrame { .. })
    }
    pub fn is_frame_like(&self) -> bool {
        matches!(self.kind, Kind::Frame { .. } | Kind::MagicFrame { .. })
    }
    pub fn is_freedraw(&self) -> bool {
        matches!(self.kind, Kind::FreeDraw(_))
    }
    pub fn is_linear(&self) -> bool {
        matches!(self.kind, Kind::Line { .. } | Kind::Arrow { .. })
    }
    pub fn is_line(&self) -> bool {
        matches!(self.kind, Kind::Line { .. })
    }
    pub fn is_arrow(&self) -> bool {
        matches!(self.kind, Kind::Arrow { .. })
    }
    pub fn is_elbow_arrow(&self) -> bool {
        matches!(self.kind, Kind::Arrow { elbow: Some(_), .. })
    }
    pub fn is_simple_arrow(&self) -> bool {
        matches!(self.kind, Kind::Arrow { elbow: None, .. })
    }
    pub fn is_sharp_arrow(&self) -> bool {
        self.is_simple_arrow() && self.roundness.is_none()
    }
    pub fn is_curved_arrow(&self) -> bool {
        self.is_simple_arrow() && self.roundness.is_some()
    }
    pub fn is_line_polygon(&self) -> bool {
        matches!(self.kind, Kind::Line { polygon: true, .. })
    }
    pub fn is_binding_element(&self, include_locked: bool) -> bool {
        (!self.locked || include_locked) && self.is_arrow()
    }
    pub fn container_id(&self) -> Option<&str> {
        self.text().and_then(|t| t.container_id.as_deref())
    }
    pub fn is_bindable(&self, include_locked: bool) -> bool {
        (!self.locked || include_locked)
            && match &self.kind {
                Kind::Rectangle
                | Kind::StickyNote { .. }
                | Kind::Diamond
                | Kind::Ellipse
                | Kind::Image(_)
                | Kind::Iframe
                | Kind::Embeddable
                | Kind::Frame { .. }
                | Kind::MagicFrame { .. } => true,
                Kind::Text(t) => t.container_id.is_none(),
                _ => false,
            }
    }
    pub fn is_rectanguloid(&self) -> bool {
        match &self.kind {
            Kind::Rectangle
            | Kind::StickyNote { .. }
            | Kind::Diamond
            | Kind::Image(_)
            | Kind::Iframe
            | Kind::Embeddable
            | Kind::Frame { .. }
            | Kind::MagicFrame { .. } => true,
            Kind::Text(t) => t.container_id.is_none(),
            _ => false,
        }
    }
    pub fn is_rectangular(&self) -> bool {
        matches!(
            self.kind,
            Kind::Rectangle
                | Kind::StickyNote { .. }
                | Kind::Image(_)
                | Kind::Text(_)
                | Kind::Iframe
                | Kind::Embeddable
                | Kind::Frame { .. }
                | Kind::MagicFrame { .. }
                | Kind::FreeDraw(_)
        )
    }
    pub fn is_text_bindable_container(&self, include_locked: bool) -> bool {
        (!self.locked || include_locked)
            && matches!(
                self.kind,
                Kind::Rectangle
                    | Kind::StickyNote { .. }
                    | Kind::Diamond
                    | Kind::Ellipse
                    | Kind::Arrow { .. }
            )
    }
    pub fn is_flowchart_node(&self) -> bool {
        matches!(
            self.kind,
            Kind::Rectangle | Kind::StickyNote { .. } | Kind::Ellipse | Kind::Diamond
        )
    }
    pub fn has_bound_text(&self) -> bool {
        self.is_text_bindable_container(true)
            && self
                .bound_elements
                .as_ref()
                .is_some_and(|b| b.iter().any(|b| b.kind == BoundType::Text))
    }
    pub fn bound_text_id(&self) -> Option<&str> {
        self.bound_elements
            .as_ref()?
            .iter()
            .find(|b| b.kind == BoundType::Text)
            .map(|b| b.id.as_str())
    }
    pub fn is_bound_to_container(&self) -> bool {
        self.container_id().is_some()
    }
    pub fn is_arrow_bound(&self) -> bool {
        self.linear()
            .is_some_and(|l| l.start_binding.is_some() || l.end_binding.is_some())
            && self.is_arrow()
    }
}

pub fn can_apply_roundness_type(kind: u8, ty: ElementType) -> bool {
    ((kind == roundness::ADAPTIVE_RADIUS || kind == roundness::LEGACY) && ty.uses_adaptive_radius())
        || (kind == roundness::PROPORTIONAL_RADIUS && ty.uses_proportional_radius())
}
pub fn default_roundness_for(ty: ElementType) -> Option<Roundness> {
    if ty.uses_proportional_radius() {
        Some(Roundness {
            kind: roundness::PROPORTIONAL_RADIUS,
            value: None,
        })
    } else if ty.uses_adaptive_radius() {
        Some(Roundness {
            kind: roundness::ADAPTIVE_RADIUS,
            value: None,
        })
    } else {
        None
    }
}
pub fn is_valid_polygon(points: &[Point]) -> bool {
    points.len() > 3
        && super::math::points_equal(points[0], points[points.len() - 1], super::math::PRECISION)
}
pub fn can_become_polygon(points: &[Point]) -> bool {
    points.len() > 3
        || (points.len() == 3
            && !super::math::points_equal(
                points[0],
                points[points.len() - 1],
                super::math::PRECISION,
            ))
}

/// Binary file attached to a scene (`BinaryFileData`). We keep the bytes in
/// the library's assets folder; `data_url` is only filled when the scene came
/// from outside (pasted or imported) and not yet written out.
#[derive(Clone, Debug, PartialEq)]
pub struct FileData {
    pub id: String,
    pub mime_type: String,
    pub data_url: Option<String>,
    /// Library-relative path under `.assets/`, ours.
    pub path: Option<String>,
    pub created: i64,
    pub last_retrieved: Option<i64>,
    pub version: Option<i64>,
    pub extra: Map<String, Value>,
}
