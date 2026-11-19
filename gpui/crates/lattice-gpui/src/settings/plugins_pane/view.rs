//! Settings › Plugins drawn as the Tauri app's (`plugin-settings.tsx`,
//! `plugins.css`): the intro, Installed · Browse and the search field, then
//! Browse (`browse.rs`) or the Install group and its URL form and per plugin
//! its name, version and where it came from over a frameless card (`super`
//! holds the state and the host calls).

use gpui::{
    AnyElement, Context, ElementId, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::plugins::{AVAILABLE, PluginInfo, Source};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field, Segmented},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR, FONT_WEIGHT_SEMIBOLD},
};

use super::{PluginsPane, Target, View, model};
use crate::{
    plugins::text,
    settings::controls::{self, Level, Marks, PageWidth, Row},
};

/// Text in Settings' scale: `role` in `ink`.
fn words(
    text: impl Into<SharedString>,
    role: TextRole,
    ink: gpui::Hsla,
    cx: &gpui::App,
) -> gpui::Div {
    div()
        .min_w_0()
        .text_role_in(role, TypeScale::Settings, cx)
        .text_color(ink)
        .child(text.into())
}

impl PluginsPane {
    pub(super) fn render_page(
        &mut self,
        width: PageWidth,
        marks: &Marks,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let busy = self.busy.is_some();
        let this = cx.entity();
        let mut groups = vec![
            words(
                t!("Plugins add commands to the command palette (⌘K). Each runs in a sandbox and can reach only what you allow when you turn it on."),
                TextRole::Body,
                palette.text_secondary,
                cx,
            )
            .into_any_element(),
        ];
        if !AVAILABLE {
            groups.push(controls::inline_message(
                Level::Warning,
                t!("Plugins run only on macOS for now. They are listed here, but can’t be turned on."),
                cx,
            ));
        }
        // `.plugin-settings-bar`: the segmented control, then the search
        // field filling the rest, 8px apart, 12px under the intro.
        let mut views = Segmented::new("plugins-view").filled();
        for (view, label) in [
            (View::Installed, t!("Installed")),
            (View::Browse, t!("Browse")),
        ] {
            let this = this.clone();
            views = views.label(label, self.view == view, move |_, window, cx| {
                this.update(cx, |pane, cx| pane.set_view(view, window, cx))
            });
        }
        let bar = div().flex().items_center().gap(px(8.)).child(views).child(
            div()
                .flex_1()
                .min_w_0()
                .child(Field::new(&self.search).search().compact()),
        );
        // Browse's status line and rows follow the bar as closely as the
        // Tauri app's, inside the intro's group rather than a page gap below.
        let browse = (self.view == View::Browse).then(|| self.browse(window, cx));
        if let Some(intro) = groups.first_mut() {
            let first = std::mem::replace(intro, div().into_any_element());
            *intro = div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(first)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(bar)
                        .children(browse),
                )
                .into_any_element();
        }
        if self.view == View::Browse {
            let this = this.clone();
            let refresh = Button::new("plugins-refresh", t!("Refresh"))
                .compact()
                .disabled(self.refreshing)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.load_listing(true, window, cx))
                })
                .into_any_element();
            return controls::page_with_action(t!("Plugins"), Some(refresh), width, groups, cx);
        }
        let update_all = (!model::quiet_updates(self.listing.as_ref(), &self.listed()).is_empty())
            .then(|| {
                let this = this.clone();
                Button::new("plugins-update-all", t!("Update all"))
                    .compact()
                    .tinted()
                    .disabled(busy || !AVAILABLE)
                    .on_click(move |_, window, cx| {
                        this.update(cx, |pane, cx| pane.update_all(window, cx))
                    })
                    .into_any_element()
            });
        if let Some(error) = self.errors.get(&Target::Updates) {
            groups.push(controls::inline_message(Level::Error, error.clone(), cx));
        }
        let toggle_url = {
            let this = this.clone();
            Button::new("plugins-install-url", t!("Install from URL…"))
                .compact()
                .disabled(busy)
                .on_click(move |_, _, cx| {
                    this.update(cx, |pane, cx| {
                        pane.url_open = !pane.url_open;
                        pane.errors.remove(&Target::Install);
                        cx.notify();
                    })
                })
        };
        let mut rows = vec![marks.row(
            Row::new("plugins-install-url", t!("Install from URL…"))
                .description(
                    t!("A plugin’s .zip release over https, checked against the SHA-256 its author publishes."),
                    cx,
                )
                .control(controls::in_column(toggle_url)),
            width,
            cx,
        )];
        if self.url_open {
            let valid = self.url_valid(cx);
            let install = {
                let this = this.clone();
                Button::new("plugins-install", t!("Install"))
                    .compact()
                    .primary()
                    .disabled(busy || !valid)
                    .on_click(move |_, window, cx| {
                        this.update(cx, |pane, cx| pane.install_url(window, cx))
                    })
            };
            // `.plugin-install-form`: the link and the checksum side by
            // side, then Install, 6px apart.
            rows.push(controls::block(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Field::new(&self.url).disabled(busy)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Field::new(&self.sha256).disabled(busy)),
                    )
                    .child(install),
                false,
            ));
        }
        let pick = {
            let this = this.clone();
            Button::new("plugins-install-folder", t!("Choose folder…"))
                .compact()
                .disabled(busy)
                .on_click(move |_, _, cx| this.update(cx, |pane, cx| pane.pick_folder(cx)))
        };
        rows.push(marks.row(
            Row::new("plugins-install-folder", t!("Install from folder…"))
                .description(
                    t!("For developing a plugin: Lattice runs the folder in place, so your edits apply on the next run."),
                    cx,
                )
                .control(controls::in_column(pick)),
            width,
            cx,
        ));
        groups.push(controls::first_group(Some(t!("Install").into()), rows, cx));
        if let Some(error) = self.errors.get(&Target::Install) {
            groups.push(controls::inline_message(Level::Error, error.clone(), cx));
        }
        let query = self.search.read(cx).value().trim().to_string();
        match self.plugins.clone() {
            None => {}
            Some(list) if list.is_empty() => groups.push(
                words(
                    t!("No plugins installed."),
                    TextRole::Body,
                    palette.text_secondary,
                    cx,
                )
                .into_any_element(),
            ),
            Some(list) => {
                let shown: Vec<_> = list
                    .into_iter()
                    .filter(|plugin| query.is_empty() || model::installed_matches(plugin, &query))
                    .collect();
                if shown.is_empty() {
                    groups.push(
                        words(
                            t!("No installed plugins match"),
                            TextRole::Body,
                            palette.text_secondary,
                            cx,
                        )
                        .into_any_element(),
                    );
                }
                for plugin in shown {
                    groups.push(self.card(&plugin, cx));
                }
            }
        }
        controls::page_with_action(t!("Plugins"), update_all, width, groups, cx)
    }

    /// A plugin's card (`PluginCard`): no frame, its name and version as
    /// the heading, then its parts 12px in.
    fn card(&mut self, plugin: &PluginInfo, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let this = cx.entity();
        let busy = self.busy.is_some();
        let id = plugin.id.clone();
        let row_id = controls::row_id("plugin", &id);
        let turned_off = plugin.blocked.as_ref().is_some_and(model::turns_off);
        let switch = {
            let this = this.clone();
            let shown = plugin.clone();
            controls::switch(
                row_id,
                plugin.enabled,
                busy || !AVAILABLE || (turned_off && !plugin.enabled),
                move |on, window, cx| {
                    this.update(cx, |pane, cx| pane.set_enabled(&shown, on, window, cx))
                },
            )
        };
        let source = match &plugin.source {
            Source::Url { url, .. } | Source::Registry { url, .. } => {
                t!("From {source}", source = url)
            }
            Source::Folder { path } => t!("Folder {source}", source = path.display()),
        };
        let heading = div()
            .mb(px(8.))
            .flex()
            .items_baseline()
            .gap(px(4.))
            .text_role_in(TextRole::Subtitle, TypeScale::Settings, cx)
            .child(
                div()
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .text_color(palette.text)
                    .child(SharedString::from(plugin.name.clone())),
            )
            .child(
                div()
                    .text_color(palette.text_secondary)
                    .child(SharedString::from(plugin.version.clone())),
            )
            .child({
                // `.plugin-card-tier`: the caption in the tertiary ink, a
                // reviewed plugin's in the success colour.
                let (tier, ink) = match plugin.source {
                    Source::Registry { .. } => (t!("Reviewed"), palette.success),
                    Source::Url { .. } => (t!("Not reviewed"), palette.text_secondary),
                    Source::Folder { .. } => (t!("Developer"), palette.text_secondary),
                };
                words(tier, TextRole::Caption, ink, cx).font_weight(FONT_WEIGHT_REGULAR)
            });
        let head = div()
            .px(px(12.))
            .py(px(10.))
            .flex()
            .items_start()
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(words(
                        plugin.id.clone(),
                        TextRole::Caption,
                        palette.text_secondary,
                        cx,
                    ))
                    .children(
                        plugin
                            .description
                            .clone()
                            .filter(|description| !description.trim().is_empty())
                            .map(|description| {
                                words(description, TextRole::Body, palette.text, cx)
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_x(px(12.))
                            .gap_y(px(4.))
                            .child(words(
                                t!("Licence: {license}", license = plugin.license),
                                TextRole::Caption,
                                palette.text_secondary,
                                cx,
                            ))
                            .child(
                                words(source, TextRole::Caption, palette.text_secondary, cx)
                                    .max_w_full()
                                    .truncate(),
                            ),
                    ),
            )
            .child(switch);
        let blocked = plugin.blocked.clone().map(|entry| {
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
            div()
                .px(px(12.))
                .pb(px(8.))
                .flex()
                .flex_col()
                .items_start()
                .gap(px(4.))
                .child(div().w_full().child(message))
                .when_some(entry.url, |this, url| {
                    // Under the message's text, past its 13px icon and 6px gap.
                    this.child(
                        super::browse::link(
                            format!("plugin-learn-more-{id}"),
                            t!("Learn more"),
                            url,
                            cx,
                        )
                        .ml(px(19.)),
                    )
                })
        });
        let update = model::update_of(self.listing.as_ref(), &id).map(|(version, _)| {
            let this = this.clone();
            let open = id.clone();
            div()
                .px(px(12.))
                .pb(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(controls::inline_message(
                    Level::Info,
                    t!("Version {next} is available", next = version),
                    cx,
                ))
                .child(
                    Button::new(
                        ElementId::Name(format!("plugin-update-{id}").into()),
                        t!("Update…"),
                    )
                    .compact()
                    .tinted()
                    .disabled(busy)
                    .on_click(move |_, _, cx| {
                        this.update(cx, |pane, cx| pane.open_details(open.clone(), cx))
                    }),
                )
        });
        let review = plugin.needs_review.then(|| {
            let shown = plugin.clone();
            let this = this.clone();
            div()
                .px(px(12.))
                .pb(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(controls::inline_message(
                    Level::Warning,
                    t!("Asks for new permissions"),
                    cx,
                ))
                .child(
                    Button::new(
                        ElementId::Name(format!("plugin-review-{id}").into()),
                        t!("Review…"),
                    )
                    .compact()
                    .disabled(busy || !AVAILABLE)
                    .on_click(move |_, window, cx| {
                        this.update(cx, |pane, cx| pane.set_enabled(&shown, true, window, cx))
                    }),
                )
        });
        let access = div()
            .px(px(12.))
            .py(px(8.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                words(t!("Access"), TextRole::Caption, palette.text_secondary, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM),
            )
            .child(
                div().flex().flex_col().gap(px(2.)).children(
                    text::permission_lines(&plugin.permissions)
                        .into_iter()
                        .map(|line| {
                            div()
                                .flex()
                                .text_role_in(TextRole::Body, TypeScale::Settings, cx)
                                .text_color(palette.text)
                                .child(div().flex_none().w(px(16.)).child("•"))
                                .child(div().flex_1().min_w_0().child(SharedString::from(line)))
                        }),
                ),
            );
        let mut parts = vec![
            head.into_any_element(),
            blocked
                .map(|blocked| blocked.into_any_element())
                .unwrap_or_else(|| div().into_any_element()),
            update
                .map(|update| update.into_any_element())
                .unwrap_or_else(|| div().into_any_element()),
            review
                .map(|review| review.into_any_element())
                .unwrap_or_else(|| div().into_any_element()),
            access.into_any_element(),
        ];
        for secret in &plugin.secrets {
            let Some(input) = self
                .secrets
                .get(&(id.clone(), secret.name.clone()))
                .cloned()
            else {
                continue;
            };
            let empty = input.read(cx).value().trim().is_empty();
            let save = {
                let this = this.clone();
                let (id, name, input) = (id.clone(), secret.name.clone(), input.clone());
                Button::new(
                    ElementId::Name(format!("plugin-secret-save-{id}-{name}").into()),
                    t!("Save"),
                )
                .compact()
                .disabled(busy || empty)
                .on_click(move |_, window, cx| {
                    let value = input.read(cx).value().trim().to_string();
                    this.update(cx, |pane, cx| {
                        pane.save_secret(id.clone(), name.clone(), Some(value), window, cx)
                    })
                })
            };
            let clear = {
                let this = this.clone();
                let (id, name) = (id.clone(), secret.name.clone());
                Button::new(
                    ElementId::Name(format!("plugin-secret-clear-{id}-{name}").into()),
                    t!("Clear"),
                )
                .compact()
                .ghost()
                .disabled(busy || !secret.saved)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| {
                        pane.save_secret(id.clone(), name.clone(), None, window, cx)
                    })
                })
            };
            parts.push(
                div()
                    .pb(px(8.))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(words(secret.name.clone(), TextRole::Body, palette.text, cx))
                            .child(words(
                                if secret.saved {
                                    t!("Saved")
                                } else {
                                    t!("Not saved")
                                },
                                TextRole::Caption,
                                palette.text_secondary,
                                cx,
                            )),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(Field::new(&input).disabled(busy)),
                            )
                            .child(save)
                            .child(clear),
                    )
                    .into_any_element(),
            );
        }
        let errors = plugin
            .error
            .iter()
            .map(|error| crate::host_errors::text(error))
            .chain(self.errors.get(&Target::Plugin(id.clone())).cloned())
            .map(|error| {
                div()
                    .mx(px(12.))
                    .mb(px(8.))
                    .child(controls::inline_message(Level::Error, error, cx))
                    .into_any_element()
            })
            .collect::<Vec<_>>();
        parts.extend(errors);
        let remove = {
            let this = this.clone();
            let shown = plugin.clone();
            Button::new(
                ElementId::Name(format!("plugin-remove-{id}").into()),
                t!("Remove"),
            )
            .compact()
            .disabled(busy)
            .on_click(move |_, _, cx| this.update(cx, |pane, cx| pane.remove(&shown, cx)))
        };
        parts.push(
            div()
                .px(px(12.))
                .pt(px(4.))
                .pb(px(8.))
                .flex()
                .items_center()
                .justify_end()
                .gap(px(8.))
                .when(self.busy == Some(Target::Plugin(id.clone())), |row| {
                    row.child(crate::build::chip_mark::infinity_loader(
                        ElementId::Name(format!("plugin-working-{id}").into()),
                        px(14.),
                        &palette,
                    ))
                })
                .child(remove)
                .into_any_element(),
        );
        div()
            .flex()
            .flex_col()
            .child(heading)
            .children(parts)
            .into_any_element()
    }
}
