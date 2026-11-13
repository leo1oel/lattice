# trellis (GPUI port)

Trellis by Dan Fessler (<https://github.com/DanFessler/trellis>), version 0.2.0, ported to Rust and GPUI for Lattice's GPUI app, with the behaviour of Lattice's patch to it (`patches/@danfessler__trellis@0.2.0.patch` in the repository root).

Uses Trellis by DanFessler - github.com/DanFessler/trellis

## License

**This crate is not under Apache-2.0, and not under the GPL that covers the rest of `gpui/`.**
It is a derivative of Trellis and stays under Trellis's own license: the Trellis Public License v1.0, whose terms are in [`LICENSE.md`](LICENSE.md), [`LICENSE-NONCOMMERCIAL.md`](LICENSE-NONCOMMERCIAL.md) and [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md), copied verbatim from Trellis 0.2.0.
Under the non-commercial license it may be used, modified and distributed for non-commercial purposes only, with the license files and the attribution above kept; commercial use needs a Trellis commercial license from its author.
Every source file carries a header naming the Trellis file it was ported from and this license.
Nothing in this crate may be moved into Lattice's Apache-2.0 tree.

## What it holds

- `model/`: the layout document (splits, tab groups, a stage, floating and hidden panels, views) and the pure functions over it, JSON-compatible with Trellis's `LayoutDocument`.
- `runtime/`: the engine, without a UI toolkit: layout with minimum sizes, docking and drag targets, tab sorting, dividers with their rubber band and spring, floating and hidden panels, the camera's framing and free navigation, the keymap, the panel menu, and the motion.
- `view/` (feature `gpui`, on by default): the engine as a GPUI view, drawing each frame through a `Skin` the app implements.

Its tests (`cargo test -p trellis --no-default-features`) drive the engine without a window.
