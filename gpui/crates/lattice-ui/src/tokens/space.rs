//! Spacing, control and row sizes, containers, breakpoints and radii.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use gpui::Rems;


// Breakpoints

/// Narrow window: secondary footer hints and two-column forms fold
///
/// App: `@media (max-width: 480px)`.
pub const BREAKPOINT_NARROW: Rems = Rems(30.0);
/// Compact window; a Papers list this wide moves its flags into a right-hand column
///
/// App: `@media (max-width: 680px)`.
pub const BREAKPOINT_COMPACT: Rems = Rems(42.5);

// Containers

/// Width of the one control on a Settings row
///
/// App: `--settings-control-width`.
pub const CONTAINER_SETTINGS_CONTROL: Rems = Rems(10.625);
/// Settings navigation column
///
/// App: `--settings-nav-width`.
pub const CONTAINER_SETTINGS_NAV: Rems = Rems(12.5);
/// Longest project name in the titlebar switcher
///
/// App: `--titlebar-project-title-max-width`.
pub const CONTAINER_TITLEBAR_TITLE: Rems = Rems(16.25);
/// Toast card width
pub const CONTAINER_TOAST: Rems = Rems(20.0);
/// Widest a menu or tooltip grows before wrapping (22rem)
///
/// App: `--menu-max-width`.
pub const CONTAINER_MENU: Rems = Rems(22.0);
/// Small dialog width
pub const CONTAINER_DIALOG: Rems = Rems(24.375);
/// Create project dialog
pub const CONTAINER_DIALOG_CREATE: Rems = Rems(27.5);
/// Confirmation with a destructive alternative
pub const CONTAINER_DIALOG_CONFIRM_WIDE: Rems = Rems(32.5);
/// Settings page column
///
/// App: `--settings-content-max-width`.
pub const CONTAINER_SETTINGS_CONTENT: Rems = Rems(45.0);
/// Sheet dialog (Add papers)
///
/// App: `--dialog-sheet-width`.
pub const CONTAINER_DIALOG_SHEET: Rems = Rems(45.0);
/// Large dialog: Settings, Open from Overleaf, Check references
///
/// App: `--dialog-large-width`.
pub const CONTAINER_DIALOG_LARGE: Rems = Rems(53.75);

// Spacing and sizes

/// Space scale step
///
/// App: `--space-1`.
pub const SPACING_1: Rems = Rems(0.125);
/// Space scale step
///
/// App: `--space-2`.
pub const SPACING_2: Rems = Rems(0.25);
/// Space scale step
///
/// App: `--space-3`.
pub const SPACING_3: Rems = Rems(0.375);
/// Space scale step
///
/// App: `--space-4`.
pub const SPACING_4: Rems = Rems(0.5);
/// Space scale step
///
/// App: `--space-5`.
pub const SPACING_5: Rems = Rems(0.625);
/// Space scale step
///
/// App: `--space-6`.
pub const SPACING_6: Rems = Rems(0.75);
/// Space scale step
///
/// App: `--space-8`.
pub const SPACING_8: Rems = Rems(1.0);
/// Space scale step
///
/// App: `--space-10`.
pub const SPACING_10: Rems = Rems(1.25);
/// Space scale step
///
/// App: `--space-12`.
pub const SPACING_12: Rems = Rems(1.5);
/// Space scale step
///
/// App: `--space-16`.
pub const SPACING_16: Rems = Rems(2.0);
/// Compact control: dense chrome, panel headers, toolbars, titlebar
///
/// App: `--control-height-compact`.
pub const SPACING_CONTROL_COMPACT: Rems = Rems(1.75);
/// Default control: forms, dialogs, Settings
///
/// App: `--control-height-default`.
pub const SPACING_CONTROL_DEFAULT: Rems = Rems(2.0);
/// Titlebar height
///
/// App: `--titlebar-height`.
pub const SPACING_TITLEBAR: Rems = Rems(2.5);
/// Every panel tab strip
///
/// App: `--tab-strip-height`.
pub const SPACING_TAB_STRIP: Rems = Rems(2.5);
/// Seam between adjacent segments in one track
///
/// App: `--gap-hairline`.
pub const SPACING_PX: Rems = Rems(0.0625);
/// Focus ring width, drawn 2px off the control (offset = same value)
///
/// App: `--focus-ring-width`.
pub const SPACING_FOCUS_RING: Rems = Rems(0.125);
/// Unsaved-changes dot cut out of a tab's file glyph
///
/// App: `--tab-dirty-dot-size`.
pub const SPACING_DIRTY_DOT: Rems = Rems(0.3125);
/// Icon in a meta row (status bar) and a disclosure chevron beside a label
pub const SPACING_ICON_SM: Rems = Rems(0.75);
/// Switch thumb
///
/// App: `--control-size-switch-thumb`.
pub const SPACING_SWITCH_THUMB: Rems = Rems(0.75);
/// Icon in the chrome: titlebar, panel tabs and headers, compact controls
///
/// App: `--search-control-icon-size`.
pub const SPACING_ICON: Rems = Rems(0.875);
/// Checkbox box
///
/// App: `--control-size-checkbox`.
pub const SPACING_CHECKBOX: Rems = Rems(0.875);
/// A panel tab's side padding; puts its icon on the panel's 20px icon gutter
///
/// App: `--tab-inset-inline`.
pub const SPACING_TAB_INSET: Rems = Rems(0.875);
/// Icon on a default control, in a dialog or a toast mark
pub const SPACING_ICON_LG: Rems = Rems(1.0);
/// Switch track height
///
/// App: `--control-height-switch`.
pub const SPACING_SWITCH_HEIGHT: Rems = Rems(1.0);
/// Compact badge height
///
/// App: `--badge-height-compact`.
pub const SPACING_BADGE_COMPACT: Rems = Rems(1.0);
/// Badge height
///
/// App: `--badge-height`.
pub const SPACING_BADGE: Rems = Rems(1.25);
/// Smallest pointer target, whatever is painted
///
/// App: `--hit-area-min`.
pub const SPACING_HIT_AREA: Rems = Rems(1.5);
/// Row or field action: toast dismiss, search clear, tab close
///
/// App: `--control-size-icon-compact`.
pub const SPACING_ICON_BUTTON_COMPACT: Rems = Rems(1.5);
/// Switch track width
///
/// App: `--control-width-switch`.
pub const SPACING_SWITCH_WIDTH: Rems = Rems(1.75);
/// Project tree row
///
/// App: `--row-height-tree`.
pub const SPACING_ROW_TREE: Rems = Rems(1.75);
/// Compact list row
///
/// App: `--row-height-compact`.
pub const SPACING_ROW_COMPACT: Rems = Rems(2.0);
/// A risky dialog's tone mark
pub const SPACING_DIALOG_MARK: Rems = Rems(2.25);
/// Data row
///
/// App: `--row-height-default`.
pub const SPACING_ROW_DEFAULT: Rems = Rems(2.5);
/// Toolbar height
///
/// App: `--toolbar-height`.
pub const SPACING_TOOLBAR: Rems = Rems(2.5);
/// Store row
///
/// App: `--row-height-comfortable`.
pub const SPACING_ROW_COMFORTABLE: Rems = Rems(2.75);
/// Minimum height of a Settings row
///
/// App: `--settings-row-min-height`.
pub const SPACING_SETTINGS_ROW: Rems = Rems(3.25);

// Radius

/// Chip, keycap, checkbox
///
/// App: `--radius-compact`.
pub const RADIUS_COMPACT: Rems = Rems(0.25);
/// Anything a pointer lands on: control, row, tab, icon button
///
/// App: `--radius-control`.
pub const RADIUS_CONTROL: Rems = Rems(0.375);
/// Surface: panel, popover, menu, toast, card
///
/// App: `--radius-panel`.
pub const RADIUS_PANEL: Rems = Rems(0.625);
/// Dialog
///
/// App: `--radius-dialog`.
pub const RADIUS_DIALOG: Rems = Rems(0.875);
/// Pill, switch, avatar
///
/// App: `--radius-pill`.
pub const RADIUS_PILL: Rems = Rems(62.4375);
/// Popover, menu, toast and card corner (same step as a panel)
///
/// App: `--radius-surface`.
pub const RADIUS_SURFACE: Rems = RADIUS_PANEL;
/// Icon button, row and tab corner (same step as a control)
///
/// App: `--radius-icon`.
pub const RADIUS_ICON: Rems = RADIUS_CONTROL;
