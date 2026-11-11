# gpui_macos, lab copy

Zed's `crates/gpui_macos` at `d2a4fb6ded7c470be25d1541281da3882495b65b` (Apache-2.0, `LICENSE-APACHE`), patched in through `[patch."https://github.com/zed-industries/zed"]` in the workspace manifest.

The only source change is `lab-occlusion.diff`: when `GPUI_LAB_IGNORE_OCCLUSION` is set, a window is paced by the display's `CVDisplayLink` (the path Zed uses before macOS 14) instead of a `CAMetalDisplayLink` on its layer, keeps that link running, and reports itself visible even when none of it is on screen.
A `CAMetalDisplayLink` stops delivering frames for a layer that is not on screen, which the occlusion switch alone does not change.
Without the variable the crate behaves exactly like upstream.

Why: Lattice's perf lab measures WebKit in windows that are never composited on the console screen, with WebKit's occlusion detection turned off (`LATTICE_WK_NOOCC`).
The prototype's `perf` scenario sets the variable so its numbers come from the same conditions, including when the console session is locked.

`Cargo.toml` is regenerated from Zed's: workspace-inherited dependencies are spelled out, and Zed's path dependencies point at the same git revision.
