//! The native surfaces that follow Lattice's own interface language rather
//! than the web UI: the macOS menu bar, and the language AppKit and WebKit
//! pick for the panels and context menus they draw themselves.
//!
//! The web UI owns the language setting and its translations, so it supplies
//! the menu labels; the host only lays them out. Every window sends the same
//! labels for the same setting, and the menu is app-wide, so the last sender
//! wins harmlessly.

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Runtime};

/// Translated titles for the app menu. Predefined items keep their native
/// actions and shortcuts; only their titles come from here.
///
/// Only the macOS menu bar reads them (`set_native_locale`); elsewhere the
/// page still sends them, and they are checked and dropped.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct MenuLabels {
    about: String,
    /// Lattice ▸ Check for Updates…, or Restart to Update… once an update is
    /// installed and waiting; `None` where Lattice does not update itself.
    /// The page's updater answers it (src/telemetry/app-updater.tsx).
    check_for_updates: Option<String>,
    /// Lattice ▸ Settings… (⌘,), the command table's `settings` command.
    settings: String,
    services: String,
    hide: String,
    hide_others: String,
    show_all: String,
    quit: String,
    file: String,
    /// File ▸ New Project, Open, Open Recent, Clone Repository, Open from
    /// Overleaf, Import Overleaf ZIP, Export ZIP and Export for arXiv: the project title
    /// menu's actions, which the page runs as its own commands
    /// (src/app/use-command-table.ts).
    new_project: String,
    open_folder: String,
    open_recent: String,
    clone_repository: String,
    open_from_overleaf: String,
    import_zip: String,
    export_zip: String,
    export_arxiv: String,
    /// The other projects the sending window's switcher offers, newest first.
    recent_projects: Vec<RecentProjectItem>,
    /// Whether the sending window has a project open, which the exports need.
    project_open: bool,
    edit: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    view: String,
    /// View ▸ Bigger, Smaller and Actual Size: the interface size, which the
    /// page also binds to ⌘+, ⌘− and ⌘0 (src/settings/interface-scale.ts).
    zoom_in: String,
    zoom_out: String,
    actual_size: String,
    fullscreen: String,
    window: String,
    minimize: String,
    zoom: String,
    /// File ▸ Close Tab (⌘W): the page closes its document tab, and its
    /// window once none is open (src/app/use-command-table.ts).
    close_tab: String,
    close_window: String,
    help: String,
    /// Help ▸ What's New in Lattice, which opens the release notes sheet
    /// (src/app/whats-new-dialog.tsx).
    whats_new: String,
    /// Help ▸ Report a Problem…, the command table's `report-problem`
    /// command (src/app/report-problem.ts).
    report_problem: String,
    /// View → Margin review, sent while the focused window shows a linked
    /// Overleaf project's source (src/overleaf/margin-review-mode.ts).
    #[serde(default)]
    margin_review: Option<MarginReviewLabels>,
}

/// One File ▸ Open Recent entry.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct RecentProjectItem {
    name: String,
    path: String,
}

/// The margin review switch's titles and the sending window's choice.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct MarginReviewLabels {
    title: String,
    auto: String,
    markers: String,
    off: String,
    mode: String,
}

/// Menu ids of the margin review choices; the part after the prefix is the
/// mode the web UI names.
const MARGIN_REVIEW_PREFIX: &str = "margin-review:";
/// The event a choice sends to the window it was made in.
const MARGIN_REVIEW_EVENT: &str = "margin-review-mode";

/// Menu ids of Edit ▸ Undo and Redo; the part after the prefix is the
/// direction the web UI names.
const EDIT_HISTORY_PREFIX: &str = "edit-history:";
/// The event Undo or Redo sends to the focused window, which hands it to
/// the focused editor (src/app/edit-history.ts).
const EDIT_HISTORY_EVENT: &str = "edit-history";

/// Menu ids of View ▸ Bigger, Smaller and Actual Size; the part after the
/// prefix is the change the web UI names.
const INTERFACE_ZOOM_PREFIX: &str = "interface-zoom:";
/// The event a size change sends to the focused window, which steps its
/// interface size as ⌘+, ⌘− or ⌘0 would.
const INTERFACE_ZOOM_EVENT: &str = "interface-zoom";

/// Menu ids of items that run one of the page's command-table commands —
/// File's project items, Lattice ▸ Settings… and Help ▸ Report a Problem…;
/// the part after the prefix is the command's id.
const FILE_COMMAND_PREFIX: &str = "file-command:";
/// The event such an item sends to the focused workspace window.
const FILE_COMMAND_EVENT: &str = "file-command";
/// Menu ids of File ▸ Open Recent's entries; the part after the prefix is the
/// project's path.
const OPEN_RECENT_PREFIX: &str = "open-recent:";
/// The event an Open Recent entry sends to the focused workspace window,
/// which opens the project as the switcher would.
const OPEN_RECENT_EVENT: &str = "open-recent";

/// The menu id of Help ▸ What's New, and the event it sends to the focused
/// window, which opens its release notes sheet.
const WHATS_NEW: &str = "whats-new";

/// The menu id of Lattice ▸ Check for Updates… (or Restart to Update…), and
/// the event it sends to the focused window, whose updater checks, offers
/// the held update again, or restarts into the installed one.
const CHECK_FOR_UPDATES: &str = "check-for-updates";

/// The menu id of Lattice ▸ Quit, which saves every window before it exits.
const QUIT: &str = "quit";

/// The menu id of File ▸ Close Tab, and the event it sends to the focused
/// workspace window.
const CLOSE_TAB: &str = "close-tab";
/// The menu id of Close Window (⇧⌘W), which closes the focused window as its
/// close button does: the page saves first (save_before_close.rs).
const CLOSE_WINDOW: &str = "close-window";

/// What a Close Tab or Close Window chosen in the menu does to the focused
/// window labelled `label`.
#[derive(Debug, PartialEq, Eq)]
enum CloseAction {
    /// A workspace window's page closes its document tab, or else itself.
    AskPage,
    /// Close the window.
    Window,
}

fn close_action(id: &str, label: &str) -> Option<CloseAction> {
    match id {
        CLOSE_TAB if crate::is_workspace_window(label) => Some(CloseAction::AskPage),
        // A window without Lattice's page (the Overleaf sign-in) has no tabs.
        CLOSE_TAB | CLOSE_WINDOW => Some(CloseAction::Window),
        _ => None,
    }
}

/// The attribution Trellis's license asks shipped apps to show.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const TRELLIS_ATTRIBUTION: &str =
    "Uses Trellis by DanFessler - github.com/DanFessler/trellis";

/// Tauri's default macOS menu (`Menu::default`), with translated titles. The
/// Window and Help submenus keep Tauri's ids so they stay registered as
/// NSApp's windows and help menus.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn build_menu<R: Runtime>(
    app: &AppHandle<R>, labels: &MenuLabels,
) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|publisher| vec![publisher]),
        // Trellis's license (commercial tier) requires this attribution; the
        // non-commercial tier asks for it too. See NOTICE.
        credits: Some(TRELLIS_ATTRIBUTION.to_string()),
        ..Default::default()
    };
    // The project title menu's actions, where a Mac user looks for them
    // first. The page binds ⇧⌘N, ⌘O and ⌘, too and sees them first, as with
    // ⌘W below, so one key runs its command once.
    let page_command = |command: &str, title: &str, enabled: bool, accelerator: Option<&str>| {
        MenuItem::with_id(
            app,
            format!("{FILE_COMMAND_PREFIX}{command}"),
            title,
            enabled,
            accelerator,
        )
    };
    let app_menu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[&PredefinedMenuItem::about(app, Some(labels.about.as_str()), Some(about))?],
    )?;
    if let Some(title) = &labels.check_for_updates {
        app_menu.append(&MenuItem::with_id(app, CHECK_FOR_UPDATES, title, true, None::<&str>)?)?;
    }
    app_menu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &page_command("settings", &labels.settings, true, Some("CmdOrCtrl+,"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, Some(labels.services.as_str()))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some(labels.hide.as_str()))?,
        &PredefinedMenuItem::hide_others(app, Some(labels.hide_others.as_str()))?,
        &PredefinedMenuItem::show_all(app, Some(labels.show_all.as_str()))?,
        &PredefinedMenuItem::separator(app)?,
        // Not the predefined item: its `terminate:` ends the process
        // before any window can save its last edits (save_before_close.rs).
        &MenuItem::with_id(app, QUIT, &labels.quit, true, Some("CmdOrCtrl+Q"))?,
    ])?;
    // ⌘W closes a tab, as in a browser or an editor, and ⇧⌘W the window.
    // Not the predefined Close Window, whose ⌘W closed the whole project when
    // a tab was meant. The page binds ⌘W too and sees it first; this runs for
    // a click, or for a ⌘W no page listener took.
    let close_window = || {
        MenuItem::with_id(app, CLOSE_WINDOW, &labels.close_window, true, Some("CmdOrCtrl+Shift+W"))
    };
    let recents = labels
        .recent_projects
        .iter()
        .map(|recent| {
            MenuItem::with_id(
                app,
                format!("{OPEN_RECENT_PREFIX}{}", recent.path),
                &recent.name,
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let recent_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        recents.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<R>).collect();
    // With no other project to offer, Open Recent stays in its place, dimmed.
    let open_recent =
        Submenu::with_items(app, &labels.open_recent, !recents.is_empty(), &recent_items)?;
    let file_menu = Submenu::with_items(
        app,
        &labels.file,
        true,
        &[
            &page_command("new-project", &labels.new_project, true, Some("CmdOrCtrl+Shift+N"))?,
            &page_command("open-folder", &labels.open_folder, true, Some("CmdOrCtrl+O"))?,
            &open_recent,
            &PredefinedMenuItem::separator(app)?,
            &page_command("clone-repository", &labels.clone_repository, true, None)?,
            &page_command("overleaf-open", &labels.open_from_overleaf, true, None)?,
            &page_command("import-zip", &labels.import_zip, true, None)?,
            &PredefinedMenuItem::separator(app)?,
            &page_command("export-zip", &labels.export_zip, labels.project_open, None)?,
            &page_command("export-arxiv", &labels.export_arxiv, labels.project_open, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, CLOSE_TAB, &labels.close_tab, true, Some("CmdOrCtrl+W"))?,
            &close_window()?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        &labels.edit,
        true,
        &[
            // Not the predefined items: theirs send AppKit's `undo:`, which
            // reaches only WebKit's own undo stack, and that holds no edit
            // CodeMirror or ProseMirror made. The page sees ⌘Z first and its
            // editors take it; these run for a click, or for a ⌘Z no editor
            // took (src/app/edit-history.ts).
            &MenuItem::with_id(
                app,
                format!("{EDIT_HISTORY_PREFIX}undo"),
                &labels.undo,
                true,
                Some("CmdOrCtrl+Z"),
            )?,
            &MenuItem::with_id(
                app,
                format!("{EDIT_HISTORY_PREFIX}redo"),
                &labels.redo,
                true,
                Some("CmdOrCtrl+Shift+Z"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(labels.cut.as_str()))?,
            &PredefinedMenuItem::copy(app, Some(labels.copy.as_str()))?,
            &PredefinedMenuItem::paste(app, Some(labels.paste.as_str()))?,
            &PredefinedMenuItem::select_all(app, Some(labels.select_all.as_str()))?,
        ],
    )?;
    // The page binds the same keys and sees them first, so these run for a
    // click, or for a key no page listener took (focus in the Agent frame).
    let zoom_item = |change: &str, title: &str, accelerator: &str| {
        MenuItem::with_id(
            app,
            format!("{INTERFACE_ZOOM_PREFIX}{change}"),
            title,
            true,
            Some(accelerator),
        )
    };
    let view_menu = Submenu::with_items(
        app,
        &labels.view,
        true,
        &[
            &zoom_item("reset", &labels.actual_size, "CmdOrCtrl+0")?,
            &zoom_item("in", &labels.zoom_in, "CmdOrCtrl+=")?,
            &zoom_item("out", &labels.zoom_out, "CmdOrCtrl+-")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some(labels.fullscreen.as_str()))?,
        ],
    )?;
    if let Some(margin) = &labels.margin_review {
        let choices = [("auto", &margin.auto), ("markers", &margin.markers), ("off", &margin.off)]
            .into_iter()
            .map(|(mode, title)| {
                CheckMenuItem::with_id(
                    app,
                    format!("{MARGIN_REVIEW_PREFIX}{mode}"),
                    title,
                    true,
                    margin.mode == mode,
                    None::<&str>,
                )
            })
            .collect::<tauri::Result<Vec<_>>>()?;
        let items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            choices.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<R>).collect();
        view_menu.append(&PredefinedMenuItem::separator(app)?)?;
        view_menu.append(&Submenu::with_items(app, &margin.title, true, &items)?)?;
    }
    let window_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        &labels.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(labels.minimize.as_str()))?,
            &PredefinedMenuItem::maximize(app, Some(labels.zoom.as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &close_window()?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::HELP_SUBMENU_ID,
        &labels.help,
        true,
        &[
            &MenuItem::with_id(app, WHATS_NEW, &labels.whats_new, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &page_command("report-problem", &labels.report_problem, true, None)?,
        ],
    )?;
    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

/// A margin review choice goes to the window it was made in, which keeps it
/// as its own and sends the menu back with the new check; Undo and Redo go
/// to the focused window's focused editor, and an interface size change,
/// What's New and Check for Updates to the focused window; a PDF window's go
/// to its owner (`menu_route`). Quit asks every window to save first.
pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    use tauri::{Emitter, Manager};

    let id = event.id().as_ref();
    if id == QUIT {
        crate::save_before_close::quit(app);
        return;
    }
    if id == CLOSE_TAB || id == CLOSE_WINDOW {
        let Some(label) = crate::macos_window::focused_window_label() else { return };
        match close_action(id, &label) {
            Some(CloseAction::AskPage) => {
                let _ = app.emit_to(tauri::EventTarget::webview_window(&label), CLOSE_TAB, ());
            }
            Some(CloseAction::Window) => {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.close();
                }
            }
            None => {}
        }
        return;
    }
    let (name, payload) = if let Some(event) = file_menu_event(id) {
        event
    } else if let Some(mode) = id.strip_prefix(MARGIN_REVIEW_PREFIX) {
        (MARGIN_REVIEW_EVENT, mode)
    } else if let Some(direction) = id.strip_prefix(EDIT_HISTORY_PREFIX) {
        (EDIT_HISTORY_EVENT, direction)
    } else if let Some(change) = id.strip_prefix(INTERFACE_ZOOM_PREFIX) {
        (INTERFACE_ZOOM_EVENT, change)
    } else if id == WHATS_NEW || id == CHECK_FOR_UPDATES {
        (id, "")
    } else {
        return;
    };
    let Some(focused) = crate::macos_window::focused_window_label() else { return };
    let owner = app.state::<crate::app_state::AppState>().pdf_windows.owner(&focused);
    match menu_route(name, &focused, owner) {
        Some(MenuRoute::NativeEditHistory) => send_native_edit_history(app, payload == "redo"),
        Some(MenuRoute::Page { label, raise }) => {
            if raise {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            let _ = app.emit_to(tauri::EventTarget::webview_window(label), name, payload);
        }
        None => {}
    }
}

/// Where a menu command's event `name`, made in the window `focused`, goes.
#[derive(Debug, PartialEq)]
enum MenuRoute {
    /// WebKit's own Undo or Redo in the focused window.
    NativeEditHistory,
    /// The page of the window `label`, brought forward first when `raise`.
    Page { label: String, raise: bool },
}

/// Undo and Redo stay with the focused window: a PDF window's go to WebKit,
/// for its own fields, never to an editor on the other screen. Other commands
/// made in a PDF window go to the workspace window that owns it (`owner`),
/// which holds the project and the settings they act on, and which comes
/// forward for a project command, a recent project, What's New or Check for
/// Updates. Only a window with Lattice's page runs File commands; the
/// Overleaf sign-in has none. None when nothing runs the command.
fn menu_route(name: &str, focused: &str, owner: Option<String>) -> Option<MenuRoute> {
    if name == EDIT_HISTORY_EVENT && !asks_page_for_edit_history(focused) {
        return Some(MenuRoute::NativeEditHistory);
    }
    let label =
        if crate::pdf_window::is_pdf_window(focused) { owner? } else { focused.to_string() };
    let file_command = name == FILE_COMMAND_EVENT || name == OPEN_RECENT_EVENT;
    if file_command && !crate::is_workspace_window(&label) {
        return None;
    }
    let raise =
        label != focused && (file_command || name == WHATS_NEW || name == CHECK_FOR_UPDATES);
    Some(MenuRoute::Page { label, raise })
}

/// The event and payload a File ▸ project item or Open Recent entry sends.
fn file_menu_event(id: &str) -> Option<(&'static str, &str)> {
    if let Some(command) = id.strip_prefix(FILE_COMMAND_PREFIX) {
        Some((FILE_COMMAND_EVENT, command))
    } else {
        id.strip_prefix(OPEN_RECENT_PREFIX).map(|path| (OPEN_RECENT_EVENT, path))
    }
}

/// Whether Undo or Redo in the window labelled `label` goes to its page,
/// which hands it to the focused editor (src/app/edit-history.ts). A window
/// without Lattice's page (the Overleaf sign-in) has no listener for the
/// event, so its fields get WebKit's own undo straight away.
fn asks_page_for_edit_history(label: &str) -> bool {
    crate::is_workspace_window(label)
}

/// What the predefined Undo and Redo items did: send AppKit's `undo:` or
/// `redo:` down the key window's responder chain, where WebKit undoes the
/// typing it recorded itself, in a text field or a frame. The web UI asks for
/// this when no editor of its own took the command.
#[cfg(target_os = "macos")]
pub(crate) fn send_native_edit_history<R: Runtime>(app: &AppHandle<R>, redo: bool) {
    let _ = app.run_on_main_thread(move || {
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{class, msg_send, sel};

        let action = if redo { sel!(redo:) } else { sel!(undo:) };
        let nothing = std::ptr::null_mut::<AnyObject>();
        // SAFETY: on the main thread; a nil target and sender are what a menu
        // item without a target sends, and AppKit finds the target in the
        // responder chain.
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: Bool = msg_send![app, sendAction: action, to: nothing, from: nothing];
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn send_native_edit_history<R: Runtime>(_app: &AppHandle<R>, _redo: bool) {}

/// The bundle localizations `AppleLanguages` may name: the ones Info.plist
/// declares in `CFBundleLocalizations`.
pub(crate) fn bundle_language(language: &str) -> Option<&'static str> {
    match language {
        "en" => Some("en"),
        "zh-Hans" => Some("zh-Hans"),
        _ => None,
    }
}

/// Pin (or, with `None`, stop pinning) the language AppKit and WebKit use for
/// this app's own panels, context menus and system-inserted menu items.
///
/// This writes `AppleLanguages` in Lattice's own defaults domain — the same
/// key System Settings › Language & Region › Applications writes — so no other
/// app and no system setting changes. AppKit reads it at launch, so it applies
/// from the next launch. A value Lattice did not write (a per-app language the
/// user chose in System Settings) is left alone when the in-app setting goes
/// back to following the system.
#[cfg(target_os = "macos")]
pub(crate) fn set_bundle_language(language: Option<&'static str>) {
    use objc2_foundation::{NSArray, NSString, NSUserDefaults};

    const APPLE_LANGUAGES: &str = "AppleLanguages";
    const PINNED_BY_LATTICE: &str = "LatticePinnedAppleLanguage";
    let defaults = NSUserDefaults::standardUserDefaults();
    let languages_key = NSString::from_str(APPLE_LANGUAGES);
    let marker_key = NSString::from_str(PINNED_BY_LATTICE);
    match language {
        Some(language) => {
            let value = NSString::from_str(language);
            let languages = NSArray::from_retained_slice(std::slice::from_ref(&value));
            // SAFETY: both values are property-list objects (an NSArray of
            // NSString, and an NSString), which is all NSUserDefaults accepts.
            unsafe {
                defaults.setObject_forKey(Some(&languages), &languages_key);
                defaults.setObject_forKey(Some(&value), &marker_key);
            }
        }
        None => {
            let Some(pinned) = defaults.stringForKey(&marker_key) else { return };
            let current = defaults
                .stringArrayForKey(&languages_key)
                .map(|languages| languages.iter().map(|item| item.to_string()).collect::<Vec<_>>());
            if current.as_deref() == Some(&[pinned.to_string()][..]) {
                defaults.removeObjectForKey(&languages_key);
            }
            defaults.removeObjectForKey(&marker_key);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_bundle_language(_language: Option<&'static str>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_labels_reject_missing_and_unknown_titles() {
        // The payload `nativeMenuLabels()` sends, shared with native-locale.test.ts.
        let complete: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/menu-labels.json"))
                .expect("fixture");
        let labels: MenuLabels = serde_json::from_value(complete.clone()).expect("labels");
        assert_eq!(labels.copy, "拷贝");
        assert_eq!(labels.recent_projects[0].path, "/Users/me/论文初稿");
        assert!(labels.project_open);
        assert_eq!(labels.check_for_updates.as_deref(), Some("检查更新…"));
        // Where Lattice does not update itself, the page sends no title and
        // the item is left out.
        let mut no_updates = complete.clone();
        no_updates
            .as_object_mut()
            .unwrap()
            .insert("checkForUpdates".into(), serde_json::Value::Null);
        let labels: MenuLabels =
            serde_json::from_value(no_updates).expect("labels without updates");
        assert!(labels.check_for_updates.is_none());
        let mut missing = complete.clone();
        missing.as_object_mut().unwrap().remove("copy");
        assert!(serde_json::from_value::<MenuLabels>(missing).is_err());
        let mut unknown = complete.clone();
        unknown.as_object_mut().unwrap().insert("print".into(), "打印".into());
        assert!(serde_json::from_value::<MenuLabels>(unknown).is_err());
        // The margin review switch comes only from a window that shows it.
        let mut margin = complete;
        margin.as_object_mut().unwrap().insert(
            "marginReview".into(),
            serde_json::json!({ "title": "页边审阅", "auto": "自动", "markers": "仅标记", "off": "关闭", "mode": "auto" }),
        );
        let labels: MenuLabels = serde_json::from_value(margin).expect("margin review labels");
        assert_eq!(labels.margin_review.map(|margin| margin.mode).as_deref(), Some("auto"));
    }

    /// Tauri's `unstable` feature builds every window's WebView as a child
    /// WebView, and wry sends a child WebView's ⌘ keys straight to this menu:
    /// the page never sees ⌘Z or ⇧⌘Z, so Edit ▸ Undo runs WebKit's own undo,
    /// which undoes nothing in CodeMirror, ProseMirror or a React field.
    #[test]
    fn tauri_unstable_stays_off_so_the_page_sees_command_keys_first() {
        let manifest = include_str!("../Cargo.toml");
        let tauri = manifest
            .lines()
            .find(|line| line.starts_with("tauri = "))
            .expect("the tauri dependency line");
        assert!(!tauri.contains("\"unstable\""), "{tauri}");
    }

    #[test]
    fn close_tab_asks_a_workspace_page_and_close_window_closes_the_window() {
        assert_eq!(close_action(CLOSE_TAB, "project-2"), Some(CloseAction::AskPage));
        assert_eq!(close_action(CLOSE_TAB, "main"), Some(CloseAction::AskPage));
        assert_eq!(close_action(CLOSE_TAB, "overleaf-login"), Some(CloseAction::Window));
        assert_eq!(close_action(CLOSE_WINDOW, "project-2"), Some(CloseAction::Window));
        assert_eq!(close_action(QUIT, "main"), None);
    }

    #[test]
    fn file_menu_items_name_the_command_or_the_project_path() {
        assert_eq!(
            file_menu_event("file-command:new-project"),
            Some(("file-command", "new-project"))
        );
        assert_eq!(
            file_menu_event("open-recent:/Users/me/Paper: draft"),
            Some(("open-recent", "/Users/me/Paper: draft"))
        );
        assert_eq!(file_menu_event(CLOSE_TAB), None);
        assert_eq!(file_menu_event(WHATS_NEW), None);
        assert_eq!(file_menu_event(CHECK_FOR_UPDATES), None);
        // Lattice ▸ Settings… and Help ▸ Report a Problem… run page commands too.
        assert_eq!(file_menu_event("file-command:settings"), Some(("file-command", "settings")));
        assert_eq!(
            file_menu_event("file-command:report-problem"),
            Some(("file-command", "report-problem"))
        );
    }

    #[test]
    fn undo_and_redo_reach_webkit_directly_in_a_window_without_lattice_page() {
        assert!(asks_page_for_edit_history("main"));
        assert!(asks_page_for_edit_history("project-2"));
        assert!(!asks_page_for_edit_history("overleaf-login"));
    }

    #[test]
    fn a_pdf_windows_menu_commands_go_to_its_owner_but_undo_stays_with_it() {
        let owner = || Some("project-2".to_string());
        let page = |label: &str, raise: bool| Some(MenuRoute::Page { label: label.into(), raise });
        // The PDF window's page has no project, editor or menu listeners.
        assert_eq!(menu_route(FILE_COMMAND_EVENT, "pdf-3", owner()), page("project-2", true));
        assert_eq!(menu_route(OPEN_RECENT_EVENT, "pdf-3", owner()), page("project-2", true));
        assert_eq!(menu_route(WHATS_NEW, "pdf-3", owner()), page("project-2", true));
        assert_eq!(menu_route(CHECK_FOR_UPDATES, "pdf-3", owner()), page("project-2", true));
        assert_eq!(menu_route(INTERFACE_ZOOM_EVENT, "pdf-3", owner()), page("project-2", false));
        assert_eq!(menu_route(WHATS_NEW, "pdf-3", None), None);
        // ⌘Z in the PDF window must not undo the owner's last source edit.
        assert_eq!(
            menu_route(EDIT_HISTORY_EVENT, "pdf-3", owner()),
            Some(MenuRoute::NativeEditHistory)
        );
        assert_eq!(
            menu_route(EDIT_HISTORY_EVENT, "pdf-3", None),
            Some(MenuRoute::NativeEditHistory)
        );
        // Elsewhere, the focused window's own page, as before.
        assert_eq!(menu_route(EDIT_HISTORY_EVENT, "main", None), page("main", false));
        assert_eq!(menu_route(FILE_COMMAND_EVENT, "project-2", None), page("project-2", false));
        assert_eq!(menu_route(FILE_COMMAND_EVENT, "overleaf-login", None), None);
        assert_eq!(
            menu_route(EDIT_HISTORY_EVENT, "overleaf-login", None),
            Some(MenuRoute::NativeEditHistory)
        );
    }

    #[test]
    fn only_declared_bundle_localizations_can_be_pinned() {
        assert_eq!(bundle_language("en"), Some("en"));
        assert_eq!(bundle_language("zh-Hans"), Some("zh-Hans"));
        for other in ["zh-CN", "fr", "", "en;rm -rf"] {
            assert_eq!(bundle_language(other), None, "{other}");
        }
    }
}
