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
- New component styles use semantic tokens from
  `src/styles/foundations.css`. Raw values are reserved for genuinely unique
  geometry, such as an asymmetric message bubble.
- Light and dark colors come from semantic theme variables. Do not introduce a
  fixed light-theme hex value into a reusable component.

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

## Geometry

- Spacing follows the 2px scale defined by `--space-*`.
- Icon controls use the 24px compact, 28px default, or 30px large role.
- Controls use 28px compact, 32px default, or 38px form height.
- Text buttons use 32px by default and an 8px control radius; 28px compact
  buttons are reserved for dense desktop chrome.
- Switches use a 24 × 14px track and a 10px thumb.
- Checkboxes use a 14px native input surface with shared checked, mixed, focus,
  and disabled states.
- Badges use a 20px height and 6px radius; compact badges use a 16px height.
- Rows use 32px compact, 40px data, or 44px store height.
- Radius roles are 4px compact, 6px icon/item, 8px control, 10px surface,
  14px dialog, and pill.

## Component boundaries

Dependencies flow in one direction:

1. Foundations: type, color, spacing, radius, size, and motion tokens.
2. Primitives: buttons, menus, selects, switches, and scroll areas.
3. Patterns: panel headers, settings sections, empty states, and dialog actions.
4. Features: Agent, Papers, Git, Overleaf, and other product behavior.

A feature may consume a shared primitive or pattern. A primitive must not know
about a feature, and one feature must not borrow another feature's class name.
For example, a general empty state must not be styled through `git-empty`.

Agent Elements under `src/components/agent-elements` are vendored upstream
source. Keep them upgradeable and place Lattice-specific integration in the
theme bridge or the Agent adapter rather than rewriting the vendored files.

### Shared component contracts

| Need | Use | Feature code owns |
| --- | --- | --- |
| Text action | `Button` or `buttonClassName` with `MotionButton` | label, callback, semantic variant |
| Icon-only action | `IconButton` | icon, label, callback, disabled state |
| Inline metadata or status | `Badge` | copy and semantic tone |
| Binary setting | `Switch`; use `SwitchField` when it has settings copy | state, callback, label |
| Immediate form choice | `Checkbox`; use `CheckboxField` for ordinary labelled choices | state, callback, label, optional description |
| Compact mutually exclusive views | `SegmentedControl` | item labels, selected value, callback |
| Section-level views | `SlidingTabs`; use the underline variant when appropriate | item labels, selected value, callback |
| Repeated list row | `rowClassName` | semantic element, contents, selection behavior |
| Panel or drawer title bar | `PanelHeader` | title, leading icon, feature actions |
| Panel close action | `PanelHeader onClose` or `CloseButton` | callback and specific label |
| Settings page heading | `SettingsSectionHeader` | title, description, optional actions |
| Labelled form control | `Field` | control, label copy, optional hint or error |
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
- Ordinary scrollable surfaces use `ScrollArea`, which applies the appropriate
  edge fade for its orientation by default and only reveals its scrollbar while
  hovering or scrolling. Set `fadeEdges={false}` only when masking would damage
  a specialized surface. CodeMirror, textareas, and embedded document surfaces
  may retain specialized scrolling when behavior or performance requires it.
  A container whose exact native viewport is observed by feature code uses
  `native-hover-scrollbar`; this is an explicit compatibility path, not a second
  general scrollbar implementation.

## Migration rule

Migrate one component family at a time and preserve the rendered result before
making aesthetic changes. Once a role is migrated, new raw values for the same
role should be treated as a regression.

Production call sites no longer use the legacy `primary-button`,
`secondary-button`, or `text-button` classes. New code uses `Button`; existing
`MotionButton` call sites use `buttonClassName` so motion and visual semantics
remain independent. Dense toolbars and inline thread actions may keep
feature-owned button geometry when they are not ordinary text actions.
