// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Editor state. Port of Excalidraw `packages/excalidraw/appState.ts` and the
//! `AppState` type in `packages/excalidraw/types.ts` @ 3a317b5, cut down to
//! what the board edits with. Element references upstream holds as objects
//! (`editingTextElement`, `frameToHighlight`, `selectedLinearElement`) are
//! ids here; the app looks them up in the scene.
//!
//! Left out, with the reason:
//! - `theme`: the app's `Theme`;
//! - collaboration (`collaborators`, `userToFollow`), dialogs and menus
//!   (`openDialog`, `openMenu`, `openPopup`, `openSidebar`, `contextMenu`,
//!   `defaultSidebarDockedPreference`, `showHyperlinkPopup`), `toast`,
//!   `errorMessage`, `isLoading`, `showWelcomeScreen`, `showHints`, stats,
//!   the export dialog (`exportBackground`, `exportScale`, `exportEmbedScene`,
//!   `exportWithDarkMode`, `fileHandle`), library, search (`searchMatches`),
//!   `colorTopPicks` / `fontTopPicks`, `zenModeEnabled`, `viewModeEnabled`,
//!   `minimapEnabled`: GPUI chrome, not board state;
//! - pen handling (`penMode`, `penDetected`, `lastPointerDownWith`,
//!   `inputDevice`), `cursorButton`, `scrolledOutside`, `offsetTop` /
//!   `offsetLeft` / `width` / `height` (the viewport size is passed to
//!   `viewport.rs`), `scrollConstraints` (a host API we don't expose):
//!   window and input plumbing the app owns;
//! - in-gesture transients (`newElement`, `multiElement`, `resizingElement`,
//!   `selectionElement`, `selectedElementsAreBeingDragged`, `isResizing`,
//!   `isRotating`, `suggestedBinding`, `textToolHover`, `snapLines`,
//!   `originSnapOffset`, `hoveredElementIds`, `elementsToHighlight`,
//!   `activeEmbeddable`, `currentHoveredFontFamily`,
//!   `shouldCacheIgnoreZoom`): they live with the tool state machines;
//! - `bindingPreference`, `isMidpointSnappingEnabled`, `boxSelectionMode`:
//!   settings we don't offer yet; their defaults are what the tools assume.

use super::consts::*;
use super::types::{Arrowhead, BindMode, FillStyle, StrokeStyle, StrokeVariability, TextAlign};
use std::collections::{BTreeMap, BTreeSet};

macro_rules! str_enum {
    ($(#[$m:meta])* $name:ident { $($v:ident = $s:literal),* $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($v),* }
        impl $name {
            pub fn as_str(self) -> &'static str { match self { $($name::$v => $s),* } }
            pub fn parse(s: &str) -> Option<$name> { match s { $($s => Some($name::$v),)* _ => None } }
        }
    };
}

str_enum!(
    /// `ToolType`. Custom tools (`type: "custom"`) are not supported.
    ToolType {
        Selection = "selection", Lasso = "lasso", Rectangle = "rectangle", Diamond = "diamond", Ellipse = "ellipse",
        Arrow = "arrow", Line = "line", FreeDraw = "freedraw", Text = "text", Image = "image", Eraser = "eraser",
        Hand = "hand", Frame = "frame", MagicFrame = "magicframe", StickyNote = "stickynote", Embeddable = "embeddable",
        Laser = "laser", Autoshape = "autoshape", BucketFill = "bucketfill",
    }
);
str_enum!(StrokeWidthKey { Thin = "thin", Medium = "medium", Bold = "bold" });
str_enum!(
    /// `StrokeRoundness`.
    StrokeRoundness { Round = "round", Sharp = "sharp" }
);
str_enum!(ArrowType { Sharp = "sharp", Round = "round", Elbow = "elbow" });

impl StrokeWidthKey {
    /// `getStrokeWidthByKey`: freedraw strokes are drawn at half width.
    pub fn stroke_width(self, freedraw: bool) -> f64 {
        let i = match self {
            StrokeWidthKey::Thin => 0,
            StrokeWidthKey::Medium => 1,
            StrokeWidthKey::Bold => 2,
        };
        if freedraw {
            FREEDRAW_STROKE_WIDTH[i]
        } else {
            STROKE_WIDTH[i]
        }
    }
}

/// `AppState["activeTool"]`.
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveTool {
    pub ty: ToolType,
    /// Tool lock: stay on the tool after drawing.
    pub locked: bool,
    /// Temporarily switched on from the selection tool.
    pub from_selection: bool,
    /// The tool to go back to when this one is deselected (eraser, hand).
    pub last_active_tool: Option<ToolType>,
}

/// `AppState["preferredSelectionTool"]`: selection or lasso.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreferredSelectionTool {
    pub ty: ToolType,
    pub initialized: bool,
}

/// `AppState["frameRendering"]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameRendering {
    pub enabled: bool,
    pub name: bool,
    pub outline: bool,
    pub clip: bool,
}

/// The part of `LinearElementEditor` the store observes: which linear
/// element is selected for point editing, and whether its editor is open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedLinearElement {
    pub element_id: String,
    pub is_editing: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppState {
    // tools
    pub active_tool: ActiveTool,
    pub preferred_selection_tool: PreferredSelectionTool,
    // defaults for new elements
    pub current_item_stroke_color: String,
    pub current_item_background_color: String,
    pub current_item_stickynote_stroke_color: String,
    pub current_item_stickynote_background_color: String,
    pub current_item_fill_style: FillStyle,
    pub current_item_stroke_width_key: StrokeWidthKey,
    pub current_item_stroke_style: StrokeStyle,
    pub current_item_roughness: f64,
    pub current_item_stroke_variability: StrokeVariability,
    pub current_item_opacity: f64,
    pub current_item_font_family: u32,
    pub current_item_font_size: f64,
    pub current_item_text_align: TextAlign,
    pub current_item_start_arrowhead: Option<Arrowhead>,
    pub current_item_end_arrowhead: Option<Arrowhead>,
    pub current_item_roundness: StrokeRoundness,
    pub current_item_arrow_type: ArrowType,
    // selection and editing
    pub selected_element_ids: BTreeSet<String>,
    pub previous_selected_element_ids: BTreeSet<String>,
    /// Top-most selected groups; a group can be listed as `false`.
    pub selected_group_ids: BTreeMap<String, bool>,
    /// The group drilled into (double-click on a group member).
    pub editing_group_id: Option<String>,
    pub selected_linear_element: Option<SelectedLinearElement>,
    /// Text element being edited (new or existing).
    pub editing_text_element: Option<String>,
    pub is_cropping: bool,
    pub cropping_element_id: Option<String>,
    /// The locked element or group whose unlock popup shows.
    pub active_locked_id: Option<String>,
    /// Temporary group ids given to units locked together.
    pub locked_multi_selections: BTreeSet<String>,
    // frames
    pub frame_rendering: FrameRendering,
    /// Frame-like whose name is being edited.
    pub editing_frame: Option<String>,
    /// Frame highlighted while dragging elements into it.
    pub frame_to_highlight: Option<String>,
    // viewport
    pub scroll_x: f64,
    pub scroll_y: f64,
    /// Normalized (`getNormalizedZoom`).
    pub zoom: f64,
    // grid and snapping
    pub grid_size: f64,
    pub grid_step: f64,
    pub grid_mode_enabled: bool,
    pub objects_snap_mode_enabled: bool,
    // binding
    pub is_binding_enabled: bool,
    /// `bindingPreference == "enabled"`: what `isBindingEnabled` returns
    /// to when ⌘ / Ctrl is released (holding it inverts it).
    pub binding_preference: bool,
    pub is_midpoint_snapping_enabled: bool,
    pub bind_mode: BindMode,
    // scene
    pub view_background_color: String,
    pub name: Option<String>,
}

impl Default for AppState {
    /// `getDefaultAppState`. `currentItemRoundness` is "round" (upstream's
    /// test environment uses "sharp").
    fn default() -> Self {
        AppState {
            active_tool: ActiveTool {
                ty: ToolType::Selection,
                locked: false,
                from_selection: false,
                last_active_tool: None,
            },
            preferred_selection_tool: PreferredSelectionTool {
                ty: ToolType::Selection,
                initialized: false,
            },
            current_item_stroke_color: DEFAULT_STROKE_COLOR.into(),
            current_item_background_color: DEFAULT_BACKGROUND_COLOR.into(),
            current_item_stickynote_stroke_color: DEFAULT_STROKE_COLOR.into(),
            current_item_stickynote_background_color: DEFAULT_STICKY_NOTE_BG.into(),
            current_item_fill_style: FillStyle::Solid,
            current_item_stroke_width_key: StrokeWidthKey::Medium,
            current_item_stroke_style: StrokeStyle::Solid,
            current_item_roughness: DEFAULT_ROUGHNESS,
            current_item_stroke_variability: StrokeVariability::Constant,
            current_item_opacity: DEFAULT_OPACITY,
            current_item_font_family: DEFAULT_FONT_FAMILY,
            current_item_font_size: DEFAULT_FONT_SIZE,
            current_item_text_align: TextAlign::Left,
            current_item_start_arrowhead: None,
            current_item_end_arrowhead: Some(Arrowhead::Arrow),
            current_item_roundness: StrokeRoundness::Round,
            current_item_arrow_type: ArrowType::Round,
            selected_element_ids: BTreeSet::new(),
            previous_selected_element_ids: BTreeSet::new(),
            selected_group_ids: BTreeMap::new(),
            editing_group_id: None,
            selected_linear_element: None,
            editing_text_element: None,
            is_cropping: false,
            cropping_element_id: None,
            active_locked_id: None,
            locked_multi_selections: BTreeSet::new(),
            frame_rendering: FrameRendering {
                enabled: true,
                name: true,
                outline: true,
                clip: true,
            },
            editing_frame: None,
            frame_to_highlight: None,
            scroll_x: 0.,
            scroll_y: 0.,
            zoom: DEFAULT_ZOOM,
            grid_size: DEFAULT_GRID_SIZE,
            grid_step: DEFAULT_GRID_STEP as f64,
            grid_mode_enabled: false,
            objects_snap_mode_enabled: false,
            is_binding_enabled: true,
            binding_preference: true,
            is_midpoint_snapping_enabled: true,
            bind_mode: BindMode::Orbit,
            view_background_color: COLOR_WHITE.into(),
            name: None,
        }
    }
}

/// One row of `APP_STATE_STORAGE_CONF`, plus whether the store observes the
/// field (`ObservedAppState`: it goes into undo history).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageConf {
    /// Kept in browser storage (upstream's per-browser restore; for us: the
    /// app's own per-board editor state, if it ever keeps one).
    pub browser: bool,
    /// Saved with the file (`cleanAppStateForExport`).
    pub export: bool,
    /// Sent to the collaboration server.
    pub server: bool,
    /// Recorded by the store and restored by undo / redo.
    pub history: bool,
}

const fn conf(browser: bool, export: bool, server: bool, history: bool) -> StorageConf {
    StorageConf {
        browser,
        export,
        server,
        history,
    }
}

/// `APP_STATE_STORAGE_CONF` for the fields kept here, by upstream key.
pub const APP_STATE_STORAGE_CONF: &[(&str, StorageConf)] = &[
    ("activeTool", conf(true, false, false, false)),
    ("preferredSelectionTool", conf(true, false, false, false)),
    ("currentItemStrokeColor", conf(true, false, false, false)),
    (
        "currentItemBackgroundColor",
        conf(true, false, false, false),
    ),
    (
        "currentItemStickynoteStrokeColor",
        conf(true, false, false, false),
    ),
    (
        "currentItemStickynoteBackgroundColor",
        conf(true, false, false, false),
    ),
    ("currentItemFillStyle", conf(true, false, false, false)),
    ("currentItemStrokeWidthKey", conf(true, false, false, false)),
    ("currentItemStrokeStyle", conf(true, false, false, false)),
    ("currentItemRoughness", conf(true, false, false, false)),
    (
        "currentItemStrokeVariability",
        conf(true, false, false, false),
    ),
    ("currentItemOpacity", conf(true, false, false, false)),
    ("currentItemFontFamily", conf(true, false, false, false)),
    ("currentItemFontSize", conf(true, false, false, false)),
    ("currentItemTextAlign", conf(true, false, false, false)),
    ("currentItemStartArrowhead", conf(true, false, false, false)),
    ("currentItemEndArrowhead", conf(true, false, false, false)),
    ("currentItemRoundness", conf(true, false, false, false)),
    ("currentItemArrowType", conf(true, false, false, false)),
    ("selectedElementIds", conf(true, false, false, true)),
    (
        "previousSelectedElementIds",
        conf(true, false, false, false),
    ),
    ("selectedGroupIds", conf(true, false, false, true)),
    ("editingGroupId", conf(true, false, false, true)),
    ("selectedLinearElement", conf(true, false, false, true)),
    ("editingTextElement", conf(false, false, false, false)),
    ("isCropping", conf(false, false, false, false)),
    ("croppingElementId", conf(false, false, false, true)),
    ("activeLockedId", conf(false, false, false, true)),
    ("lockedMultiSelections", conf(true, true, true, true)),
    ("frameRendering", conf(false, false, false, false)),
    ("editingFrame", conf(false, false, false, false)),
    ("frameToHighlight", conf(false, false, false, false)),
    ("scrollX", conf(true, false, false, false)),
    ("scrollY", conf(true, false, false, false)),
    ("zoom", conf(true, false, false, false)),
    ("gridSize", conf(true, true, true, false)),
    ("gridStep", conf(true, true, true, false)),
    ("gridModeEnabled", conf(true, true, true, false)),
    ("objectsSnapModeEnabled", conf(true, false, false, false)),
    ("isBindingEnabled", conf(true, false, false, false)),
    ("bindingPreference", conf(true, false, false, false)),
    ("isMidpointSnappingEnabled", conf(true, false, false, false)),
    ("bindMode", conf(true, false, false, false)),
    ("viewBackgroundColor", conf(true, true, true, true)),
    ("name", conf(true, false, false, true)),
];

pub fn storage_conf(key: &str) -> Option<StorageConf> {
    APP_STATE_STORAGE_CONF
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, c)| *c)
}

impl AppState {
    /// `cleanAppStateForExport`, as far as our files carry it (see
    /// `restore::ExportedAppState`).
    pub fn for_export(&self) -> super::restore::ExportedAppState {
        super::restore::ExportedAppState {
            view_background_color: self.view_background_color.clone(),
            grid_size: self.grid_size,
            grid_step: self.grid_step,
            grid_mode_enabled: self.grid_mode_enabled,
        }
    }
    /// Takes over the fields a file carries.
    pub fn apply_exported(&mut self, e: &super::restore::ExportedAppState) {
        self.view_background_color = e.view_background_color.clone();
        (self.grid_size, self.grid_step, self.grid_mode_enabled) =
            (e.grid_size, e.grid_step, e.grid_mode_enabled);
    }
    /// `isEraserActive`.
    pub fn is_eraser_active(&self) -> bool {
        self.active_tool.ty == ToolType::Eraser
    }
    /// `isHandToolActive`.
    pub fn is_hand_tool_active(&self) -> bool {
        self.active_tool.ty == ToolType::Hand
    }
    /// The stroke width new elements of this kind get.
    pub fn current_item_stroke_width(&self, freedraw: bool) -> f64 {
        self.current_item_stroke_width_key.stroke_width(freedraw)
    }
}
