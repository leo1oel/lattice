//! Process-wide setup: Lattice's theme (palette, fonts, GPUI Kit's theme and
//! the editor's code theme), Zed's settings, editor, search and Vim; key
//! bindings.

use gpui::{App, Global};
use lattice_ui::{ActiveLattice as _, Appearance, LatticeTheme, editor_theme};
use settings::{KeymapFile, Settings as _, SettingsStore};

/// Settings the app runs Zed's editor with. Soft wrap matches Lattice's
/// CodeMirror editor, which wraps lines; the gutter shows line numbers only,
/// as Lattice's does; Zed's AI, git and telemetry features have nothing to
/// attach to here. The theme, the fonts and Vim are filled in from Lattice's
/// theme and the toggle.
const BASE_SETTINGS: &str = r#"{
  "theme": { "mode": "THEME_MODE", "light": "LIGHT_THEME", "dark": "DARK_THEME" },
  "buffer_font_family": "EDITOR_FONT",
  "buffer_font_size": 14,
  "buffer_line_height": { "custom": 1.6 },
  "ui_font_family": "UI_FONT",
  "ui_font_size": 13,
  "soft_wrap": "editor_width",
  "show_edit_predictions": false,
  "minimap": { "show": "never" },
  "git": { "inline_blame": { "enabled": false }, "git_gutter": "hide" },
  "gutter": {
    "line_numbers": true,
    "min_line_number_digits": 4,
    "runnables": false,
    "breakpoints": false,
    "bookmarks": false,
    "folds": false
  },
  "current_line_highlight": "line",
  "scrollbar": {
    "show": "system",
    "cursors": false,
    "git_diff": false,
    "selected_text": false,
    "selected_symbol": false,
    "diagnostics": "none"
  },
  "show_wrap_guides": false,
  "indent_guides": { "enabled": false },
  "telemetry": { "diagnostics": false, "metrics": false },
  "vim_mode": VIM_MODE
}"#;

const VIM_KEYMAP_PATH: &str = "keymaps/vim.json";

/// `LATTICE_APPEARANCE=light|dark` fixes the appearance instead of following
/// the system's, for screenshots and scripted runs.
pub(crate) fn appearance_override() -> Option<Appearance> {
    match std::env::var("LATTICE_APPEARANCE").as_deref() {
        Ok("light") => Some(Appearance::Light),
        Ok("dark") => Some(Appearance::Dark),
        _ => None,
    }
}

/// The appearance the writer chose from the palette, over the system's.
#[derive(Default)]
struct AppearanceChoice(Option<Appearance>);

impl Global for AppearanceChoice {}

/// Whether the writer fixed the appearance (or the run did).
pub(crate) fn appearance_chosen(cx: &App) -> bool {
    appearance_override().is_some()
        || cx
            .try_global::<AppearanceChoice>()
            .is_some_and(|choice| choice.0.is_some())
}

/// Fix the appearance, or (`None`) follow the system's (`system`) again,
/// unless the run fixed one.
pub(crate) fn choose_appearance(appearance: Option<Appearance>, system: Appearance, cx: &mut App) {
    cx.set_global(AppearanceChoice(appearance));
    LatticeTheme::set_appearance(
        appearance.or_else(appearance_override).unwrap_or(system),
        cx,
    );
}

/// `scripted`: a scenario run, which keeps the layouts in memory unless
/// `LATTICE_GPUI_STATE_DIR` names a directory.
pub fn init(scripted: bool, cx: &mut App) {
    release_channel::init(semver::Version::new(0, 1, 0), cx);
    settings::init(cx);
    theme_settings::init(theme::LoadThemes::All(Box::new(assets::Assets)), cx);
    crate::assets::load_fonts(cx);
    gpui_kit::init(cx);
    LatticeTheme::init(appearance_override(), cx);
    load_code_themes(cx);
    apply_settings(std::env::var_os("LATTICE_GPUI_VIM").is_some(), cx);
    // Zed's own settings observer only reloads the theme when the selected
    // name differs from the one it saw last, which can run before the Lattice
    // themes are registered; select the theme now that they are.
    theme_settings::reload_theme(cx);
    editor::init(cx);
    search::init(cx);
    vim::init(cx);
    crate::latex::init(cx);
    load_keymaps(cx);
    crate::shell::workspaces::Workspaces::init(scripted, cx);
    crate::shell::menus::install(cx);
    // The app ends with its last window, as the Tauri app does.
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();

    // A change of appearance, tint, accent or code theme reaches the editor.
    cx.observe_global::<LatticeTheme>(|cx| {
        load_code_themes(cx);
        apply_settings(vim_mode_enabled(cx), cx);
        theme_settings::reload_theme(cx);
    })
    .detach();
}

/// Register the Lattice code themes with Zed's theme registry, in the current
/// tint and accent.
fn load_code_themes(cx: &mut App) {
    let palette = cx.lattice().palette.clone();
    let registry = theme::ThemeRegistry::global(cx);
    for family in editor_theme::zed_theme_families(palette.tint, palette.accent_preset) {
        if let Err(error) = theme_settings::load_user_theme(&registry, &family) {
            log::error!("could not load a Lattice code theme: {error:#}");
        }
    }
}

fn apply_settings(vim_mode: bool, cx: &mut App) {
    let lattice = cx.lattice();
    let code_theme = lattice.code_theme;
    let json = BASE_SETTINGS
        .replace(
            "THEME_MODE",
            match lattice.palette.appearance {
                Appearance::Light => "light",
                Appearance::Dark => "dark",
            },
        )
        .replace("LIGHT_THEME", &code_theme.zed_theme_name(Appearance::Light))
        .replace("DARK_THEME", &code_theme.zed_theme_name(Appearance::Dark))
        .replace("EDITOR_FONT", &lattice.fonts.editor)
        .replace("UI_FONT", &lattice.fonts.ui)
        .replace("VIM_MODE", if vim_mode { "true" } else { "false" });
    SettingsStore::update(cx, |store, cx| {
        let result = store.set_user_settings(&json, cx);
        if let settings::ParseStatus::Failed { error } = &result.parse_status {
            log::error!("the editor settings did not parse: {error}");
        }
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
        crate::shell::bind_keys(cx);
    }
}

fn load_keymaps(cx: &mut App) {
    bind_asset_keymap(settings::DEFAULT_KEYMAP_PATH, cx);
    if vim_mode_enabled(cx) {
        bind_asset_keymap(VIM_KEYMAP_PATH, cx);
    }
    crate::shell::bind_keys(cx);
}

/// Zed's keymaps name actions from crates this app does not include (panes,
/// the agent, the terminal); those entries are skipped.
fn bind_asset_keymap(path: &str, cx: &mut App) {
    match KeymapFile::load_asset_allow_partial_failure(path, cx) {
        Ok(bindings) => cx.bind_keys(bindings),
        Err(error) => log::warn!("{error:#}"),
    }
}
