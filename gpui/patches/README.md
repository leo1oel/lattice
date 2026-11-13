# Patched upstream crates

Four crates the app builds on are vendored here with Lattice's changes, and swapped in through the workspace manifest's `[patch]` tables.
Each is upstream's source at an exact pin plus the diffs in this directory, nothing else; `script/check-patches` rebuilds them from upstream and fails on any difference (CI runs it), and `script/check-patches --write` rebuilds them after a diff is edited or a pin moves.

| Crate | Upstream | Pin | License | Diffs |
|---|---|---|---|---|
| `gpui-fast/crates/gpui` | [longbridge/gpui-fast](https://github.com/longbridge/gpui-fast) `crates/gpui` | commit `bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa` | Apache-2.0 | `gpui-fast-vendoring.diff`, `gpui-fast-motion-and-type.diff` |
| `gpui-fast/crates/gpui_macos` | the same repository's `crates/gpui_macos` | the same commit | Apache-2.0 | `gpui-fast-lab-occlusion.diff` |
| `gpui-component` | [crates.io `gpui-component`](https://crates.io/crates/gpui-component) (GPUI Kit's components) | 0.9.1, crate SHA-256 `e155c4914bd809d966660610d596f7b57c5cd38979ca2c132215057a91f23f03` | Apache-2.0 | `gpui-component-overlays.diff`, `gpui-component-lattice-hooks.diff` |
| `gpui-base` | [crates.io `gpui-base`](https://crates.io/crates/gpui-base) (GPUI Kit's foundation: the dock's behaviour) | 0.9.1, crate SHA-256 `f3e9ae5237737cfd110d0ff513fcd9c20f97d98ebabd0a73164068177f0aca4f` | Apache-2.0 | `gpui-base-dock-drag-out.diff` |

What is copied: each crate's sources, manifest, build script, README and license (a copy of the repository's, which upstream links), without examples, benches and docs, and for the crates.io crates without their packaging files (`Cargo.lock`, `Cargo.toml.orig`); `gpui-base` keeps the tests and benches its manifest names.
The vendored copies cannot run their own tests where they sit (the gpui crate's tests read examples and fonts that are not copied), so the tests the diffs add run in a gpui-fast checkout at the pin with the diffs applied: the `gpui-patches` workflow does that on every change to this directory, and the command is under "Moving a pin" below. The whole gpui test suite passed against these diffs when they were written (852 tests).

## The diffs

- **`gpui-fast-vendoring.diff`**: what it takes to build the two gpui-fast crates out of their repository.
  `gpui-fast/Cargo.toml` is gpui-fast's workspace manifest, kept so the crates inherit exactly the dependencies and features they do upstream; its members are cut to the two vendored crates, every other gpui-fast crate it names is taken from gpui-fast's git repository at the pin, and its `[patch]` and `[profile]` tables (which only a root workspace reads) are dropped.
  `crates/gpui/Cargo.toml` loses its `[[example]]` entries, whose files are not copied.
- **`gpui-fast-lab-occlusion.diff`**: with `GPUI_LAB_IGNORE_OCCLUSION` set, a window renders as if visible when none of it is on screen (covered, or on a locked display): it is paced by the display's `CVDisplayLink` instead of a `CAMetalDisplayLink`, which stops for a layer that is not on screen, and reports itself visible. Lattice's perf lab measures WebKit the same way. Without the variable the crate behaves as upstream.
- **`gpui-fast-motion-and-type.diff`**: two things CSS has and GPUI lacked, which Lattice's look needs (`fast/scale.rs`, `fast/letter_spacing.rs`; upstream files get only hooks, as gpui-fast's own rules ask).
  - *Element scale*: `gpui::scaled(child).scale(s).origin(..).translate(..)`, CSS's `transform: translate() scale()` about a `transform-origin`, for the popup, dialog and toast entrances. Paint is transformed in the scene, every primitive kind, layer and rounded clip alike; layout and hit testing are not. Sprites are stretched from their raster at rest rather than rasterized at every fractional size, as a browser composites a transformed layer, so an entrance adds nothing to the atlas. A view replayed from last frame is replayed only under the scale it was drawn with, and a view drawn again inside a replayed one keeps the scale it is drawn under.
  - *Letter spacing*: `TextStyle::letter_spacing` and `Styled::letter_spacing` (pixels, rems, or a fraction of the font size, which is CSS's `em`), applied after shaping and keyed in the line layout cache, so wrapping and hit testing read the spaced glyphs.
- **`gpui-base-dock-drag-out.diff`**: a group with nothing beside it in its region no longer keeps its last panel. GPUI Kit refused to drag a dock's (or the center's) last panel out, or to close it, so the dock could never be emptied; Trellis lets a column's last panel go and its neighbours take the room. Lattice's shell takes a dock left empty away on `DockEvent::LayoutChanged` and draws its own empty center. It is one constant in `plan_tree`'s constraints (`KEEP_LAST_PANEL`), so the change reads in one place; upstream's own test `the_only_groups_last_visible_panel_cannot_be_dragged_out` sets the constraint directly and still describes the group, not the dock. The `e2e` scenario drags the PDF out of its dock with native mouse events.
- **`gpui-component-lattice-hooks.diff`**: two seams for Lattice's design system, each inert until the app uses it.
  - *A host-drawn menu highlight*: with a `GlobalMenuHighlight` installed, a `PopupMenu`'s rows draw no hover or selection fill of their own; the menu records each row's bounds, section (rows between two separators or labels) and whether it can be highlighted as it is laid out, and hands them with its highlighted item to the host's `MenuHighlight::paint`, behind the rows.
    Lattice draws the fluid hover there (`lattice_ui::fluid_hover::KitMenuGlide`): one fill gliding between rows, as the Tauri app's menus have it.
    Without the global the menu is upstream's.
  - *`Tree::scrollbar(false)`*: the tree leaves out its own scrollbar, so a host can draw one over `TreeState::scroll_handle` (Lattice's hover-revealed scrollbar, `lattice_ui::scrollbar`).
    The default draws it, as upstream.
- **`gpui-component-overlays.diff`**: GPUI Kit's notification and sheet layers are drawn `deferred`, as its dialogs already are. gpui-fast composes native views (a webview island) between a window's base content and its overlay surface, and only deferred draws reach the overlay surface, so without this a toast or a Kit sheet is covered by any webview under it.

The new public API (`scaled`, `Scaled`, `TextStyle::letter_spacing`, `Styled::letter_spacing`) is not gpui-fast's, which adds no public API without its maintainers' agreement; it is kept here, on the pin, until it is upstreamed or replaced.

## Moving a pin

1. Change the pin in `script/check-patches`, in the workspace manifest's `[patch]` tables and in `gpui-fast-vendoring.diff`.
2. Run `script/check-patches --write`; a diff that no longer applies fails it, and is fixed against the new upstream.
3. Run the patch tests in a gpui-fast checkout at the new pin with the diffs applied; this is required, because a diff can still apply and build after upstream moved what it hooks into. From a directory holding the checkout as `gpui-fast/`:

   ```sh
   for diff in gpui-fast-lab-occlusion gpui-fast-motion-and-type; do git apply "<lattice>/gpui/patches/$diff.diff"; done
   (cd gpui-fast && cargo test -p gpui --lib --features test-support,gpui_platform/runtime_shaders -- fast::scale fast::letter_spacing)
   ```

   `fast::scale` covers the transform of every primitive kind, nesting, the kept outer clip, and a view replayed inside a scale or drawn again inside a replayed one; `fast::letter_spacing` covers the spacing of clusters and marks and the measured width of tracked text. CI's `gpui-patches` workflow runs the same.
4. Build, run the workspace tests and the `e2e` scenario.
