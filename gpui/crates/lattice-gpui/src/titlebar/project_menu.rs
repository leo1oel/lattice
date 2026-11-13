//! The project switcher's menu, as the Tauri app's (`src/project/project-menu.tsx`):
//! the recent projects other than this one (five at most), each opened in a
//! window of its own by its row or in this window by the row's trailing
//! window glyph; then Open another folder (with its own in-this-window
//! glyph), New project, Clone repository…, and the Guided tutorial.
//!
//! The app's trailing glyph is a menu item of its own, so the keyboard
//! reaches it as the next item down; GPUI Kit's menu has one item per row,
//! so here it is the pointer's alone and the keyboard opens a recent
//! project in a window of its own, as the row does. Export ZIP, Export for
//! arXiv, Open from Overleaf and Settings belong to other lanes of the port.

use std::{cell::Cell, path::PathBuf, rc::Rc};

use gpui::{Action, App, Context, ParentElement as _, Styled as _, WeakEntity, Window, div, px};
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::IconButton,
    icons::ICON_SMALL,
};

use crate::{
    recents::RecentProjects,
    shell::{
        Shell,
        commands::{CloneRepository, NewProject, OpenFolder, OpenFolderHere, OpenRecentProject},
    },
};

/// How many other projects the menu lists.
const MAX_SWITCHER_PROJECTS: usize = 5;

/// The recent projects other than `current`, newest first.
fn switcher_projects(current: Option<&PathBuf>, cx: &App) -> Vec<(String, PathBuf)> {
    RecentProjects::list(cx)
        .iter()
        .filter(|recent| Some(&recent.path) != current)
        .take(MAX_SWITCHER_PROJECTS)
        .map(|recent| (recent.name.clone(), recent.path.clone()))
        .collect()
}

/// A row that runs `action` (`here` when its trailing glyph was the one
/// pressed): the glyph's click lands first and marks the row's, which
/// follows it, so the menu closes as for any item.
fn row_with_here(
    id: &'static str,
    ix: usize,
    icon: Icon,
    label: String,
    here_label: String,
    action: impl Fn(bool) -> Box<dyn Action> + 'static,
) -> PopupMenuItem {
    let here = Rc::new(Cell::new(false));
    let mark = here.clone();
    PopupMenuItem::element(move |_, cx| {
        let palette = cx.palette().clone();
        let mark = mark.clone();
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(8.))
            .child(icon.element(ICON_SMALL, palette.text_secondary))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Body, cx)
                    .child(label.clone()),
            )
            .child(
                IconButton::new((id, ix), Icon::APP_WINDOW)
                    .frame(px(22.), px(22.))
                    .icon_size(ICON_SMALL)
                    .radius(px(4.))
                    .tooltip(here_label.clone())
                    .on_click(move |_, _, _| mark.set(true)),
            )
    })
    .on_click(move |_, window, cx| {
        let here = here.replace(false);
        window.dispatch_action(action(here), cx);
    })
}

pub(super) fn project_menu(
    shell: WeakEntity<Shell>,
    menu: PopupMenu,
    _: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let current = shell.upgrade().and_then(|shell| shell.read(cx).root(cx));
    let recents = switcher_projects(current.as_ref(), cx);
    let mut menu = menu.min_w(px(208.));
    // With no other project to go back to, the menu starts at its actions.
    if !recents.is_empty() {
        menu = menu.label("Recent projects");
        for (ix, (name, path)) in recents.into_iter().enumerate() {
            menu = menu.item(row_with_here(
                "recent-here",
                ix,
                Icon::FOLDER,
                name.clone(),
                format!("Open {name} in this window"),
                move |here| {
                    Box::new(OpenRecentProject {
                        path: path.clone(),
                        here,
                    })
                },
            ));
        }
        menu = menu.separator();
    }
    menu.item(row_with_here(
        "folder-here",
        0,
        Icon::FOLDER_OPEN,
        t!("Open another folder").into(),
        "Open a folder in this window".into(),
        |here| {
            if here {
                Box::new(OpenFolderHere)
            } else {
                Box::new(OpenFolder)
            }
        },
    ))
    .item(
        PopupMenuItem::new("New project")
            .icon(Icon::PLUS.kit())
            .action(Box::new(NewProject)),
    )
    .item(
        PopupMenuItem::new("Clone repository…")
            .icon(Icon::GIT_BRANCH.kit())
            .action(Box::new(CloneRepository)),
    )
    .separator()
    .item(
        PopupMenuItem::new("Guided tutorial")
            .icon(Icon::SPARKLES.kit())
            .on_click(move |_, window, cx| {
                shell
                    .update(cx, |shell, cx| shell.open_tutorial(window, cx))
                    .ok();
            }),
    )
}
