// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/model/).

//! The document model: plain data and pure functions over it.

pub mod builder;
pub mod document;
pub mod spatial;
pub mod tree;
pub mod types;

#[cfg(test)]
mod requirements;
#[cfg(test)]
mod tests;

pub use builder::{FloatSpec, LayoutSpec, PanelSpec, SplitSpec, StageSpec, ViewSpec, create_document, layout};
pub use document::*;
pub use spatial::*;
pub use tree::*;
pub use types::*;
