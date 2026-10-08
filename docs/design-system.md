# Lattice design system

Lattice uses a compact desktop chrome around more comfortable writing and
reading surfaces. The design system exists to keep those contexts coordinated,
not to force every surface into one density.

## Decisions

- The interface font (`--ui-font`) is Inter Variable, or Timeless Sans in a
  build that embeds the Timeless family: releases and local builds that have
  the fonts (see Private interface fonts).
  Long-form reading surfaces use `--reading-font`; code never leaves
  `--editor-font`.
- The product accent is neutral by default (Graphite). Settings → Appearance
  offers six accent presets and a custom color; each reads at 4.6:1 as text on
  every surface of every tint, and a custom pick is fitted to that floor.
  Status colors communicate success, warning, and danger; they are not
  substitutes for the interaction accent.
- Agent body copy, user messages, and the composer use the body role (13/20)
  at regular weight.
- Long-form reading surfaces use the typeset role (14/22).
- Code and diffs use one fixed editor font stack. The bundled default is
  Ioskeley Mono (OFL), with system monospace faces as fallback. Local and
  embedded code surfaces share this stack; editor font size remains
  adjustable.
- Project filenames and folders use the interface font at 13/16px. Project rows use the
  compact 32px row role; selected items move from regular to medium weight.
- Papers titles use the reading font at 13/18px regular weight, as the paper
  reader sets a title. Author, year, venue, and other Papers metadata remain
  in the interface font at 11/16px regular weight.
- Diff code uses the editor font at 11/18px. Diff paths, headers, and line
  numbers remain in the interface font; compact metadata uses the 10/14px role.
- Embedded Agent thread titles use the caption role (11/16) at regular
  weight; Project filenames use their own 13/16px alias.
- The top toolbar and left Project, Papers, and Agent navigation form the app
  chrome. At the default Graphite tint they use `#EFEFF0` in the light theme
  and `#141416` in the dark theme. The titlebar lifts a step off that ground
  (`--surface-titlebar`, a white veil over the chrome, closed by a hairline),
  so it never reads as the same sheet as the gutters beneath it.
- Default navigation text on the light chrome uses `#59595B`; selected and
  emphasized items use the primary text color.
- Right-side feature drawers are a separate surface: `#F9F9FA` in the light
  theme and `#1B1B1D` in the dark theme. Feature drawers must not introduce
  their own white or gray outer background. Embedded routes receive their
  surface role explicitly rather than inferring it from feature-specific CSS.
- New component styles use semantic tokens from
  `src/styles/foundations.css`. Raw values are reserved for genuinely unique
  geometry, such as an asymmetric message bubble.
- Light and dark colors come from semantic theme variables. Do not introduce a
  fixed light-theme hex value into a reusable component.


## Theme presets and window material

Settings → Appearance → Theme adds three choices to light and dark, all
applied on `<html>` by `src/settings/use-appearance.ts`:

- **Tint** (`data-tint`): Graphite, Paper, Sage, Mist or Dusk. A tint moves
  only the neutral surfaces to one hue at their existing OKLCH lightness, so
  the syntax tokens keep their 4.5:1; chrome takes the full tint, panels and
  the editor 70% of it, and text and lines stay neutral.
- **Accent** (`data-accent`): Graphite or a preset, or `custom` with the color
  set inline after `fitAccent` (`src/settings/theme-customization.ts`). A
  colored accent also becomes the focus ring. The editor's current line keeps
  `--editor-active-line-surface`, which is neutral under every accent.
- **Translucency** (`data-glass`, only while the native window reports
  vibrancy behind it): the window clears its background, the gutters take
  `--surface-shell`, the titlebar the same under its veil, and Project,
  Papers and the editors `--surface-navigator` over macOS's under-window
  material, as Synara's own window does. That sheet is their tab strip; the
  selected tab and the body share a second coat over it
  (`--surface-navigator-lift`, or `--surface-editor-glass` for an editor,
  thinner under Strong), so the tab still runs into its body a step above the
  strip. PDFs, the agent, tool panels, menus and dialogs stay opaque. Reduce transparency, a browser tab and every
  other platform keep the opaque palette, which is also what Off gives.

Presets live in `src/styles/theme.css` as attribute blocks that apply to any
element, so a Settings swatch carrying `data-tint` or `data-accent` shows the
real color in the current light or dark.

## Private interface fonts

The Timeless type family (Timeless Free Font License 1.2; get the fonts and
the license from [timeless.co](https://timeless.co)) is embedded by release
builds and by local builds that have the fonts. The license allows embedding
the fonts in an application, as long as they reach people only as part of it
and always with a copy of the license, but forbids putting them on a public
repository or redistributing them on their own. So this repository holds no
font file, subset, conversion or copy of the license, and
`src/platform/font-license-guard.test.ts` fails if one is ever tracked. Keep
the download, with its `LICENSE.pdf` beside the fonts, outside the checkout.

- `LATTICE_PRIVATE_FONTS_DIR` names the download's folder (the one holding
  `LICENSE.pdf`, `Sans-Grotesk/` and `Serif-Text/`); unset, it defaults to
  `~/Downloads/Timeless-Type-Family-1.094`. An empty value builds without it.
  `vite build`, `pnpm tauri dev`/`build` and the mock-backend page all read it
  through `scripts/private-fonts.ts`, which logs whether it embedded the fonts.
- With every face and the license present, the build emits the original
  WOFF2 files of the faces it uses, unmodified, as hashed assets of the web
  bundle (which Tauri compiles into the app binary) and puts them first in the
  font roles. Otherwise nothing changes: CI, forks and other contributors get
  Inter, Instrument Serif and the same layout.
- Releases: the fonts and their license live in the private repository
  `leo1oel/lattice-fonts`. Only the tag-triggered job in
  `.github/workflows/release.yml` reads it, with the read-only deploy key in
  the `LATTICE_FONTS_DEPLOY_KEY` secret, into the runner's temp directory
  outside the workspace. It sets `LATTICE_PRIVATE_FONTS_REQUIRED=1`, so a
  missing or incomplete copy fails the release instead of quietly shipping
  Inter; without the secret (a fork) the release builds without them.
  `scripts/check-font-leaks.mjs` then checks the built app before it is
  packaged (no file named for Timeless or a byte copy of one of its fonts, and
  no font outside the bundled open-licensed runtimes) and, before the draft
  release is published, its assets (only the signed artifacts, none of them a
  font). It recognizes fonts by signature as well as extension, so a renamed
  copy fails too.
- The license travels with the app: the build emits the unmodified
  `LICENSE.pdf` as a hashed asset beside the fonts, and Settings › About ›
  Acknowledgements credits timeless.co and opens it in the app's PDF viewer.
  A build without the fonts leaves that row out; the page itself, which credits
  the open-source software Lattice ships, is in every build. The Timeless name credits the
  fonts only; it names no Lattice feature.
- Roles: `--ui-font` is Timeless Sans in its Grotesk style (the variable
  font's default; at 10–13px it kept confusable pairs such as e/o, rn/m and
  3/8 slightly further apart than the Sans style). `--reading-font`, for the
  visual Markdown surface and a paper's title, is Timeless Serif Text, the cut
  drawn for body sizes. `--display-font` (the welcome title) is Timeless
  Serif. Source editors, code, logs and every monospace surface stay on
  `--editor-font`.
- Metrics: Timeless is about 3.5% narrower than Inter with a smaller
  x-height. `size-adjust` scales the sans by 104% (matching Inter's widths
  over every English UI string within 1%) and the serif by 105% (matching
  Inter's x-height); ascent and descent overrides keep Inter's line metrics.
  Truncation, wrapping and baselines therefore match the Inter build, and
  Chinese, set in PingFang SC in both builds, keeps the same relative size
  beside Latin text. Both families have tabular figures, so
  `font-variant-numeric: tabular-nums` behaves the same.
- Timeless covers Latin only; Greek and Cyrillic fall through to Inter.
- The Agent panel and the Synara settings pane are iframes served by the
  Synara sidecar, so Lattice's font roles and `@font-face` rules do not reach
  them; they keep Synara's own interface font.

## Token layers

Three layers, one direction of dependency. A layer may read the one above it and
never the one below.

| Layer | Lives in | Holds | Example |
| --- | --- | --- | --- |
| Palette | `src/styles/theme.css` `:root` and `[data-theme="dark"]` | the only raw colors in the product | `--line: rgba(28, 28, 31, 0.09)` |
| Semantic roles | `src/styles/foundations.css` | what a value means, per theme | `--border-subtle: var(--line)` |
| Component contracts | `foundations.css`, grouped per family | the geometry and states one family shares | `--navigation-action-size`, `--tab-selected-surface` |

Rules that follow from this:

- Feature CSS consumes semantic roles or component contracts. It does not read
  the palette. `var(--line)`, `var(--muted)`, `var(--accent)`, and their siblings
  are palette names and are treated as legacy in feature code.
- A raw value belongs in feature CSS only when it is genuinely one-off geometry.
  A second use of the same number is a missing token.
- A new color goes into the palette for both themes first, then gets a semantic
  name. A component never receives a fixed hex value.
- Status surfaces derive their borders and washes from their own `color` with the
  `--tone-*` roles instead of repeating one `color-mix` per severity.

## Focus

Keyboard focus is one ring for the whole product. Its selector lives in
`src/styles/app-shell.css`; `--focus-ring`, `--focus-ring-width`, and
`--focus-ring-offset` live in `src/styles/foundations.css`.
Components do not add a second ring. The native `:focus` halo stays suppressed,
and text entry is deliberately excluded from the ring because a field already
answers with the border treatment in its `--field-control-*` contract.

## Interactive states

| State | Selector | Meaning |
| --- | --- | --- |
| hover | `:hover:not(:disabled)` | pointer is over the control |
| pressed | `:active:not(:disabled)` | pointer is held down |
| focus | `:focus-visible` | keyboard focus |
| open | `[data-state="open"]` | this control owns an open menu, popover, or select |
| active | `.active` | the view this control leads to is the current one |
| selected | `[aria-selected="true"]`, `.selected` | one of several rows the user picked |
| checked | `[aria-checked="true"]`, `:checked`, `[data-state="checked"]` | a toggle is on |
| disabled | `:disabled`, `[data-disabled]` | not operable |

Surface strength runs in one direction so two states never read the same:
hover < pressed, and hover < selected < active.

## Embed and third-party boundaries

| Surface | Owned by | Host may | Host must not |
| --- | --- | --- | --- |
| Synara runtime (Agent, providers, MCP, skills) | Synara, isolated in an iframe | set frame size, loading and failure surfaces, theme and settings context over the bridge | reach into the embedded document with CSS or DOM selectors |
| Pierre file tree | Pierre component | map every visual through the `--trees-*-override` tokens in `src/styles/app-shell.css` | restyle Pierre internals by class name |
| Radix primitives (menu, select, popover) | Radix behavior, Lattice appearance | style through `menu-surface.ts` and `data-slot` hooks | fork the primitive to change appearance, or import Radix outside `src/components/ui` (lint-enforced; add a wrapper there instead) |
| Tailwind / shadcn utilities | `src/index.css` `@theme inline` | map utilities onto the palette | enable preflight or introduce a parallel color scale |
| CodeMirror, PDF.js, KaTeX | the library | theme through the documented extension points and `cm-*` / `pdf-*` classes it exposes | assume internal DOM structure beyond those hooks |
| Motion (`motion/react`) | the library | take the spring tiers from `motion-values.ts`, the same ones CSS runs from `foundations.css`, with the global reduced-motion clamp in `adaptive-feedback.css` | animate a property the reduced-motion path cannot disable, or pass a transition that is not a tier |

The bridge, not CSS, carries state across the Synara boundary: theme, settings
section, frame height, confirmations, and notifications. Light or dark rides in
the frame URL; the tint, accent and resolved colors go to the agent frame as a
`lattice:host-theme` message (`src/agent/agent-host-theme.ts`), on its
`synara:embed-ready`, on every change and on `lattice:request-host-theme`, so
a new accent repaints the agent without reloading it. Until the pinned runtime
reads that message, the panel keeps its own copy of the Graphite palette.

## Typography roles

Six roles, each a size with its own leading. Take both: a size on another
role's leading (or on `normal`) is a missing role, not a choice.

| Role | Chrome | Settings | Weight | Typical use |
| --- | --- | --- | --- | --- |
| Display | 24 / 30 | 26 / 32 | 600 | the one title on a page that has only one: the welcome screen, a paper's title, the error page |
| Title | 18 / 22 | 20 / 24 | 600 | dialog, sheet and Settings page titles; the guided tour's card |
| Subtitle | 13 / 18 | 14 / 20 | 600 | panel, drawer and group headings; the project switcher |
| Body | 13 / 20 | 14 / 22 | 400 | menus, popovers, copy, the Agent's messages and composer |
| Caption | 11 / 16 | 12 / 18 | 400 | metadata, paths, descriptions, helper text |
| Micro | 10 / 14 | 11 / 16 | 500 | badges, counters, compact status; one line only |

- **Body has a compact step**, `--type-body-compact-*` (12/16, 500; 13/18 in
  Settings): the text inside a control, whether a button, field, select, tab,
  toast title or compact list row. Fluid Functionalism sets a control's text at
  the body role one step down for the control's density, which is the step the
  chrome runs at. A compact (28px) control drops to caption.
- **Typeset** (`--type-typeset-*`, 14/22; 15/24 in Settings) is prose: the
  visual Markdown surface, the source editor's default size and the update
  notes. It is reading, not interface.
- **Thin aliases** name a surface's own contract and resolve to a role:
  `--type-tree-*` (caption: Papers metadata, Agent thread titles),
  `--type-project-tree-*` (body on the compact leading: project filenames),
  `--type-diff-meta-*` (micro) and `--type-diff-code-*` (caption size on an
  18px leading, for code).
- **Settings runs one step up.** `.settings-modal` (and a select portalled out
  of it) redeclares every role and alias, so the same CSS reads larger there.
- **The Synara iframe mirrors four of these.** The pinned runtime sets its own
  title, subtitle, body-compact and caption, at both steps, and the 30px
  Settings control height (`apps/web/src/embedMode.ts`), so the Agent panel and
  the Providers, MCP and Skills pages line up with the native ones. Those values
  move only together with a Synara pin.
- In a Tailwind class list, name the role's two values,
  `text-[length:var(--type-caption-size)] leading-[var(--type-caption-line-height)]`,
  never Tailwind's own `text-xs`/`text-sm` scale. A `text-<name>` theme key
  reads as a colour to `cn()`'s tailwind-merge, which drops it beside one.

The fourteen roles this replaced map as: Micro and Nano (9px) to micro;
Caption and Compact navigation to caption; Label to body-compact; Body to body;
Reading to typeset; Compact title (13/16) and Title (14/18) to subtitle; Large
title (16/20) and Heading to title; Display to display; Project tree, Diff code
and Diff metadata to the aliases above.

Compact interface copy — titles, setting descriptions, dialog subtitles, tour cards, empty states, and helper text — does not end in a full stop.
Punctuation inside multi-sentence copy remains.
A description, subtitle, or explainer paragraph appears only when it says something the label or control does not. A settings group gets a heading only when it holds several rows.

## Geometry

- Spacing follows the 2px scale defined by `--space-*`. Distances inside a
  control that the grid cannot express are named roles rather than literals:
  `--gap-hairline`, `--gap-tight`, `--gap-inline-tight`, `--gap-inline`,
  `--pad-inline-control`, `--pad-inline-control-tight`.
- A surface nested flush inside another does not choose its own radius. The
  container declares `--surface-radius` and `--surface-inset`, and the child uses
  `border-radius: var(--nested-radius)`, which resolves to
  `outer - inset` so the two curves stay parallel. This covers segmented tabs,
  menu items, and dialog list rows. Cards with generous padding are not nesting
  in this sense and keep an independent radius.
- A control may be painted smaller than `--hit-area-min` (24px), but its pointer
  target may not be. Add `data-hit-area` and it gets a centered, invisible
  target of at least that size with no change to any visible dimension. Steppers
  are exempt where the adjacent text field is an equivalent control.
- **Controls stand on a two-step ladder.** Every control a pointer lands on
  is compact (`--control-height-compact`, 28px) or default
  (`--control-height-default`, 30px), so a button next to a select next to a
  tab lands on one height:

  | Step | Height | Text | Icons | Where |
  | --- | --- | --- | --- | --- |
  | compact | 28px | caption | 13px | dense chrome: panel headers, toolbars, filters, the titlebar, popover forms |
  | default | 30px | body-compact | 16px | forms, dialogs, Settings |

  Buttons (`Button` `size`), fields (`Input` `controlSize`), selects
  (`SelectTrigger` `size`), `SearchField` and `SegmentedControl` take
  `compact` or `default` and nothing else. Square icon controls use the same
  two heights (`--control-size-icon`, `--control-size-icon-large`), and toolbar
  buttons are 24px wide on the compact height. The 24px
  `--control-size-icon-compact` is an action inside a row or a field (a
  toast's dismiss, a search's clear), and counts as part of that row.
  The default is 30px rather than Fluid Functionalism's 36px: it is the height
  the chrome was drawn around, and the embedded Synara Settings pages pin their
  controls to it. Width remains layout-owned.
- Text buttons use an 8px control radius.
- Switches use a 28 × 16px track and a 12px thumb.
- Checkboxes use a 14px native input surface with shared checked, mixed, focus,
  and disabled states.
- Badges use a 20px height and 6px radius; compact badges use a 16px height.
- Rows use 32px compact, 40px data, or 44px store height.
- Radius roles are 4px compact, 6px icon/item, 7px chrome, 8px control,
  9px panel, 10px surface, 14px dialog, and pill.
- The titlebar is 40px and hosts the traffic lights, the project switcher and
  the panel controls; the sidebar navigation header matches that height.
- Every panel's tab strip is 34px (`--tab-strip-height`) and its tabs stand on
  the compact control height. A tab's trailing slot (its close button or
  unsaved dot) is one width whatever it holds, so hovering, saving or
  selecting never resizes a tab; squeezed below its natural width, an
  unselected tab's empty slot gives its room to the title first. The selected
  tab stays in view whenever the strip has to scroll.

## Elevation

One ladder for every surface that sits above another, in light and dark. The
shadows live in the palette (`--shadow-*` in `theme.css`, one stack per level,
deeper in dark where a faint shadow disappears into the ground); feature code
takes a level from `foundations.css`.

| Level | Token | Surface | Edge and shadow | Who stands there |
| --- | --- | --- | --- | --- |
| Page | — | `--surface-app`, the window | none | the window, the welcome page |
| Panel | `--elevation-panel` | `--surface-panel` | half a hairline | docked Trellis panels |
| Raised | `--elevation-raised` | `--surface-elevated` | ring and a contact shadow | a plate lifted inside a surface: the chosen segment, zoom controls over a figure, a resize handle |
| Popover | `--elevation-popover` | `--surface-elevated` | ring and shadow | menus, selects, popovers, tooltips, hover cards, the editor's tooltips and selection toolbar, the PDF preview's loading status and notices |
| Floating | `--elevation-floating` | `--surface-elevated` | ring and a deeper shadow | floating panels, drawers, toasts, the update banner, the build's diagnostics card, a dragged item |
| Dialog | `--elevation-dialog` | `--surface-elevated` | ring and the deepest shadow | modal dialogs, Settings, the guided tour's card |

- The ring (`--elevation-ring`) is the edge; a floating surface does not add a
  border on top of it.
- A level's shadow does not change with nesting, so a popover inside a dialog
  still reads as a popover.
- A surface that colours its edge composes the same two parts:
  `box-shadow: 0 0 0 1px <edge>, var(--elevation-floating-shadow)`. Toasts
  colour theirs by severity; a Trellis panel held mid-drag takes the strong
  border over the dialog shadow.
- `surfaces.css` assigns the shared surfaces their level; Radix menus,
  selects and popovers take theirs through `menu-surface.ts`.
- Radii nest by the rule under Geometry: a level's surface declares
  `--surface-radius` and `--surface-inset`, and what sits flush inside takes
  `--nested-radius`.
- A compiled PDF page keeps `--pdf-page-shadow`: paper on a desk, not
  interface.

## Component boundaries

Dependencies flow in one direction:

1. Foundations: type, color, spacing, radius, size, and motion tokens.
2. Primitives: buttons, menus, selects, switches, and scroll areas.
3. Patterns: panel headers, settings sections, empty states, and dialog actions.
4. Features: Agent, Papers, Git, Overleaf, and other product behavior.

A feature may consume a shared primitive or pattern. A primitive must not know
about a feature, and one feature must not borrow another feature's class name.
For example, a general empty state must not be styled through `git-empty`.

Synara owns the Agent, source-control, provider, MCP, and skill surfaces.
Lattice only owns the surrounding host chrome and the context bridge between
the research workspace and those embedded surfaces.

### Shared component contracts

| Need | Use | Feature code owns |
| --- | --- | --- |
| Text action | `Button` or `buttonClassName` with `MotionButton` | label, callback, semantic variant |
| Icon-only action | `IconButton` | icon, label, callback, disabled state |
| Inline metadata or status | `Badge` | copy and semantic tone |
| Binary setting | `Switch`; use `SwitchField` when it has settings copy | state, callback, label |
| Immediate form choice | `Checkbox`; use `CheckboxField` for ordinary labelled choices | state, callback, label, optional description |
| Single-line form value | `Input` | type, value, callbacks, semantic control size, invalid state |
| Search or filter value | `SearchField` | query, callbacks, default or compact size, optional trailing result controls |
| Multi-line form value | `Textarea` | value, callbacks, UI or monospace font, invalid state |
| Form selection | `Select` with `SelectTrigger` | options, value, callback, semantic control size |
| Compact mutually exclusive views | `SegmentedControl` | item labels, selected value, callback |
| Section-level views | `SlidingTabs` | item labels, selected value, callback |
| Repeated list row | `rowClassName` | semantic element, contents, selection behavior |
| Panel or drawer title bar | `PanelHeader` | title, leading icon, feature actions |
| Panel close action | `PanelHeader onClose` or `CloseButton` | callback and specific label |
| Settings page heading | `SettingsSectionHeader` | title, description, optional actions |
| No-content message | `EmptyState` | copy, optional icon and actions, density |
| Menu-like floating surface | primitives using `menu-surface.ts` | Radix semantics and feature content |
| Ordinary scrolling | `ScrollArea` | orientation and exceptional layout classes |
| Keyboard shortcut hint | `Keycaps`, or `renderKeycaps` in a long list (one cap per key) | the keys, from the binding through `key-combos.ts` rather than typed out |
| Keyboard-driven list (quick open, pickers, the command palette) | `PickerDialog` / `SearchPickerDialog`, ranked by `picker-ranking.ts` | items, their icon, detail and shortcut, and what choosing one does |

`PanelHeader` deliberately does not own outer height, padding, or borders.
Those may differ between a drawer, modal, and embedded panel. It does own title
typography, title/action alignment, action spacing, and the close control.

`rowClassName` deliberately returns classes instead of rendering an element.
Rows are buttons, list items, or composite containers depending on the feature;
the primitive standardizes density without changing those semantics.

## Interaction patterns

- A reversible action happens at once and its toast offers the way back
  (Undo, Resume) instead of a confirmation in front of it. Confirm only what
  cannot be undone. A toast's action dismisses the toast unless it sets
  `keepOpen`.
- Panel and drawer headers use an icon-only X close control with an accessible
  label through `PanelHeader` or `CloseButton`. Dialog footer actions may still
  say Cancel or Close when that wording communicates an operation.
- Dropdown menus, context menus, selects, and popovers keep their distinct
  accessibility semantics while consuming the shared surface and item contracts
  from `menu-surface.ts`.
- Shared tab strips expose real tab semantics, keep only the selected tab in
  the keyboard order, and support Arrow Left/Right plus Home/End navigation.
- Use a checkbox for an immediate local form choice and a switch for a
  persistent setting that takes effect independently. CodeMirror controls,
  embedded content, and vendored Agent Elements may retain their native
  implementation when integration requires it.
- There is no generic labelled-field wrapper. `SwitchField` and `CheckboxField`
  cover those two controls; ordinary text controls are labelled by the feature
  that owns them. Pass the invalid state to `Input` or `Textarea` so visual state
  and `aria-invalid` stay aligned. Use `SearchField` for search and filtering; its
  trailing slot keeps result navigation or clear actions inside the same visual
  contract. Range controls, color pickers, and editor inputs remain feature-owned
  when their interaction model is specialized.
- Ordinary scrollable surfaces use `ScrollArea`, which applies the appropriate
  edge fade for its orientation by default and only reveals its scrollbar while
  hovering or scrolling. Set `fadeEdges={false}` only when masking would damage
  a specialized surface. CodeMirror, textareas, and embedded document surfaces
  may retain specialized scrolling when behavior or performance requires it.
  A container whose exact native viewport is observed by feature code uses
  `native-hover-scrollbar`; this is an explicit compatibility path, not a second
  general scrollbar implementation.
  When an embedded engine owns the scroller and its layout depends on the
  viewport's own width — the PDF viewer, whose fitted page is scaled to
  `clientWidth` — `OverlayScrollbars` draws the same bars outside that width and
  reveals them on the bar rather than on the whole surface, matching the
  editor's.
- The command palette (⌘K, and ⌘⇧P) is the one place every app command can be
  reached by name, on the welcome screen as well as in a project; a typed query
  also finds the project's files, its Papers and every Settings row. A new
  app-level action gets an entry in App's command table, which drives both the
  palette, the global shortcuts and the shortcut sheet, with a section
  (`palette-sections.ts`) and either a `key` or, for a key bound elsewhere, a
  display-only `shortcut`. Keyboard pickers keep the
  highlighted row in view as the arrows (and ⌃N / ⌃P) move it, and only a
  pointer that really moved takes the highlight back.
- Embedded Settings routes delegate scrolling to the Lattice `ScrollArea`; the
  embedded document must not expose a second viewport scrollbar.

## Dialogs, notifications and empty states

- **A small dialog has one anatomy** (`.modal` in `dialogs.css`): an optional
  36px mark (`.modal-icon`, the accent, or `data-tone="danger"` /
  `"warning"` for what the dialog asks), the title role, one line of copy in
  the body role, fields labelled in the caption role at medium weight and
  standing 12px apart, and the action row 24px below. It closes on Escape, a
  backdrop click and its Cancel; it draws no X. A tool too large for that
  shape is a `SheetDialog`, whose title row is a `PanelHeader`.
- **Destructive answers.** The confirmation that destroys leads its row as the
  tinted `danger` Button (`--status-danger-soft`, deeper on hover), never a red
  slab; a destructive alternative beside a safe default ("Don't save" beside
  Save) stays a quiet ghost in the danger colour. Cancel takes focus.
- **Toasts and the update banner** are one floating card: 320px,
  `--radius-surface`, a title in the body-compact role, detail in the caption
  role, actions as compact Buttons and a compact `CloseButton`. Only the
  edge's tint changes with severity.
- **Asked for by name, always answered.** An action the writer invoked must
  show a result even when there is nothing to do: Install LaTeX tools opens the
  wizard when something is missing and otherwise says LaTeX is ready.
- **Build feedback stays in place.** The Build button carries the running and
  finished state; the diagnostics card holds the messages and the raw log. A
  failed build's log opens at TeX's first error (else the end, where latexmk
  says why it stopped), and Copy log takes all of it.
- **Empty states offer the way forward.** An empty region says what would be
  there and offers the next step, with its shortcut drawn by `Keycaps`. The
  welcome screen lists a few recent projects under its actions and, when launch
  could not reopen the last one, names it with an inline warning instead of
  silently landing there.

## Motion

One motion system: Fluid Functionalism's three spring tiers, the same in CSS
and in `motion/react`. The bigger the thing that moves, the slower the tier.

| Tier | Enter | Exit | Use |
| --- | --- | --- | --- |
| fast | 80ms spring, no bounce | 60ms tween | hover, focus, fades, tooltips, selection marks |
| moderate | 160ms spring, no bounce | 120ms tween | travel and small expansion: menus, selects, popovers, tab indicators, switches, rows |
| slow | 240ms spring, bounce 0.12 | 160ms tween | large surfaces: dialogs, drawers, split panes, the guided tour, a theme switch |

- **CSS takes a tier whole:** `transition: opacity var(--motion-fast)`,
  `animation: x var(--motion-slow) both`. Each `--motion-*` token pairs a
  duration with its spring sampled into `linear()` from motion's own solver,
  so CSS and JS land the same way, and a curve never meets another tier's
  duration. WebKit before Safari 17.2 gets the nearest cubic curves. The bare
  `--duration-*` values are for longhands and arithmetic: a
  `transition-duration` override, a staggered delay.
- **Exits are one tier quicker** and are plain tweens, so a dismissal reads as
  final rather than replaying the entrance backwards: `--motion-*-exit` in
  CSS, `springExit` in JS. A CSS hover leaves on the same tier it entered on;
  an element that leaves the screen takes the exit.
- **JS takes the same tiers:** `spring.fast|moderate|slow` and `springExit`
  from `components/ui/motion-values.ts`. Motion run outside motion/react (an
  `element.animate()` call, a library's own transition) takes
  `animationTiming(tier)`. The one physics spring is `MAGNET_SPRING`, which
  follows the pointer rather than making a timed change.
- **Two moments sit off the tiers:** `--motion-draw` (560ms, a stroke drawing
  itself or an icon turning once) and `--motion-flourish` (720ms, a ripple or
  burst). Ambient loops time themselves.
- `tokens.test.ts` fails on a raw time or curve in a transition, a bare
  duration where a tier belongs, and a sampled curve that no longer matches
  its spring.

## Keyboard shortcuts and focus mode

- A key combination is drawn by `key-combos.ts` everywhere it appears: Mac
  glyphs, ⌘ first (⌘⇧J, ⌘⌥P), a Shift-typed character as itself (⌘?). In a
  list, a hint or a palette row it is `Keycaps` (`src/components/ui/keycaps.tsx`,
  or `renderKeycaps` where a list draws many), a quiet cap per key; inline in
  a menu it stays text.
- Shortcuts are never typed out by hand next to a command. The palette draws
  a command's keys from the command table, a tooltip takes them as `Tip`'s
  `shortcut` (quiet text after the label, outside the accessible name), and
  the shortcut sheet (⌘?, or Keyboard shortcuts in the palette) lists every
  key from the keymaps that bind them, grouped by where they work, so a moved
  key moves everywhere.
- Focus mode (⌘⇧D, the Panels menu or the palette) is a layout state, not a
  second theme: the open documents fill the window in one panel without
  their tab bar, the PDF beside them if the writer last asked for it, and the
  titlebar keeps only the window's controls, the document's name and the
  focus bar on the shell's ground. The source keeps a reading measure
  (`--focus-mode-measure`). Escape leaves it as the key's last meaning (never
  in Vim, never past an open dialog, menu or completion list), and leaving
  brings back the layout it was entered from exactly, a preset included.

## Identity and motion moments

The app icon's woven lattice is Lattice's mark, and a small set of touches
reuse its vocabulary so the product reads as one thing:

- `LatticeMark` (`src/components/ui/lattice-mark.tsx`) draws the icon live from
  its own geometry. Its two threads have their own roles, `--mark-weft` (blue)
  and `--mark-warp` (teal), plus `--mark-glint`. They are identity, not
  interaction: they color the mark and the one accent stroke of an
  illustration, never a control, whatever accent the writer chose.
- `EmptyIllustration` (`src/components/ui/empty-illustration.tsx`) holds the
  empty-state drawings: neutral line work in the host's text color with one
  weft or warp thread. Pass one to `EmptyState`'s `icon`.
- The welcome screen's lattice field (`src/project/welcome-lattice.tsx`)
  repeats the mark as a faint backdrop.

Motion follows three rules:

- **Moments, not loops.** Motion marks a state change (a build ending, the
  Overleaf channel coming up, a dialog arriving) or something appearing (an
  empty state, a skeleton). It plays once. The only ambient loops are the
  welcome screen, which is never on screen while writing, loading
  placeholders such as the PDF skeleton, which last only until content arrives,
  and the comments empty state's typing dots, which run only while hovered.
- **Never in the writing surface.** Nothing animates in the editor, and nothing
  near it repeats while the writer works. A flourish that a remount could
  replay is guarded, as the Build button's `isFreshOutcome` is.
- **Paint-cheap and layout-free.** Animate `transform`, `opacity`, and
  `stroke-dashoffset`; never geometry. Times come from the tiers under Motion
  (`--motion-draw` for a line drawing itself, `--motion-flourish` for a
  one-time ripple or burst). Ambient loops longer than the scale may use
  literal times.

Reduced motion is owned by `src/styles/adaptive-feedback.css`. Its universal
clamp finishes every one-shot animation at once, so a moment's resting style
must be its finished frame. The clamp shortens durations, not delays, so a
staggered moment needs an `animation-delay: 0s` entry there, as the Build
button's warning pip has. An ambient loop also needs an `animation: none`
entry there, and its resting style must be invisible or still.

## Migration rule

Migrate one component family at a time and preserve the rendered result before
making aesthetic changes. Once a role is migrated, new raw values for the same
role should be treated as a regression.

Production call sites no longer use the legacy `primary-button`,
`secondary-button`, or `text-button` classes. New code uses `Button`; existing
`MotionButton` call sites use `buttonClassName` so motion and visual semantics
remain independent. Dense toolbars and inline thread actions may keep
feature-owned button geometry when they are not ordinary text actions.
