//! The menu bar (`src-tauri/src/native_locale.rs`, `src/app/native-locale.ts`):
//! Lattice, File, Edit, View, Window and Help, each item an action from the
//! command table, so the menus show the same keys the keymap binds and run
//! what the palette runs. The app-wide actions (quit, hide, about, a new
//! window) are handled here; the rest reach the window in front.
//!
//! The titles follow the interface language, as the Tauri app's do. Its
//! menu keeps Apple's own wording, which can differ from the same English
//! word inside the app, so those titles take the catalog's "macOS menu bar"
//! context; the menus' other items are the GPUI app's own.

use gpui::{App, Menu, MenuItem, OsAction, SystemMenuType};
use lattice_i18n::{t, tc};

use super::{commands::*, windows};

pub fn install(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &NewWindow, cx| windows::new_window(None, None, cx));
    cx.on_action(|_: &About, cx| {
        if let Some(window) = cx.active_window() {
            window
                .update(cx, |_, window, cx| {
                    let _ = window.prompt(
                        gpui::PromptLevel::Info,
                        t!("Lattice (GPUI preview)"),
                        Some(t!(
                            "A native preview of Lattice, growing beside the Tauri app."
                        )),
                        &[tc!("dialog button", "OK")],
                        cx,
                    );
                })
                .ok();
        }
    });
    install_menus(cx);
}

/// Set the menu bar in the interface language now; called again when it
/// changes.
pub fn install_menus(cx: &mut App) {
    cx.set_menus(menus(cx));
    #[cfg(target_os = "macos")]
    crate::native::set_windows_menu(tc!("macOS menu bar", "Window"));
}

/// Lay the menus out again: File ▸ Open Recent follows the recent projects
/// and the window in front.
pub fn refresh(cx: &mut App) {
    cx.defer(install_menus);
}

/// File ▸ Open Recent: the recent projects, newest first, at most five, the
/// one in front left out (`switcherProjects`). Each opens as Open Recent does
/// in the app: in a window of its own once the window shows a project.
fn open_recent(cx: &App) -> MenuItem {
    let front = cx
        .active_window()
        .and_then(|window| windows::root_of(window, cx));
    let items: Vec<MenuItem> = crate::recents::RecentProjects::list(cx)
        .iter()
        .filter(|recent| Some(&recent.path) != front.as_ref())
        .take(5)
        .map(|recent| {
            MenuItem::action(
                recent.name.clone(),
                OpenRecentProject {
                    path: recent.path.clone(),
                    here: false,
                },
            )
        })
        .collect();
    MenuItem::submenu(Menu::new(tc!("macOS menu bar", "Open Recent")).items(items))
}

fn menus(cx: &App) -> Vec<Menu> {
    let name = "Lattice";
    vec![
        Menu::new("Lattice").items([
            MenuItem::action(tc!("macOS menu bar", "About {name}", name = name), About),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Settings…"), OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu(tc!("macOS menu bar", "Services"), SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Hide {name}", name = name), Hide),
            MenuItem::action(tc!("macOS menu bar", "Hide Others"), HideOthers),
            MenuItem::action(tc!("macOS menu bar", "Show All"), ShowAll),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Quit {name}", name = name), Quit),
        ]),
        Menu::new(tc!("macOS menu bar", "File")).items([
            MenuItem::action(tc!("macOS menu bar", "New Project…"), NewProject),
            MenuItem::action(tc!("macOS menu bar", "Open…"), OpenFolder),
            open_recent(cx),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Clone Repository…"), CloneRepository),
            MenuItem::action(tc!("macOS menu bar", "Import Overleaf ZIP…"), ImportZip),
            MenuItem::separator(),
            MenuItem::action(t!("New Window"), NewWindow),
            MenuItem::action(t!("Open in New Window"), OpenInNewWindow),
            MenuItem::separator(),
            MenuItem::action(t!("Save and Build"), Save),
            MenuItem::action(t!("Build"), Build),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Close Tab"), CloseTab),
            MenuItem::action(tc!("macOS menu bar", "Close Window"), CloseWindow),
        ]),
        Menu::new(tc!("macOS menu bar", "Edit")).items([
            MenuItem::os_action(
                tc!("macOS menu bar", "Undo"),
                editor::actions::Undo,
                OsAction::Undo,
            ),
            MenuItem::os_action(
                tc!("macOS menu bar", "Redo"),
                editor::actions::Redo,
                OsAction::Redo,
            ),
            MenuItem::separator(),
            MenuItem::os_action(
                tc!("macOS menu bar", "Cut"),
                editor::actions::Cut,
                OsAction::Cut,
            ),
            MenuItem::os_action(
                tc!("macOS menu bar", "Copy"),
                editor::actions::Copy,
                OsAction::Copy,
            ),
            MenuItem::os_action(
                tc!("macOS menu bar", "Paste"),
                editor::actions::Paste,
                OsAction::Paste,
            ),
            MenuItem::os_action(
                tc!("macOS menu bar", "Select All"),
                editor::actions::SelectAll,
                OsAction::SelectAll,
            ),
        ]),
        Menu::new(tc!("macOS menu bar", "View")).items([
            MenuItem::action(t!("Command Palette…"), CommandPalette),
            MenuItem::action(t!("Keyboard Shortcuts"), ShowShortcuts),
            MenuItem::separator(),
            MenuItem::action(t!("Project"), ToggleProjectPanel),
            MenuItem::action(t!("Papers"), TogglePapersPanel),
            MenuItem::action(t!("Agent"), ToggleAgentPanel),
            MenuItem::action(t!("PDF"), TogglePdfPanel),
            MenuItem::action(t!("Build Log"), ToggleBuildPanel),
            MenuItem::separator(),
            MenuItem::action(t!("Writing Layout"), WritingPreset),
            MenuItem::action(t!("Reading Layout"), ReadingPreset),
            MenuItem::action(t!("Focus Mode"), ToggleFocusMode),
            MenuItem::action(t!("Maximize Focused Panel"), ToggleMaximize),
            MenuItem::action(t!("Reset Layout"), ResetLayout),
            // The interface size (native_locale.rs's View ▸ Actual Size,
            // Bigger and Smaller).
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Actual Size"), ResetInterfaceSize),
            MenuItem::action(tc!("macOS menu bar", "Bigger"), LargerInterface),
            MenuItem::action(tc!("macOS menu bar", "Smaller"), SmallerInterface),
        ]),
        Menu::new(tc!("macOS menu bar", "Window")).items([
            MenuItem::action(tc!("macOS menu bar", "Minimize"), Minimize),
            MenuItem::action(tc!("macOS menu bar", "Zoom"), Zoom),
            MenuItem::separator(),
            MenuItem::action(t!("Next Project"), NextProject),
            MenuItem::action(t!("Previous Project"), PreviousProject),
        ]),
        Menu::new(tc!("macOS menu bar", "Help"))
            .items([MenuItem::action(t!("Keyboard Shortcuts"), ShowShortcuts)]),
    ]
}
