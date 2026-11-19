//! Settings › Plugins drawn as the Tauri app's (`plugin-settings.tsx`,
//! `plugins.css`): the intro, the Install group and its URL form, then per
//! plugin its name and version over a frameless card (`super` holds the
//! state and the host calls).

use gpui::{
    AnyElement, Context, ElementId, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, div, prelude::FluentBuilder as _, px,
};
use lattice_core::plugins::{AVAILABLE, PluginInfo, Source};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, TypeScale,
    components::{Button, Field},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{PluginsPane, Target};
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
                for plugin in list {
                    groups.push(self.card(&plugin, cx));
                }
            }
        }
        controls::page(t!("Plugins"), width, groups, cx)
    }

    /// A plugin's card (`PluginCard`): no frame, its name and version as
    /// the heading, then its parts 12px in.
    fn card(&mut self, plugin: &PluginInfo, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let this = cx.entity();
        let busy = self.busy.is_some();
        let id = plugin.id.clone();
        let row_id = controls::row_id("plugin", &id);
        let switch = {
            let this = this.clone();
            let shown = plugin.clone();
            controls::switch(
                row_id,
                plugin.enabled,
                busy || !AVAILABLE,
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
            );
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
