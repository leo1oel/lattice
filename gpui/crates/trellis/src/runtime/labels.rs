// Ported from Lattice's patch to DanFessler/trellis 0.2.0 (patches/@danfessler__trellis@0.2.0.patch: tl()
// and TRELLIS_EN), on Trellis, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial.

//! Every user-facing string, through one function a host can translate
//! ([`set_labels`]), as the patch's `globalThis.__TRELLIS_LABELS__` did.

use std::sync::RwLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Label {
    AddAsTab,
    Moved,
    ReleaseToFocus,
    ReleaseToFocusTarget(String),
    Unavailable,
    Workspace,
    PanelMenu,
    ResizePanels,
    CloseTab(String),
    GroupPanels(usize),
    DoubleClickToZoomIn,
    RestoreSize,
    Maximize,
    DockBesideStage,
    Dock,
    Float,
    NewSplitRight,
    NewSplitBelow,
    MoveTo(String),
    Hide,
    CloseView(String),
    CloseOtherTabs,
    TheStage,
    ThisGroup,
}

/// Trellis's English.
pub fn english(label: &Label) -> String {
    match label {
        Label::AddAsTab => "Add as tab".into(),
        Label::Moved => "Moved".into(),
        Label::ReleaseToFocus => "Release to focus".into(),
        Label::ReleaseToFocusTarget(title) => format!("Release to focus {title} · Esc to cancel"),
        Label::Unavailable => "Unavailable".into(),
        Label::Workspace => "Workspace".into(),
        Label::PanelMenu => "Panel menu".into(),
        Label::ResizePanels => "Resize panels".into(),
        Label::CloseTab(title) => format!("Close {title}"),
        Label::GroupPanels(count) => format!("{count} panels. Double-click to zoom in."),
        Label::DoubleClickToZoomIn => "Double-click to zoom in".into(),
        Label::RestoreSize => "Restore size".into(),
        Label::Maximize => "Maximize".into(),
        Label::DockBesideStage => "Dock beside stage".into(),
        Label::Dock => "Dock".into(),
        Label::Float => "Float".into(),
        Label::NewSplitRight => "New split right".into(),
        Label::NewSplitBelow => "New split below".into(),
        Label::MoveTo(title) => format!("Move {title} to"),
        Label::Hide => "Hide".into(),
        Label::CloseView(title) => format!("Close {title}"),
        Label::CloseOtherTabs => "Close other tabs".into(),
        Label::TheStage => "the stage".into(),
        Label::ThisGroup => "this group".into(),
    }
}

type Labels = Box<dyn Fn(&Label) -> Option<String> + Send + Sync>;

static LABELS: RwLock<Option<Labels>> = RwLock::new(None);

/// The host's translations; a label it returns `None` for stays English.
pub fn set_labels(labels: impl Fn(&Label) -> Option<String> + Send + Sync + 'static) {
    if let Ok(mut slot) = LABELS.write() {
        *slot = Some(Box::new(labels));
    }
}

pub fn label(label: Label) -> String {
    LABELS
        .read()
        .ok()
        .and_then(|slot| slot.as_ref().and_then(|own| own(&label)))
        .unwrap_or_else(|| english(&label))
}
