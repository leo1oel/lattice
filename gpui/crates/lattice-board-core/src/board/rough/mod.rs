// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! rough.js 4.6.4 (MIT, Preet Shihn), the version Excalidraw @ 3a317b5
//! depends on: the generator (`generator.js`), the renderer (`renderer.js`),
//! the fillers (`fillers/*.js`), `math.js`'s `Random`, and its dependencies
//! hachure-fill 0.5.2, points-on-curve 0.2.0 (= 1.0.1 for what we use),
//! points-on-path 0.2.1 and path-data-parser 0.1.0 (all MIT, Preet Shihn).
//! Ops come out as rough.js computes them, to the last bit where the
//! arithmetic allows (tests/board_rough.rs checks them against roughjs).
//!
//! Differences: options are a struct, and the randomizer rough.js keeps on
//! the options object (and shares with every `Object.assign` copy) is passed
//! alongside as `&mut Random`; `Math.random()` (seed 0, the dot filler's
//! jitter, the hachure skip test without a randomizer) is a mulberry32
//! stream seeded with the options' seed, so drawings stay stable; paths are
//! given as parsed segments (`path_data::parse_path` reads strings);
//! `fixedDecimalPlaceDigits` and the canvas / SVG drawing classes are left
//! out (the board's display list draws the ops, `display.rs`).

pub mod curve;
pub mod fillers;
mod generator;
pub mod path_data;
pub mod renderer;

pub use generator::*;
pub use renderer::{EllipseParams, ellipse as ellipse_ops, generate_ellipse_params};

use super::math::Point;

/// A rough.js op (`move`, `lineTo`, `bcurveTo`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Op {
    Move(Point),
    LineTo(Point),
    BCurveTo(Point, Point, Point),
}

impl Op {
    pub fn end(&self) -> Point {
        match *self {
            Op::Move(p) | Op::LineTo(p) | Op::BCurveTo(_, _, p) => p,
        }
    }
    pub fn map(&self, f: impl Fn(Point) -> Point) -> Op {
        match *self {
            Op::Move(p) => Op::Move(f(p)),
            Op::LineTo(p) => Op::LineTo(f(p)),
            Op::BCurveTo(a, b, c) => Op::BCurveTo(f(a), f(b), f(c)),
        }
    }
}

/// `OpSetType`: an outline stroked with `stroke`, an area filled with
/// `fill`, or fill lines stroked with `fill` at `fillWeight`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpSetType {
    Path,
    FillPath,
    FillSketch,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpSet {
    pub ty: OpSetType,
    pub ops: Vec<Op>,
}

impl OpSet {
    pub fn path(ops: Vec<Op>) -> OpSet {
        OpSet {
            ty: OpSetType::Path,
            ops,
        }
    }
}

/// `Drawable.shape`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShapeKind {
    Line,
    Rectangle,
    Ellipse,
    Circle,
    LinearPath,
    Arc,
    Curve,
    Polygon,
    Path,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Drawable {
    pub shape: ShapeKind,
    pub sets: Vec<OpSet>,
    pub options: Options,
}

impl Drawable {
    /// The fill rule the canvas renderer fills `fillPath` sets with.
    pub fn even_odd(&self) -> bool {
        matches!(
            self.shape,
            ShapeKind::Curve | ShapeKind::Polygon | ShapeKind::Path
        )
    }
}

/// `fillStyle`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillStyle {
    Hachure,
    Solid,
    Zigzag,
    CrossHatch,
    Dots,
    Dashed,
    ZigzagLine,
}

/// rough.js `Options` with the generator's defaults. `stroke` None is
/// `"none"`; `fill` None is unset.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub max_randomness_offset: f64,
    pub roughness: f64,
    pub bowing: f64,
    pub stroke: Option<String>,
    pub stroke_width: f64,
    pub curve_tightness: f64,
    pub curve_fitting: f64,
    pub curve_step_count: f64,
    pub fill_style: FillStyle,
    pub fill_weight: f64,
    pub hachure_angle: f64,
    pub hachure_gap: f64,
    pub dash_offset: f64,
    pub dash_gap: f64,
    pub zigzag_offset: f64,
    pub seed: i64,
    pub disable_multi_stroke: bool,
    pub disable_multi_stroke_fill: bool,
    pub preserve_vertices: bool,
    pub fill_shape_roughness_gain: f64,
    pub fill: Option<String>,
    pub simplification: Option<f64>,
    pub stroke_line_dash: Option<Vec<f64>>,
    pub stroke_line_dash_offset: Option<f64>,
    pub fill_line_dash: Option<Vec<f64>>,
    pub fill_line_dash_offset: Option<f64>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            max_randomness_offset: 2.,
            roughness: 1.,
            bowing: 1.,
            stroke: Some("#000".into()),
            stroke_width: 1.,
            curve_tightness: 0.,
            curve_fitting: 0.95,
            curve_step_count: 9.,
            fill_style: FillStyle::Hachure,
            fill_weight: -1.,
            hachure_angle: -41.,
            hachure_gap: -1.,
            dash_offset: -1.,
            dash_gap: -1.,
            zigzag_offset: -1.,
            seed: 0,
            disable_multi_stroke: false,
            disable_multi_stroke_fill: false,
            preserve_vertices: false,
            fill_shape_roughness_gain: 0.8,
            fill: None,
            simplification: None,
            stroke_line_dash: None,
            stroke_line_dash_offset: None,
            fill_line_dash: None,
            fill_line_dash_offset: None,
        }
    }
}

impl Options {
    /// `fillSketch`'s line width.
    pub fn fill_weight_or_default(&self) -> f64 {
        if self.fill_weight < 0. {
            self.stroke_width / 2.
        } else {
            self.fill_weight
        }
    }
}

/// `math.js` `Random` (Park–Miller with `Math.imul`), created lazily as
/// rough.js does on the first draw from an options object.
#[derive(Clone, Debug)]
pub struct Random {
    seed: i64,
    state: Option<i32>,
    math: u32,
}

impl Random {
    pub fn new(seed: i64) -> Random {
        Random {
            seed,
            state: None,
            math: seed as u32,
        }
    }
    /// Whether `o.randomizer` exists yet.
    pub fn started(&self) -> bool {
        self.state.is_some()
    }
    /// `Random.next()`: in [0, 1).
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        let s = *self.state.get_or_insert(self.seed as i32);
        if s != 0 {
            let n = s.wrapping_mul(48271);
            self.state = Some(n);
            (n & 0x7fff_ffff) as f64 / 2f64.powi(31)
        } else {
            self.math_random()
        }
    }
    /// The `Math.random()` stand-in: mulberry32.
    pub fn math_random(&mut self) -> f64 {
        self.math = self.math.wrapping_add(0x6d2b79f5);
        let mut n = self.math;
        n = (n ^ (n >> 15)).wrapping_mul(n | 1);
        n ^= n.wrapping_add((n ^ (n >> 7)).wrapping_mul(n | 61));
        (n ^ (n >> 14)) as f64 / 4294967296.
    }
}
