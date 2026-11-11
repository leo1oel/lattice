//! How each of the app's panels presents itself in the dock: its tab's icon,
//! whether it has unsaved changes, and which surface its card is.
//!
//! The Main window puts navigation (Project, Papers, Agent) on the chrome
//! and the stage (editors, the PDF, tool panels) on the sheet. Tabs carry
//! Lucide icons for tools and a file's own glyph for a file.

use gpui::App;
use lattice_ui::{
    GlyphKind, Icon,
    components::Surface,
    dock::{TabIcon, TabLook, TabPresenter},
};

use crate::{
    build_panel::BuildPanel, editor_panel::EditorPanel, file_tree::FileTreePanel, pdf::PdfPanel,
};

pub fn present_tabs(cx: &mut App) {
    TabPresenter::set(cx, |panel, cx| {
        let view = panel.view();
        let view = match view.downcast::<EditorPanel>() {
            Ok(editor) => {
                let editor = editor.read(cx);
                return TabLook {
                    icon: TabIcon::Glyph(GlyphKind::for_name(&editor.path().to_string_lossy())),
                    dirty: editor.is_dirty(cx),
                    surface: Surface::Sheet,
                };
            }
            Err(view) => view,
        };
        let look = |icon, surface| TabLook {
            icon: TabIcon::Icon(icon),
            dirty: false,
            surface,
        };
        if view.clone().downcast::<FileTreePanel>().is_ok() {
            look(Icon::FOLDER_TREE, Surface::Chrome)
        } else if view.clone().downcast::<PdfPanel>().is_ok() {
            look(Icon::FILE_TEXT, Surface::Sheet)
        } else if view.downcast::<BuildPanel>().is_ok() {
            look(Icon::HAMMER, Surface::Sheet)
        } else {
            TabLook::default()
        }
    });
}
