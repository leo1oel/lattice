//! The editor panel's ⋯ menu: a file with views (HTML, `.bib`) repeats its
//! Edit / Split / Preview switch and has no build; any other file has the
//! build's commands, and a `.tex` file its Source / Visual switch, which
//! goes first when the strip is short of room.

use gpui::{Context, prelude::FluentBuilder as _};
use gpui_kit::component::menu::PopupMenu;
use lattice_editor::latex;
use lattice_i18n::t;
use zed_actions::buffer_search::Deploy;

use super::{
    DocumentView, EditorPanel, ShowSourceView, ShowVisualView, VISUAL_NOT_PORTED, ViewPreview,
    ViewSource, ViewSplit,
};
use crate::shell::{Build, CleanRebuild, ForwardSync, StopBuild, ToggleVimMode};

impl EditorPanel {
    pub(super) fn panel_menu(&mut self, menu: PopupMenu, cx: &mut Context<Self>) -> PopupMenu {
        if let Some(current) = self.document_view() {
            return menu
                .menu_with_check(
                    "Edit",
                    current == DocumentView::Source,
                    Box::new(ViewSource),
                )
                .menu_with_check("Split", current == DocumentView::Split, Box::new(ViewSplit))
                .menu_with_check(
                    "Preview",
                    current == DocumentView::Preview,
                    Box::new(ViewPreview),
                )
                .separator()
                .menu("Find", Box::new(Deploy::find()))
                .separator()
                .menu_with_check(
                    "Vim mode",
                    crate::app::vim_mode_enabled(cx),
                    Box::new(ToggleVimMode),
                );
        }
        let building = self.build.read(cx).is_running();
        menu.menu(t!("Build"), Box::new(Build))
            .menu(t!("Clean rebuild"), Box::new(CleanRebuild))
            .when(building, |menu| {
                menu.menu(t!("Stop the build"), Box::new(StopBuild))
            })
            .menu(t!("Reveal cursor in PDF"), Box::new(ForwardSync))
            .menu(t!("Find"), Box::new(Deploy::find()))
            // The strip's Source / Visual switch, which goes first when the
            // strip is short of room.
            .when(latex::is_tex_source(&self.path), |menu| {
                menu.separator()
                    .menu_with_check("Source", true, Box::new(ShowSourceView))
                    .menu_with_check_and_disabled(
                        VISUAL_NOT_PORTED,
                        false,
                        Box::new(ShowVisualView),
                        true,
                    )
            })
            .separator()
            .menu_with_check(
                t!("Vim mode"),
                crate::app::vim_mode_enabled(cx),
                Box::new(ToggleVimMode),
            )
    }
}
