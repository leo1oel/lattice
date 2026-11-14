//! Add papers drawn (`add-papers-sheet.css`): the paste box, the tabs that
//! sort what it found (pills that wrap before a label clips), and one card
//! row per reference in a raised list, each with its kind, its title in the
//! reading face, its byline, and what will happen to it; at the foot what
//! the batch will do, and Add. While a batch runs the sheet shows the batch,
//! each row with its own progress.

use gpui::{
    AnyElement, Context, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Textarea},
    icons::ICON_SMALL,
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{AddPapers, AddPapersEvent, Row, RowState, Tab};
use crate::{
    papers::batch::{BatchItem, ItemState},
    search::sheet::SheetFrame,
};

impl AddPapers {
    fn tabs(&self, rows: &[Row], cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let count = |tab: Tab| rows.iter().filter(|row| tab.keeps(row.state)).count();
        div()
            .flex()
            .flex_wrap()
            .gap(px(4.))
            .children(
                [Tab::All, Tab::New, Tab::Duplicate, Tab::Choose]
                    .into_iter()
                    // A tab with nothing in it is left out (All aside, and
                    // the one in view).
                    .filter(|tab| *tab == Tab::All || *tab == self.tab || count(*tab) > 0)
                    .map(|tab| {
                        let selected = tab == self.tab;
                        div()
                            .id(tab.label())
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .h(px(26.))
                            .px(px(8.))
                            .rounded_full()
                            .cursor_pointer()
                            .when(selected, |pill| pill.bg(palette.text.opacity(0.07)))
                            .when(!selected, |pill| {
                                pill.hover(|style| style.bg(palette.hover))
                            })
                            .text_role(TextRole::Caption, cx)
                            .text_color(if selected {
                                palette.text
                            } else {
                                palette.text_secondary
                            })
                            .on_click(cx.listener(move |this, _, _, cx| this.set_tab(tab, cx)))
                            .child(div().min_w_0().truncate().child(tab.label()))
                            .child(div().flex_none().child(count(tab).to_string()))
                    }),
            )
            .into_any_element()
    }

    /// What happens to the row: New in the success ink, the duplicate's key,
    /// the choice to make, and once adding, the row's own progress.
    fn state(&self, row: &Row, item: Option<&BatchItem>, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let success = mix(palette.success, palette.text, 0.2);
        let failed = mix(palette.danger, palette.text, 0.2);
        let line = |ink: Hsla, icon: Option<Icon>, text: String, cx: &Context<Self>| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(6.))
                .max_w(px(340.))
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .whitespace_nowrap()
                .children(icon.map(|icon| icon.element(ICON_SMALL, ink)))
                .child(div().min_w_0().truncate().child(text))
                .into_any_element()
        };
        if let Some(item) = item {
            return match item.state {
                ItemState::Added => {
                    let said = if item.already_imported {
                        t!("Already in Papers")
                    } else {
                        t!("Added")
                    };
                    line(
                        if item.already_imported {
                            palette.text_secondary
                        } else {
                            success
                        },
                        (!item.already_imported).then_some(Icon::CHECK),
                        match &item.citation_key {
                            Some(key) => format!("{said}  {key}"),
                            None => said.into(),
                        },
                        cx,
                    )
                }
                ItemState::Adding => {
                    line(palette.text, Some(Icon::LOADER), t!("Adding…").into(), cx)
                }
                ItemState::Waiting => line(
                    palette.text_secondary,
                    Some(Icon::CIRCLE_DOT),
                    t!("Waiting").into(),
                    cx,
                ),
                ItemState::Failed => line(
                    failed,
                    Some(Icon::CIRCLE_ALERT),
                    t!("Couldn't add").into(),
                    cx,
                ),
                ItemState::Cancelled => {
                    line(palette.text_secondary, None, t!("Not added").into(), cx)
                }
            };
        }
        match row.state {
            RowState::Resolving => line(
                palette.text_secondary,
                Some(Icon::LOADER),
                String::new(),
                cx,
            ),
            RowState::Failed => line(failed, Some(Icon::CIRCLE_ALERT), t!("Not found").into(), cx),
            RowState::Duplicate => line(
                palette.text_secondary,
                None,
                match &row.existing_key {
                    Some(key) => format!("{}  {key}", t!("Already in Papers")),
                    None => t!("Already in Papers").into(),
                },
                cx,
            ),
            RowState::Choose | RowState::New if !row.candidates.is_empty() => {
                let id = row.reference.id.clone();
                let pending = row.state == RowState::Choose;
                let warning = mix(palette.warning, palette.text, 0.28);
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(6.))
                    .when(!pending, |state| {
                        state.child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(success)
                                .child(t!("New")),
                        )
                    })
                    .child(
                        div()
                            .id(format!("choose:{id}").as_str().to_string())
                            .h(px(24.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .when(pending, |button| {
                                button.bg(palette.warning_soft).text_color(warning)
                            })
                            .when(!pending, |button| {
                                button
                                    .text_color(palette.text_secondary)
                                    .hover(|style| style.bg(palette.hover))
                            })
                            .text_role(TextRole::Caption, cx)
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.open_candidates(&id, cx)),
                            )
                            .child(if pending {
                                t!("Choose…")
                            } else {
                                t!("Change")
                            }),
                    )
                    .into_any_element()
            }
            _ => line(success, None, t!("New").into(), cx),
        }
    }

    /// The records a title matched, to choose one.
    fn candidates(&self, row: &Row, chosen: usize, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .px(px(12.))
            .pb(px(12.))
            .child(div().flex().flex_col().gap(px(2.)).children(
                row.candidates.iter().enumerate().map(|(ix, candidate)| {
                    let record = crate::papers::model::record_of_resolved(candidate);
                    let on = ix == chosen;
                    div()
                        .id(("candidate", ix))
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .px(px(8.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .when(on, |option| option.bg(palette.accent_soft))
                        .when(!on, |option| option.hover(|style| style.bg(palette.hover)))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.highlight_candidate(ix, cx)),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_role(TextRole::Body, cx)
                                .text_color(if on { palette.accent } else { palette.text })
                                .child(record.title),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(model_byline(&record.byline, candidate.doi.as_str())),
                        )
                }),
            ))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(6.))
                    .child(
                        Button::new("candidates-cancel", t!("Cancel"))
                            .ghost()
                            .compact()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.choosing = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("candidates-use", t!("Use this record"))
                            .tinted()
                            .compact()
                            .on_click(cx.listener(|this, _, _, cx| this.use_candidate(cx))),
                    ),
            )
            .into_any_element()
    }

    fn card(&self, row: &Row, item: Option<&BatchItem>, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let reading = cx.lattice().fonts.ui.clone();
        let editor = cx.lattice().fonts.editor.clone();
        let code_title =
            matches!(row.state, RowState::Resolving | RowState::Failed) && item.is_none();
        let note = item.and_then(|item| item.note.clone());
        let byline =
            crate::papers::model::byline_of([row.byline.as_str(), note.as_deref().unwrap_or("")]);
        let open = self
            .choosing
            .as_ref()
            .filter(|(id, _)| item.is_none() && *id == row.reference.id)
            .map(|(_, at)| *at);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(10.))
                    .child(
                        div().flex_none().w(px(56.)).child(
                            div()
                                .h(px(18.))
                                .px(px(6.))
                                .flex()
                                .items_center()
                                .max_w_full()
                                .rounded(px(4.))
                                .bg(palette.text.opacity(0.06))
                                .text_role(TextRole::Micro, cx)
                                .text_color(palette.text_secondary)
                                .child(match row.reference.kind {
                                    crate::papers::model::ReferenceKind::Url => t!("Link"),
                                    kind => kind.label(),
                                }),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .flex_1()
                            .min_w_0()
                            .when(row.state == RowState::Duplicate && item.is_none(), |main| {
                                main.opacity(0.62)
                            })
                            .child(
                                div()
                                    .truncate()
                                    .map(|title| {
                                        if code_title {
                                            title
                                                .font_family(editor)
                                                .text_role(TextRole::Caption, cx)
                                        } else {
                                            title
                                                .font_family(reading)
                                                .text_role(TextRole::Typeset, cx)
                                        }
                                    })
                                    .text_color(palette.text)
                                    .child(row.title.clone()),
                            )
                            .when(!byline.is_empty(), |main| {
                                // Why a lookup or an import failed, in full.
                                let why = note.clone().or_else(|| row.error.clone());
                                main.child(
                                    div()
                                        .id(format!("why:{}", row.reference.id)
                                            .as_str()
                                            .to_string())
                                        .truncate()
                                        .text_role(TextRole::Caption, cx)
                                        .text_color(palette.text_secondary)
                                        .when_some(why, |line, why| {
                                            line.tooltip(move |_, cx| {
                                                lattice_ui::components::LatticeTooltip::view(
                                                    why.clone(),
                                                    None,
                                                    cx,
                                                )
                                            })
                                        })
                                        .child(byline),
                                )
                            }),
                    )
                    .child(self.state(row, item, cx)),
            )
            .when_some(open, |card, chosen| {
                card.child(self.candidates(row, chosen, cx))
            })
            .into_any_element()
    }
}

fn model_byline(byline: &str, doi: &str) -> String {
    crate::papers::model::byline_of([byline, doi])
}

impl Render for AddPapers {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let batch: Vec<BatchItem> = self.papers.read(cx).batch.items.clone();
        if let Some(zotero) = self.zotero.clone().filter(|_| batch.is_empty()) {
            let view = cx.entity().downgrade();
            let dirty = self.dirty(cx);
            return SheetFrame {
                id: "add-papers",
                icon: Icon::BOOK_MARKED,
                title: t!("Add papers"),
                body: vec![zotero.into_any_element()],
                actions: Vec::new(),
                scrim_closes: !dirty,
            }
            .render(window, cx, move |_, cx| {
                view.update(cx, |this, cx| this.close(cx)).ok();
            });
        }
        let adding = self.papers.read(cx).batch.adding();
        let importing_elsewhere = self.papers.read(cx).importing.is_some() && !adding;
        let rows = self.rows(cx);
        let listed: Vec<(Row, Option<BatchItem>)> = if batch.is_empty() {
            self.shown(&rows)
                .into_iter()
                .map(|row| (row, None))
                .collect()
        } else {
            batch
                .iter()
                .map(|item| {
                    let row = Row {
                        reference: crate::papers::model::PastedReference {
                            id: item.id.clone(),
                            kind: item.kind,
                            input: item.input.clone(),
                            label: item.label.clone(),
                            record: None,
                        },
                        state: RowState::New,
                        title: item.title.clone().unwrap_or_else(|| item.label.clone()),
                        byline: item.byline.clone(),
                        existing_key: None,
                        candidates: Vec::new(),
                        import_input: None,
                        error: None,
                    };
                    (row, Some(item.clone()))
                })
                .collect()
        };
        let mut body: Vec<AnyElement> = Vec::new();
        if batch.is_empty() {
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_role(TextRole::Caption, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(t!("Paste references")),
                    )
                    .child(Textarea::new(&self.text).height(px(if rows.is_empty() {
                        112.
                    } else {
                        92.
                    })))
                    .into_any_element(),
            );
            // Other ways in: by hand, or from Zotero.
            body.push(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(4.))
                    .child(
                        Button::new("add-papers-manual", t!("Enter manually"))
                            .compact()
                            .ghost()
                            .icon(Icon::PEN_LINE)
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(AddPapersEvent::EnterManually)),
                            ),
                    )
                    .child(
                        Button::new("add-papers-linked", t!("Linked library…"))
                            .compact()
                            .ghost()
                            .icon(Icon::LINK_2)
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(AddPapersEvent::LinkLibrary)),
                            ),
                    )
                    .child(
                        Button::new("add-papers-zotero", t!("Zotero…"))
                            .compact()
                            .ghost()
                            .icon(Icon::LIBRARY)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_zotero(window, cx)),
                            ),
                    )
                    .into_any_element(),
            );
        }
        if !listed.is_empty() || !rows.is_empty() {
            if batch.is_empty() {
                body.push(self.tabs(&rows, cx));
            }
            let mut list = div()
                .id("add-papers-rows")
                .flex()
                .flex_col()
                .min_h_0()
                .overflow_y_scroll()
                .rounded(px(10.))
                .border_1()
                .border_color(palette.line)
                .bg(palette.raised);
            for (ix, (row, item)) in listed.iter().enumerate() {
                list = list.child(
                    div()
                        .when(ix > 0, |card| card.border_t_1().border_color(palette.line))
                        .child(self.card(row, item.as_ref(), cx)),
                );
            }
            if listed.is_empty() {
                list = list.child(
                    div()
                        .p(px(12.))
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .text_center()
                        .child(t!("Nothing here")),
                );
            }
            body.push(list.into_any_element());
        }

        let count = |state: RowState| rows.iter().filter(|row| row.state == state).count();
        let addable = rows.iter().filter(|row| row.addable().is_some()).count();
        let done = batch
            .iter()
            .filter(|item| item.state == ItemState::Added)
            .count();
        let summary = if !batch.is_empty() {
            // The batch adds in parallel: it counts what has landed.
            if !adding && done == batch.len() {
                if done == 1 {
                    t!("Added 1 paper").to_string()
                } else {
                    t!("Added {done} papers", done = done)
                }
            } else {
                t!("Added {done} of {0}", batch.len()).replace("{done}", &done.to_string())
            }
        } else {
            let plural = |count: usize, one: &str, many: String| match count {
                0 => String::new(),
                1 => one.to_string(),
                _ => many,
            };
            let duplicate = count(RowState::Duplicate);
            let choose = count(RowState::Choose);
            let failed = count(RowState::Failed);
            let resolving = count(RowState::Resolving);
            crate::papers::model::byline_of([
                plural(
                    duplicate,
                    t!("1 already in Papers is skipped"),
                    t!("{0} already in Papers are skipped", duplicate),
                )
                .as_str(),
                plural(
                    choose,
                    t!("1 waits for your choice"),
                    t!("{0} wait for your choice", choose),
                )
                .as_str(),
                plural(
                    failed,
                    t!("1 not found"),
                    t!("{failed} not found", failed = failed),
                )
                .as_str(),
                (if resolving > 0 {
                    t!("Looking up {resolving}…", resolving = resolving)
                } else {
                    String::new()
                })
                .as_str(),
            ])
        };
        let mut actions: Vec<AnyElement> = vec![
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(summary)
                .into_any_element(),
        ];
        if adding {
            actions.push(
                Button::new("add-papers-stop", t!("Stop"))
                    .ghost()
                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx)))
                    .into_any_element(),
            );
            actions.push(
                Button::new("add-papers-close", t!("Close"))
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx)))
                    .into_any_element(),
            );
        } else if !batch.is_empty() {
            actions.push(
                Button::new("add-papers-done", t!("Done"))
                    .primary()
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx)))
                    .into_any_element(),
            );
        } else {
            actions.push(
                Button::new("add-papers-cancel", t!("Cancel"))
                    .ghost()
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx)))
                    .into_any_element(),
            );
            let label = match addable {
                0 => t!("Add papers").to_string(),
                1 => t!("Add 1 paper").to_string(),
                count => t!("Add {0} papers", count),
            };
            actions.push(
                Button::new("add-papers-add", label)
                    .primary()
                    .icon(Icon::PLUS)
                    .disabled(addable == 0 || importing_elsewhere)
                    .when(importing_elsewhere, |button| {
                        button.tooltip(t!("Another paper is being added"))
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.add(cx)))
                    .into_any_element(),
            );
        }
        let dirty = self.dirty(cx);
        let view = cx.entity().downgrade();
        SheetFrame {
            id: "add-papers",
            icon: Icon::BOOK_MARKED,
            title: t!("Add papers"),
            body,
            actions,
            scrim_closes: !dirty,
        }
        .render(window, cx, move |_, cx| {
            view.update(cx, |this, cx| this.close(cx)).ok();
        })
    }
}
