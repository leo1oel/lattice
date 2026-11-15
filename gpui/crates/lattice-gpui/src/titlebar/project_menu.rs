//! The project switcher's menu, as the Tauri app's (`src/project/project-menu.tsx`):
//! the recent projects other than this one (five at most), each opened in a
//! window of its own by its row or in this window by the row's trailing
//! window glyph; then Open another folder (with its own in-this-window
//! glyph), New project, Clone repository…, Open from Overleaf, the Guided
//! tutorial, and Settings, the titlebar's way into Settings, as the app's
//! menu ends.
//!
//! The glyph is the row's secondary action (`MenuAction::secondary`): the
//! keys reach it with → from its row and run it with Enter, as the app's
//! glyph is an item of its own. Export ZIP and Export for arXiv… follow Open
//! from Overleaf, and while an export runs the menu ends with "Exporting ZIP…"
//! after a loader, and the rows that would switch or replace the project
//! under it (the recent projects and their glyphs, Open from Overleaf, the
//! Guided tutorial) are dimmed, as the app's `busy` dims them.

use std::path::PathBuf;

use gpui::{Action as _, App, IntoElement, Styled as _, WeakEntity, Window, px};
use lattice_i18n::t;
use lattice_ui::{
    Icon,
    components::{Menu, MenuAction, MenuPopover, ToolbarButton},
};

use crate::{
    recents::RecentProjects,
    shell::{
        Shell,
        commands::{
            CloneRepository, CloseProject, NewProject, OpenFolder, OpenFolderHere,
            OpenRecentProject,
        },
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

pub(super) fn project_menu(
    shell: WeakEntity<Shell>,
    menu: Menu,
    _: &mut Window,
    cx: &mut App,
) -> Menu {
    let current = shell.upgrade().and_then(|shell| shell.read(cx).root(cx));
    let exporting = shell
        .upgrade()
        .is_some_and(|shell| shell.read(cx).exporting_zip());
    let recents = switcher_projects(current.as_ref(), cx);
    let mut menu = menu.min_w(px(208.));
    // With no other project to go back to, the menu starts at its actions.
    if !recents.is_empty() {
        menu = menu.label(t!("Recent projects"));
        for (name, path) in recents {
            let here = OpenRecentProject {
                path: path.clone(),
                here: true,
            };
            menu = menu.item(
                MenuAction::dispatch(
                    name.clone(),
                    Box::new(OpenRecentProject { path, here: false }),
                )
                .icon(Icon::FOLDER)
                .disabled(exporting)
                .secondary(
                    Icon::APP_WINDOW,
                    lattice_i18n::space_mixed_script(&t!(
                        "Open {name} in this window",
                        name = name
                    )),
                    move |window, cx| window.dispatch_action(here.boxed_clone(), cx),
                ),
            );
        }
        menu = menu.separator();
    }
    let menu = menu
        .item(
            MenuAction::dispatch(t!("Open another folder"), Box::new(OpenFolder))
                .icon(Icon::FOLDER_OPEN)
                .secondary(
                    Icon::APP_WINDOW,
                    t!("Open a folder in this window"),
                    |window, cx| window.dispatch_action(Box::new(OpenFolderHere), cx),
                ),
        )
        .item(MenuAction::dispatch(t!("New project"), Box::new(NewProject)).icon(Icon::PLUS))
        .item(
            MenuAction::dispatch(t!("Clone repository…"), Box::new(CloneRepository))
                .icon(Icon::GIT_BRANCH),
        )
        .item(
            MenuAction::dispatch(
                t!("Open from Overleaf"),
                Box::new(crate::shell::overleaf_flow::OpenOverleafProject),
            )
            .icon(Icon::CLOUD)
            .disabled(exporting),
        )
        .item(
            MenuAction::dispatch(t!("Export ZIP"), Box::new(crate::shell::ExportProjectZip))
                .icon(Icon::FILE_ARCHIVE),
        )
        .item(
            MenuAction::dispatch(t!("Export for arXiv…"), Box::new(crate::shell::ExportArxiv))
                .icon(Icon::PACKAGE_CHECK),
        )
        .separator()
        .item(
            MenuAction::new(t!("Guided tutorial"), {
                let shell = shell.clone();
                move |window, cx| {
                    shell
                        .update(cx, |shell, cx| shell.open_tutorial(window, cx))
                        .ok();
                }
            })
            .icon(Icon::SPARKLES)
            .disabled(exporting),
        )
        // Settings opens on its shell directly, as the app's `onSettings` does,
        // rather than as an action dispatched from whatever focus the menu
        // interrupted: a press on the titlebar leaves no focused view on the
        // shell's dispatch path to carry it there.
        .item(
            MenuAction::new(t!("Settings"), move |window, cx| {
                shell
                    .update(cx, |shell, cx| shell.open_settings(None, window, cx))
                    .ok();
            })
            .icon(Icon::SETTINGS),
        );
    // The export under way, as the Tauri menu's `busyLabel` line.
    if exporting {
        menu.busy(t!("Exporting ZIP…"))
    } else {
        menu
    }
}

/// The switcher beside a window's project tabs: the project menu, and a
/// way to close the project shown.
pub(super) fn switcher_for(
    shell: &Shell,
    weak: WeakEntity<Shell>,
    cx: &gpui::App,
) -> impl IntoElement {
    MenuPopover::new(
        "project-switcher-menu",
        ToolbarButton::new("project-switcher", shell.project_name(cx))
            .switcher()
            .max_w(px(super::fit::TAB_SWITCHER_MAX))
            .parity("titlebar/project"),
        move |menu, window, cx| {
            project_menu(weak.clone(), menu, window, cx)
                .separator()
                .item(MenuAction::dispatch(
                    t!("Close this project"),
                    Box::new(CloseProject),
                ))
        },
    )
}
