# Lattice design system

Lattice uses a compact desktop chrome around more comfortable writing and
reading surfaces. The design system exists to keep those contexts coordinated,
not to force every surface into one density.

## Decisions

- The interface font is Inter Variable.
- The product accent stays neutral. Status colors communicate success, warning,
  and danger; they are not substitutes for the interaction accent.
- Agent body copy, user messages, and the composer use 13px type on a 20px line
  height at regular weight.
- Long-form reading surfaces may use 14px type on a 22px line height.
- Code and diffs use one fixed editor font stack. The bundled default is
  Ioskeley Mono (OFL), with system monospace faces as fallback. Local and
  embedded code surfaces share this stack; editor font size remains
  adjustable.
- Project filenames and folders use Inter at 13/16px. Project rows use the
  compact 32px row role; selected items move from regular to medium weight.
- Papers titles use Inter at 12/16px regular weight. Author, year, venue, and
  other Papers metadata remain at 11/16px regular weight.
- Diff code uses the editor font at 11/18px. Diff paths, headers, and line
  numbers remain Inter; compact metadata uses the 10/14px role.
- Embedded Agent thread titles retain the compact Inter 11/16px navigation
  role at regular weight; Project filenames use their independent 13/16px role.
- The top toolbar and left Project, Papers, and Agent navigation form the app
  chrome. They use `#EFEFF0` in the light theme and `#141416` in the dark theme.
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
| Radix primitives (menu, select, popover) | Radix behavior, Lattice appearance | style through `menu-surface.ts` and `data-slot` hooks | fork the primitive to change appearance |
| Tailwind / shadcn utilities | `src/index.css` `@theme inline` | map utilities onto the palette | enable preflight or introduce a parallel color scale |
| CodeMirror, PDF.js, KaTeX | the library | theme through the documented extension points and `cm-*` / `pdf-*` classes it exposes | assume internal DOM structure beyond those hooks |
| Motion / Framer Motion | the library | own shared durations and easings in `foundations.css`, with the global reduced-motion clamp in `adaptive-feedback.css` | animate a property the reduced-motion path cannot disable |

The bridge, not CSS, carries state across the Synara boundary: theme, settings
section, frame height, confirmations, and notifications.

## Typography roles

| Role | Size / line height | Weight | Typical use |
| --- | --- | --- | --- |
| Micro | 10 / 14 | 500 | badges and compact status |
| Caption | 11 / 16 | 400 | metadata, paths, descriptions |
| Label | 12 / 16 | 500 | controls, menus, tool labels |
| Body | 13 / 20 | 400 | application and Agent body copy |
| Reading | 14 / 22 | 400 | papers and long-form previews |
| Compact title | 13 / 16 | 600 | panel and drawer titles |
| Title | 14 / 18 | 600 | content headings |
| Large title | 16 / 20 | 600 | dialogs and major surfaces |
| Heading | 18 / 22 | 600 | settings and top-level sections |
| Compact navigation | 11 / 16 | 400 | Papers metadata and Agent thread titles |
| Project tree | 12 / 16 | 400; selected 500 | project filenames and folders |
| Papers title | 12 / 16 | 400 | paper titles in the Papers navigation |
| Diff code | 11 / 18 | 400 | source changes and conflict previews |
| Diff metadata | 10 / 14 | 500 | line numbers and compact change statistics |

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
- Icon controls use the 24px compact, 28px default, or 30px large role.
- Search fields, inputs, and select triggers with the same semantic size must
  have the same exact height: 28px compact, 32px default, or 38px form, through
  the shared `controlSize` / `size` contract. Width remains layout-owned.
- Text buttons use 32px by default and an 8px control radius; 28px compact
  buttons are reserved for dense desktop chrome.
- Switches use a 24 × 14px track and a 10px thumb.
- Checkboxes use a 14px native input surface with shared checked, mixed, focus,
  and disabled states.
- Badges use a 20px height and 6px radius; compact badges use a 16px height.
- Rows use 32px compact, 40px data, or 44px store height.
- Radius roles are 4px compact, 6px icon/item, 7px chrome, 8px control,
  9px panel, 10px surface, 14px dialog, and pill.
- The titlebar is 40px and hosts the traffic lights, project switcher, and the
  compact tab variant; the sidebar navigation header matches that height.
- Editor tabs are 36px in the standalone strip and 28px inside the titlebar,
  through the shared `--tab-*` contract.

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
| Section-level views | `SlidingTabs`; use the underline variant when appropriate | item labels, selected value, callback |
| Repeated list row | `rowClassName` | semantic element, contents, selection behavior |
| Panel or drawer title bar | `PanelHeader` | title, leading icon, feature actions |
| Panel close action | `PanelHeader onClose` or `CloseButton` | callback and specific label |
| Settings page heading | `SettingsSectionHeader` | title, description, optional actions |
| No-content message | `EmptyState` | copy, optional icon and actions, density |
| Menu-like floating surface | primitives using `menu-surface.ts` | Radix semantics and feature content |
| Ordinary scrolling | `ScrollArea` | orientation and exceptional layout classes |

`PanelHeader` deliberately does not own outer height, padding, or borders.
Those may differ between a drawer, modal, and embedded panel. It does own title
typography, title/action alignment, action spacing, and the close control.

`rowClassName` deliberately returns classes instead of rendering an element.
Rows are buttons, list items, or composite containers depending on the feature;
the primitive standardizes density without changing those semantics.

## Interaction patterns

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
- Embedded Settings routes delegate scrolling to the Lattice `ScrollArea`; the
  embedded document must not expose a second viewport scrollbar.

## Migration rule

Migrate one component family at a time and preserve the rendered result before
making aesthetic changes. Once a role is migrated, new raw values for the same
role should be treated as a regression.

Production call sites no longer use the legacy `primary-button`,
`secondary-button`, or `text-button` classes. New code uses `Button`; existing
`MotionButton` call sites use `buttonClassName` so motion and visual semantics
remain independent. Dense toolbars and inline thread actions may keep
feature-owned button geometry when they are not ordinary text actions.
