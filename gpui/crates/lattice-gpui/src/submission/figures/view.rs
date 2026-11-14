//! How the figure inventory draws: the sheet's actions and notes, a card per
//! image with its uses, and the open card's preview and replacement.

use gpui::{
    AnyElement, App, Context, ImageSource, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Window, div, img, prelude::FluentBuilder as _, px,
};
use lattice_i18n::{comma, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Badge, Button, LayerPlacement, ModalLayer, Select, Sheet},
};

use super::{
    FigureInventory, Preview,
    scan::{FigureUse, figure_argument, is_figure_asset, is_vector_figure},
    undo_of,
};

/// An `InlineMessage` of the warning or error level.
fn message(text: impl Into<SharedString>, error: bool, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(6.))
        .text_role(TextRole::Caption, cx)
        .text_color(palette.text)
        .child(div().flex_none().pt(px(1.5)).child(if error {
            Icon::CIRCLE_ALERT.element(px(13.), palette.danger)
        } else {
            Icon::TRIANGLE_ALERT.element(px(13.), palette.warning)
        }))
        .child(div().min_w_0().child(text.into()))
        .into_any_element()
}

fn caption(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    div()
        .text_role(TextRole::Caption, cx)
        .text_color(cx.palette().text_secondary)
        .child(text.into())
        .into_any_element()
}

fn vector_badge() -> AnyElement {
    Badge::new(t!("Vector")).compact().into_any_element()
}

impl FigureInventory {
    fn render_preview(&self, path: &str, uses: &[FigureUse], cx: &App) -> AnyElement {
        let preview = self.previews.get(path).cloned().unwrap_or(Preview::Loading);
        let vector = is_vector_figure(path);
        let mut parts: Vec<AnyElement> = Vec::new();
        let shown = |source: ImageSource| {
            div()
                .child(img(source).max_w_full().max_h(px(180.)))
                .into_any_element()
        };
        match &preview {
            Preview::Raster { path, .. } => parts.push(shown(ImageSource::from(path.clone()))),
            Preview::Vector(Some(source)) => parts.push(shown(source.clone())),
            _ => {}
        }
        let pixels = match preview {
            Preview::Raster { width, height, .. } => Some((width, height)),
            _ => None,
        };
        if vector {
            parts.push(div().child(vector_badge()).into_any_element());
        } else {
            parts.push(caption(
                match pixels {
                    Some((width, height)) => {
                        t!("{width} × {height} pixels", width = width, height = height)
                    }
                    None => t!("Dimensions unknown").to_string(),
                },
                cx,
            ));
        }
        if matches!(preview, Preview::Failed | Preview::Vector(None)) {
            parts.push(caption(t!("Preview unavailable"), cx));
        }
        if !vector {
            for use_ in uses {
                let dpi = pixels.zip(use_.width_inches).map(|((width, _), inches)| {
                    t!(
                        "{dpi} DPI at the specified width",
                        dpi = (width as f64 / inches).round() as i64
                    )
                });
                parts.push(caption(
                    format!(
                        "{}:{}{}{}",
                        use_.source,
                        use_.line,
                        comma(),
                        dpi.unwrap_or_else(|| t!("DPI unknown").to_string())
                    ),
                    cx,
                ));
            }
        }
        div()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(4.))
            .children(parts)
            .into_any_element()
    }

    fn render_group(
        &mut self,
        key: &str,
        uses: &[FigureUse],
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let busy = self.busy;
        let asset = uses[0].asset.clone();
        let open = self.selected.as_deref() == Some(key);
        let mut actions = div().flex().flex_wrap().items_center().gap(px(4.));
        if let Some(asset) = asset.clone() {
            actions = actions.child(
                Button::new(
                    SharedString::from(format!("figure-open-{index}")),
                    t!("Open original"),
                )
                .compact()
                .disabled(busy)
                .on_click(
                    cx.listener(move |this, _, _, cx| this.navigate(asset.clone(), None, cx)),
                ),
            );
        }
        let toggled = key.to_string();
        actions = actions.child(
            Button::new(
                SharedString::from(format!("figure-inspect-{index}")),
                if open {
                    t!("Hide details")
                } else {
                    t!("Inspect and replace")
                },
            )
            .compact()
            .disabled(busy || self.loading)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected =
                    (this.selected.as_deref() != Some(toggled.as_str())).then(|| toggled.clone());
                this.target = None;
                this.plan = None;
                cx.notify();
            })),
        );
        let use_rows: Vec<AnyElement> = uses
            .iter()
            .enumerate()
            .map(|(row, use_)| {
                let (path, line) = (use_.source.clone(), use_.line);
                let mut refs = div().flex().flex_wrap().items_center().gap(px(4.));
                if use_.references.is_empty() {
                    refs = refs.child(caption(t!("No literal references found"), cx));
                }
                for (at, (source, line)) in use_.references.iter().enumerate() {
                    let (source, line) = (source.clone(), *line);
                    refs = refs.child(
                        Button::new(
                            SharedString::from(format!("figure-ref-{index}-{row}-{at}")),
                            format!("{} {source}:{line}", t!("Reference:")),
                        )
                        .ghost()
                        .compact()
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.navigate(source.clone(), Some(line), cx)
                        })),
                    );
                }
                div()
                    .min_w_0()
                    .pl(px(6.))
                    .border_l_1()
                    .border_color(palette.line)
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div().child(
                            Button::new(
                                SharedString::from(format!("figure-use-{index}-{row}")),
                                format!("{}:{}", use_.source, use_.line),
                            )
                            .ghost()
                            .compact()
                            .disabled(busy)
                            .on_click(cx.listener(
                                move |this, _, _, cx| this.navigate(path.clone(), Some(line), cx),
                            )),
                        ),
                    )
                    .when(use_.asset.is_none(), |this| {
                        this.child(message(
                            if use_.dynamic {
                                t!("Path unresolved — macro or ambiguous filename")
                            } else {
                                t!("Missing image")
                            },
                            false,
                            cx,
                        ))
                    })
                    .child(caption(
                        if use_.caption.is_empty() {
                            t!("Empty or unresolved caption").to_string()
                        } else {
                            use_.caption.clone()
                        },
                        cx,
                    ))
                    .child(caption(
                        if use_.labels.is_empty() {
                            t!("No literal label").to_string()
                        } else {
                            use_.labels.join(", ")
                        },
                        cx,
                    ))
                    .when(!use_.duplicate_labels.is_empty(), |this| {
                        this.child(message(
                            format!(
                                "{} {}",
                                t!("Duplicate labels:"),
                                use_.duplicate_labels.join(", ")
                            ),
                            false,
                            cx,
                        ))
                    })
                    .child(refs)
                    .into_any_element()
            })
            .collect();
        let details = open.then(|| self.render_details(key, uses, index, cx));
        div()
            .min_w_0()
            .pt(px(8.))
            .pb(px(8.))
            .border_t_1()
            .border_color(palette.line)
            .flex()
            .flex_col()
            .gap(px(6.))
            .when(index == 0, |card| {
                card.children(lattice_ui::parity::probe("figures/card"))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_role(TextRole::Body, cx)
                    .font_weight(lattice_ui::tokens::FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text)
                    .child(div().min_w_0().child(key.to_string()))
                    .when(asset.as_deref().is_some_and(is_vector_figure), |head| {
                        head.child(vector_badge())
                    }),
            )
            .child(actions)
            .children(use_rows)
            .children(details)
            .into_any_element()
    }

    fn render_details(
        &mut self,
        key: &str,
        uses: &[FigureUse],
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let busy = self.busy;
        let asset = uses[0].asset.clone();
        if let Some(asset) = &asset {
            self.ensure_preview(asset, cx);
        }
        let choices: Vec<String> = self
            .paths
            .iter()
            .filter(|path| is_figure_asset(path) && Some(*path) != asset.as_ref())
            .cloned()
            .collect();
        if let Some(target) = self.target.clone() {
            self.ensure_preview(&target, cx);
        }
        let selected = self
            .target
            .as_ref()
            .and_then(|target| choices.iter().position(|path| path == target));
        let locked = busy || uses.iter().any(|use_| use_.dynamic) || !self.unreadable.is_empty();
        let options = choices.clone();
        let select = Select::new(
            SharedString::from(format!("figure-target-{index}")),
            choices.clone(),
            selected,
        )
        .placeholder(t!("Choose a project image"))
        .disabled(locked)
        .on_change(cx.listener(move |this, chosen: &usize, _, cx| {
            this.target = options.get(*chosen).cloned();
            this.plan = None;
            cx.notify();
        }));
        let plan_uses = uses.to_vec();
        let fresh = self.plan.clone().filter(|plan| {
            !self.loading
                && plan
                    .iter()
                    .all(|edit| self.live_sources().get(&edit.path) == Some(&edit.before))
        });
        let target = self.target.clone();
        let _ = key;
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(asset.as_deref().map(|asset| self.render_preview(asset, uses, cx)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text)
                    .child(t!("Replace these usages with"))
                    .child(select),
            )
            .children(target.as_deref().map(|target| self.render_preview(target, uses, cx)))
            .child(
                div().child(
                    Button::new(SharedString::from(format!("figure-plan-{index}")), t!("Preview replacement"))
                        .disabled(target.is_none() || busy || self.loading)
                        .on_click(cx.listener(move |this, _, _, cx| this.preview_plan(&plan_uses, cx))),
                ),
            )
            .children(fresh.map(|plan| {
                let target = target.clone().unwrap_or_default();
                div()
                    .p(px(6.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(palette.line)
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(caption(t!("Only the listed graphics arguments will change. Image files stay in place."), cx))
                    .children(uses.iter().map(|use_| {
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(format!("{}:{}", use_.source, use_.line))
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap_x(px(4.))
                                    .child(div().line_through().child(use_.raw.clone()))
                                    .child("→")
                                    .child(div().underline().text_color(palette.text).child(figure_argument(&target))),
                            )
                    }))
                    .child(
                        div().child(
                            Button::new(SharedString::from(format!("figure-write-{index}")), t!("Replace listed usages"))
                                .primary()
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, _, cx| this.write(plan.clone(), false, cx))),
                        ),
                    )
            }))
            .into_any_element()
    }
}

impl Render for FigureInventory {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let inventory = self.inventory();
        let mut groups: Vec<(String, Vec<FigureUse>)> = Vec::new();
        for use_ in inventory.uses.iter().cloned() {
            let key = use_.asset.clone().unwrap_or_else(|| use_.raw.clone());
            match groups.iter_mut().find(|(existing, _)| *existing == key) {
                Some((_, uses)) => uses.push(use_),
                None => groups.push((key, vec![use_])),
            }
        }
        let count = inventory.uses.len();
        let has_undo = !undo_of(&self.root, cx).is_empty();
        let mut body: Vec<AnyElement> = Vec::new();
        let mut actions = div().flex().flex_wrap().items_center().gap(px(4.)).child(
            Button::new("figure-refresh", t!("Refresh"))
                .disabled(self.busy || self.loading)
                .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
        );
        if has_undo {
            actions = actions.child(
                Button::new("figure-undo", t!("Undo replacement"))
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.undo(cx))),
            );
        }
        body.push(actions.into_any_element());
        if self.busy {
            body.push(caption(t!("Applying figure changes…"), cx));
        }
        if let Some(error) = self.error.clone() {
            body.push(message(error, true, cx));
        }
        if self.loading {
            body.push(caption(t!("Reading figure usages…"), cx));
        } else if count > 0 {
            body.push(caption(
                t!("{count} literal graphics commands found", count = count),
                cx,
            ));
        }
        if !self.unreadable.is_empty() {
            body.push(message(
                format!("{} {}", t!("Could not read:"), self.unreadable.join(", ")),
                false,
                cx,
            ));
        }
        if !inventory.limited.is_empty() {
            body.push(message(
                format!(
                    "{} {}",
                    t!("Static coverage is limited in:"),
                    inventory.limited.join(", ")
                ),
                false,
                cx,
            ));
        }
        if !self.loading && count == 0 {
            body.push(
                div()
                    .py(px(16.))
                    .flex()
                    .justify_center()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(cx.palette().text)
                    .child(t!("No figures found"))
                    .into_any_element(),
            );
        }
        for (index, (key, uses)) in groups.iter().enumerate() {
            body.push(self.render_group(key, uses, index, cx));
        }
        let this = cx.entity().downgrade();
        let close = this.clone();
        let sheet = Sheet::new("figure-inventory", t!("Figure inventory"))
            .size(
                px(760.).min(viewport.width - px(32.)),
                px(640.).min(viewport.height - px(40.)),
            )
            .on_close(move |_, cx| {
                close.update(cx, |sheet, cx| sheet.close(cx)).ok();
            })
            .children(body);
        ModalLayer::new(
            "figure-inventory-layer",
            LayerPlacement::Center,
            sheet,
            move |_, cx| {
                this.update(cx, |sheet, cx| sheet.close(cx)).ok();
            },
        )
        .closable_by_scrim(!self.busy && self.plan.is_none())
    }
}
