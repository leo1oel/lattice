// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! What the board's chrome and keyboard can ask of `BoardView`: the tool
//! set (Excalidraw `TOOL_TYPE`) and every user action (Excalidraw
//! `actions/*`). The chrome only builds these and calls `BoardView::run` /
//! `set_tool`; `BoardView` turns them into core calls and history entries.

use super::align::{Axis, Position};
use super::app_state::ArrowType;
use super::types::{Arrowhead, FillStyle, StrokeStyle, TextAlign, VerticalAlign};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tool {
    Selection,
    Lasso,
    Hand,
    Rectangle,
    Diamond,
    Ellipse,
    Arrow,
    Line,
    FreeDraw,
    Text,
    Image,
    Eraser,
    Frame,
    StickyNote,
}

impl Tool {
    /// Upstream shortcuts: letter and number keys (`TOOL_TYPE` order).
    pub fn shortcut(self) -> Option<(&'static str, Option<u8>)> {
        Some(match self {
            Tool::Selection => ("v", Some(1)),
            Tool::Rectangle => ("r", Some(2)),
            Tool::Diamond => ("d", Some(3)),
            Tool::Ellipse => ("o", Some(4)),
            Tool::Arrow => ("a", Some(5)),
            Tool::Line => ("l", Some(6)),
            Tool::FreeDraw => ("p", Some(7)),
            Tool::Text => ("t", Some(8)),
            Tool::Image => ("9", Some(9)),
            Tool::Eraser => ("e", Some(0)),
            Tool::Hand => ("h", None),
            Tool::Frame => ("f", None),
            Tool::StickyNote => ("n", None),
            Tool::Lasso => return None,
        })
    }
}

/// Which arrowhead a `SetArrowhead` changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Forward,
    Backward,
    Front,
    Back,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BoardAction {
    // history
    Undo,
    Redo,
    // selection and clipboard
    SelectAll,
    Deselect,
    Delete,
    Duplicate,
    Copy,
    /// `actionCopyAsSvg` / `actionCopyAsPng`: the selection (or the board)
    /// as a picture, the scene embedded.
    CopyAsSvg,
    CopyAsPng,
    Cut,
    Paste,
    CopyStyles,
    PasteStyles,
    // arrangement
    Group,
    Ungroup,
    Layer(Layer),
    Align(Axis, Position),
    Distribute(Axis),
    FlipHorizontal,
    FlipVertical,
    ToggleLock,
    /// `actionUnlockAllElements` (the canvas menu).
    UnlockAll,
    /// `actionToggleCropEditor`: the selected image's crop mode.
    ToggleCrop,
    FrameFromSelection,
    RemoveFromFrame,
    // properties of the selection, or the defaults for new elements
    StrokeColor(String),
    BackgroundColor(String),
    /// `actionChangeViewBackgroundColor` (the main menu's canvas background).
    ViewBackgroundColor(String),
    /// `copyText`: the selection's texts (labels included) as plain text.
    CopyText,
    /// `actionSelectAllElementsInFrame`.
    SelectAllInFrame,
    /// `actionTextAutoResize`.
    TextAutoResize,
    /// `actionUnbindText`, `actionBindText`, `actionWrapTextInContainer`.
    UnbindText,
    BindText,
    WrapTextInContainer,
    FillStyle(FillStyle),
    StrokeWidth(f64),
    StrokeStyle(StrokeStyle),
    /// `actionChangeSloppiness`: roughness 0 (architect), 1 (artist), 2 (cartoonist).
    Roughness(f64),
    Opacity(f64),
    FontSize(f64),
    FontFamily(u32),
    TextAlign(TextAlign),
    VerticalAlign(VerticalAlign),
    /// Rounded (true) or sharp edges.
    Roundness(bool),
    Arrowhead(End, Option<Arrowhead>),
    ArrowType(ArrowType),
    // view
    ZoomIn,
    ZoomOut,
    ResetZoom,
    ZoomToFit,
    ZoomToSelection,
    ToggleGrid,
    ToggleSnap,
    /// `actionToggleArrowBinding`, `actionToggleMidpointSnapping`.
    ToggleArrowBinding,
    ToggleMidpointSnapping,
    ToggleToolLock,
    // other
    /// `actionClearCanvas` (the main menu's 重置画布, after its confirm dialog).
    ClearCanvas,
    InsertImage,
    ToggleLinearEditor,
    ShowHelp,
    /// \`actionToggleSearchMenu\` (⌘F).
    FindOnCanvas,
    /// The image export dialog (⇧⌘E).
    ExportImage,
}
