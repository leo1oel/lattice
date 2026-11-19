//! How each of the app's panels presents itself in the dock: its tab's icon,
//! whether it has unsaved changes, which surface its card is, and whether
//! its tab is a document's (which ellipsizes in a narrow strip) or a named
//! panel's.
//!
//! The Main window puts navigation (Project, Papers, Agent) on the side
//! panels' surface and the stage (editors, the PDF, tool panels) on the sheet. Tabs carry
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
                };
            }
            Err(view) => view,
        };
        let look = |icon, surface| TabLook {
            icon: TabIcon::Icon(icon),
            dirty: false,
            surface,
            document: false,
        };
        // Project, Papers and the Agent share the side panels' surface, opaque
        // in a translucent window too (trellis.css).
        if view.clone().downcast::<FileTreePanel>().is_ok() {
            look(Icon::FOLDER_TREE, Surface::SidePanel)
        } else if view.clone().downcast::<PapersPanel>().is_ok() {
            look(Icon::LIBRARY, Surface::SidePanel)
        } else if let Ok(synara) = view.clone().downcast::<crate::agent::SynaraPanel>() {
            // The Git workspace is a tool among the documents (`PANEL_ICONS`:
            // Bot, GitBranch).
            match synara.read(cx).kind(cx) {
                crate::agent::SurfaceKind::Agent => look(Icon::BOT, Surface::SidePanel),
                crate::agent::SurfaceKind::Git => look(Icon::GIT_BRANCH, Surface::Sheet),
                crate::agent::SurfaceKind::Settings => look(Icon::BOT, Surface::Sheet),
            }
        } else if let Ok(pdf) = view.clone().downcast::<PdfPanel>() {
            // A PDF of the project opened from the tree is a document, with
            // its file's glyph; the compiled PDFs are the PDF panel's.
            match pdf.read(cx).kind() {
                PdfPanelKind::File(_) => TabLook {
                    icon: TabIcon::Glyph(GlyphKind::Pdf),
                    dirty: false,
                    surface: Surface::Sheet,
                    document: true,
                },
                _ => look(Icon::FILE_TEXT, Surface::Sheet),
            }
        } else if view
            .clone()
            .downcast::<crate::papers::reader::PaperReader>()
            .is_ok()
        {
            // A paper is a document, with the `.bib` glyph the app gives a
            // paper's tab (trellis-icons.tsx `documentGlyphKind`).
            TabLook {
                icon: TabIcon::Glyph(GlyphKind::Bib),
                dirty: false,
                surface: Surface::Sheet,
                document: true,
            }
        } else if view.clone().downcast::<BuildPanel>().is_ok() {
            look(Icon::HAMMER, Surface::Sheet)
        } else if view
            .clone()
            .downcast::<crate::history::HistoryPanel>()
            .is_ok()
        {
            look(Icon::TOOL_HISTORY, Surface::Sheet)
        } else if view
            .clone()
            .downcast::<crate::submission::todos::TodosPanel>()
            .is_ok()
        {
            look(Icon::LIST_TODO, Surface::Sheet)
        } else if view
            .clone()
            .downcast::<crate::submission::checklist::ChecklistPanel>()
            .is_ok()
        {
            look(Icon::CLIPBOARD_CHECK, Surface::Sheet)
        } else if view
            .clone()
            .downcast::<crate::get_started::panel::GetStartedPanel>()
            .is_ok()
        {
            look(Icon::LIST_CHECKS, Surface::Sheet)
        } else if view
            .clone()
            .downcast::<crate::terminal::TerminalPanel>()
            .is_ok()
        {
            look(Icon::SQUARE_TERMINAL, Surface::Sheet)
        } else if let Ok(comments) = view.clone().downcast::<crate::shell::CommentsView>() {
            // Overleaf's for a linked project, else Annotations' (the Tauri
            // app's `comments` view, trellis-icons.tsx).
            if comments.read(cx).shows_overleaf(cx) {
                look(Icon::LEAF, Surface::Sheet)
            } else {
                look(Icon::MESSAGE_SQUARE, Surface::Sheet)
            }
        } else if view
            .clone()
            .downcast::<crate::overleaf::collab::OverleafCollabPanel>()
            .is_ok()
        {
            // The Tauri app's `overleaf` view (trellis-icons.tsx).
            look(Icon::LEAF, Surface::Sheet)
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
