//! The panel's tab and strip: its name, the dirty mark, the tools the strip
//! carries for the document's kind (`documentTools`: the build chip, an HTML
//! file's view switch, nothing for a board, sheet or deck) and its ⋯ menu.

use gpui::{App, Context, IntoElement, SharedString, Window, prelude::*};
use gpui_kit::component::{dock::Panel, menu::PopupMenu};
use lattice_editor::latex;
use lattice_i18n::t;
use zed_actions::buffer_search::Deploy;

use super::{
    DocumentView, EditorPanel, ShowSourceView, ShowVisualView, VISUAL_NOT_PORTED, ViewPreview,
    ViewSource, ViewSplit, file_name,
};
use crate::{
    editor_status,
    shell::{Build, CleanRebuild, ForwardSync, StopBuild, ToggleVimMode},
};

impl Panel for EditorPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(file_name(&self.path).into())
    }

    fn title(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name = file_name(&self.path);
        if self.is_dirty(cx) {
            format!("{name} •")
        } else {
            name
        }
    }

    /// The build chip, at the strip's trailing end as the app puts it; an
    /// HTML file's view switch in its place (`documentTools`: "views").
    fn title_suffix(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        // A board, sheet or deck carries no tools (`documentTools` is null).
        if self.structured.is_some() {
            return None;
        }
        Some(
            self.view_switch(window, cx)
                .unwrap_or_else(|| editor_status::build_chip(&self.build, window, cx)),
        )
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        // A board, sheet or deck adds nothing to the panel's own items.
        if self.structured.is_some() {
            return menu;
        }
        // An HTML file's menu repeats its view switch, and has no build.
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

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}
