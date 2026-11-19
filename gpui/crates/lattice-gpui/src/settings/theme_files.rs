//! Settings › Appearance › Theme's Palette and Theme files rows
//! (theme-settings.tsx, theme-file-actions.tsx; `docs/themes.md`): Lattice's
//! own colors or a theme, as the same miniature windows as the Color theme
//! row; installing a theme file and choosing it; showing the themes folder;
//! removing the chosen theme when it was installed.

use std::{path::PathBuf, sync::Arc};

use gpui::{
    AppContext as _, ClickEvent, Context, ElementId, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::themes::{ThemeInfo, ThemeSource, format::ThemeFile};
use lattice_i18n::t;
use lattice_settings::{Accent as StoredAccent, AccentPreset, ThemePreference};
use lattice_ui::{Appearance, components::Button};

use super::{
    controls::{self, Level, PageWidth, Row, Wrap},
    dialog::SettingsDialog,
    theme_art,
};
use crate::confirm::{self, Confirm};

/// A theme the writer can pick: what the list shows, and the file its art
/// is painted from.
#[derive(Clone)]
pub struct ThemeEntry {
    pub info: ThemeInfo,
    pub file: Arc<ThemeFile>,
}

/// The bundled themes, then the installed ones, read once when Settings
/// opens and again after an install or a removal.
pub fn load() -> Vec<ThemeEntry> {
    let store = super::theme_store();
    super::registry()
        .list_themes(&store)
        .into_iter()
        .filter_map(|info| {
            let file = Arc::new(store.get(&info.id)?);
            Some(ThemeEntry { info, file })
        })
        .collect()
}

/// Choose the theme `id` (`""`: Lattice's own colors). A theme brings its
/// own accent: the default Graphite gives way to it, and an accent the
/// writer picked stays and wins (L13).
pub fn choose(id: String, cx: &mut gpui::App) {
    super::update_appearance(cx, move |appearance| {
        if !id.is_empty() && appearance.accent == StoredAccent::Preset(AccentPreset::Graphite) {
            appearance.accent = StoredAccent::Theme;
        }
        appearance.theme = id;
    });
}

/// The theme in effect, if the list has it.
pub fn chosen<'a>(dialog: &'a SettingsDialog, cx: &gpui::App) -> Option<&'a ThemeEntry> {
    let id = &super::get(cx).appearance.theme;
    dialog
        .fields
        .themes
        .iter()
        .find(|entry| &entry.info.id == id)
}

pub fn rows(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> Vec<Row> {
    let settings = super::get(cx).clone();
    let wraps = width.wraps();
    let mode = match settings.theme_preference {
        ThemePreference::System => None,
        ThemePreference::Light => Some(Appearance::Light),
        ThemePreference::Dark => Some(Appearance::Dark),
    };
    let tint = super::tint(settings.appearance.tint);
    let chosen = chosen(dialog, cx).cloned();
    let tile_width = (!wraps).then_some(px(88.));

    let mut tiles = vec![theme_art::tile(
        "theme-palette-lattice".into(),
        t!("Lattice"),
        tile_width,
        theme_art::window_art(mode, tint, cx),
        chosen.is_none(),
        |_: &ClickEvent, _, cx| choose(String::new(), cx),
        window,
        cx,
    )];
    for entry in dialog.fields.themes.clone() {
        let id = entry.info.id.clone();
        tiles.push(theme_art::tile(
            ElementId::Name(format!("theme-palette-{id}").into()),
            entry.info.name.clone(),
            tile_width,
            theme_art::theme_window_art(&entry.file, mode, cx),
            chosen.as_ref().is_some_and(|chosen| chosen.info.id == id),
            move |_: &ClickEvent, _, cx| choose(id.clone(), cx),
            window,
            cx,
        ));
    }
    let tiles = div()
        .flex()
        .flex_wrap()
        .when(!wraps, |this| this.justify_end())
        .when(wraps, |this| this.w_full())
        .gap(px(12.))
        .children(tiles);
    let mut palette = Row::new("theme-palette", t!("Palette"))
        .control(tiles)
        .wrap(Wrap::Line)
        .roomy();
    let blocked = chosen
        .as_ref()
        .and_then(|entry| Some((entry.info.name.clone(), entry.info.blocked.clone()?)));
    if let Some((name, entry)) = blocked {
        palette = palette.description_element(super::theme_browse::block_notice(&name, &entry, cx));
    } else if let Some(description) = chosen
        .as_ref()
        .map(|entry| entry.info.description.clone())
        .filter(|text| !text.is_empty())
    {
        palette = palette.description(description, cx);
    }

    let this = cx.entity();
    let mut buttons = Vec::new();
    {
        let this = this.clone();
        buttons.push(
            Button::new("theme-browse", t!("Browse themes…"))
                .compact()
                .on_click(move |_, window, cx| {
                    this.update(cx, |dialog, cx| dialog.open_theme_browse(window, cx))
                })
                .into_any_element(),
        );
    }
    if let Some(entry) = chosen.filter(|entry| entry.info.source == ThemeSource::Installed) {
        let this = this.clone();
        buttons.push(
            Button::new("theme-remove", t!("Remove theme"))
                .compact()
                .ghost()
                .on_click(move |_, _, cx| ask_remove(this.clone(), entry.info.clone(), cx))
                .into_any_element(),
        );
    }
    {
        let this = this.clone();
        buttons.push(
            Button::new("theme-reveal", t!("Show themes folder"))
                .compact()
                .ghost()
                .on_click(move |_, _, cx| {
                    let result = super::theme_store().folder();
                    match result {
                        Ok(folder) => cx.reveal_path(&folder),
                        Err(error) => this.update(cx, |dialog, cx| dialog.theme_failed(error, cx)),
                    }
                })
                .into_any_element(),
        );
    }
    buttons.push(
        Button::new("theme-install", t!("Install from file…"))
            .compact()
            .on_click(move |_, _, cx| this.update(cx, |dialog, cx| dialog.pick_theme_file(cx)))
            .into_any_element(),
    );
    let mut actions = div()
        .flex()
        .flex_col()
        .items_end()
        .gap(px(6.))
        .min_w_0()
        .child(
            div()
                .flex()
                .flex_wrap()
                .justify_end()
                .gap(px(6.))
                .children(buttons),
        );
    if let Some(error) = dialog.fields.theme_error.clone() {
        actions = actions.child(controls::inline_message(Level::Error, error, cx));
    }
    let files = Row::new("theme-files", t!("Theme files"))
        .description(
            t!("Install a .lattice-theme.json file. Lattice keeps its own copy."),
            cx,
        )
        .control(actions);

    vec![palette, files]
}

fn ask_remove(this: gpui::Entity<SettingsDialog>, theme: ThemeInfo, cx: &mut gpui::App) {
    let this = this.downgrade();
    let name = theme.name.clone();
    confirm::ask(
        Confirm::new(t!("Remove {name}?", name = name))
            .body(t!("Lattice goes back to its own colors. Installing the file again brings the theme back."))
            .confirm_label(t!("Remove"))
            .destructive()
            .on_confirm(move |_, cx| {
                let result = super::theme_store().remove(&theme.id);
                this.update(cx, |dialog, cx| match result {
                    Ok(()) => {
                        dialog.fields.theme_error = None;
                        dialog.fields.themes = load();
                        choose(String::new(), cx);
                        cx.notify();
                    }
                    Err(error) => dialog.theme_failed(error, cx),
                })
                .ok();
            }),
        cx,
    );
}

impl SettingsDialog {
    /// Open Browse themes over Settings.
    pub fn open_theme_browse(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let dialog = cx.entity().downgrade();
        self.pages.theme_browse =
            Some(cx.new(|cx| super::theme_browse::ThemeBrowse::new(dialog, window, cx)));
        cx.notify();
    }

    pub fn close_theme_browse(&mut self, cx: &mut Context<Self>) {
        self.pages.theme_browse = None;
        cx.notify();
    }

    /// The installed themes or the block list changed: list them again,
    /// apply the choice again (the kill switch may have turned it off or
    /// on), and choose `choose` when an install asks for it.
    pub fn themes_changed(&mut self, choose: Option<String>, cx: &mut Context<Self>) {
        self.fields.theme_error = None;
        self.fields.themes = load();
        super::reload_theme(cx);
        if let Some(id) = choose {
            self::choose(id, cx);
        }
        cx.notify();
    }

    fn theme_failed(&mut self, error: String, cx: &mut Context<Self>) {
        self.fields.theme_error = Some(SharedString::from(crate::host_errors::text(&error)));
        cx.notify();
    }

    /// Install the theme file at `path` and choose it (the picker's choice,
    /// or a scenario's).
    pub fn install_theme_file(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        match super::theme_store().install_file(&path) {
            Ok(info) => {
                self.fields.theme_error = None;
                self.fields.themes = load();
                super::reload_theme(cx);
                choose(info.id, cx);
                cx.notify();
            }
            Err(error) => self.theme_failed(error, cx),
        }
    }

    fn pick_theme_file(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(t!("Install from file…").into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| this.install_theme_file(path, cx))
                .ok();
        })
        .detach();
    }
}
