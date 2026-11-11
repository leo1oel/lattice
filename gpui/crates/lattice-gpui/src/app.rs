//! Process-wide setup: Zed's settings, themes, editor, search and Vim; GPUI
//! Kit; key bindings.

use gpui::App;
use settings::{KeymapFile, Settings as _, SettingsStore};

/// Settings the prototype runs Zed's editor with. Soft wrap matches Lattice's
/// CodeMirror editor, which wraps lines; Zed's AI, git and telemetry features
/// have nothing to attach to here.
const BASE_SETTINGS: &str = r#"{
  "theme": { "mode": "system", "light": "One Light", "dark": "One Dark" },
  "buffer_font_size": 14,
  "ui_font_size": 14,
  "soft_wrap": "editor_width",
  "show_edit_predictions": false,
  "minimap": { "show": "never" },
  "git": { "inline_blame": { "enabled": false } },
  "telemetry": { "diagnostics": false, "metrics": false },
  "vim_mode": VIM_MODE
}"#;

const VIM_KEYMAP_PATH: &str = "keymaps/vim.json";

pub fn init(cx: &mut App) {
    release_channel::init(semver::Version::new(0, 1, 0), cx);
    settings::init(cx);
    apply_settings(std::env::var_os("LATTICE_GPUI_VIM").is_some(), cx);
    theme_settings::init(theme::LoadThemes::All(Box::new(assets::Assets)), cx);
    crate::assets::load_fonts(cx);
    editor::init(cx);
    search::init(cx);
    vim::init(cx);
    gpui_kit::init(cx);
    gpui_kit::component::Theme::sync_system_appearance(None, cx);
    crate::latex::init(cx);
    load_keymaps(cx);
}

fn apply_settings(vim_mode: bool, cx: &mut App) {
    let json = BASE_SETTINGS.replace("VIM_MODE", if vim_mode { "true" } else { "false" });
    SettingsStore::update(cx, |store, cx| {
        let _ = store.set_user_settings(&json, cx);
    });
}

pub fn vim_mode_enabled(cx: &App) -> bool {
    vim_mode_setting::VimModeSetting::get_global(cx).0
}

/// Turn Vim mode on or off for every editor. Zed's Vim attaches itself to
/// each editor when the setting changes; its key bindings are loaded once.
pub fn set_vim_mode(enabled: bool, cx: &mut App) {
    apply_settings(enabled, cx);
    if enabled {
        bind_asset_keymap(VIM_KEYMAP_PATH, cx);
    }
}

fn load_keymaps(cx: &mut App) {
    bind_asset_keymap(settings::DEFAULT_KEYMAP_PATH, cx);
    if vim_mode_enabled(cx) {
        bind_asset_keymap(VIM_KEYMAP_PATH, cx);
    }
    crate::shell::bind_keys(cx);
}

/// Zed's keymaps name actions from crates this prototype does not include
/// (panes, the agent, the terminal); those entries are skipped.
fn bind_asset_keymap(path: &str, cx: &mut App) {
    match KeymapFile::load_asset_allow_partial_failure(path, cx) {
        Ok(bindings) => cx.bind_keys(bindings),
        Err(error) => log::warn!("{error:#}"),
    }
}
