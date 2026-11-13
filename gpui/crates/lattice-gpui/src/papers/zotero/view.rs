//! The Zotero browser drawn (`zotero-browser.tsx`, `add-papers-sheet.css`):
//! folders and papers side by side, a narrow sheet showing one at a time
//! (the papers' Folders button returns), and the footer with what is ticked,
//! Back and Add.

use gpui::{
    AnyElement, ClickEvent, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputState};
use lattice_i18n::{format_count, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Badge, BadgeTone, Button, CheckState, Checkbox, Switch},
    icons::{ICON, ICON_SMALL},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{ZoteroBrowser, ZoteroPaper, folder_counts, folder_rows};

/// A sheet this narrow shows the folders or the papers, not both.
const ONE_PANE: f32 = 560.;

fn search(input: &gpui::Entity<InputState>, cx: &gpui::App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .h(px(28.))
        .px(px(8.))
        .rounded(px(6.))
        .bg(palette.input)
        .border_1()
        .border_color(palette.field_border)
        .child(Icon::SEARCH.element(ICON_SMALL, palette.text_secondary))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(Input::new(input).appearance(false).bordered(false).px_0()),
        )
        .into_any_element()
}

impl ZoteroBrowser {
    fn folder_row(
        &self,
        key: String,
        name: String,
        count: Option<usize>,
        depth: usize,
        toggle: Option<bool>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let selected = self.folder.as_deref() == Some(key.as_str());
        let (toggle_key, open_key) = (key.clone(), key.clone());
        div()
            .id(SharedString::from(format!("zotero-folder:{key}")))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .h(px(28.))
            .pl(px(4. + depth as f32 * 14.))
            .pr(px(8.))
            .rounded(px(6.))
            .cursor_pointer()
            .when(selected, |row| row.bg(palette.row_selected))
            .when(!selected, |row| row.hover(|style| style.bg(palette.hover)))
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.open_folder(open_key.clone(), window, cx)
            }))
            .child(match toggle {
                Some(open) => div()
                    .id(SharedString::from(format!("zotero-toggle:{key}")))
                    .flex_none()
                    .size(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.toggle_folder(toggle_key.clone(), cx)
                    }))
                    .child(
                        if open {
                            Icon::CHEVRON_DOWN
                        } else {
                            Icon::CHEVRON_RIGHT
                        }
                        .element(ICON_SMALL, palette.text_secondary),
                    )
                    .into_any_element(),
                None => div().flex_none().size(px(16.)).into_any_element(),
            })
            .child(
                if key.is_empty() {
                    Icon::LIBRARY
                } else {
                    Icon::FOLDER
                }
                .element(
                    ICON,
                    if selected {
                        palette.text
                    } else {
                        palette.text_secondary
                    },
                ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text)
                    .child(name),
            )
            .when_some(count, |row, count| {
                row.child(
                    div()
                        .flex_none()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(format_count(count as i64)),
                )
            })
            .into_any_element()
    }

    fn folders(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let mut pane = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .min_h_0()
            .child(search(&self.folder_query, cx));
        if let Some(error) = self.error.clone() {
            return pane
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .p(px(10.))
                        .rounded(px(8.))
                        .bg(palette.danger_soft)
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(mix(palette.danger, palette.text, 0.25))
                                .child(error),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap(px(6.))
                                .child(
                                    Button::new("zotero-retry", t!("Try again"))
                                        .compact()
                                        .on_click(
                                            cx.listener(|this, _: &ClickEvent, _, cx| {
                                                this.read(cx)
                                            }),
                                        ),
                                )
                                .child(
                                    Button::new("zotero-choose", t!("Choose Zotero folder…"))
                                        .compact()
                                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                            this.choose_dir(cx)
                                        })),
                                ),
                        ),
                )
                .into_any_element();
        }
        let Some(library) = self.library.clone() else {
            return pane
                .child(
                    div()
                        .flex()
                        .justify_center()
                        .py(px(16.))
                        .child(Icon::LOADER.element(ICON, palette.text_secondary)),
                )
                .into_any_element();
        };
        let query = self.folder_query.read(cx).value().to_string();
        let counts = folder_counts(&library, self.subfolders);
        let rows = folder_rows(&library.collections, &self.expanded, &query);
        let mut tree = div()
            .id("zotero-tree")
            .flex()
            .flex_col()
            .gap(px(1.))
            .min_h_0()
            .overflow_y_scroll();
        if query.trim().is_empty() {
            tree = tree.child(self.folder_row(
                String::new(),
                t!("My Library").into(),
                None,
                0,
                None,
                cx,
            ));
        }
        let none = rows.is_empty() && !query.trim().is_empty();
        for row in rows {
            let count = counts.get(&row.key).copied().unwrap_or(0);
            let toggle = row.has_children.then_some(row.expanded);
            tree = tree.child(self.folder_row(
                row.key,
                row.name,
                Some(count),
                row.depth + 1,
                toggle,
                cx,
            ));
        }
        if none {
            tree = tree.child(
                div()
                    .px(px(8.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("No matching folders")),
            );
        }
        pane = pane.child(tree);
        pane.into_any_element()
    }

    fn paper_row(&self, paper: &ZoteroPaper, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let on = self.ticked.contains(&paper.citation_key);
        let tickable = paper.can_tick();
        let view = cx.entity().downgrade();
        let ticked = paper.clone();
        let annotations = if paper.annotations == 1 {
            t!("1 annotation").to_string()
        } else {
            t!("{0} annotations", paper.annotations)
        };
        div()
            .flex()
            .items_start()
            .gap(px(8.))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(6.))
            .when(!tickable, |row| row.opacity(0.6))
            .child(
                Checkbox::new(
                    SharedString::from(format!("zotero-tick:{}", paper.citation_key)),
                    if on { CheckState::On } else { CheckState::Off },
                )
                .disabled(!tickable)
                .on_toggle(move |on, _, cx| {
                    let ticked = ticked.clone();
                    view.update(cx, |this, cx| this.tick(&[ticked], *on, cx))
                        .ok();
                }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(paper.title.clone()),
                    )
                    .when(!paper.byline.is_empty(), |text| {
                        text.child(
                            div()
                                .truncate()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(paper.byline.clone()),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .gap(px(4.))
                    .when(paper.annotations > 0, |badges| {
                        badges.child(
                            div()
                                .id(SharedString::from(format!(
                                    "zotero-notes:{}",
                                    paper.citation_key
                                )))
                                .flex()
                                .items_center()
                                .gap(px(3.))
                                .px(px(5.))
                                .h(px(18.))
                                .rounded(px(4.))
                                .bg(palette.hover)
                                .tooltip(crate::papers::row::tooltip(annotations))
                                .text_role(TextRole::Micro, cx)
                                .text_color(palette.text_secondary)
                                .child(Icon::HIGHLIGHTER.element(px(11.), palette.text_secondary))
                                .child(format_count(paper.annotations as i64)),
                        )
                    })
                    .when(paper.pdf.is_some(), |badges| {
                        badges.child(Badge::new("PDF").compact())
                    })
                    .when(paper.existing.is_some(), |badges| {
                        badges.child(
                            Badge::new(t!("In Papers"))
                                .compact()
                                .tone(BadgeTone::Success),
                        )
                    }),
            )
            .into_any_element()
    }

    fn papers_pane(&self, one_pane: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let library = self.library.clone();
        let folder_name = match self.folder.as_deref() {
            Some("") => t!("My Library").to_string(),
            Some(key) => library
                .as_ref()
                .and_then(|library| {
                    library
                        .collections
                        .iter()
                        .find(|collection| collection.key == key)
                })
                .map(|collection| collection.name.clone())
                .unwrap_or_default(),
            None => String::new(),
        };
        let has_children = self.folder.as_deref().is_some_and(|folder| {
            !folder.is_empty()
                && library.as_ref().is_some_and(|library| {
                    library
                        .collections
                        .iter()
                        .any(|c| c.parent.as_deref() == Some(folder))
                })
        });
        let all = self.folder_papers(cx);
        let shown = self.shown_papers(cx);
        let tickable: Vec<ZoteroPaper> = shown
            .iter()
            .filter(|paper| paper.can_tick())
            .cloned()
            .collect();
        let ticked = tickable
            .iter()
            .filter(|paper| self.ticked.contains(&paper.citation_key))
            .count();
        let mut pane = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .h(px(28.))
                    .when(one_pane, |head| {
                        head.child(
                            Button::new("zotero-back-to-folders", t!("Folders"))
                                .compact()
                                .ghost()
                                .icon(Icon::CHEVRON_LEFT)
                                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                    this.papers_pane = false;
                                    cx.notify();
                                })),
                        )
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(folder_name),
                    )
                    .when(has_children, |head| {
                        head.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(t!("Include subfolders"))
                                .child(
                                    Switch::new("zotero-subfolders", self.subfolders).on_toggle(
                                        cx.listener(|this, on: &bool, _, cx| {
                                            this.subfolders = *on;
                                            cx.notify();
                                        }),
                                    ),
                                ),
                        )
                    }),
            );
        if !all.is_empty() {
            let every = tickable.clone();
            pane = pane.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        Checkbox::new(
                            "zotero-select-all",
                            if !tickable.is_empty() && ticked == tickable.len() {
                                CheckState::On
                            } else if ticked > 0 {
                                CheckState::Mixed
                            } else {
                                CheckState::Off
                            },
                        )
                        .label(t!("Select all"))
                        .disabled(tickable.is_empty())
                        .on_toggle(
                            cx.listener(move |this, on: &bool, _, cx| this.tick(&every, *on, cx)),
                        ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(search(&self.paper_query, cx)),
                    ),
            );
        }
        let empty = |text: &'static str, cx: &Context<Self>| {
            div()
                .flex()
                .justify_center()
                .py(px(24.))
                .text_role(TextRole::Body, cx)
                .text_color(cx.palette().text_secondary)
                .child(text)
                .into_any_element()
        };
        let list = if self.folder.is_none() || library.is_none() {
            empty(t!("Choose a folder"), cx)
        } else if all.is_empty() {
            empty(t!("No papers in this folder"), cx)
        } else if shown.is_empty() {
            empty(t!("No matching papers"), cx)
        } else {
            let mut list = div()
                .id("zotero-papers")
                .flex()
                .flex_col()
                .min_h_0()
                .overflow_y_scroll();
            for paper in &shown {
                list = list.child(self.paper_row(paper, cx));
            }
            list.into_any_element()
        };
        pane.child(div().flex_1().min_h_0().child(list))
            .into_any_element()
    }

    fn footer(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let ticked = self.ticked_here(cx);
        let count = ticked.len();
        let pdfs = ticked.iter().filter(|paper| paper.brings_pdf()).count();
        let annotations = ticked.iter().any(|paper| paper.annotations > 0);
        let held = count > 0 && ticked.iter().all(|paper| paper.existing.is_some());
        let label = if held {
            match (pdfs, annotations) {
                (0, _) => t!("Add annotations").to_string(),
                (1, true) => t!("Add PDF and annotations").to_string(),
                (1, false) => t!("Add PDF").to_string(),
                (_, true) => t!("Add PDFs and annotations").to_string(),
                (_, false) => t!("Add PDFs").to_string(),
            }
        } else if count == 1 {
            t!("Add 1 paper").to_string()
        } else if count > 1 {
            t!("Add {0} papers", count)
        } else {
            t!("Add papers").to_string()
        };
        let summary = match count {
            0 => String::new(),
            1 => t!("1 paper selected").to_string(),
            count => t!("{0} papers selected", count),
        };
        let busy = {
            let library = self.papers.read(cx);
            library.batch.running || library.importing.is_some()
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .pt(px(12.))
            .border_t_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(summary),
            )
            .child(
                Button::new("zotero-back", t!("Back"))
                    .ghost()
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.back(cx))),
            )
            .child(
                Button::new("zotero-add", label)
                    .primary()
                    .icon(Icon::PLUS)
                    .disabled(count == 0 || busy)
                    .map(|button| {
                        if busy {
                            button.tooltip(t!("Another paper is being added"))
                        } else {
                            button
                        }
                    })
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.add(cx))),
            )
            .into_any_element()
    }
}

impl Render for ZoteroBrowser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let one_pane = f32::from(window.viewport_size().width) - 40. < ONE_PANE;
        let show_papers = !one_pane || (self.papers_pane && self.folder.is_some());
        let show_folders = !one_pane || !show_papers;
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .gap(px(12.))
                    .when(show_folders, |panes| {
                        panes.child(
                            div()
                                .flex()
                                .flex_col()
                                .min_h_0()
                                .map(|pane| {
                                    if one_pane {
                                        pane.flex_1()
                                    } else {
                                        pane.w(px(220.)).flex_none()
                                    }
                                })
                                .child(self.folders(cx)),
                        )
                    })
                    .when(show_folders && show_papers, |panes| {
                        panes.child(div().flex_none().w(px(1.)).bg(palette.line))
                    })
                    .when(show_papers, |panes| {
                        panes.child(self.papers_pane(one_pane, cx))
                    }),
            )
            .child(self.footer(cx))
    }
}
