//! Surfaces, inks, lines, the accent, states and statuses, and the opacity steps they are mixed at.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use crate::token_types::{ColorToken, hex, rgba8};

// Colour

/// The window behind everything; welcome page
///
/// App: `--surface-window`.
pub const COLOR_WINDOW: ColorToken = ColorToken::new(hex(0xF7F7F6), hex(0x171718));
/// Ground: titlebar gutters and the Project, Papers and Agent navigation
///
/// App: `--surface-chrome`.
pub const COLOR_CHROME: ColorToken = ColorToken::new(hex(0xEFEFF0), hex(0x131315));
/// Titlebar: the shell under a white veil, closed by a hairline
///
/// App: `--surface-titlebar`.
pub const COLOR_TITLEBAR: ColorToken = ColorToken::new(hex(0xF6F6F7), hex(0x1B1B1D));
/// The sheet: docked panels and cards
///
/// App: `--surface-panel`.
pub const COLOR_PANEL: ColorToken = ColorToken::new(hex(0xFAFAFA), hex(0x1A1A1C));
/// The lift: menus, popovers, toasts, dialogs, Settings cards
///
/// App: `--surface-panel-raised`.
pub const COLOR_RAISED: ColorToken = ColorToken::new(hex(0xFFFFFF), hex(0x252528));
/// Fields, selects and search
///
/// App: `--surface-input`.
pub const COLOR_INPUT: ColorToken = ColorToken::new(hex(0xFAFAFA), hex(0x1F1F22));
/// Source editor and tool panels (Git, History, Overleaf)
///
/// App: `--editor-bg`.
pub const COLOR_EDITOR: ColorToken = ColorToken::new(hex(0xFAFAFA), hex(0x1F1F22));
/// Behind a PDF page
///
/// App: `--pdf-bg`.
pub const COLOR_PDF_GROUND: ColorToken = ColorToken::new(hex(0xEFEFF0), hex(0x29292A));
/// Primary ink
///
/// App: `--text-primary`.
pub const COLOR_TEXT: ColorToken = ColorToken::new(hex(0x242426), hex(0xE9E9E7));
/// Secondary ink; 5.5:1 on the chrome
///
/// App: `--text-secondary`.
pub const COLOR_TEXT_SECONDARY: ColorToken = ColorToken::new(hex(0x5F5F64), hex(0xA0A0A7));
/// Hairline: dividers, card edges, segmented track
///
/// App: `--border-subtle`.
pub const COLOR_LINE: ColorToken = ColorToken::new(rgba8(28, 28, 31, 0.09), rgba8(255, 255, 255, 0.075));
/// Stronger line: secondary Button edge, switch off track
///
/// App: `--border-strong`.
pub const COLOR_LINE_STRONG: ColorToken = ColorToken::new(rgba8(28, 28, 31, 0.14), rgba8(255, 255, 255, 0.12));
/// Interaction accent (Graphite = neutral); checkbox and switch on
///
/// App: `--accent`.
pub const COLOR_ACCENT: ColorToken = ColorToken::new(hex(0x303033), hex(0xE7E7E4));
/// Accent wash: menu and picker highlight, compact selected chip
///
/// App: `--accent-soft`.
pub const COLOR_ACCENT_SOFT: ColorToken = ColorToken::new(rgba8(48, 48, 51, 0.08), rgba8(255, 255, 255, 0.1));
/// Ink on a filled accent
///
/// App: `--accent-contrast`.
pub const COLOR_ACCENT_CONTRAST: ColorToken = ColorToken::new(hex(0xFFFFFF), hex(0x171718));
/// Keyboard focus ring (blue under Graphite; the accent under a preset)
///
/// App: `--focus`.
pub const COLOR_FOCUS: ColorToken = ColorToken::new(hex(0x3B5BD6), hex(0x7F97FF));
/// Control hover, 5% of the ink
///
/// App: `--control-hover-surface`.
pub const COLOR_HOVER: ColorToken = ColorToken::new(rgba8(36, 36, 38, 0.05), rgba8(233, 233, 231, 0.05));
/// Control press, 8% of the ink
///
/// App: `--control-pressed-surface`.
pub const COLOR_PRESSED: ColorToken = ColorToken::new(rgba8(36, 36, 38, 0.08), rgba8(233, 233, 231, 0.08));
/// Tinted Button rest, accent 12%
///
/// App: `--control-tinted-surface`.
pub const COLOR_TINTED: ColorToken = ColorToken::new(rgba8(48, 48, 51, 0.12), rgba8(231, 231, 228, 0.12));
/// Hover on the darker chrome, 6% of the ink
///
/// App: `--chrome-hover-surface`.
pub const COLOR_CHROME_HOVER: ColorToken = ColorToken::new(rgba8(36, 36, 38, 0.06), rgba8(233, 233, 231, 0.06));
/// Selected row, 8% of the ink, with medium weight
///
/// App: `--navigation-tree-selected-surface`.
pub const COLOR_ROW_SELECTED: ColorToken = ColorToken::new(rgba8(36, 36, 38, 0.08), rgba8(233, 233, 231, 0.08));
/// Text selection in the editor
///
/// App: `--editor-selection-surface`.
pub const COLOR_SELECTION: ColorToken = ColorToken::new(rgba8(61, 122, 242, 0.16), rgba8(61, 122, 242, 0.19));
/// Editor current line, neutral under every accent
///
/// App: `--editor-active-line-surface`.
pub const COLOR_CURRENT_LINE: ColorToken = ColorToken::new(rgba8(48, 48, 51, 0.043), rgba8(255, 255, 255, 0.05));
/// Danger status
///
/// App: `--status-danger`.
pub const COLOR_DANGER: ColorToken = ColorToken::new(hex(0xBC413E), hex(0xEE7772));
/// Success status
///
/// App: `--status-success`.
pub const COLOR_SUCCESS: ColorToken = ColorToken::new(hex(0x2C785C), hex(0x66BD99));
/// Warning status
///
/// App: `--status-warning`.
pub const COLOR_WARNING: ColorToken = ColorToken::new(hex(0x8D6400), hex(0xD7A62B));
/// Info status
///
/// App: `--status-info`.
pub const COLOR_INFO: ColorToken = ColorToken::new(hex(0x6488C5), hex(0x8FABD8));
/// Open local note
///
/// App: `--annotation`.
pub const COLOR_ANNOTATION: ColorToken = ColorToken::new(hex(0x9A5C00), hex(0xF2B65E));
/// Mark weft thread; identity only, never a control
///
/// App: `--brand-weft`.
pub const COLOR_BRAND_WEFT: ColorToken = ColorToken::new(hex(0x4E5C1D), hex(0x8A9C3E));
/// Mark warp thread; identity only, never a control
///
/// App: `--brand-warp`.
pub const COLOR_BRAND_WARP: ColorToken = ColorToken::new(hex(0x909E42), hex(0xC5CE80));
/// Tinted Button hover, accent 18%
///
/// App: `--control-tinted-hover-surface`.
pub const COLOR_TINTED_HOVER: ColorToken = ColorToken::new(rgba8(48, 48, 51, 0.18), rgba8(231, 231, 228, 0.18));
/// Tinted Button press, accent 24%
///
/// App: `--control-tinted-pressed-surface`.
pub const COLOR_TINTED_PRESSED: ColorToken = ColorToken::new(rgba8(48, 48, 51, 0.24), rgba8(231, 231, 228, 0.24));
/// Toolbar icon that is on, accent 14%
///
/// App: `--toolbar-active-surface`.
pub const COLOR_TOOLBAR_ACTIVE: ColorToken = ColorToken::new(rgba8(48, 48, 51, 0.14), rgba8(231, 231, 228, 0.14));
/// Field, select and search border at rest: ink 12% over the input surface
///
/// App: `--field-control-border-color`.
pub const COLOR_FIELD_BORDER: ColorToken = ColorToken::new(hex(0xE0E0E1), hex(0x37373A));
/// Field border on hover and focus: ink 24% over the input surface
///
/// App: `--field-control-interactive-border-color`.
pub const COLOR_FIELD_BORDER_HOVER: ColorToken = ColorToken::new(hex(0xC7C7C7), hex(0x4F4F51));
/// Checkbox border on hover
///
/// App: `--control-hover-border`.
pub const COLOR_CONTROL_HOVER_BORDER: ColorToken = ColorToken::new(rgba8(45, 45, 48, 0.519), rgba8(234, 234, 232, 0.508));
/// Border of a selected compact chip or card
///
/// App: `--control-active-border`.
pub const COLOR_CONTROL_ACTIVE_BORDER: ColorToken = ColorToken::new(rgba8(45, 45, 48, 0.409), rgba8(234, 234, 231, 0.398));
/// Disabled Button slab, every variant
///
/// App: `--control-disabled-surface`.
pub const COLOR_DISABLED_SURFACE: ColorToken = ColorToken::new(rgba8(36, 36, 38, 0.04), rgba8(233, 233, 231, 0.04));
/// Disabled Button edge, every variant
///
/// App: `--control-disabled-border`.
pub const COLOR_DISABLED_BORDER: ColorToken = ColorToken::new(rgba8(28, 28, 31, 0.072), rgba8(255, 255, 255, 0.06));
/// Disabled Button label, every variant
///
/// App: `--control-disabled-ink`.
pub const COLOR_DISABLED_INK: ColorToken = ColorToken::new(rgba8(95, 95, 100, 0.62), rgba8(160, 160, 167, 0.62));
/// Success wash: badge, notice
///
/// App: `--status-success-soft`.
pub const COLOR_SUCCESS_SOFT: ColorToken = ColorToken::new(rgba8(44, 120, 92, 0.12), rgba8(102, 189, 153, 0.12));
/// Warning wash: badge, dialog mark
///
/// App: `--status-warning-soft`.
pub const COLOR_WARNING_SOFT: ColorToken = ColorToken::new(rgba8(141, 100, 0, 0.12), rgba8(215, 166, 43, 0.12));
/// Danger Button rest and danger dialog mark, danger 12%
///
/// App: `--status-danger-soft`.
pub const COLOR_DANGER_SOFT: ColorToken = ColorToken::new(rgba8(188, 65, 62, 0.12), rgba8(238, 119, 114, 0.12));
/// Danger Button hover, danger 18%
///
/// App: `--status-danger-soft-hover`.
pub const COLOR_DANGER_SOFT_HOVER: ColorToken = ColorToken::new(rgba8(188, 65, 62, 0.18), rgba8(238, 119, 114, 0.18));
/// Danger Button press, danger 24%
///
/// App: `--status-danger-soft-pressed`.
pub const COLOR_DANGER_SOFT_PRESSED: ColorToken = ColorToken::new(rgba8(188, 65, 62, 0.24), rgba8(238, 119, 114, 0.24));
/// Text under an open local note
///
/// App: `--annotation-highlight`.
pub const COLOR_ANNOTATION_HIGHLIGHT: ColorToken = ColorToken::new(rgba8(154, 92, 0, 0.14), rgba8(242, 182, 94, 0.14));
/// Backdrop behind a modal dialog
///
/// App: `--scrim-dialog-surface`.
pub const COLOR_SCRIM: ColorToken = ColorToken::new(rgba8(10, 10, 12, 0.28), rgba8(0, 0, 0, 0.5));
/// Trellis drop slot wash; its edge is the focus colour
///
/// App: `--drop-target-surface`.
pub const COLOR_DROP_TARGET: ColorToken = ColorToken::new(rgba8(231, 234, 246, 0.816), rgba8(36, 38, 50, 0.816));
/// Selected row and typed filter in the navigator, a step under the primary ink
///
/// App: `--navigation-text-strong`.
pub const COLOR_NAV_TEXT_STRONG: ColorToken = ColorToken::new(hex(0x404042), hex(0xCBCBCA));
/// Settings control hover, ink 5% over the lift
///
/// App: `--settings-control-hover-surface`.
pub const COLOR_SETTINGS_CONTROL_HOVER: ColorToken = ColorToken::new(hex(0xF4F4F4), hex(0x2F2F32));
/// Editor gutter line numbers
///
/// App: `--lattice-code-line-number`.
pub const COLOR_LINE_NUMBER: ColorToken = ColorToken::new(hex(0x8A8A8E), hex(0x7C7C82));
/// Primary Button hover: ink 88% over the app ground
///
/// App: `color-mix(in srgb, var(--text-primary) 88%, var(--surface-app))`.
pub const COLOR_PRIMARY_HOVER: ColorToken = ColorToken::new(hex(0x3D3D3F), hex(0xD0D0CE));
/// Primary Button press: ink 82% over the app ground
///
/// App: `color-mix(in srgb, var(--text-primary) 82%, var(--surface-app))`.
pub const COLOR_PRIMARY_PRESSED: ColorToken = ColorToken::new(hex(0x4A4A4B), hex(0xC3C3C2));
/// Selected panel tab: ink 10% laid opaque on the panel
///
/// App: `color-mix(in srgb, var(--text-primary) 10%, var(--surface-panel))`.
pub const COLOR_TAB_SELECTED: ColorToken = ColorToken::new(hex(0xE5E5E5), hex(0x2F2F30));
/// Edge ring of every raised and floating surface
///
/// App: `--shadow-ring`.
pub const COLOR_RING: ColorToken = ColorToken::new(rgba8(0, 0, 0, 0.05), rgba8(255, 255, 255, 0.1));
/// A compiled PDF page; paper-coloured in both themes
///
/// App: `--pdf-page-surface`.
pub const COLOR_PDF_PAGE: ColorToken = ColorToken::same(hex(0xF9F9FA));
/// Search hit on document content, both themes
///
/// App: `--highlight-match-surface`.
pub const COLOR_MATCH: ColorToken = ColorToken::same(rgba8(255, 208, 0, 0.34));
/// Current search hit, both themes
///
/// App: `--highlight-match-current-surface`.
pub const COLOR_MATCH_CURRENT: ColorToken = ColorToken::same(rgba8(255, 142, 0, 0.48));

// Opacity

/// Control hover: ink at this strength
///
/// App: `--control-hover-surface`.
pub const OPACITY_HOVER: f32 = 0.05;
/// Hover on the darker chrome
///
/// App: `--chrome-hover-surface`.
pub const OPACITY_CHROME_HOVER: f32 = 0.06;
/// Press and selected row
///
/// App: `--control-pressed-surface`.
pub const OPACITY_PRESSED: f32 = 0.08;
/// Selected panel tab: ink at this strength laid opaque on the panel surface
pub const OPACITY_TAB_SELECTED: f32 = 0.1;
/// Tinted and danger Button rest, status washes
///
/// App: `--control-tinted-surface`.
pub const OPACITY_TINTED: f32 = 0.12;
/// Tinted and danger Button hover
///
/// App: `--control-tinted-hover-surface`.
pub const OPACITY_TINTED_HOVER: f32 = 0.18;
/// Tinted and danger Button press
///
/// App: `--control-tinted-pressed-surface`.
pub const OPACITY_TINTED_PRESSED: f32 = 0.24;
/// Icon buttons, switches and checkboxes when disabled (Buttons use the disabled slab instead)
///
/// App: `--control-disabled-opacity`.
pub const OPACITY_DISABLED: f32 = 0.42;
/// Disabled field, select and search
///
/// App: `--form-control-disabled-opacity`.
pub const OPACITY_FIELD_DISABLED: f32 = 0.45;
/// Disabled menu item
pub const OPACITY_MENU_DISABLED: f32 = 0.5;
