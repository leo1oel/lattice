// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Board transforms: upstream Excalidraw tests @ 3a317b5 translated with their
//! inputs and expected values. UI-driven cases (pointer drags, keyboard
//! shortcuts, menu clicks) are re-expressed as direct calls on the ported
//! functions with the same setup and expected values. One file per area under
//! `board_transform/`; each lists what it skipped and why.
//! - resize.rs: element/tests/resize.test.tsx, excalidraw/tests/rotate.test.tsx,
//!   excalidraw/tests/flip.test.tsx, element/tests/sizeHelpers.test.ts leftovers.
//! - frame_drag.rs: element/tests/frame.test.tsx, element/tests/dragElements.test.ts,
//!   excalidraw/tests/move.test.tsx.
//! - order.rs: element/tests/selection.test.ts, zindex.test.tsx, duplicate.test.tsx,
//!   align.test.tsx, distribute.test.tsx.
//! - actions.rs: excalidraw/tests/elementLocking.test.tsx, actionStyles.test.tsx and
//!   the actions' own tests.

#[path = "board_transform"]
mod board {
    mod actions;
    mod common;
    mod frame_drag;
    mod order;
    mod resize;
}
