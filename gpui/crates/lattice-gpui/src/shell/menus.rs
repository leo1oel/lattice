//! The menu bar (`src-tauri/src/native_locale.rs`): Lattice, File, Edit,
//! View, Window and Help, each item an action from the command table, so the
//! menus show the same keys the keymap binds and run what the palette runs.
//! The app-wide actions (quit, hide, about, a new window) are handled here;
//! the rest reach the window in front.

use gpui::{App, Menu, MenuItem, OsAction, SystemMenuType};

use super::{commands::*, windows};

pub fn install(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &NewWindow, cx| windows::new_window(None, cx));
    cx.on_action(|_: &About, cx| {
        if let Some(window) = cx.active_window() {
            window
                .update(cx, |_, window, cx| {
                    let _ = window.prompt(
                        gpui::PromptLevel::Info,
                        "Lattice (GPUI preview)",
                        Some("A native preview of Lattice, growing beside the Tauri app."),
                        &["OK"],
                        cx,
                    );
                })
                .ok();
        }
    });
    cx.set_menus(menus());
}

fn menus() -> Vec<Menu> {
    vec![
        Menu::new("Lattice").items([
            MenuItem::action("About Lattice", About),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide Lattice", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit Lattice", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Window", NewWindow),
            MenuItem::action("Open Folder…", OpenFolder),
            MenuItem::action("Open in New Window", OpenInNewWindow),
            MenuItem::separator(),
            MenuItem::action("Save", Save),
            MenuItem::action("Build", Build),
            MenuItem::separator(),
            MenuItem::action("Close Tab", CloseTab),
            MenuItem::action("Close Window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", editor::actions::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", editor::actions::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", editor::actions::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", editor::actions::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", editor::actions::Paste, OsAction::Paste),
            MenuItem::os_action(
                "Select All",
                editor::actions::SelectAll,
                OsAction::SelectAll,
            ),
        ]),
        Menu::new("View").items([
            MenuItem::action("Command Palette…", CommandPalette),
            MenuItem::action("Keyboard Shortcuts", ShowShortcuts),
            MenuItem::separator(),
            MenuItem::action("Project", ToggleProjectPanel),
            MenuItem::action("Papers", TogglePapersPanel),
            MenuItem::action("Agent", ToggleAgentPanel),
            MenuItem::action("PDF", TogglePdfPanel),
            MenuItem::action("Build Log", ToggleBuildPanel),
            MenuItem::separator(),
            MenuItem::action("Writing Layout", WritingPreset),
            MenuItem::action("Reading Layout", ReadingPreset),
            MenuItem::action("Focus Mode", ToggleFocusMode),
            MenuItem::action("Maximize Focused Panel", ToggleMaximize),
            MenuItem::action("Reset Layout", ResetLayout),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Next Project", NextProject),
            MenuItem::action("Previous Project", PreviousProject),
        ]),
        Menu::new("Help").items([MenuItem::action("Keyboard Shortcuts", ShowShortcuts)]),
    ]
}
