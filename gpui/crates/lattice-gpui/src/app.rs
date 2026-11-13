//! Process-wide setup: Lattice's theme (palette, fonts, GPUI Kit's theme and
//! the editor's code theme), Zed's settings, editor, search and Vim; key
//! bindings.

use gpui::{App, Global};
use lattice_ui::{ActiveLattice as _, Appearance, LatticeTheme, editor_theme};
use settings::{KeymapFile, Settings as _, SettingsStore};

/// Settings the app runs Zed's editor with. Soft wrap matches Lattice's
/// CodeMirror editor, which wraps lines; the gutter shows line numbers only,
/// as Lattice's does; completion offers only what Lattice's sources answer
/// (`lattice-editor`), not every word in the buffer; Zed's AI, git and
/// telemetry features have nothing to attach to here. Scrolling stops at the
/// last line, as CodeMirror's does, and Zed's scrollbar gives way to
/// Lattice's overlay one (`lattice-editor`'s `scrollbar.rs`). The theme, the
/// fonts and Vim are filled in from Lattice's theme and the toggle.
const BASE_SETTINGS: &str = r#"{
  "theme": { "mode": "THEME_MODE", "light": "LIGHT_THEME", "dark": "DARK_THEME" },
  "buffer_font_family": "EDITOR_FONT",
  "buffer_font_size": EDITOR_FONT_SIZE,
  "buffer_line_height": { "custom": EDITOR_LINE_HEIGHT },
  "ui_font_family": "UI_FONT",
  "ui_font_size": 13,
  "soft_wrap": "editor_width",
  "show_edit_predictions": false,
  "completions": { "words": "disabled" },
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
  "scroll_beyond_last_line": "off",
  "scrollbar": {
    "show": "never",
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
#[cfg(target_os = "macos")]
const EMACS_KEYMAP_PATH: &str = "keymaps/macos/emacs.json";
#[cfg(not(target_os = "macos"))]
const EMACS_KEYMAP_PATH: &str = "keymaps/linux/emacs.json";

/// The key context the shell carries while the Emacs keymap is chosen; the
/// Emacs bindings are loaded under it, so choosing another keymap turns them
/// off without unbinding anything.
pub const EMACS_CONTEXT: &str = "LatticeEmacs";

/// Which keymaps' bindings are loaded (each once, on first use).
#[derive(Default)]
struct LoadedKeymaps {
    /// The actions the keymaps name are registered (Zed's editor, Vim).
    ready: bool,
    vim: bool,
    emacs: bool,
}

impl Global for LoadedKeymaps {}

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
    // The writer's settings (or the Tauri app's, imported) before anything
    // is drawn: appearance, tint, accent, code theme, editor type, keymap,
    // language.
    crate::settings::init(scripted, cx);
    if std::env::var_os("LATTICE_GPUI_VIM").is_some() {
        crate::settings::update_appearance(cx, |appearance| {
            appearance.editor_keymap = lattice_settings::EditorKeymap::Vim
        });
    }
    // Zed's own settings observer only reloads the theme when the selected
    // name differs from the one it saw last, which can run before the Lattice
    // themes are registered; select the theme now that they are.
    theme_settings::reload_theme(cx);
    editor::init(cx);
    search::init(cx);
    vim::init(cx);
    lattice_editor::init(cx);
    load_keymaps(cx);
    crate::shell::workspaces::Workspaces::init(scripted, cx);
    crate::recents::RecentProjects::init(scripted, cx);
    crate::first_pages::FirstPages::init(scripted, cx);
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
        apply_editor_settings(cx);
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

/// The source editor's family for a face Settings offers by its CSS name.
fn editor_family(face: &str, default: &str) -> String {
    match face {
        "" => default.to_owned(),
        "ui-monospace" => "SF Mono".to_owned(),
        "system-ui" => ".SystemUIFont".to_owned(),
        "Inter Variable" => "Inter".to_owned(),
        face => face.to_owned(),
    }
}

/// Bring Zed's editor settings in line with Lattice's: the theme for the
/// appearance and code theme (a fixed variant shows in either appearance),
/// the editor's face, size and line height, and the keymap.
pub(crate) fn apply_editor_settings(cx: &mut App) {
    let lattice = cx.lattice();
    let code_theme = lattice.code_theme;
    let appearance = crate::settings::get(cx).appearance.clone();
    let variant = crate::settings::code_theme_variant(appearance.code_theme_variant);
    let vim_mode = appearance.editor_keymap == lattice_settings::EditorKeymap::Vim;
    let json = BASE_SETTINGS
        .replace(
            "THEME_MODE",
            match lattice.palette.appearance {
                Appearance::Light => "light",
                Appearance::Dark => "dark",
            },
        )
        .replace(
            "LIGHT_THEME",
            &code_theme.zed_theme_name(variant.unwrap_or(Appearance::Light)),
        )
        .replace(
            "DARK_THEME",
            &code_theme.zed_theme_name(variant.unwrap_or(Appearance::Dark)),
        )
        .replace("EDITOR_FONT_SIZE", &appearance.editor_font_size.to_string())
        .replace(
            "EDITOR_LINE_HEIGHT",
            &appearance.source_line_height.to_string(),
        )
        .replace(
            "EDITOR_FONT",
            &serde_json::to_string(&editor_family(
                &appearance.source_font,
                &lattice.fonts.editor,
            ))
            .unwrap_or_default()
            .trim_matches('"')
            .to_owned(),
        )
        .replace("UI_FONT", &lattice.fonts.ui)
        .replace("VIM_MODE", if vim_mode { "true" } else { "false" });
    SettingsStore::update(cx, |store, cx| {
        let result = store.set_user_settings(&json, cx);
        if let settings::ParseStatus::Failed { error } = &result.parse_status {
            log::error!("the editor settings did not parse: {error}");
        }
    });
    theme_settings::reload_theme(cx);
    load_chosen_keymap(appearance.editor_keymap, cx);
}

/// Load the Vim or Emacs bindings the first time that keymap is chosen.
fn load_chosen_keymap(keymap: lattice_settings::EditorKeymap, cx: &mut App) {
    let loaded = cx.default_global::<LoadedKeymaps>();
    let (ready, vim, emacs) = (loaded.ready, loaded.vim, loaded.emacs);
    if !ready {
        return;
    }
    match keymap {
        lattice_settings::EditorKeymap::Vim if !vim => {
            cx.global_mut::<LoadedKeymaps>().vim = true;
            bind_asset_keymap(VIM_KEYMAP_PATH, cx);
            crate::shell::bind_keys(cx);
        }
        lattice_settings::EditorKeymap::Emacs if !emacs => {
            cx.global_mut::<LoadedKeymaps>().emacs = true;
            bind_emacs_keymap(cx);
            crate::shell::bind_keys(cx);
        }
        _ => {}
    }
}

/// Zed's Emacs keymap (from Zed's own embedded keymaps, as the default and
/// Vim keymaps are loaded), each binding put under [`EMACS_CONTEXT`]: its
/// context must hold below the shell's, which carries that context only
/// while Emacs is the chosen keymap.
fn bind_emacs_keymap(cx: &mut App) {
    use gpui::{KeyBinding, KeyBindingContextPredicate as Predicate};
    let bindings = match KeymapFile::load_asset_allow_partial_failure(EMACS_KEYMAP_PATH, cx) {
        Ok(bindings) => bindings,
        Err(error) => {
            log::warn!("{error:#}");
            return;
        }
    };
    let os = cx.platform_info().os;
    let scope = Predicate::Identifier(EMACS_CONTEXT.into());
    let scoped: Vec<KeyBinding> = bindings
        .iter()
        .filter_map(|binding| {
            let keys: Vec<String> = binding.keystrokes().iter().map(|k| k.unparse(os)).collect();
            let predicate = match binding.predicate() {
                Some(own) => {
                    Predicate::Descendant(Box::new(scope.clone()), Box::new((*own).clone()))
                }
                None => scope.clone(),
            };
            KeyBinding::load(
                &keys.join(" "),
                binding.action().boxed_clone(),
                Some(std::rc::Rc::new(predicate)),
                false,
                binding.action_input(),
                cx,
            )
            .ok()
        })
        .collect();
    cx.bind_keys(scoped);
}

pub fn vim_mode_enabled(cx: &App) -> bool {
    vim_mode_setting::VimModeSetting::get_global(cx).0
}

/// Turn Vim mode on or off for every editor: the keymap setting, which
/// Settings › Editor & builds and the palette's "Vim mode" both change. Zed's
/// Vim attaches itself to each editor when the setting changes; its key
/// bindings are loaded once.
pub fn set_vim_mode(enabled: bool, cx: &mut App) {
    crate::settings::update_appearance(cx, |appearance| {
        appearance.editor_keymap = if enabled {
            lattice_settings::EditorKeymap::Vim
        } else {
            lattice_settings::EditorKeymap::Default
        }
    });
}

fn load_keymaps(cx: &mut App) {
    bind_asset_keymap(settings::DEFAULT_KEYMAP_PATH, cx);
    // The settings were applied before the actions the keymaps name were
    // registered; the chosen keymap is bound now, over the default.
    *cx.default_global::<LoadedKeymaps>() = LoadedKeymaps {
        ready: true,
        ..LoadedKeymaps::default()
    };
    load_chosen_keymap(crate::settings::get(cx).appearance.editor_keymap, cx);
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
