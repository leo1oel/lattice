//! The menu bar, as the Tauri app lays it out (`src-tauri/src/native_locale.rs`,
//! `src/app/native-locale.ts`): Lattice, File, Edit, View, Window and Help,
//! each item an action from the command table, so the menus show the same
//! keys the keymap binds and run what the palette runs. The app-wide
//! actions (quit, hide, About, the Help links) are handled here; the rest
//! reach the window in front.
//!
//! The titles follow the interface language, as the Tauri app's do. Its
//! menu keeps Apple's own wording, which can differ from the same English
//! word inside the app, so every title takes the catalog's "macOS menu bar"
//! context.
//!
//! Lattice ▸ About Lattice is AppKit's About panel with the version, the
//! attribution Trellis's license asks a shipped app to show, and the
//! project's website and repository (`about_links.rs`, `macos_about.rs`).

use gpui::{App, Global, Menu, MenuItem, OsAction, SystemMenuType, actions};
use lattice_i18n::tc;

use super::{commands::*, windows};

actions!(
    lattice,
    [OpenUserGuide, OpenWebsite, OpenRepository, EnterFullScreen]
);

/// The project's repository and website (`about_links.rs`).
pub const REPOSITORY_URL: &str = "https://github.com/leo1oel/lattice";
pub const WEBSITE_URL: &str = "https://leo1oel.github.io/lattice/";

/// Help ▸ User Guide: the guide's pages on the website (docs/guide/), in the
/// interface language, as the Tauri app opens them (`userGuideUrl` in
/// src/app/native-locale.ts).
fn user_guide_url(locale: lattice_i18n::Locale) -> &'static str {
    if locale.is_chinese() {
        "https://leo1oel.github.io/lattice/guide/zh-CN/"
    } else {
        "https://leo1oel.github.io/lattice/guide/"
    }
}

/// The attribution Trellis's license asks a shipped app to show (NOTICE).
pub const TRELLIS_ATTRIBUTION: &str = "Uses Trellis by DanFessler - github.com/DanFessler/trellis";

/// Help's link titles, in the interface language.
fn link_titles() -> (String, String) {
    (
        tc!("macOS menu bar", "{name} Website", name = "Lattice").to_string(),
        tc!("macOS menu bar", "{name} on GitHub", name = "Lattice").to_string(),
    )
}

/// Lattice ▸ About Lattice: the name, the version, the Trellis attribution
/// and the two links.
fn show_about(cx: &mut App) {
    let (website, github) = link_titles();
    #[cfg(target_os = "macos")]
    {
        let _ = cx;
        crate::native::show_about_panel(
            crate::APP_NAME,
            lattice_core::VERSION,
            TRELLIS_ATTRIBUTION,
            &[(&website, WEBSITE_URL), (&github, REPOSITORY_URL)],
        );
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = cx.active_window() {
        let detail = format!(
            "{}\n\n{TRELLIS_ATTRIBUTION}\n\n{website}: {WEBSITE_URL}\n{github}: {REPOSITORY_URL}",
            lattice_i18n::t!("Version {version}", version = lattice_core::VERSION)
        );
        window
            .update(cx, |_, window, cx| {
                let _ = window.prompt(
                    gpui::PromptLevel::Info,
                    crate::APP_NAME,
                    Some(&detail),
                    &[tc!("dialog button", "OK")],
                    cx,
                );
            })
            .ok();
    }
}

pub fn install(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| {
        if !windows::any_overlay_writing(cx) {
            cx.quit();
        }
    });
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &NewWindow, cx| windows::new_window(None, None, cx));
    cx.on_action(|_: &About, cx| show_about(cx));
    cx.on_action(|_: &OpenUserGuide, cx| cx.open_url(user_guide_url(lattice_i18n::locale())));
    cx.on_action(|_: &OpenWebsite, cx| cx.open_url(WEBSITE_URL));
    cx.on_action(|_: &OpenRepository, cx| cx.open_url(REPOSITORY_URL));
    // View ▸ Enter Full Screen (Exit Full Screen in full screen): AppKit's
    // own, on the window in front.
    cx.on_action(|_: &EnterFullScreen, cx| {
        if let Some(window) = cx.active_window() {
            window
                .update(cx, |_, window, _| window.toggle_fullscreen())
                .ok();
        }
    });
    install_menus(cx);
}

/// Set the menu bar in the interface language now; called again when it
/// changes.
pub fn install_menus(cx: &mut App) {
    let front = front(cx);
    cx.set_menus(menus(front, cx));
    cx.set_global(Shown(front));
    #[cfg(target_os = "macos")]
    crate::native::set_windows_menu(tc!("macOS menu bar", "Window"));
}

/// Lay the menus out again: File ▸ Open Recent follows the recent projects
/// and the window in front.
pub fn refresh(cx: &mut App) {
    cx.defer(install_menus);
}

/// Lay the menus out again if what they show of the window in front
/// changed (its project closed, linked to Overleaf or unlinked). Deferred:
/// the caller may be inside the shell's own update.
pub fn follow_front(cx: &mut App) {
    cx.defer(|cx| {
        if cx.try_global::<Shown>().map(|shown| shown.0) != Some(front(cx)) {
            install_menus(cx);
        }
    });
}

/// How many projects File ▸ Open Recent lists before All Recent Projects….
const OPEN_RECENT_SHOWN: usize = 10;

/// File ▸ Open Recent: the recent projects, newest first, at most ten, the
/// one in front left out (`switcherProjects`), then with more, a separator
/// and All Recent Projects…, the recent project finder. Each opens as Open
/// Recent does in the app: in a window of its own once the window shows a
/// project.
fn open_recent(cx: &App) -> MenuItem {
    let front = cx
        .active_window()
        .and_then(|window| windows::root_of(window, cx));
    let others = crate::recents::RecentProjects::others(front.as_deref(), cx);
    let mut items: Vec<MenuItem> = others
        .iter()
        .take(OPEN_RECENT_SHOWN)
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
    if others.len() > OPEN_RECENT_SHOWN {
        items.extend([
            MenuItem::separator(),
            MenuItem::action(
                tc!("macOS menu bar", "All Recent Projects…"),
                OpenRecentFinder,
            ),
        ]);
    }
    // With no other project to offer, it stays in its place, dimmed.
    let none = items.is_empty();
    MenuItem::submenu(
        Menu::new(tc!("macOS menu bar", "Open Recent"))
            .items(items)
            .disabled(none),
    )
}

/// What the menus need from the window in front: whether it shows a
/// project, its margin review choice when its project is linked to
/// Overleaf (the Tauri app's `marginReviewAvailable`), and whether it is in
/// full screen.
#[derive(Clone, Copy, Default, PartialEq)]
struct Front {
    project_open: bool,
    margin: Option<crate::editor_panel::MarginMode>,
    fullscreen: bool,
}

/// What the menus showed of the window in front when last laid out.
struct Shown(Front);

impl Global for Shown {}

fn front(cx: &App) -> Front {
    let window = cx.active_window();
    let fullscreen = window.is_some_and(|window| windows::is_fullscreen(window.window_id(), cx));
    let Some(shell) = window.and_then(|window| windows::shell_of(window, cx)) else {
        return Front {
            fullscreen,
            ..Front::default()
        };
    };
    let shell = shell.read(cx);
    let context = shell.command_context(cx);
    Front {
        project_open: context.in_project,
        margin: (context.in_project && context.overleaf_linked).then_some(shell.margin_mode),
        fullscreen,
    }
}

/// View ▸ Margin Review: Auto, Markers Only and Off, the one chosen checked.
fn margin_review(mode: crate::editor_panel::MarginMode) -> MenuItem {
    use super::overleaf_collab::{MarginReviewAuto, MarginReviewMarkers, MarginReviewOff};
    use crate::editor_panel::MarginMode;
    MenuItem::submenu(
        Menu::new(tc!("macOS menu bar", "Margin Review")).items([
            MenuItem::action(tc!("macOS menu bar", "Auto"), MarginReviewAuto)
                .checked(mode == MarginMode::Auto),
            MenuItem::action(tc!("macOS menu bar", "Markers Only"), MarginReviewMarkers)
                .checked(mode == MarginMode::Markers),
            MenuItem::action(tc!("macOS menu bar", "Off"), MarginReviewOff)
                .checked(mode == MarginMode::Off),
        ]),
    )
}

fn menus(front: Front, cx: &App) -> Vec<Menu> {
    let name = crate::APP_NAME;
    let (website, github) = link_titles();
    let mut lattice = vec![MenuItem::action(
        tc!("macOS menu bar", "About {name}", name = name),
        About,
    )];
    lattice.extend(crate::updater::menu_item(cx));
    lattice.extend([
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
    ]);
    let mut view = vec![
        MenuItem::action(tc!("macOS menu bar", "Actual Size"), ResetInterfaceSize),
        MenuItem::action(tc!("macOS menu bar", "Bigger"), LargerInterface),
        MenuItem::action(tc!("macOS menu bar", "Smaller"), SmallerInterface),
        MenuItem::separator(),
        MenuItem::action(
            if front.fullscreen {
                tc!("macOS menu bar", "Exit Full Screen")
            } else {
                tc!("macOS menu bar", "Enter Full Screen")
            },
            EnterFullScreen,
        ),
    ];
    if let Some(mode) = front.margin {
        view.extend([MenuItem::separator(), margin_review(mode)]);
    }
    vec![
        Menu::new(name).items(lattice),
        Menu::new(tc!("macOS menu bar", "File")).items([
            MenuItem::action(tc!("macOS menu bar", "New Project…"), NewProject),
            MenuItem::action(tc!("macOS menu bar", "Open…"), OpenFolder),
            open_recent(cx),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Clone Repository…"), CloneRepository),
            MenuItem::action(
                tc!("macOS menu bar", "Open from Overleaf…"),
                super::overleaf_flow::OpenOverleafProject,
            ),
            MenuItem::action(tc!("macOS menu bar", "Import Overleaf ZIP…"), ImportZip),
            MenuItem::separator(),
            MenuItem::action(
                tc!("macOS menu bar", "Export ZIP…"),
                super::export_zip::ExportProjectZip,
            )
            .disabled(!front.project_open),
            MenuItem::action(
                tc!("macOS menu bar", "Export for arXiv…"),
                super::tools_flow::ExportArxiv,
            )
            .disabled(!front.project_open),
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
        Menu::new(tc!("macOS menu bar", "View")).items(view),
        Menu::new(tc!("macOS menu bar", "Window")).items([
            MenuItem::action(tc!("macOS menu bar", "Minimize"), Minimize),
            MenuItem::action(tc!("macOS menu bar", "Zoom"), Zoom),
            MenuItem::separator(),
            MenuItem::action(tc!("macOS menu bar", "Close Window"), CloseWindow),
        ]),
        Menu::new(tc!("macOS menu bar", "Help")).items([
            MenuItem::action(tc!("macOS menu bar", "User Guide"), OpenUserGuide),
            MenuItem::action(
                tc!("macOS menu bar", "What’s New in {name}", name = name),
                super::WhatsNew,
            ),
            MenuItem::separator(),
            MenuItem::action(
                tc!("macOS menu bar", "Report a Problem…"),
                super::ReportProblem,
            ),
            MenuItem::separator(),
            MenuItem::action(website, OpenWebsite),
            MenuItem::action(github, OpenRepository),
        ]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_names_trellis_as_its_license_asks() {
        // The repository's NOTICE carries the line Trellis's license asks a
        // shipped app to show.
        let notice = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../NOTICE"));
        assert!(
            notice
                .lines()
                .any(|line| line.trim() == TRELLIS_ATTRIBUTION),
            "NOTICE has no line {TRELLIS_ATTRIBUTION:?}"
        );
        let (website, github) = link_titles();
        assert_eq!(website, "Lattice Website");
        assert_eq!(github, "Lattice on GitHub");
    }

    #[test]
    fn user_guide_follows_the_interface_language() {
        assert_eq!(
            user_guide_url(lattice_i18n::Locale::En),
            "https://leo1oel.github.io/lattice/guide/"
        );
        assert_eq!(
            user_guide_url(lattice_i18n::Locale::ZhCn),
            "https://leo1oel.github.io/lattice/guide/zh-CN/"
        );
    }
}
