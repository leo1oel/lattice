//! The sheet's look (`review-pdf-sheet.css`, in the Add papers sheet's
//! frame): the raised list of annotations, each a ticked row with its pin,
//! the passage in the reading face, the note, and a chip saying where on
//! the PDF it lands (a highlight or a margin note), its icon first.

use super::*;

impl ReviewSheet {
    fn body(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let caption = |text: SharedString, cx: &mut Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(text)
                .into_any_element()
        };
        if self.source.is_none() {
            return caption(t!("Build the PDF to export a review copy").into(), cx);
        }
        if self.notes.is_empty() {
            return caption(t!("No annotations yet").into(), cx);
        }
        let Some(placements) = self.placements.clone() else {
            return div()
                .flex()
                .items_center()
                .justify_center()
                .gap(SPACING_4)
                .py(px(48.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(lattice_ui::loading::loader(
                    "review-pdf-loading",
                    px(14.),
                    palette.text_secondary,
                    cx,
                ))
                .child(t!("Finding each note on the PDF…"))
                .into_any_element();
        };
        let placeable = self.placeable();
        let chosen = self.chosen();
        let all = !placeable.is_empty() && chosen.len() == placeable.len();
        let busy = self.busy;
        let ids: Vec<String> = placeable
            .iter()
            .map(|ix| self.notes[*ix].id.clone())
            .collect();
        let view = cx.entity().downgrade();
        let select_all = Checkbox::new(
            "review-pdf-all",
            if all {
                CheckState::On
            } else if chosen.is_empty() {
                CheckState::Off
            } else {
                CheckState::Mixed
            },
        )
        .label(t!("{0} of {1} selected", chosen.len(), placeable.len()))
        .quiet()
        .disabled(placeable.is_empty() || busy)
        .on_toggle(move |_, _, cx| {
            let ids = ids.clone();
            view.update(cx, |this, cx| {
                this.selected = if all {
                    HashSet::new()
                } else {
                    ids.into_iter().collect()
                };
                cx.notify();
            })
            .ok();
        });
        let rows: Vec<AnyElement> = self
            .notes
            .clone()
            .into_iter()
            .enumerate()
            .map(|(ix, note)| self.row(ix, &note, &placements[ix], cx))
            .collect();
        let has_replies = chosen.iter().any(|ix| !self.notes[*ix].replies.is_empty());
        let view = cx.entity().downgrade();
        div()
            .flex()
            .flex_col()
            .gap(SPACING_4)
            .min_w_0()
            .children(self.error.clone().map(|error| {
                div()
                    .px(SPACING_6)
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(error)
            }))
            .child(div().px(SPACING_6).child(select_all))
            .child(
                div()
                    .id("review-pdf-rows")
                    .flex()
                    .flex_col()
                    .rounded(RADIUS_SURFACE)
                    .bg(palette.raised)
                    .border_1()
                    .border_color(palette.line)
                    .overflow_hidden()
                    .children(rows),
            )
            .when(has_replies, |this| {
                this.child(
                    div().px(SPACING_6).child(
                        Checkbox::new(
                            "review-pdf-replies",
                            if self.with_replies {
                                CheckState::On
                            } else {
                                CheckState::Off
                            },
                        )
                        .label(t!("Include replies"))
                        .quiet()
                        .disabled(busy)
                        .on_toggle(move |on, _, cx| {
                            let on = *on;
                            view.update(cx, |this, cx| {
                                this.with_replies = on;
                                cx.notify();
                            })
                            .ok();
                        }),
                    ),
                )
            })
            .into_any_element()
    }

    fn row(
        &self,
        ix: usize,
        note: &EditorComment,
        placement: &ReviewPlacement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let unplaced = placement.page().is_none();
        let ticked = self.selected.contains(&note.id) && !unplaced;
        let body = note.body.trim();
        let body = if body.is_empty() {
            t!("No note").to_string()
        } else {
            body.to_string()
        };
        let body = if note.resolved {
            t!("Resolved: {note}", note = body)
        } else {
            body
        };
        let (icon, label) = match placement {
            ReviewPlacement::Highlight { page, .. } => {
                (Icon::HIGHLIGHTER, t!("Highlight on p. {0}", page + 1))
            }
            ReviewPlacement::Note { page, .. } => {
                (Icon::STICKY_NOTE, t!("Margin note on p. {0}", page + 1))
            }
            ReviewPlacement::Unplaced => (Icon::CIRCLE_ALERT, t!("Not on this PDF").to_string()),
        };
        let (chip_bg, chip_ink) = if unplaced {
            (palette.warning_soft, palette.warning)
        } else {
            (palette.hover, palette.text_secondary)
        };
        let chip = div()
            .id(("review-pdf-place", ix))
            .flex_none()
            .max_w(px(160.))
            .h(px(18.))
            .px(SPACING_3)
            .flex()
            .items_center()
            .gap(SPACING_2)
            .rounded(px(4.))
            .bg(chip_bg)
            .text_color(chip_ink)
            .text_role(TextRole::Micro, cx)
            .overflow_hidden()
            .whitespace_nowrap()
            .child(icon.element(px(11.), chip_ink))
            .child(label)
            .when(unplaced, |chip| {
                let hint: SharedString = t!(
                    "SyncTeX does not place this passage on the PDF. Build the project again, then export."
                )
                .into();
                chip.tooltip(move |_, cx| {
                    lattice_ui::components::LatticeTooltip::view(hint.clone(), None, cx)
                })
            });
        let id = note.id.clone();
        let busy = self.busy;
        let view = cx.entity().downgrade();
        div()
            .id(("review-pdf-row", ix))
            .flex()
            .items_center()
            .gap(SPACING_5)
            .py(SPACING_5)
            .px(SPACING_6)
            .min_w_0()
            .when(ix > 0, |row| row.border_t_1().border_color(palette.line))
            .child(
                Checkbox::new(
                    ("review-pdf-tick", ix),
                    if ticked {
                        CheckState::On
                    } else {
                        CheckState::Off
                    },
                )
                .disabled(unplaced || busy)
                .on_toggle(move |on, _, cx| {
                    let (id, on) = (id.clone(), *on);
                    view.update(cx, |this, cx| {
                        if on {
                            this.selected.insert(id);
                        } else {
                            this.selected.remove(&id);
                        }
                        cx.notify();
                    })
                    .ok();
                }),
            )
            .child(card::pin(note.number, Status::of(note), card::PIN, cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .when(note.resolved || unplaced, |main| main.opacity(0.62))
                    .child(
                        div()
                            .truncate()
                            .font_family(cx.lattice().fonts.display.clone())
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.text)
                            .child(short_quote(&note.quote)),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(body),
                    ),
            )
            .child(chip)
            .into_any_element()
    }
}

impl Render for ReviewSheet {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let chosen = self.chosen().len();
        let action = match chosen {
            0 => t!("Export notes…").to_string(),
            1 => t!("Export 1 note…").to_string(),
            count => t!("Export {0} notes…", count),
        };
        let body = self.body(cx);
        let this = cx.entity().downgrade();
        let busy = self.busy;
        let sheet = Sheet::new("review-pdf", t!("Export review PDF"))
            .size(px(640.), px(560.))
            .on_close({
                let this = this.clone();
                move |window, cx| {
                    let this = this.clone();
                    ModalLayer::leave("review-pdf", window, cx, move |_, cx| {
                        this.update(cx, |_, cx| Self::close(cx)).ok();
                    });
                }
            })
            .child(
                div()
                    .id("review-pdf-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
            .action(
                Button::new("review-pdf-cancel", t!("Cancel"))
                    .ghost()
                    .on_click({
                        let this = this.clone();
                        move |_, window, cx| {
                            let this = this.clone();
                            ModalLayer::leave("review-pdf", window, cx, move |_, cx| {
                                this.update(cx, |_, cx| Self::close(cx)).ok();
                            });
                        }
                    }),
            )
            .action(
                Button::new("review-pdf-export", action)
                    .primary()
                    .disabled(chosen == 0 || busy)
                    .map(|button| {
                        if busy {
                            button.icon(Icon::LOADER)
                        } else {
                            button
                        }
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.export(window, cx))),
            );
        ModalLayer::new("review-pdf", LayerPlacement::Center, sheet, move |_, cx| {
            this.update(cx, |_, cx| Self::close(cx)).ok();
        })
    }
}
