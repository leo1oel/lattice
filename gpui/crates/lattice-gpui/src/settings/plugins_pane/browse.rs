//! Settings › Plugins › Browse and a listed plugin's details sheet, drawn as
//! the Tauri app's (`plugin-browse.tsx`, `plugin-details.tsx`,
//! `plugin-browse.css`): the status line and sort over 56px rows of a
//! monogram, name, version, description and author, each with its install
//! state; a row opens the sheet, which lists what the plugin can reach and
//! the commands it adds before anything downloads.

use gpui::{
    AnyElement, Context, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::plugins::AVAILABLE;
use lattice_core::registry::{IndexPlugin, PluginListing, Status};
use lattice_i18n::{join_phrases, locale, t};
use lattice_ui::fluid_hover::FluidHover;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, LayerPlacement, ModalLayer, Select, Sheet},
    interaction::mix,
    tokens::{CONTAINER_DIALOG_SHEET, FONT_WEIGHT_MEDIUM},
};

use super::{
    PluginsPane, Target,
    model::{self, Offer, Sort},
};
use crate::{
    plugins::text,
    settings::controls::{self, Level},
};

/// The layer the sheet stands in (`pages::sheet`'s).
const LAYER: &str = "settings-sheet-layer";
const ROW_HEIGHT: f32 = 56.;
const SORTS: [Sort; 3] = [Sort::Popular, Sort::Recent, Sort::Name];

fn caption(text: impl Into<SharedString>, color: gpui::Hsla, cx: &gpui::App) -> gpui::Div {
    div()
        .min_w_0()
        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
        .text_color(color)
        .child(text.into())
}

/// An underlined caption that opens `url`, without button chrome
/// (`.plugin-details-link`, the kill switch's Learn more).
pub(super) fn link(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    url: String,
    cx: &gpui::App,
) -> gpui::Stateful<gpui::Div> {
    caption(label, cx.palette().text_secondary, cx)
        .id(id.into())
        .underline()
        .cursor_pointer()
        .on_click(move |_, _, cx| cx.open_url(&url))
}

/// A plugin's initial on a 32px tile, since the manifest has no icon
/// (`.plugin-monogram`).
pub(super) fn monogram(name: &str, cx: &gpui::App) -> AnyElement {
    let palette = cx.palette();
    let initial: String = name
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "?".into());
    div()
        .flex_none()
        .size(px(32.))
        .rounded(px(6.))
        .border_1()
        .border_color(palette.line)
        .bg(palette.accent_soft)
        .flex()
        .items_center()
        .justify_center()
        .text_role_in(TextRole::Body, TypeScale::Settings, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .text_color(palette.text_secondary)
        .child(initial)
        .into_any_element()
}

fn downloads(plugin: &IndexPlugin) -> Option<String> {
    let count = model::compact_count(plugin.downloads?, locale().is_chinese());
    Some(t!("{downloads} downloads", downloads = count))
}

impl PluginsPane {
    /// Browse: the status line and sort, then the rows.
    pub(super) fn browse(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let this = cx.entity();
        let plugins = self
            .listing
            .as_ref()
            .map(|listing| listing.plugins.clone())
            .unwrap_or_default();
        let loading = self.refreshing && plugins.is_empty();
        let sort = {
            let selected = SORTS.iter().position(|sort| *sort == self.sort);
            let this = this.clone();
            div().flex_none().w(px(132.)).child(
                Select::new(
                    "plugins-sort",
                    [t!("Most downloaded"), t!("Recently updated"), t!("Name")],
                    selected,
                )
                .compact()
                .on_change(move |ix, _, cx| {
                    if let Some(sort) = SORTS.get(*ix).copied() {
                        this.update(cx, |pane, cx| {
                            pane.sort = sort;
                            cx.notify();
                        });
                    }
                }),
            )
        };
        let mut body = div().flex().flex_col().gap(px(8.)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .min_h(px(28.))
                .child(self.status(loading, cx).flex_1())
                .child(sort),
        );
        if loading {
            let surface = palette.raised;
            return body
                .children((0..4).map(|ix| {
                    div()
                        .relative()
                        .h(px(ROW_HEIGHT - 8.))
                        .rounded(px(6.))
                        .bg(surface)
                        .overflow_hidden()
                        .children(lattice_ui::loading::sheen(
                            SharedString::from(format!("plugin-browse-sheen-{ix}")),
                            surface,
                            cx,
                        ))
                }))
                .into_any_element();
        }
        let Some(listing) = self.listing.clone() else {
            return body.into_any_element();
        };
        if plugins.is_empty() {
            return body
                .child(caption(
                    t!("No plugins are listed yet."),
                    palette.text_secondary,
                    cx,
                ))
                .into_any_element();
        }
        let query = self.search.read(cx).value().trim().to_string();
        let shown: Vec<IndexPlugin> = model::sorted(&plugins, self.sort)
            .into_iter()
            .filter(|plugin| query.is_empty() || model::listed_matches(plugin, &query))
            .collect();
        if shown.is_empty() {
            return body
                .child(caption(t!("No plugins match"), palette.text_secondary, cx))
                .into_any_element();
        }
        let hover = FluidHover::new("plugin-browse-hover", window, cx)
            .fill(palette.line)
            .radius(px(6.));
        let installed = self.listed();
        let rows: Vec<AnyElement> = shown
            .iter()
            .enumerate()
            .map(|(ix, plugin)| {
                let row = self.row(ix, plugin, &listing, &installed, cx);
                hover.item(ix, row)
            })
            .collect();
        body = body.child(
            div()
                .relative()
                .flex()
                .flex_col()
                .child(hover.highlight())
                .children(rows),
        );
        body.into_any_element()
    }

    fn status(&self, loading: bool, cx: &gpui::App) -> gpui::Div {
        let palette = cx.palette();
        if loading {
            return caption(t!("Loading…"), palette.text_secondary, cx);
        }
        if let Some(failure) = &self.list_failure {
            return caption(crate::host_errors::text(failure), palette.danger, cx);
        }
        let Some(listing) = &self.listing else {
            return div();
        };
        match (&listing.status, &listing.fetched_at) {
            (Status::Refused { .. }, _) => caption(
                t!("Couldn't verify the plugin list. Nothing new can be installed."),
                palette.danger,
                cx,
            ),
            (Status::Offline { .. }, Some(at)) => caption(
                t!(
                    "Offline: showing the list from {date}",
                    date = crate::settings::theme_browse::date(at)
                ),
                palette.text_secondary,
                cx,
            ),
            (Status::Offline { .. }, None) => caption(
                t!("Offline. The plugin list can't be reached."),
                palette.text_secondary,
                cx,
            ),
            (_, Some(at)) => caption(
                t!(
                    "Updated {when}",
                    when = crate::overleaf::picker::relative_time(at)
                ),
                palette.text_secondary,
                cx,
            ),
            (_, None) => div(),
        }
    }

    fn row(
        &self,
        index: usize,
        plugin: &IndexPlugin,
        listing: &PluginListing,
        installed: &[lattice_core::plugins::PluginInfo],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let offer = model::offer(plugin, listing, installed);
        let parts: Vec<String> = [plugin.author.clone(), downloads(plugin)]
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
                        .child(plugin.name.clone()),
                )
                .child(caption(plugin.version.clone(), palette.text_secondary, cx)),
        );
        if let Some(description) = plugin.description.clone().filter(|text| !text.is_empty()) {
            text = text.child(caption(description, palette.text_secondary, cx).truncate());
        }
        text = match listing.blocked_offers.get(&plugin.id) {
            Some(entry) if entry.action == "warn" => text.child(
                caption(
                    entry.reason.clone(),
                    mix(palette.warning, palette.text, 0.28),
                    cx,
                )
                .truncate(),
            ),
            Some(entry) => text.child(caption(entry.reason.clone(), palette.danger, cx).truncate()),
            None if !meta.is_empty() => {
                text.child(caption(meta, palette.text_secondary, cx).truncate())
            }
            None => text,
        };
        let id = plugin.id.clone();
        let button_id = |name: &str| SharedString::from(format!("plugin-browse-{name}-{id}"));
        let open = cx.listener({
            let id = id.clone();
            move |pane, _, _, cx| pane.open_details(id.clone(), cx)
        });
        let button = match offer {
            Offer::Blocked(entry) => Button::new(button_id("blocked"), t!("Blocked"))
                .compact()
                .danger()
                .disabled(true)
                .tooltip(entry.reason),
            Offer::Installed(_) => Button::new(button_id("installed"), t!("Installed"))
                .compact()
                .ghost()
                .disabled(true),
            Offer::Install => Button::new(button_id("install"), t!("Install…"))
                .compact()
                .on_click(open),
            Offer::Update { version, .. } => {
                Button::new(button_id("update"), t!("Update to {next}", next = version))
                    .compact()
                    .tinted()
                    .on_click(open)
            }
        };
        let open = cx.listener(move |pane, _, _, cx| pane.open_details(id.clone(), cx));
        div()
            .flex()
            .items_center()
            .gap(px(12.))
            .min_h(px(ROW_HEIGHT))
            .px(px(8.))
            .child(
                div()
                    .id(SharedString::from(format!("plugin-browse-row-{index}")))
                    .flex_1()
                    .min_w_0()
                    .py(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .on_click(open)
                    .child(monogram(&plugin.name, cx))
                    .child(text),
            )
            .child(button)
            .into_any_element()
    }
}

/// The open details sheet over Settings, as a layer of its own
/// (`pages::sheet`).
pub fn details_sheet(pane: Entity<PluginsPane>, cx: &mut gpui::App) -> Option<AnyElement> {
    let (plugin, listing, installed, busy, error) = {
        let state = pane.read(cx);
        let listing = state.listing.clone()?;
        let id = state.details.clone()?;
        let plugin = listing
            .plugins
            .iter()
            .find(|plugin| plugin.id == id)?
            .clone();
        let error = state.errors.get(&Target::Plugin(id)).cloned();
        (plugin, listing, state.listed(), state.busy.is_some(), error)
    };
    let offer = model::offer(&plugin, &listing, &installed);
    let palette = cx.palette().clone();
    let close = {
        let pane = pane.downgrade();
        move |window: &mut Window, cx: &mut gpui::App| {
            let pane = pane.clone();
            ModalLayer::leave(LAYER, window, cx, move |_, cx| {
                pane.update(cx, |pane, cx| pane.close_details(cx)).ok();
            });
        }
    };
    let name = plugin.name.clone();
    let can_install = AVAILABLE && model::installable(&listing) && !busy;
    let blocked = match &offer {
        Offer::Blocked(entry) => Some(entry.clone()),
        Offer::Installed(info) | Offer::Update { info, .. } => info.blocked.clone(),
        Offer::Install => None,
    };
    let turned_off = blocked.as_ref().is_some_and(model::turns_off);

    let updated = plugin
        .updated
        .as_deref()
        .map(crate::overleaf::picker::relative_time);
    let parts: Vec<String> = [
        plugin.author.clone(),
        Some(t!("Version {version}", version = plugin.version)),
        updated.map(|updated| t!("Updated {updated}", updated = updated)),
        downloads(&plugin),
        Some(plugin.license.clone()),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect();
    let repository = plugin.repository.clone();
    // The sheet sits outside Settings, so its text takes the interface
    // scale (`.plugin-details-*` read the root type tokens, not
    // `.settings-modal`'s).
    let head = div()
        .flex()
        .items_start()
        .gap(px(8.))
        .child(monogram(&name, cx))
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .items_start()
                .gap(px(4.))
                .child(caption(join_phrases(&parts), palette.text_secondary, cx))
                .children(plugin.description.clone().map(|description| {
                    div()
                        .text_role_in(TextRole::Body, TypeScale::Interface, cx)
                        .text_color(palette.text)
                        .child(description)
                }))
                .child(link(
                    "plugin-details-source",
                    t!("Source code"),
                    repository,
                    cx,
                )),
        );
    let section = |title: SharedString, cx: &gpui::App| {
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(caption(title, palette.text_secondary, cx).font_weight(FONT_WEIGHT_MEDIUM))
    };
    let bullets = |lines: Vec<String>, cx: &gpui::App| {
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .children(lines.into_iter().map(|line| {
                div()
                    .flex()
                    .text_role_in(TextRole::Body, TypeScale::Interface, cx)
                    .text_color(palette.text)
                    .child(div().flex_none().w(px(16.)).child("•"))
                    .child(div().flex_1().min_w_0().child(SharedString::from(line)))
            }))
    };
    let mut body = div().flex().flex_col().gap(px(10.)).child(head);
    if !AVAILABLE {
        body = body.child(controls::inline_message(
            Level::Warning,
            t!("Plugins run only on macOS for now."),
            cx,
        ));
    }
    if let Some(entry) = &blocked {
        let reason = entry.reason.clone();
        let message = if turned_off {
            controls::inline_message(
                Level::Error,
                t!("Lattice turned this plugin off: {reason}", reason = reason),
                cx,
            )
        } else {
            controls::inline_message(
                Level::Warning,
                t!("This plugin has a warning: {reason}", reason = reason),
                cx,
            )
        };
        body = body.child(
            div()
                .flex()
                .flex_col()
                .items_start()
                .gap(px(4.))
                .child(div().w_full().child(message))
                .when_some(entry.url.clone(), |this, url| {
                    // Under the message's text, past its 13px icon and 6px gap.
                    this.child(
                        link("plugin-details-learn-more", t!("Learn more"), url, cx).ml(px(19.)),
                    )
                }),
        );
    }
    if let Offer::Update { asks, .. } = &offer
        && !model::asks_nothing(asks)
    {
        body = body.child(
            section(
                t!("Version {version} also wants:", version = plugin.version).into(),
                cx,
            )
            .child(bullets(text::permission_lines(asks), cx)),
        );
    }
    body = body.child(
        section(t!("This plugin can").into(), cx)
            .child(bullets(text::permission_lines(&plugin.permissions), cx))
            .child(caption(
                t!("It can’t read other files, use your API keys or environment, or write files without asking you."),
                palette.text_secondary,
                cx,
            )),
    );
    if !plugin.commands.is_empty() {
        body = body.child(
            section(t!("Commands it adds").into(), cx).child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .children(plugin.commands.iter().map(|command| {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .child(
                                div()
                                    .text_role_in(TextRole::BodyCompact, TypeScale::Interface, cx)
                                    .text_color(palette.text)
                                    .child(command.title.clone()),
                            )
                            .children(command.description.clone().map(|description| {
                                caption(description, palette.text_secondary, cx)
                            }))
                    })),
            ),
        );
    }
    if let Some(error) = error {
        body = body.child(controls::inline_message(Level::Error, error, cx));
    }

    let id = plugin.id.clone();
    let install = |label: SharedString, turn_on: bool, primary: bool| {
        let pane = pane.clone();
        let id = id.clone();
        let button = Button::new(
            SharedString::from(format!("plugin-details-install-{turn_on}")),
            label,
        )
        .disabled(!can_install)
        .on_click(move |_, window, cx| {
            pane.update(cx, |pane, cx| {
                pane.install_registry(id.clone(), turn_on, window, cx)
            })
        });
        if primary { button.primary() } else { button }
    };
    let mut foot = div().w_full().flex().items_center().gap(px(8.));
    match &offer {
        Offer::Install => {
            foot = foot
                .child(div().flex_1())
                .child(install(t!("Install only").into(), false, false))
                .child(install(t!("Install and turn on").into(), true, true));
        }
        Offer::Blocked(_) => {
            foot = foot.child(div().flex_1()).child(
                Button::new("plugin-details-blocked", t!("Blocked"))
                    .danger()
                    .disabled(true),
            );
        }
        Offer::Installed(info) | Offer::Update { info, .. } => {
            let remove = {
                let pane = pane.clone();
                let info = info.clone();
                Button::new("plugin-details-remove", t!("Remove"))
                    .ghost()
                    .disabled(busy)
                    .on_click(move |_, _, cx| pane.update(cx, |pane, cx| pane.remove(&info, cx)))
            };
            foot = foot.child(remove).child(div().flex_1());
            let quiet = match &offer {
                Offer::Update { asks, .. } => model::asks_nothing(asks),
                _ => true,
            };
            if let Offer::Update { version, .. } = &offer {
                if quiet {
                    let pane = pane.clone();
                    let (id, on) = (id.clone(), info.enabled);
                    foot = foot.child(
                        Button::new(
                            "plugin-details-update",
                            t!("Update to {version}", version = version),
                        )
                        .tinted()
                        .disabled(!can_install)
                        .on_click(move |_, window, cx| {
                            pane.update(cx, |pane, cx| {
                                pane.install_registry(id.clone(), on, window, cx)
                            })
                        }),
                    );
                } else {
                    let keep = {
                        let close = close.clone();
                        Button::new(
                            "plugin-details-keep",
                            t!("Keep {current}", current = info.version),
                        )
                        .ghost()
                        .on_click(move |_, window, cx| close(window, cx))
                    };
                    foot =
                        foot.child(keep)
                            .child(install(t!("Allow and update").into(), true, true));
                }
            }
            if quiet {
                let pane = pane.clone();
                let shown = info.clone();
                foot = foot.child(controls::switch(
                    "plugin-details-enabled",
                    info.enabled,
                    !AVAILABLE || busy || (turned_off && !info.enabled),
                    move |on, window, cx| {
                        pane.update(cx, |pane, cx| pane.set_enabled(&shown, on, window, cx))
                    },
                ));
            }
        }
    }
    let surface = Sheet::new("plugin-details", name)
        .width(CONTAINER_DIALOG_SHEET)
        .icon(Icon::PACKAGE)
        .on_close(close)
        .action(foot)
        .child(div().id("plugin-details-body").child(body))
        .into_any_element();
    let pane = pane.downgrade();
    Some(
        ModalLayer::new(LAYER, LayerPlacement::Center, surface, move |_, cx| {
            pane.update(cx, |pane, cx| pane.close_details(cx)).ok();
        })
        .into_any_element(),
    )
}
