//! The panel's tab and strip: its name, the dirty mark, the tools the strip
//! carries for the document's kind (`documentTools`: the build chip, an HTML
//! file's view switch, nothing for a board, sheet or deck) and its ⋯ menu.

use gpui::{App, Context, Focusable as _, IntoElement, SharedString, Window, prelude::*};
use gpui_kit::component::dock::Panel;
use lattice_editor::latex;
use lattice_i18n::t;
use lattice_ui::components::{Menu, MenuAction};
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

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl EditorPanel {
    /// The editor's own items at the head of its ⋯ menu; each runs on the
    /// editor, wherever focus was when the menu opened.
    pub(crate) fn panel_menu(&self, menu: Menu, cx: &App) -> Menu {
        // A board, sheet or deck adds nothing to the panel's own items.
        if self.structured.is_some() {
            return menu;
        }
        let building = self.build.read(cx).is_running();
        let focus = self.focus_handle(cx);
        let command = |label: &'static str, action: Box<dyn gpui::Action>| {
            MenuAction::dispatch_on(label, action, focus.clone())
        };
        // An HTML file's menu repeats its view switch, and has no build.
        if let Some(current) = self.document_view() {
            return menu
                .item(
                    command("Edit", Box::new(ViewSource)).checked(current == DocumentView::Source),
                )
                .item(command("Split", Box::new(ViewSplit)).checked(current == DocumentView::Split))
                .item(
                    command("Preview", Box::new(ViewPreview))
                        .checked(current == DocumentView::Preview),
                )
                .separator()
                .item(command("Find", Box::new(Deploy::find())))
                .separator()
                .item(
                    command("Vim mode", Box::new(ToggleVimMode))
                        .checked(crate::app::vim_mode_enabled(cx)),
                );
        }
        menu.item(command(t!("Build"), Box::new(Build)))
            .item(command(t!("Clean rebuild"), Box::new(CleanRebuild)))
            .when(building, |menu| {
                menu.item(command(t!("Stop the build"), Box::new(StopBuild)))
            })
            .item(command(t!("Reveal cursor in PDF"), Box::new(ForwardSync)))
            .item(command(t!("Find"), Box::new(Deploy::find())))
            // The strip's Source / Visual switch, which goes first when the
            // strip is short of room.
            .when(latex::is_tex_source(&self.path), |menu| {
                menu.separator()
                    .item(command("Source", Box::new(ShowSourceView)).checked(true))
                    .item(
                        command(VISUAL_NOT_PORTED, Box::new(ShowVisualView))
                            .checked(false)
                            .disabled(true),
                    )
            })
            .separator()
            .item(
                command(t!("Vim mode"), Box::new(ToggleVimMode))
                    .checked(crate::app::vim_mode_enabled(cx)),
            )
    }
}
