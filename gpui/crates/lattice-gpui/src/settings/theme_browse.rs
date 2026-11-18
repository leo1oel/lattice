//! Settings › Appearance › Theme files › Browse themes (theme-browse.tsx,
//! `docs/themes.md`): the theme marketplace's signed list as a sheet over
//! Settings, row for row as the Tauri app draws it. lattice-core's
//! `Registry` fetches, verifies and installs, off the main thread; each row's
//! tile is painted from the list's own colors, so nothing downloads before
//! Install.

mod model;

use std::{collections::HashMap, sync::Arc};

use gpui::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::registry::{IndexTheme, Listing, Status};
use lattice_core::themes::format::ThemeFile;
use lattice_i18n::{join_phrases, locale, t};
use lattice_settings::ThemePreference;
use lattice_ui::fluid_hover::FluidHover;
use lattice_ui::{
    ActiveLattice as _, Appearance, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field, LayerPlacement, ModalLayer, Sheet},
    interaction::mix,
};
use model::{Line, RowAction};

use super::{
    controls::{self, Level},
    dialog::SettingsDialog,
    theme_art,
};

/// The layer the sheet stands in (`pages::sheet`'s).
const LAYER: &str = "settings-sheet-layer";
const ROW_HEIGHT: f32 = 64.;

pub struct ThemeBrowse {
    dialog: WeakEntity<SettingsDialog>,
    search: Entity<InputState>,
    listing: Option<Listing>,
    refreshing: bool,
    /// Each listed theme as a theme file built from the list's colors, for
    /// its tile (`None`: drawn as Lattice's own).
    art: HashMap<String, Option<Arc<ThemeFile>>>,
    /// The theme being installed.
    busy: Option<String>,
    /// Why a row's last install failed, by id.
    errors: HashMap<String, SharedString>,
    _subscription: Subscription,
}

impl ThemeBrowse {
    pub fn new(
        dialog: WeakEntity<SettingsDialog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder(t!("Search by name, description or author"))
        });
        let subscription = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                cx.notify();
            }
        });
        let mut this = Self {
            dialog,
            search,
            listing: None,
            refreshing: true,
            art: HashMap::new(),
            busy: None,
            errors: HashMap::new(),
            _subscription: subscription,
        };
        // The cached list shows at once; the registry's replaces it when it
        // is fetched and verified.
        this.load(false, cx);
        this.load(true, cx);
        this
    }

    fn load(&mut self, refresh: bool, cx: &mut Context<Self>) {
        if refresh {
            self.refreshing = true;
            cx.notify();
        }
        let task = cx.background_spawn(async move {
            super::registry().listing(&super::theme_store(), refresh)
        });
        cx.spawn(async move |this, cx| {
            let listing = task.await;
            this.update(cx, |this, cx| {
                // A cached answer arriving after the fetched one is older.
                if !refresh && this.listing.is_some() {
                    return;
                }
                if refresh {
                    this.refreshing = false;
                    // A new block list can turn the chosen theme off or on.
                    if listing.status == Status::Fresh {
                        this.dialog
                            .update(cx, |dialog, cx| dialog.themes_changed(None, cx))
                            .ok();
                    }
                }
                this.set_listing(listing);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn set_listing(&mut self, listing: Listing) {
        let themes = listing.index.iter().flat_map(|index| index.themes.iter());
        self.art = themes
            .map(|theme| (theme.id.clone(), art_file(theme)))
            .collect();
        self.listing = Some(listing);
    }

    fn install(&mut self, id: String, update: bool, cx: &mut Context<Self>) {
        self.busy = Some(id.clone());
        self.errors.remove(&id);
        cx.notify();
        let task = cx.background_spawn({
            let id = id.clone();
            async move { super::registry().install_theme(&super::theme_store(), &id) }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    Ok(info) => {
                        // Install chooses the theme; Update keeps the choice.
                        let choose = (!update).then_some(info.id);
                        this.dialog
                            .update(cx, |dialog, cx| dialog.themes_changed(choose, cx))
                            .ok();
                        this.listing = None;
                        this.load(false, cx);
                    }
                    Err(error) => {
                        this.errors
                            .insert(id, crate::host_errors::text(&error).into());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn status(&self, cx: &gpui::App) -> AnyElement {
        let palette = cx.palette();
        let (text, color): (SharedString, _) =
            match model::status_line(self.listing.as_ref(), self.refreshing) {
                Line::Loading => (t!("Loading…").into(), palette.text_secondary),
                Line::Updated(at) => {
                    let when = crate::overleaf::picker::relative_time(&at);
                    (
                        t!("Updated {when}", when = when).into(),
                        palette.text_secondary,
                    )
                }
                Line::Offline(Some(at)) => (
                    t!("Offline: showing the list from {date}", date = date(&at)).into(),
                    palette.text_secondary,
                ),
                Line::Offline(None) => (
                    t!("Offline. The theme list can't be reached.").into(),
                    palette.text_secondary,
                ),
                Line::Refused => (
                    t!("Couldn't verify the theme list. Nothing new can be installed.").into(),
                    palette.danger,
                ),
                Line::Nothing => (SharedString::default(), palette.text_secondary),
            };
        div()
            .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
            .text_color(color)
            .child(text)
            .into_any_element()
    }

    fn row(
        &self,
        index: usize,
        theme: &IndexTheme,
        listing: &Listing,
        mode: Option<Appearance>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let installed: Vec<_> = self.dialog.upgrade().map_or_else(Vec::new, |dialog| {
            dialog
                .read(cx)
                .fields
                .themes
                .iter()
                .map(|entry| entry.info.clone())
                .collect()
        });
        let action = model::row_action(theme, listing, &installed);
        let art = match self.art.get(&theme.id).cloned().flatten() {
            Some(file) => theme_art::theme_window_art(&file, mode, cx),
            None => theme_art::window_art(mode, lattice_ui::Tint::Graphite, cx),
        };
        let caption = |text: SharedString, color| {
            div()
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(color)
                .truncate()
                .child(text)
        };
        let parts: Vec<String> = [theme.author.clone(), theme.license.clone()]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect();
        let meta = join_phrases(&parts);
        let mut text = div().flex().flex_col().min_w_0().flex_1().child(
            div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .min_w_0()
                .child(
                    div()
                        .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                        .text_color(palette.text)
                        .truncate()
                        .child(theme.name.clone()),
                )
                .child(caption(
                    theme.version.clone().into(),
                    palette.text_secondary,
                )),
        );
        if let Some(description) = theme.description.clone().filter(|text| !text.is_empty()) {
            text = text.child(caption(description.into(), palette.text_secondary));
        }
        text = match listing.blocked_offers.get(&theme.id) {
            Some(entry) if entry.action == "warn" => text.child(caption(
                entry.reason.clone().into(),
                mix(palette.warning, palette.text, 0.28),
            )),
            Some(entry) => text.child(caption(entry.reason.clone().into(), palette.danger)),
            None if !meta.is_empty() => text.child(caption(meta.into(), palette.text_secondary)),
            None => text,
        };
        if let Some(error) = self.errors.get(&theme.id) {
            text = text.child(controls::inline_message(Level::Error, error.clone(), cx));
        }
        let installable = model::installable(listing) && self.busy.is_none();
        let id = theme.id.clone();
        let button_id = |name: &str| SharedString::from(format!("theme-browse-{name}-{id}"));
        let button = match action {
            RowAction::Blocked(entry) => Button::new(button_id("blocked"), t!("Blocked"))
                .compact()
                .danger()
                .disabled(true)
                .tooltip(entry.reason),
            RowAction::Installed => Button::new(button_id("installed"), t!("Installed"))
                .compact()
                .ghost()
                .disabled(true),
            RowAction::Install => Button::new(button_id("install"), t!("Install"))
                .compact()
                .disabled(!installable)
                .on_click(cx.listener(move |this, _, _, cx| this.install(id.clone(), false, cx))),
            RowAction::Update(version) => {
                Button::new(button_id("update"), t!("Update to {next}", next = version))
                    .compact()
                    .tinted()
                    .disabled(!installable)
                    .on_click(cx.listener(move |this, _, _, cx| this.install(id.clone(), true, cx)))
            }
        };
        div()
            .id(SharedString::from(format!("theme-browse-row-{index}")))
            .flex()
            .items_center()
            .gap(px(12.))
            .min_h(px(ROW_HEIGHT))
            .px(px(8.))
            .py(px(6.))
            .child(art)
            .child(text)
            .child(button)
            .into_any_element()
    }
}

/// A listed theme as a theme file of its base colors, so its tile is the
/// Palette tiles' window (`theme_art::theme_window_art`).
fn art_file(theme: &IndexTheme) -> Option<Arc<ThemeFile>> {
    let variants: Vec<_> = theme
        .variants
        .iter()
        .map(|variant| serde_json::json!({ "id": variant.id, "appearance": variant.appearance, "colors": variant.colors }))
        .collect();
    let json = serde_json::json!({
        "schema": 1, "id": theme.id, "name": theme.name, "version": theme.version, "variants": variants,
    });
    ThemeFile::parse(&json.to_string()).ok().map(Arc::new)
}

/// The day a list was fetched, as the picker writes a date.
fn date(timestamp: &str) -> String {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(timestamp) else {
        return timestamp.to_string();
    };
    let local = at.with_timezone(&chrono::Local);
    if locale().is_chinese() {
        local.format("%Y/%-m/%-d").to_string()
    } else {
        local.format("%-m/%-d/%Y").to_string()
    }
}

impl Render for ThemeBrowse {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let mode = match super::get(cx).theme_preference {
            ThemePreference::System => None,
            ThemePreference::Light => Some(Appearance::Light),
            ThemePreference::Dark => Some(Appearance::Dark),
        };
        let query = self.search.read(cx).value().trim().to_string();
        let refresh = Button::new("theme-browse-refresh", t!("Refresh"))
            .compact()
            .ghost()
            .disabled(self.refreshing)
            .on_click(cx.listener(|this, _, _, cx| this.load(true, cx)));
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .pt(px(6.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .child(Field::new(&self.search).search().compact()),
                    )
                    .child(refresh),
            )
            .child(self.status(cx));
        let line = model::status_line(self.listing.as_ref(), self.refreshing);
        if line == Line::Loading {
            let surface = palette.raised;
            body = body.children((0..4).map(|ix| {
                div()
                    .relative()
                    .h(px(ROW_HEIGHT - 8.))
                    .rounded(px(6.))
                    .bg(surface)
                    .overflow_hidden()
                    .children(lattice_ui::loading::sheen(
                        SharedString::from(format!("theme-browse-sheen-{ix}")),
                        surface,
                        cx,
                    ))
                    .into_any_element()
            }));
            return body;
        }
        let Some(listing) = self.listing.clone() else {
            return body;
        };
        let themes: Vec<IndexTheme> = listing
            .index
            .iter()
            .flat_map(|index| index.themes.iter())
            .filter(|theme| query.is_empty() || model::matches(theme, &query))
            .cloned()
            .collect();
        if themes.is_empty() && !query.is_empty() {
            return body.child(
                div()
                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("No themes match")),
            );
        }
        let hover = FluidHover::new("theme-browse-hover", window, cx)
            .fill(palette.line)
            .radius(px(6.));
        let rows: Vec<AnyElement> = themes
            .iter()
            .enumerate()
            .map(|(ix, theme)| {
                let row = self.row(ix, theme, &listing, mode, cx);
                hover.item(ix, row)
            })
            .collect();
        body.child(
            div()
                .relative()
                .flex()
                .flex_col()
                .child(hover.highlight())
                .children(rows),
        )
    }
}

/// The sheet over Settings, as a layer of its own (`pages::sheet`).
pub fn sheet(browse: Entity<ThemeBrowse>, cx: &gpui::App) -> AnyElement {
    let dialog = browse.read(cx).dialog.clone();
    let close = {
        let dialog = dialog.clone();
        move |window: &mut Window, cx: &mut gpui::App| {
            let dialog = dialog.clone();
            ModalLayer::leave(LAYER, window, cx, move |_, cx| {
                dialog
                    .update(cx, |dialog, cx| dialog.close_theme_browse(cx))
                    .ok();
            });
        }
    };
    let surface = Sheet::new("theme-browse", t!("Browse themes"))
        .on_close(close)
        .child(div().h(px(560.)).overflow_hidden().child(browse))
        .into_any_element();
    ModalLayer::new(LAYER, LayerPlacement::Center, surface, move |_, cx| {
        dialog
            .update(cx, |dialog, cx| dialog.close_theme_browse(cx))
            .ok();
    })
    .into_any_element()
}

/// The Palette row's note when the chosen theme falls under the registry's
/// kill switch (`ThemeBlockNotice`).
pub fn block_notice(
    name: &str,
    entry: &lattice_core::registry::BlockedEntry,
    cx: &gpui::App,
) -> AnyElement {
    let reason = entry.reason.clone();
    let (level, text) = if entry.action == "warn" {
        (
            Level::Warning,
            t!(
                "{name} has a warning: {reason}",
                name = name,
                reason = reason
            ),
        )
    } else {
        (
            Level::Error,
            t!(
                "{name} was turned off: {reason}",
                name = name,
                reason = reason
            ),
        )
    };
    div()
        .flex()
        .flex_col()
        .items_start()
        .gap(px(4.))
        .child(controls::inline_message(level, text, cx))
        .when_some(entry.url.clone(), |this, url| {
            this.child(
                Button::new("theme-block-learn-more", t!("Learn more"))
                    .compact()
                    .ghost()
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            )
        })
        .into_any_element()
}
