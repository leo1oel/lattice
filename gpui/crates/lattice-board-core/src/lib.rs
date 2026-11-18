// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The whiteboard's engine, free of any UI: quiet.md's port of Excalidraw's
//! model, geometry, editing algorithms and history (`board`). The GPUI view
//! is `lattice-board`.

// The ported functions keep Excalidraw's signatures and shapes, so each
// stays traceable to its upstream counterpart.
#![allow(
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::large_enum_variant
)]

pub mod board;
mod time;
pub mod whiteboard;
