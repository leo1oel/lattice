//! The writer's preferences, app-wide, and Settings, the dialog that changes
//! them (`src/settings/`, `use-appearance.ts`).
//!
//! [`AppSettings`] holds `lattice_settings::Settings` in a GPUI global. It is
//! read from `settings.json` in the app's state directory, or on the first
//! run imported from the Tauri app's storage, and written back whole on
//! every change. The file is watched: an edit made to it by hand or by
//! another copy of the app applies within a second, as a change made in one
//! Tauri window shows in the others.
//!
//! Each change applies as it is made, everywhere: the appearance, tint,
//! accent and code theme reach the palette, GPUI Kit and every editor; the
//! editor's face, size and line height reach Zed's settings; the keymap
//! turns Vim on or off; the language switches every string and the menu
//! bar; the automatic build decides whether a save builds; the notification
//! position moves the stack; the title bar's tools hide and show; the
//! interface size zooms every window (`interface_zoom`), translucency puts
//! the window's vibrancy behind its frosted surfaces (`window_material`),
//! interface sounds decide whether a cue plays (`sounds`) and spell
//! checking whether editors check (`editor_panel/spelling.rs`). Choices the
//! GPUI app has no surface for yet (the visual Markdown editor's type) are
//! kept, so they carry over unchanged.
//!
//! A scripted run keeps its settings in memory (unless
//! `LATTICE_GPUI_STATE_DIR` names a directory), imports nothing, and shows
//! the interface in English whatever the system's language, so a run never
//! reads or changes the writer's own preferences.

mod appearance_pane;
mod controls;
mod dialog;
mod editor_pane;
pub(crate) mod logs_export;
pub(crate) mod logs_pane;
mod nav;
pub(crate) mod overleaf_pane;
mod search;
mod theme_art;

use std::{
    path::PathBuf,
    time::{Duration, SystemTime},
};

use gpui::{App, Global};
use lattice_i18n::Locale;
use lattice_settings::{
    AccentPreset, Appearance as AppearanceSettings, CodeTheme as StoredCodeTheme, CodeThemeVariant,
    EditorKeymap, InterfaceLanguage, Settings, ThemePreference, Tint as StoredTint,
};
use lattice_ui::{Accent, Appearance, CodeTheme, LatticeTheme, Tint};

pub use dialog::{SettingsDialog, SettingsEvent};
pub use editor_pane::set_spelling_words;

/// How often the file is checked for an edit made outside this app.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

pub struct AppSettings {
    pub settings: Settings,
    /// Where they are kept; none for a run that keeps them in memory.
    path: Option<PathBuf>,
    /// The file's modification time as last read or written, so the watch
    /// tells an outside edit from this app's own write.
    seen: Option<SystemTime>,
    scripted: bool,
    /// The keymap the file holds while `LATTICE_GPUI_VIM` puts Vim in its
    /// place for this run; none once the writer chooses a keymap.
    saved_keymap: Option<EditorKeymap>,
}

impl Global for AppSettings {}

impl AppSettings {
    /// The settings as the file keeps them.
    fn to_save(&self) -> Settings {
        let mut settings = self.settings.clone();
        if let Some(keymap) = self.saved_keymap {
            settings.appearance.editor_keymap = keymap;
        }
        settings
    }
}

/// The settings now.
pub fn get(cx: &App) -> &Settings {
    &cx.global::<AppSettings>().settings
}

fn modified(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

/// Read (or import) the settings and apply them, before the first window
/// opens; then keep watching the file.
pub fn init(scripted: bool, cx: &mut App) {
    let path =
        crate::shell::workspaces::state_dir(scripted).map(|dir| lattice_settings::file_in(&dir));
    // The import reads the Tauri app's storage only on an ordinary run;
    // `LATTICE_GPUI_TAURI_STORAGE` points it elsewhere (a scenario's copy).
    let tauri = match std::env::var_os("LATTICE_GPUI_TAURI_STORAGE") {
        Some(dir) if dir.is_empty() => None,
        Some(dir) => Some(PathBuf::from(dir)),
        None if scripted => None,
        None => lattice_settings::import::website_data(lattice_settings::import::TAURI_BUNDLE_ID),
    };
    let settings = match &path {
        Some(path) => lattice_settings::load(path, tauri.as_deref())
            .settings()
            .clone(),
        None => Settings::default(),
    };
    let seen = path.as_deref().and_then(modified);
    cx.set_global(AppSettings {
        settings,
        path,
        seen,
        scripted,
        saved_keymap: None,
    });
    apply(None, cx);
    watch(cx);
}

/// Turn Vim on for this run only, leaving the file as it is.
pub fn use_vim_for_this_run(cx: &mut App) {
    let before = get(cx).clone();
    let state = cx.global_mut::<AppSettings>();
    state.saved_keymap = Some(before.appearance.editor_keymap);
    state.settings.appearance.editor_keymap = EditorKeymap::Vim;
    apply(Some(&before), cx);
}

/// Change the settings: write them, then apply what changed.
pub fn update(cx: &mut App, edit: impl FnOnce(&mut Settings)) {
    let before = get(cx).clone();
    let mut after = before.clone();
    edit(&mut after);
    if after == before {
        return;
    }
    let state = cx.global_mut::<AppSettings>();
    if after.appearance.editor_keymap != before.appearance.editor_keymap {
        state.saved_keymap = None;
    }
    state.settings = after;
    if let Some(path) = state.path.clone() {
        if let Err(error) = lattice_settings::write(&path, &state.to_save()) {
            log::warn!("could not save the settings: {error:#}");
        }
        state.seen = modified(&path);
    }
    apply(Some(&before), cx);
}

/// Change the appearance settings.
pub fn update_appearance(cx: &mut App, edit: impl FnOnce(&mut AppearanceSettings)) {
    update(cx, |settings| edit(&mut settings.appearance));
}

/// Keep the settings in the file at `path` from now on and watch it, as an
/// ordinary run does, for a scenario that checks an outside edit.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn use_file(path: PathBuf, cx: &mut App) {
    let watching = cx.global::<AppSettings>().path.is_some();
    let state = cx.global_mut::<AppSettings>();
    if let Err(error) = lattice_settings::write(&path, &state.to_save()) {
        log::warn!("could not write {}: {error:#}", path.display());
    }
    state.seen = modified(&path);
    state.path = Some(path);
    if !watching {
        watch(cx);
    }
}

/// Check the file every second, and apply an edit made outside the app.
fn watch(cx: &mut App) {
    if cx.global::<AppSettings>().path.is_none() {
        return;
    }
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(WATCH_INTERVAL).await;
            let changed = cx.update(|cx| {
                let state = cx.global::<AppSettings>();
                let path = state.path.clone()?;
                let now = modified(&path);
                (now != state.seen).then_some((path, now))
            });
            let Some((path, now)) = changed else {
                continue;
            };
            let read = cx
                .background_executor()
                .spawn(async move { lattice_settings::read_live(&path) })
                .await;
            cx.update(|cx| {
                let before = get(cx).clone();
                let state = cx.global_mut::<AppSettings>();
                state.seen = now;
                if let Some(mut settings) = read {
                    if state.saved_keymap.is_some() {
                        state.saved_keymap = Some(settings.appearance.editor_keymap);
                        settings.appearance.editor_keymap = EditorKeymap::Vim;
                    }
                    if settings != before {
                        state.settings = settings;
                        apply(Some(&before), cx);
                    }
                }
            });
        }
    })
    .detach();
}

/// The system's preferred languages, first choice first.
fn system_languages() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        crate::native::preferred_languages()
    }
    #[cfg(not(target_os = "macos"))]
    {
        ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
            .map(|value| {
                vec![
                    value
                        .split('.')
                        .next()
                        .unwrap_or_default()
                        .replace('_', "-"),
                ]
            })
            .unwrap_or_default()
    }
}

/// The interface language the settings resolve to now. A scripted run
/// reads no system language, so it is English unless the settings say
/// otherwise.
pub fn locale_for(language: InterfaceLanguage, scripted: bool) -> Locale {
    let fixed = match language {
        InterfaceLanguage::System => None,
        InterfaceLanguage::En => Some(Locale::En),
        InterfaceLanguage::ZhCn => Some(Locale::ZhCn),
    };
    let system = if scripted {
        Vec::new()
    } else {
        system_languages()
    };
    lattice_i18n::resolve_locale(fixed, &system)
}

pub fn tint(tint: StoredTint) -> Tint {
    match tint {
        StoredTint::Graphite => Tint::Graphite,
        StoredTint::Paper => Tint::Paper,
        StoredTint::Sage => Tint::Sage,
        StoredTint::Mist => Tint::Mist,
        StoredTint::Dusk => Tint::Dusk,
    }
}

pub fn accent(accent: &lattice_settings::Accent) -> Accent {
    match accent {
        lattice_settings::Accent::Custom(_) => accent
            .custom_rgb()
            .map(|[r, g, b]| Accent::Custom(u32::from(r) << 16 | u32::from(g) << 8 | u32::from(b)))
            .unwrap_or_default(),
        lattice_settings::Accent::Preset(preset) => match preset {
            AccentPreset::Graphite => Accent::Graphite,
            AccentPreset::Blue => Accent::Blue,
            AccentPreset::Purple => Accent::Purple,
            AccentPreset::Pink => Accent::Pink,
            AccentPreset::Orange => Accent::Orange,
            AccentPreset::Green => Accent::Green,
            AccentPreset::Teal => Accent::Teal,
        },
    }
}

pub fn code_theme(theme: StoredCodeTheme) -> CodeTheme {
    match theme {
        StoredCodeTheme::Github => CodeTheme::Github,
        StoredCodeTheme::Lattice => CodeTheme::WeftAndWarp,
        StoredCodeTheme::One => CodeTheme::One,
        StoredCodeTheme::Solarized => CodeTheme::Solarized,
        StoredCodeTheme::Catppuccin => CodeTheme::Catppuccin,
        StoredCodeTheme::TokyoNight => CodeTheme::TokyoNight,
        StoredCodeTheme::Dracula => CodeTheme::Dracula,
        StoredCodeTheme::Nord => CodeTheme::Nord,
        StoredCodeTheme::Monokai => CodeTheme::Monokai,
    }
}

/// The appearance a code theme's variant fixes, or `None` to follow the app.
pub fn code_theme_variant(variant: CodeThemeVariant) -> Option<Appearance> {
    match variant {
        CodeThemeVariant::Auto => None,
        CodeThemeVariant::Light => Some(Appearance::Light),
        CodeThemeVariant::Dark => Some(Appearance::Dark),
    }
}

/// Apply the settings, all of them (`before` is `None`) or what changed.
fn apply(before: Option<&Settings>, cx: &mut App) {
    let now = get(cx).clone();
    let scripted = cx.global::<AppSettings>().scripted;
    let changed =
        |same: fn(&Settings, &Settings) -> bool| before.is_none_or(|was| !same(was, &now));
    let (a, theme) = (&now.appearance, now.theme_preference);

    if changed(|was, now| was.appearance.interface_language == now.appearance.interface_language) {
        let locale = locale_for(a.interface_language, scripted);
        if before.is_none() || lattice_i18n::locale() != locale {
            lattice_i18n::set_locale(locale);
            crate::shell::menus::install_menus(cx);
            cx.defer(|cx| {
                crate::shell::windows::for_shells(
                    cx,
                    |_| true,
                    |shell, window, cx| shell.set_window_title(window, cx),
                );
            });
            cx.refresh_windows();
        }
    }
    if changed(|was, now| was.theme_preference == now.theme_preference) {
        let fixed = match theme {
            ThemePreference::System => None,
            ThemePreference::Light => Some(Appearance::Light),
            ThemePreference::Dark => Some(Appearance::Dark),
        };
        let system = cx.window_appearance().into();
        crate::app::choose_appearance(fixed, system, cx);
    }
    // Each of these does nothing when it is unchanged.
    LatticeTheme::set_tint(tint(a.tint), cx);
    LatticeTheme::set_accent(accent(&a.accent), cx);
    LatticeTheme::set_code_theme(code_theme(a.code_theme), cx);
    if changed(|was, now| {
        let (was, now) = (&was.appearance, &now.appearance);
        (
            was.editor_keymap,
            was.editor_font_size,
            &was.source_font,
            was.source_line_height,
            was.code_theme_variant,
        ) == (
            now.editor_keymap,
            now.editor_font_size,
            &now.source_font,
            now.source_line_height,
            now.code_theme_variant,
        )
    }) {
        crate::app::apply_editor_settings(cx);
    }
    if changed(|was, now| was.appearance.interface_scale == now.appearance.interface_scale)
        && before.is_some()
    {
        crate::interface_zoom::apply_all(cx);
    }
    if changed(|was, now| {
        (was.appearance.translucency, was.theme_preference)
            == (now.appearance.translucency, now.theme_preference)
    }) && before.is_some()
    {
        crate::window_material::apply_all(cx);
    }
    if changed(|was, now| {
        (
            was.appearance.toast_position,
            &was.appearance.hidden_titlebar_tools,
        ) == (
            now.appearance.toast_position,
            &now.appearance.hidden_titlebar_tools,
        )
    }) {
        cx.refresh_windows();
    }
}

/// Whether this is a scripted run, which plays no sound and reads no system
/// preference.
pub fn scripted(cx: &App) -> bool {
    cx.global::<AppSettings>().scripted
}

/// Where builds leave their intermediate files: the "Hide auxiliary files"
/// switch.
pub fn aux_files(cx: &App) -> lattice_core::latex::AuxFiles {
    if get(cx).hidden_build_files {
        lattice_core::latex::AuxFiles::Hidden
    } else {
        lattice_core::latex::AuxFiles::Beside
    }
}

/// Whether a save (or an outside edit) builds on its own.
pub fn builds_automatically(cx: &App) -> bool {
    get(cx).auto_build_mode == lattice_settings::AutoBuildMode::Automatic
}

/// Vim mode is the keymap setting.
pub fn vim_mode(cx: &App) -> bool {
    get(cx).appearance.editor_keymap == EditorKeymap::Vim
}
