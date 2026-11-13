# Lattice's design system on GPUI

The Tauri app moves and shapes its interface with Fluid Functionalism (<https://www.fluidfunctionalism.com/docs>), adapted in `../src/components/ui/` and written down in `../docs/design-system.md`.
`crates/lattice-ui` carries the same system natively, so every GPUI surface hovers, moves, reveals, scrolls and rounds its corners the way the app does.
Use these primitives instead of a per-row `.hover()`, a hand-written duration or a restated radius; a surface that needs something they do not cover should grow them here rather than invent its own.

| Need | Use | The app's source |
| --- | --- | --- |
| A list, menu or picker the pointer lights | `fluid_hover::FluidHover` | `fluid-hover-surface.tsx`, `use-fluid-hover.ts` |
| GPUI Kit's popup menus (context menus, a dock's ⋯ menu) | nothing: `kit::apply` installs `fluid_hover::KitMenuGlide` | the same |
| Motion of any kind | `motion::Motion` tiers, `motion::Tween` | `motion-values.ts`, `--motion-*` |
| A selection plate that moves between items | `sliding::SlidingPlate` | `SlidingTabs` in `motion.tsx` |
| Something that arrives, leaves or loads | `reveal::{reveal, Arrival, Presence, loading_opacity}` | `.reveal-product`, `loading-reveal.ts` |
| A scroll area's scrollbar | `scrollbar::FluidScrollbar` | `scroll-area.tsx`, `scroll-area.css` |
| A label whose weight or text changes | `weight::StableLabel` | the ghost-span pattern, `.trellis-build-sizer` |
| A corner inside another surface | `shape::Nest` | `--nested-radius` in `surfaces.css` |
| An element's bounds as it is laid out | `measure::measured` | `offsetTop`, `ResizeObserver` |

## Motion

There are three spring tiers and a pop tier, each with an exit one tier quicker (`motion::Motion`).

| Tier | Enter | Exit | For |
| --- | --- | --- | --- |
| `Fast` | 80 ms, no bounce | 60 ms ease-out | hover, focus, fades, the fluid hover's travel |
| `Moderate` | 160 ms, critically damped | 120 ms ease-out | a sliding plate, rows, a view's fade, a scrollbar thumb |
| `Slow` | 240 ms, small bounce | 160 ms ease-out | dialogs, drawers, panes |
| `Pop` | 220 ms, soft bounce | 120 ms ease-out | menus, selects, popovers |

The bigger the thing that moves, the slower the tier.
The curves are the app's own `linear()` spring samples, so a GPUI animation follows the CSS point for point.

- `Motion::animation()` is a GPUI `Animation` on the tier, for `with_animation`.
- `interaction::fade(id, on, motion, window, cx)` is a 0..1 progress that runs in on the tier and out on its exit; `interaction::use_interaction` is a control's eased hover and press.
- `motion::Tween<T>` is one value (an `f32`, `Pixels` or a rect) that a component keeps itself and retargets mid-flight from where it is drawn: `retarget(to, motion, now)`, or `retarget_on(to, token, delay, now)` for a CSS transition whose duration, curve and delay are written apart.
  Read it with `value(now)`, and ask for a frame while `is_running(now)`.
- `motion::Entrance` holds the popup, tooltip, dialog and toast entrances (`components::pop_in`, `rise_in`, `toast_in`).
- Under reduced motion (`cx.reduce_motion()`), spatial travel lands at once and fades stay.

## Fluid hover

One fill per list, gliding to the row under the pointer, instead of a fill per row that blinks between rows.

```rust
let hover = FluidHover::new("outline", window, cx)
    .fill(palette.accent_soft)            // the list's current-row wash
    .radius(shape::MENU.inner())          // the rows' corner
    .follow(self.current, cx);            // the keys' current row, if the list has one
div()
    .relative()                           // the fill is laid over the list
    .child(hover.highlight())             // first: it paints behind the rows
    .children(rows.map(|(ix, row)| hover.item(ix, row)))
```

- The pointer lights the row it is over, or one whose edge is within 3px; a separator's margin and a section label stay dark.
- Within a section the fill travels on the fast tier; entering the list or crossing into another section (`ItemKind::section`) fades a new fill in and the old one out, never sliding through a label.
- A row that must not be promised (disabled, destructive, or the selected row of a list that keeps its own selection fill) is `ItemKind::skip()`: under the pointer it clears the fill.
- Leaving, pressing and scrolling under a resting pointer clear the fill; only a pointer that really moves lights a row again.
  `quiet_after_scroll(duration, cx)` keeps a list dark for a moment after each scroll (the Project tree's 150 ms).
- `follow(current, cx)` gives the keys the same fill; whichever hand moved last owns it.
  A list whose keyboard answer is a focus ring (a tree) does not follow.
- `lit(cx)` is the row the pointer or keys lit (run it on Enter, step the keys on from it); `is_lit(ix, cx)` lets a row change its ink.
- Rows draw no hover fill of their own: `components::MenuItem::fluid()` and `TreeRow::fluid(probe)` do that for the shared rows.
- `item(ix, row)` records a row's bounds without changing its layout; `probe(ix, kind)` does it from inside a positioned row built elsewhere (Kit's tree items).
  The rows must be built in the same view as the highlight.

Where it runs today: `components::Menu` and `Select`, Kit's popup menus (`KitMenuGlide`, through `patches/gpui-component-lattice-hooks.diff`), the Project tree and the command palette.
Tabs, toolbar buttons and the titlebar's controls keep a per-control fade on the fast tier (`interaction::use_interaction`), as the app's do.

## Sliding plate

A strip's selection plate is one element that slides to the new item on the moderate tier (`sliding::SlidingPlate`), as the app's segmented controls and sliding tabs do.
`components::Segmented` uses it.

```rust
let plate = SlidingPlate::new("presets", selected, window, cx);
let drawn = plate.is_drawn(cx);           // until then the selected item draws its own plate
let strip = div()
    .relative()
    .children(plate.plate(|plate| plate.bg(palette.panel).rounded(radius), cx))
    .children(items.map(|(ix, item)| plate.item(ix, item)));
plate.strip(strip)
```

## Reveal

- `reveal(id, Arrival::PRODUCT.nth(i), element, cx)`: a block fades in where it is on the moderate tier, items that arrive together 40 ms apart (eight steps at most), and nothing moves on scroll (Fluid Functionalism's product preset).
  `Arrival::SWAP` rises 3px, for a status line that swaps in.
- `Presence::new(id, shown, motion, window, cx)` keeps something drawn while it leaves, with its opacity: in on the tier, out on the exit.
- `loading_opacity(id, started, window, cx)` shows nothing for 150 ms, then fades in on the fast tier, so a quick load shows no indicator.

## Scrollbars

`FluidScrollbar::vertical(id, &handle)` (or `horizontal`) draws the app's scrollbar over a scroll container: put it last in the positioned element that holds the container.
It takes any `gpui_kit::base::ScrollbarHandle` (a `ScrollHandle`, a uniform list's, a Kit tree's `TreeState::scroll_handle`).

- A 10px track flush with the edge, a hit target even while the bar is invisible, and nothing when the content fits.
- Shown while the pointer is over the area (or the bar, for a document) and for a moment after a scroll, fading in over 160 ms; it hides over 80 ms after a 160 ms wait.
- A pill thumb 4px wide and 2px off the edge, 6px over the track, in the ink at 8%, 12% over the track and 16% held, moving on the moderate tier; 4px in from the ends, never shorter than its feel's shortest thumb.
- Dragging the thumb scrolls; pressing the track jumps the thumb's middle to the pointer.

The app has four feels of the one bar, which differ only in what reveals it, how long it lingers after a scroll, its shortest thumb and what a press on the track does; pick the surface's with `.feel(..)`:

| Feel | The app's | Revealed by | Lingers | Shortest thumb | Track press |
| --- | --- | --- | --- | --- | --- |
| `ScrollbarFeel::AREA` (default) | `scroll-area.tsx` | the pointer over the area | 500 ms | 16px | the thumb's middle to the pointer |
| `ScrollbarFeel::LIST` | `external-scrollbar.tsx` (the Project tree) | the pointer over the list | 500 ms | 18px | the same |
| `ScrollbarFeel::DOCUMENT` | `overlay-scrollbar.tsx` (the PDF) | the pointer on the bar | 180 ms | 24px | the same |
| `ScrollbarFeel::EDITOR` | `codemirror-scrollbar.tsx` | the pointer on the bar | 180 ms | 24px | the document to the pointer's share of the track |

`.ink(color)` sets the thumb's ink before its 8/12/16% share: the source editor's bar takes the code ink.
A wheel over any track scrolls what is under it (the app's overlay and list bars forward it by hand; the editor's did not, which this unifies).

Kit's tree draws it with `.scrollbar(false)` (in the list feel); Kit's other scrollbars and Zed's editor keep their own, themed in Lattice's inks (`kit.rs`, `editor_theme`).
The editor's overlay scrollbar (`lattice-editor`) moves onto `FluidScrollbar` with `ScrollbarFeel::EDITOR` and the code ink.

## Corners

A surface flush inside another does not choose its corner: `shape::Nest { radius, inset, border, floor }` derives it as `max(floor, radius - inset - border)` (<https://interactively.info/article/perfect-nested-rounded-corners>).

| Nest | Container | Inset | Child |
| --- | --- | --- | --- |
| `shape::MENU` | a menu, select or context menu, 10px | 4px | its rows, 6px |
| `shape::PANEL_TABS` | a docked panel, 10px | 6px | its tabs, held at 6px |
| `shape::TAB_CLOSE` | a tab, 6px | 2px | its close square, 4px |
| `shape::SEGMENTED` | a segmented track, 6px | 2px | its chip, 4px |
| `shape::PALETTE_LIST` | the command palette, 14px | 6px | its rows, 8px |
| `shape::IN_PLACE_MENU` | an in-place menu, 10px | 4px | its rows, 6px |

The steps are `shape::RADIUS_CHIP` (4), `RADIUS_TARGET` (6), `RADIUS_SURFACE` (10) and `RADIUS_MODAL` (14).
The app draws its corners as squircles scaled by `--corner-smoothing` (1.84) where the engine can; GPUI draws round corners, and `shape::Corners` says which drawing a radius copies.
The chrome (panels, tabs, segmented controls, the titlebar's search field, keycaps) copies Paper's measured, smoothed radii through `shape::CHROME`; the smoothing is applied after the nesting (`Nest::painted`), never before, so the inset holds along the diagonal.
A new radius picks a step and, when nested, a `Nest`; never a value between the steps.

## Labels that change weight

`weight::StableLabel::new(text).weight(w).reserve_weight(FontWeight::SEMIBOLD)` sizes its box by the heaviest weight (and any other text it may show, `reserve(text, weight)`), so a selected label getting heavier, or a status changing its words, never moves its neighbours.
