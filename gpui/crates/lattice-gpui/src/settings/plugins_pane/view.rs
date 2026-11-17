//! Settings › Plugins drawn: the install rows and form, then a card per
//! plugin (`super` holds the state and the host calls).

use gpui::{
    AnyElement, Context, ElementId, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, div, prelude::FluentBuilder as _, px,
};
use lattice_core::plugins::{AVAILABLE, PluginInfo, Source};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _, TypeScale,
    components::{Badge, BadgeTone, Button, Field},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{PluginsPane, Target};
use crate::{
    plugins::text,
    settings::controls::{self, Level, Marks, PageWidth, Row, Wrap},
};

/// The muted caption lines of a card.
fn caption(text: impl Into<SharedString>, cx: &gpui::App) -> gpui::Div {
    div()
        .min_w_0()
        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
        .text_color(cx.palette().text_secondary)
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
        let loader =
            |id: &'static str| crate::build::chip_mark::infinity_loader(id, px(14.), &palette);
        // Installing.
        let mut rows = vec![controls::block(
            caption(
                t!(
                    "Plugins add commands to the command palette. Each one runs in a sandbox and can use only what you allow."
                ),
                cx,
            ),
            false,
        )];
        if !AVAILABLE {
            rows.push(controls::block(
                controls::inline_message(
                    Level::Warning,
                    t!("Plugins run only on macOS for now. They are listed here but don’t run."),
                    cx,
                ),
                true,
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
                        cx.notify();
                    })
                })
        };
        rows.push(
            marks.row(
                Row::new("plugins-install-url", t!("Install from URL"))
                    .description(
                        t!("A .zip release and the SHA-256 its author publishes beside it"),
                        cx,
                    )
                    .control(controls::in_column(toggle_url)),
                width,
                cx,
            ),
        );
        if self.url_open {
            let empty = self.url.read(cx).value().trim().is_empty()
                || self.sha256.read(cx).value().trim().is_empty();
            let install = {
                let this = this.clone();
                Button::new("plugins-install", t!("Install"))
                    .compact()
                    .primary()
                    .disabled(busy || empty)
                    .on_click(move |_, window, cx| {
                        this.update(cx, |pane, cx| pane.install_url(window, cx))
                    })
            };
            rows.push(controls::block(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(Field::new(&self.url).disabled(busy))
                    .child(Field::new(&self.sha256).disabled(busy))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(install)
                            .when(self.busy == Some(Target::Install), |row| {
                                row.child(loader("plugins-installing"))
                            }),
                    ),
                true,
            ));
        }
        let pick = {
            let this = this.clone();
            Button::new("plugins-install-folder", t!("Install from folder…"))
                .compact()
                .disabled(busy)
                .on_click(move |_, _, cx| this.update(cx, |pane, cx| pane.pick_folder(cx)))
        };
        rows.push(marks.row(
            Row::new("plugins-install-folder", t!("Install from folder"))
                .description(
                    t!("For developing a plugin: Lattice runs it from the folder, so your edits apply on the next run"),
                    cx,
                )
                .control(controls::in_column(pick)),
            width,
            cx,
        ));
        rows.extend(self.message(&Target::Install, cx));
        let mut groups = vec![controls::first_group(None, rows, cx)];
        match self.plugins.clone() {
            None => groups.push(loader("plugins-loading")),
            Some(list) if list.is_empty() => groups.push(
                caption(t!("No plugins installed yet."), cx)
                    .px(px(4.))
                    .into_any_element(),
            ),
            Some(list) => {
                for plugin in list {
                    groups.push(self.card(&plugin, width, marks, cx));
                }
            }
        }
        controls::page(t!("Plugins"), width, groups, cx)
    }

    fn card(
        &mut self,
        plugin: &PluginInfo,
        width: PageWidth,
        marks: &Marks,
        cx: &mut Context<Self>,
    ) -> AnyElement {
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
                plugin.enabled && !plugin.needs_review,
                busy || !AVAILABLE,
                move |on, window, cx| {
                    this.update(cx, |pane, cx| pane.set_enabled(&shown, on, window, cx))
                },
            )
        };
        let mut rows = vec![
            marks.row(
                Row::new(row_id, plugin.name.clone())
                    .description(plugin.description.clone().unwrap_or_default(), cx)
                    .control(switch)
                    .wrap(Wrap::Never),
                width,
                cx,
            ),
        ];
        let source = match &plugin.source {
            Source::Url { url, .. } => url.clone(),
            Source::Folder { path } => path.display().to_string(),
        };
        rows.push(controls::block(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(caption(
                    format!("{} · {}", t!("Version {0}", plugin.version), plugin.id),
                    cx,
                ))
                .child(caption(
                    format!("{} · {}", t!("License {0}", plugin.license), source),
                    cx,
                )),
            true,
        ));
        if plugin.needs_review {
            let review = {
                let this = this.clone();
                let shown = plugin.clone();
                Button::new(
                    ElementId::Name(format!("plugin-review-{id}").into()),
                    t!("Review and turn on…"),
                )
                .compact()
                .disabled(busy || !AVAILABLE)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.set_enabled(&shown, true, window, cx))
                })
            };
            rows.push(controls::block(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(controls::inline_message(
                        Level::Warning,
                        t!("Asks for new permissions"),
                        cx,
                    ))
                    .child(review),
                true,
            ));
        }
        if let Some(error) = &plugin.error {
            rows.push(controls::block(
                controls::inline_message(Level::Error, error.clone(), cx),
                true,
            ));
        }
        rows.push(controls::block(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .child(t!("Permissions")),
                )
                .children(
                    text::permission_lines(&plugin.permissions)
                        .into_iter()
                        .map(|line| caption(format!("• {line}"), cx)),
                ),
            false,
        ));
        for secret in &plugin.secrets {
            let Some(input) = self
                .secrets
                .get(&(id.clone(), secret.name.clone()))
                .cloned()
            else {
                continue;
            };
            let empty = input.read(cx).value().is_empty();
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
                    let value = input.read(cx).value().to_string();
                    this.update(cx, |pane, cx| {
                        pane.save_secret(id.clone(), name.clone(), Some(value), window, cx)
                    })
                })
            };
            let clear = secret.saved.then(|| {
                let this = this.clone();
                let (id, name) = (id.clone(), secret.name.clone());
                Button::new(
                    ElementId::Name(format!("plugin-secret-clear-{id}-{name}").into()),
                    t!("Clear"),
                )
                .compact()
                .ghost()
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| {
                        pane.save_secret(id.clone(), name.clone(), None, window, cx)
                    })
                })
            });
            rows.push(controls::block(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(palette.text)
                                    .child(t!("Secret “{0}”", secret.name)),
                            )
                            .when(secret.saved, |row| {
                                row.child(
                                    Badge::new(t!("Saved")).compact().tone(BadgeTone::Success),
                                )
                            }),
                    )
                    .child(Field::new(&input).disabled(busy))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .child(save)
                            .children(clear),
                    ),
                false,
            ));
        }
        let remove = {
            let this = this.clone();
            let shown = plugin.clone();
            Button::new(
                ElementId::Name(format!("plugin-remove-{id}").into()),
                t!("Remove"),
            )
            .compact()
            .ghost_danger()
            .disabled(busy)
            .on_click(move |_, _, cx| this.update(cx, |pane, cx| pane.remove(&shown, cx)))
        };
        rows.push(controls::block(
            div().flex().items_center().gap(px(8.)).child(remove).when(
                self.busy == Some(Target::Plugin(id.clone())),
                |row| {
                    row.child(crate::build::chip_mark::infinity_loader(
                        ElementId::Name(format!("plugin-working-{id}").into()),
                        px(14.),
                        &palette,
                    ))
                },
            ),
            false,
        ));
        rows.extend(self.message(&Target::Plugin(id), cx));
        controls::group(None, rows, cx)
    }
}
