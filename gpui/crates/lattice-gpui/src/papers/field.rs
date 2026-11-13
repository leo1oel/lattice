//! The box and what it would add (`paper-library.tsx`, `.paper-import-*`
//! and `.paper-add*` in `app-shell.css`): the search field, 32px on the
//! input surface, its X while it holds text and + for Add papers; while a
//! paper downloads the stage it is on where the text was, Cancel beside it,
//! over a hairline of progress. Under it, soft plates on the rows' inset say
//! what Enter will do before it happens, or where a known id already is,
//! and the import under way names its three stages.

use gpui::{
    AnyElement, Context, Focusable as _, Hsla, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px, relative,
};
use gpui_kit::component::input::Input;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    icons::{ICON, ICON_SMALL},
    interaction::{mix, track_pointer, use_interaction},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    PapersPanel,
    model::{self, ReferenceKind},
    row::tooltip,
};

impl PapersPanel {
    /// The box: search as you type, Enter adds an identifier, + opens Add
    /// papers. While a paper downloads it says which stage it is on where
    /// the text was, with Cancel, over a hairline of progress.
    pub(super) fn render_field(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let state = self.input().read(cx);
        let focused = state.focus_handle(cx).is_focused(window);
        let has_value = !state.value().is_empty();
        let fetching = self.fetching.busy() && self.importing.is_none();
        let border = if fetching {
            mix(palette.field_border, palette.accent, 0.35)
        } else if focused {
            palette.field_border_hover
        } else {
            palette.field_border
        };
        let hover_border = palette.field_border_hover;
        let view = cx.entity().downgrade();
        let trailing: AnyElement = if fetching {
            let stage = super::stage_label(self.fetching.stage.as_deref());
            let cancel_view = view.clone();
            let narrow = self.width < 220.;
            div()
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text)
                        .child(stage),
                )
                .child(
                    div()
                        .id("papers-cancel-download")
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .h(px(24.))
                        .when(narrow, |button| button.w(px(24.)))
                        .when(!narrow, |button| button.px(px(6.)))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(|style| style.bg(palette.hover))
                        .tooltip(tooltip("Cancel download"))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text)
                        .on_click(move |_, _, cx| {
                            cancel_view
                                .update(cx, |this, cx| this.cancel_fetches(cx))
                                .ok();
                        })
                        .map(|button| {
                            if narrow {
                                button.child(Icon::X.element(px(13.), palette.text_secondary))
                            } else {
                                button.child("Cancel")
                            }
                        }),
                )
                .into_any_element()
        } else {
            let clear_view = view.clone();
            let add_view = view.clone();
            div()
                .flex()
                .flex_none()
                .items_center()
                .when(has_value, |trailing| {
                    trailing.child(
                        div()
                            .id("papers-clear")
                            .flex_none()
                            .w(px(20.))
                            .h(px(22.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(|style| style.bg(palette.line))
                            .on_mouse_down(MouseButton::Left, |_, window, _| {
                                window.prevent_default()
                            })
                            .on_click(move |_, window, cx| {
                                clear_view
                                    .update(cx, |this, cx| this.clear_query(window, cx))
                                    .ok();
                            })
                            .child(Icon::X.element(ICON_SMALL, palette.text_secondary)),
                    )
                })
                // Everything else there is to add, a pasted list or a whole
                // .bib, goes through Add papers.
                .child(
                    div()
                        .id("papers-add")
                        .flex_none()
                        .size(px(24.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(|style| style.bg(palette.hover))
                        .tooltip(tooltip("Add papers…"))
                        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                        .on_click(move |_, window, cx| {
                            add_view
                                .update(cx, |this, cx| this.open_add_sheet(window, cx))
                                .ok();
                        })
                        .child(Icon::PLUS.element(ICON, palette.text_secondary)),
                )
                .into_any_element()
        };
        let progress = if fetching { self.progress() } else { None };
        if progress.is_some() {
            window.request_animation_frame();
        }
        div()
            .id("papers-field")
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .h(px(32.))
            .mr(px(10.))
            .pl(px(9.))
            .pr(px(4.))
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(palette.input)
            .when(!fetching, |field| {
                field.hover(move |style| style.border_color(hover_border))
            })
            .children(progress.map(|progress| {
                div()
                    .absolute()
                    .top(px(1.))
                    .left(px(1.))
                    .bottom(px(1.))
                    .right(px(1.))
                    .rounded(px(5.))
                    .overflow_hidden()
                    .child(
                        div()
                            .h_full()
                            .w(relative(progress))
                            .bg(palette.accent.opacity(0.12)),
                    )
            }))
            .child(Icon::SEARCH.element(ICON, palette.text_secondary))
            .when(!fetching, |field| {
                field.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_role(TextRole::BodyCompact, cx)
                        .child(
                            Input::new(self.input())
                                .appearance(false)
                                .bordered(false)
                                .px_0(),
                        ),
                )
            })
            .child(trailing)
            .into_any_element()
    }

    /// What the box will add, said before it happens, or the import under
    /// way; a known arXiv id or DOI says where it already is instead.
    pub(super) fn render_add_rows(
        &self,
        matches: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = cx.palette().clone();
        if let Some(importing) = &self.importing {
            return Some(self.render_pending(importing, window, cx));
        }
        let query = self.query(cx).trim().to_string();
        let kind = model::reference_kind(&query)?;
        let duplicate = self.duplicate(cx);
        if duplicate.is_some_and(|paper| model::is_just_added(paper, &self.just_added)) {
            return None;
        }
        let view = cx.entity().downgrade();
        let plate = |id: &'static str, quiet: bool, window: &mut Window, cx: &mut Context<Self>| {
            let (interaction, pointer) = use_interaction(id, window, cx);
            let rest = if quiet {
                Hsla::transparent_black()
            } else {
                palette.text.opacity(0.04)
            };
            track_pointer(div().id(id), pointer)
                .relative()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .p(px(8.))
                .rounded(px(6.))
                .bg(mix(rest, palette.hover, interaction.hover))
                .cursor_pointer()
        };
        let quoted = |lead: &'static str, cx: &Context<Self>| {
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_role(TextRole::Body, cx)
                .line_height(px(18.))
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text)
                .child(format!("{lead} “{query}”"))
        };
        let mut rows: Vec<AnyElement> = Vec::new();
        if let Some(duplicate) = duplicate {
            let cite = duplicate
                .citation_key
                .as_ref()
                .map(|key| format!("\\cite{{{key}}}"));
            let detail = cite.clone().unwrap_or_else(|| duplicate.title.clone());
            let editor_font = cx.lattice().fonts.editor.clone();
            let open_view = view.clone();
            let copy_view = view.clone();
            rows.push(
                plate("papers-duplicate", false, window, cx)
                    .tooltip(tooltip("Already in Papers"))
                    .on_click(move |_, window, cx| {
                        open_view.update(cx, |this, cx| this.add(window, cx)).ok();
                    })
                    .child(Icon::CHECK.element(px(13.), palette.success))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_role(TextRole::Body, cx)
                                    .line_height(px(18.))
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(palette.text)
                                    .child("Already in Papers"),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .when(cite.is_some(), |detail| {
                                        detail.font_family(editor_font).text_size(px(11.))
                                    })
                                    .child(detail),
                            ),
                    )
                    .when_some(cite, |row, cite| {
                        row.child(
                            div()
                                .id("papers-duplicate-copy")
                                .flex_none()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .h(px(24.))
                                .px(px(6.))
                                .rounded(px(4.))
                                .hover(|style| style.bg(palette.hover))
                                .tooltip(tooltip("Copy \\cite command"))
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .on_mouse_down(MouseButton::Left, |_, window, cx| {
                                    window.prevent_default();
                                    cx.stop_propagation();
                                })
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    copy_view
                                        .update(cx, |this, cx| this.copy(cite.clone(), cx))
                                        .ok();
                                })
                                .child(Icon::COPY.element(ICON_SMALL, palette.text_secondary))
                                .child("Copy"),
                        )
                    })
                    .into_any_element(),
            );
        } else if kind != ReferenceKind::Title || matches == 0 {
            let lead = if kind == ReferenceKind::Title {
                "Look up and add"
            } else {
                "Add"
            };
            let add_view = view.clone();
            rows.push(
                plate("papers-add-row", false, window, cx)
                    .on_click(move |_, window, cx| {
                        add_view.update(cx, |this, cx| this.add(window, cx)).ok();
                    })
                    .child(Icon::PLUS.element(px(13.), palette.text_secondary))
                    .child(quoted(lead, cx))
                    .child(
                        div()
                            .flex_none()
                            .h(px(18.))
                            .px(px(6.))
                            .flex()
                            .items_center()
                            .rounded(px(4.))
                            .bg(palette.text.opacity(0.06))
                            .text_role(TextRole::Micro, cx)
                            .text_color(palette.text_secondary)
                            .child(kind.label()),
                    )
                    .when(kind != ReferenceKind::Title, |row| {
                        row.child(
                            Icon::CORNER_DOWN_LEFT.element(ICON_SMALL, palette.text_secondary),
                        )
                    })
                    .into_any_element(),
            );
        }
        if kind == ReferenceKind::Title {
            let search_view = view;
            rows.push(
                plate("papers-search-literature", true, window, cx)
                    .on_click(move |_, window, cx| {
                        search_view
                            .update(cx, |this, cx| this.search_literature(window, cx))
                            .ok();
                    })
                    .child(Icon::ARROW_RIGHT.element(px(13.), palette.text_secondary))
                    .child(quoted("Search the literature for", cx))
                    .into_any_element(),
            );
        }
        (!rows.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .mb(px(6.))
                .children(rows)
                .into_any_element()
        })
    }

    /// The import under way: what was given, the pipeline's three steps,
    /// Cancel, and a hairline of progress.
    pub(super) fn render_pending(
        &self,
        importing: &super::Importing,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let stages = [
            ("resolving", "Metadata"),
            ("fulltext", "Full text"),
            ("overview", "Overview"),
        ];
        let at = stages
            .iter()
            .position(|(id, _)| Some(*id) == importing.stage.as_deref())
            .unwrap_or(0);
        let progress = self.progress().unwrap_or(0.);
        window.request_animation_frame();
        let view = cx.entity().downgrade();
        let label = if importing.label.is_empty() {
            "Adding paper".to_string()
        } else {
            importing.label.clone()
        };
        div()
            .mb(px(6.))
            .child(
                div()
                    .relative()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .min_w_0()
                    .p(px(8.))
                    .rounded(px(6.))
                    .overflow_hidden()
                    .bg(palette.text.opacity(0.04))
                    .child(Icon::LOADER.element(ICON_SMALL, palette.text_secondary))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_role(TextRole::Body, cx)
                            .line_height(px(18.))
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(label),
                    )
                    .when(self.width >= 260., |row| {
                        row.child(div().flex().flex_none().gap(px(8.)).children(
                            stages.iter().enumerate().map(|(ix, (_, name))| {
                                let ink = if ix <= at {
                                    palette.text
                                } else {
                                    palette.text_secondary
                                };
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(3.))
                                    .text_role(TextRole::Micro, cx)
                                    .text_color(ink)
                                    .child(if ix < at {
                                        Icon::CHECK
                                            .element(px(11.), palette.success)
                                            .into_any_element()
                                    } else {
                                        div()
                                            .size(px(5.))
                                            .rounded_full()
                                            .bg(if ix == at {
                                                palette.accent
                                            } else {
                                                palette.line_strong
                                            })
                                            .into_any_element()
                                    })
                                    .child(*name)
                            }),
                        ))
                    })
                    .child(
                        div()
                            .id("papers-cancel-import")
                            .flex_none()
                            .size(px(24.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(|style| style.bg(palette.hover))
                            .tooltip(tooltip("Cancel"))
                            .on_click(move |_, _, cx| {
                                view.update(cx, |this, cx| this.cancel_import(cx)).ok();
                            })
                            .child(Icon::X.element(px(13.), palette.text_secondary)),
                    )
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .bottom_0()
                            .h(px(2.))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(progress))
                                    .bg(palette.accent.opacity(0.5)),
                            ),
                    ),
            )
            .into_any_element()
    }
}
