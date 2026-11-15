//! A Project tree row being dragged: what it carries, and how it looks under
//! the pointer.

use gpui::{
    App, Context, ExternalPaths, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Window, div, px,
};
use lattice_ui::{
    ActiveLattice as _, GlyphKind, TextRole, TextRoleStyle as _,
    icons::{ICON, file_glyph},
};

/// A row on its way to another folder.
#[derive(Clone)]
pub struct DraggedEntry {
    pub(super) path: String,
    pub(super) name: SharedString,
    pub(super) folder: bool,
    pub(super) figure: bool,
}

impl DraggedEntry {
    /// The row's project-relative path, when it is a figure or a binary
    /// asset, as the Tauri app starts a figure drag only for those
    /// (`project-file-tree.tsx`); a folder or a text file inserts nothing.
    pub fn figure(&self) -> Option<&str> {
        self.figure.then_some(self.path.as_str())
    }

    /// Whether what is being dragged is a drop the tree and the editors
    /// take (a row of the tree, or files from Finder). Their highlights are
    /// drawn from what those drags' moves last saw, which another kind of
    /// drag (the editor's split divider) never updates, and a Finder drag
    /// that leaves the window never clears.
    pub fn dropping(cx: &App) -> bool {
        cx.has_active_drag_of::<Self>() || cx.has_active_drag_of::<ExternalPaths>()
    }
}

/// What the dragged row looks like under the pointer: its glyph and name on
/// the lifted surface.
pub(super) struct DragPreview(pub(super) DraggedEntry);

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let glyph = if self.0.folder {
            GlyphKind::Folder
        } else {
            GlyphKind::for_name(&self.0.name)
        };
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .px(px(8.))
            .rounded(px(6.))
            .bg(palette.raised)
            .shadow(lattice_ui::Elevation::Popover.shadows(&palette))
            .text_role(TextRole::Body, cx)
            .text_color(palette.text)
            .child(file_glyph(glyph, ICON, &palette))
            .child(self.0.name.clone())
    }
}
