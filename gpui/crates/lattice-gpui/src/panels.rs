//! How each of the app's panels presents itself in the dock: its tab's icon,
//! whether it has unsaved changes, which surface its card is, and whether
//! its tab is a document's (which ellipsizes in a narrow strip) or a named
//! panel's.
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
    build_panel::BuildPanel,
    editor_panel::EditorPanel,
    empty_slot::EmptySlotPanel,
    file_tree::FileTreePanel,
    papers::PapersPanel,
    pdf::{PdfPanel, PdfPanelKind},
    stand_in_panels::StandInPanel,
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
                    document: true,
                    frosted: false,
                };
            }
            Err(view) => view,
        };
        let look = |icon, surface| TabLook {
            icon: TabIcon::Icon(icon),
            dirty: false,
            surface,
            document: false,
            frosted: false,
        };
        // Project and Papers frost over a translucent window; the Agent
        // stays on its opaque sidebar (trellis.css `data-glass`).
        if view.clone().downcast::<FileTreePanel>().is_ok() {
            TabLook {
                frosted: true,
                ..look(Icon::FOLDER_TREE, Surface::Chrome)
            }
        } else if view.clone().downcast::<PapersPanel>().is_ok() {
            TabLook {
                frosted: true,
                ..look(Icon::LIBRARY, Surface::Chrome)
            }
        } else if let Ok(stand_in) = view.clone().downcast::<StandInPanel>() {
            look(stand_in.read(cx).kind().icon(), Surface::Chrome)
        } else if let Ok(pdf) = view.clone().downcast::<PdfPanel>() {
            // A PDF of the project opened from the tree is a document, with
            // its file's glyph; the compiled PDFs are the PDF panel's.
            match pdf.read(cx).kind() {
                PdfPanelKind::File(_) => TabLook {
                    icon: TabIcon::Glyph(GlyphKind::Pdf),
                    dirty: false,
                    surface: Surface::Sheet,
                    document: true,
                    frosted: false,
                },
                _ => look(Icon::FILE_TEXT, Surface::Sheet),
            }
        } else if view.clone().downcast::<BuildPanel>().is_ok() {
            look(Icon::HAMMER, Surface::Sheet)
        } else if view.downcast::<EmptySlotPanel>().is_ok() {
            // A document's place: a document's tab, with the empty state's icon.
            TabLook {
                document: true,
                ..look(Icon::FILE_TEXT, Surface::Sheet)
            }
        } else {
            TabLook::default()
        }
    });
}
