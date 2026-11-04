//! The website stays in a normal single-WebView window; navigation controls
//! belong to the native menu or the separate trusted address window.
use super::*;
use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, Submenu};

const MENU: &str = "browser-navigation";
const PREFIX: &str = "browser-navigation:";
const ITEMS: &[(&str, &str, &str, Option<&str>)] = &[
    ("back", "Back", "后退", Some("CmdOrCtrl+[")),
    ("forward", "Forward", "前进", Some("CmdOrCtrl+]")),
    ("reload", "Reload", "重新加载", Some("CmdOrCtrl+R")),
    ("address", "Address and navigation…", "地址与导航…", Some("CmdOrCtrl+L")),
    ("external", "Open in default browser", "在默认浏览器中打开", None),
    ("close", "Close browser", "关闭浏览器", None),
];

fn metadata<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Option<bool> {
    let state = app.try_state::<WebBrowsers>()?;
    let sessions = state.0.lock().ok()?;
    sessions
        .iter()
        .find(|(controls, session)| controls.as_str() == label || session.content == label)
        .map(|(_, session)| session.chinese)
}

pub(super) fn append<R: Runtime>(app: &tauri::AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    if menu.get(MENU).is_some() {
        return Ok(());
    }
    let Some(state) = app.try_state::<WebBrowsers>() else {
        return Ok(());
    };
    let Some(chinese) = state
        .0
        .lock()
        .ok()
        .and_then(|sessions| sessions.values().next().map(|session| session.chinese))
    else {
        return Ok(());
    };
    let active = crate::macos_window::focused_window_label()
        .is_some_and(|label| metadata(app, &label).is_some());
    let items: Vec<_> = ITEMS
        .iter()
        .map(|(action, english, translated, accelerator)| {
            MenuItem::with_id(
                app,
                format!("{PREFIX}{action}"),
                if chinese { *translated } else { *english },
                active,
                *accelerator,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let references: Vec<&dyn IsMenuItem<R>> =
        items.iter().map(|item| item as &dyn IsMenuItem<R>).collect();
    let submenu = Submenu::with_id_and_items(
        app,
        MENU,
        if chinese { "浏览器" } else { "Browser" },
        active,
        &references,
    )?;
    menu.insert(&submenu, menu.items()?.len().saturating_sub(2))
}

pub(super) fn focus<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    let Some(menu) = app.menu() else {
        return;
    };
    let selected = metadata(app, label);
    if selected.is_some() {
        let _ = append(app, &menu);
    }
    let active = selected.is_some();
    if let Some(MenuItemKind::Submenu(submenu)) = menu.get(MENU) {
        let _ = submenu.set_enabled(active);
        if let Some(chinese) = selected {
            let _ = submenu.set_text(if chinese { "浏览器" } else { "Browser" });
        }
        for (action, english, translated, _) in ITEMS {
            if let Some(MenuItemKind::MenuItem(item)) = submenu.get(&format!("{PREFIX}{action}")) {
                let _ = item.set_enabled(active);
                if let Some(chinese) = selected {
                    let _ = item.set_text(if chinese { *translated } else { *english });
                }
            }
        }
    }
}

pub(super) fn handle(app: &AppHandle, event: &tauri::menu::MenuEvent) -> bool {
    let Some(action) = event.id().as_ref().strip_prefix(PREFIX) else {
        return false;
    };
    let Some(label) = crate::macos_window::focused_window_label() else {
        return true;
    };
    let state = app.state::<WebBrowsers>();
    let window = state.0.lock().ok().and_then(|sessions| {
        sessions
            .iter()
            .find(|(controls, session)| controls.as_str() == label || session.content == label)
            .map(|(_, session)| session.content.clone())
    });
    if let Some(window) = window {
        let _ = perform_action(app, &window, action);
    }
    true
}
