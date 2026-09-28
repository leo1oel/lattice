//! The native surfaces that follow Lattice's own interface language rather
//! than the web UI: the macOS menu bar, and the language AppKit and WebKit
//! pick for the panels and context menus they draw themselves.
//!
//! The web UI owns the language setting and its translations, so it supplies
//! the menu labels; the host only lays them out. Every window sends the same
//! labels for the same setting, and the menu is app-wide, so the last sender
//! wins harmlessly.

use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Translated titles for the app menu. Predefined items keep their native
/// actions and shortcuts; only their titles come from here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MenuLabels {
    about: String,
    services: String,
    hide: String,
    hide_others: String,
    show_all: String,
    quit: String,
    file: String,
    edit: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    view: String,
    fullscreen: String,
    window: String,
    minimize: String,
    zoom: String,
    close_window: String,
    help: String,
}

/// Tauri's default macOS menu (`Menu::default`), with translated titles. The
/// Window and Help submenus keep Tauri's ids so they stay registered as
/// NSApp's windows and help menus.
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
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(labels.about.as_str()), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(labels.services.as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(labels.hide.as_str()))?,
            &PredefinedMenuItem::hide_others(app, Some(labels.hide_others.as_str()))?,
            &PredefinedMenuItem::show_all(app, Some(labels.show_all.as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(labels.quit.as_str()))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        &labels.file,
        true,
        &[&PredefinedMenuItem::close_window(app, Some(labels.close_window.as_str()))?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        &labels.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(labels.undo.as_str()))?,
            &PredefinedMenuItem::redo(app, Some(labels.redo.as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(labels.cut.as_str()))?,
            &PredefinedMenuItem::copy(app, Some(labels.copy.as_str()))?,
            &PredefinedMenuItem::paste(app, Some(labels.paste.as_str()))?,
            &PredefinedMenuItem::select_all(app, Some(labels.select_all.as_str()))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        &labels.view,
        true,
        &[&PredefinedMenuItem::fullscreen(app, Some(labels.fullscreen.as_str()))?],
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        &labels.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(labels.minimize.as_str()))?,
            &PredefinedMenuItem::maximize(app, Some(labels.zoom.as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(labels.close_window.as_str()))?,
        ],
    )?;
    let help_menu =
        Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, &labels.help, true, &[])?;
    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

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
        let complete = serde_json::json!({
            "about": "关于 Lattice", "services": "服务", "hide": "隐藏 Lattice",
            "hideOthers": "隐藏其他", "showAll": "全部显示", "quit": "退出 Lattice",
            "file": "文件", "edit": "编辑", "undo": "撤销", "redo": "重做", "cut": "剪切",
            "copy": "拷贝", "paste": "粘贴", "selectAll": "全选", "view": "显示",
            "fullscreen": "进入全屏幕", "window": "窗口", "minimize": "最小化", "zoom": "缩放",
            "closeWindow": "关闭窗口", "help": "帮助",
        });
        let labels: MenuLabels = serde_json::from_value(complete.clone()).expect("labels");
        assert_eq!(labels.copy, "拷贝");
        let mut missing = complete.clone();
        missing.as_object_mut().unwrap().remove("copy");
        assert!(serde_json::from_value::<MenuLabels>(missing).is_err());
        let mut unknown = complete;
        unknown.as_object_mut().unwrap().insert("print".into(), "打印".into());
        assert!(serde_json::from_value::<MenuLabels>(unknown).is_err());
    }

    #[test]
    fn only_declared_bundle_localizations_can_be_pinned() {
        assert_eq!(bundle_language("en"), Some("en"));
        assert_eq!(bundle_language("zh-Hans"), Some("zh-Hans"));
        for other in ["zh-CN", "fr", "", "en;rm -rf"] {
            assert_eq!(bundle_language(other), None, "{other}");
        }
        let plist = include_str!("../Info.plist");
        assert!(plist.contains("<key>CFBundleLocalizations</key>"));
        for language in ["en", "zh-Hans"] {
            assert!(plist.contains(&format!("<string>{language}</string>")), "{language}");
        }
    }
}
