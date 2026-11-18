// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! 画板: a whiteboard ported from Excalidraw (MIT,
//! github.com/excalidraw/excalidraw @ 3a317b55f508815d10a4c12acca99df30f026521).
//! Model, geometry, editing algorithms and history live here, free of GPUI;
//! tools, rendering and chrome live in the app's `board` module. Each file
//! names the upstream file it ports. See docs/design/whiteboard-excalidraw.md.

pub mod actions;
pub mod align;
pub mod app_state;
pub mod arrow_text;
pub mod binding;
pub mod bounds;
pub mod clipboard;
pub mod collision;
pub mod color;
pub mod consts;
pub mod crop;
pub mod deconstruct;
pub mod display;
pub mod drag;
pub mod duplicate;
pub mod elbow;
pub mod encode;
pub mod eraser;
pub mod export_svg;
pub mod flowchart;
pub mod font_subset;
pub mod fractional_index;
pub mod frame;
pub mod freehand;
pub mod groups;
pub mod handles;
pub mod heading;
pub mod history;
pub mod image;
pub mod json;
pub mod lasso;
pub mod linear;
pub mod list_marker;
pub mod math;
pub mod mutate;
pub mod new_element;
pub mod random;
pub mod resize;
pub mod restore;
pub mod rough;
pub mod scene;
pub mod selection;
pub mod shape;
pub mod size_helpers;
pub mod snapping;
pub mod sticky;
pub mod text;
pub mod text_edit;
pub mod text_measure;
pub mod text_wrapping;
pub mod transform;
pub mod types;
pub mod utils;
pub mod viewport;
pub mod zindex;
