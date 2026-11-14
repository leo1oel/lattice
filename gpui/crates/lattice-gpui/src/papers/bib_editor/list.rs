//! The `.bib` form drawn (`bib-visual-editor.css`, `bib-row.tsx`): a toolbar
//! (search, Filter, Sort, Add reference), then the reference list beside the
//! reference in front, a hairline divider between them that drags. A pane
//! 720px or narrower shows one at a time.
//!
//! Every row is one height, set as a reference list sets an entry: the year
//! in a margin column, the title in the reading face, authors then the venue
//! in italic, the key and its use quiet on the right, and the paper's open
//! control at the end. The one in front stands on the raised surface with
//! the weft's edge. A list 380px or narrower has no room for the margin: the
//! year leads the byline and the key takes a third line.

use gpui::{
    Anchor, AnyElement, App, ClickEvent, Context, Hsla, InteractiveElement as _, IntoElement,
    KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas, div,
    prelude::FluentBuilder as _, px, uniform_list,
};
use gpui_kit::component::input::Input;
use lattice_i18n::{format_count, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, MenuAction, MenuPopover},
    icons::{ICON, ICON_LARGE, ICON_SMALL},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    BibEditor, list_ratio,
    model::{self, BibFilter, BibSort, PaperState},
};
use crate::papers::{row::tooltip, toolbar::ListTool};

/// The list and the reference beside it never get narrower than these.
pub(super) const LIST_MIN_WIDTH: f32 = 240.;
pub(super) const DETAIL_MIN_WIDTH: f32 = 320.;
/// Every row is this tall, so the list knows which rows are in view.
const ROW_HEIGHT: f32 = 60.;
/// A list this narrow stacks a row's lines, and is this tall.
const NARROW_LIST_WIDTH: f32 = 380.;
const NARROW_ROW_HEIGHT: f32 = 80.;
/// A pane this narrow shows the list or the reference, not both.
const ONE_AT_A_TIME: f32 = 720.;
const YEAR_COLUMN: f32 = 44.;

impl BibEditor {
    fn toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let width = self.width.get();
        let caret = width >= 560.;
        let folded = width > 0. && width < 400.;
        let add_folded = width > 0. && width < 480.;
        let usages = self.usages.as_ref();
        let unused = self
            .rows
            .iter()
            .filter(|row| model::is_unused(usages, &row.entry.key))
            .count();
        let counts = [
            (BibFilter::All, self.rows.len()),
            (BibFilter::Cited, self.rows.len() - unused),
            (BibFilter::Unused, unused),
        ];
        let (filter, sort) = (self.filter, self.sort);
        let view = cx.entity().downgrade();
        let filter_menu = {
            let view = view.clone();
            move |menu: lattice_ui::components::Menu| {
                counts.iter().fold(menu, |menu, (choice, count)| {
                    let (view, choice) = (view.clone(), *choice);
                    menu.item(
                        MenuAction::new(choice.label(), move |_, cx| {
                            view.update(cx, |this, cx| this.set_filter(choice, cx)).ok();
                        })
                        .checked(choice == filter)
                        .shortcut(format_count(*count as i64)),
                    )
                })
            }
        };
        let sort_menu = move |menu: lattice_ui::components::Menu| {
            BibSort::ALL.iter().fold(menu, |menu, choice| {
                let (view, choice) = (view.clone(), *choice);
                menu.item(
                    MenuAction::new(choice.label(), move |_, cx| {
                        view.update(cx, |this, cx| this.set_sort(choice, cx)).ok();
                    })
                    .checked(choice == sort),
                )
            })
        };
        let filter_count = counts
            .iter()
            .find(|(choice, _)| *choice == filter)
            .map_or(0, |(_, count)| *count);
        div()
            .flex()
            .flex_wrap()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .px(px(16.))
            .py(px(10.))
            .border_b_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w(px(120.))
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .bg(palette.input)
                    .border_1()
                    .border_color(palette.field_border)
                    // ↓ and ↑ step the list from the search, and take the
                    // keys there (bib-preview.tsx).
                    .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                        let keys = &event.keystroke;
                        if matches!(keys.key.as_str(), "down" | "up") && !keys.modifiers.modified()
                        {
                            window.focus(&this.focus, cx);
                            this.list_key(event, cx);
                        }
                    }))
                    .child(Icon::SEARCH.element(ICON_SMALL, palette.text_secondary))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.query)
                                .appearance(false)
                                .bordered(false)
                                .px_0(),
                        ),
                    ),
            )
            .child(
                MenuPopover::new(
                    "bib-filter",
                    ListTool {
                        id: "bib-filter-tool".into(),
                        icon: Icon::LIST_FILTER,
                        label: t!("Filter").into(),
                        value: (filter != BibFilter::All).then(|| {
                            SharedString::from(format!(
                                "{} {}",
                                filter.label(),
                                format_count(filter_count as i64)
                            ))
                        }),
                        on: filter != BibFilter::All,
                        caret,
                        folded,
                        tooltip: t!("Show references"),
                        open: false,
                    },
                    move |menu, _, _| filter_menu(menu),
                )
                .anchor(Anchor::TopRight),
            )
            .child(
                MenuPopover::new(
                    "bib-sort",
                    ListTool {
                        id: "bib-sort-tool".into(),
                        icon: Icon::ARROW_DOWN_UP,
                        label: t!("Sort").into(),
                        value: Some(sort.label().into()),
                        on: sort != BibSort::File,
                        caret,
                        folded,
                        tooltip: t!("Sort references"),
                        open: false,
                    },
                    move |menu, _, _| sort_menu(menu),
                )
                .anchor(Anchor::TopRight),
            )
            .child(
                div().ml(px(4.)).child(
                    Button::new("bib-add", if add_folded { "" } else { t!("Add reference") })
                        .compact()
                        .icon(Icon::PLUS)
                        .tooltip(t!("Add reference"))
                        .on_click(cx.listener(|this, _, window, cx| this.open_add(window, cx))),
                ),
            )
            .into_any_element()
    }

    fn row(&self, index: usize, narrow: bool, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let Some(row) = self.rows.iter().find(|row| row.index == index) else {
            return div().h(px(height)).into_any_element();
        };
        let key = row.entry.key.clone();
        let summary = &row.summary;
        let selected = self
            .selected_row()
            .is_some_and(|front| front.index == index);
        let unused = model::is_unused(self.usages.as_ref(), &key);
        let cited = self
            .usages
            .as_ref()
            .map_or(0, |usages| usages.of(&key).len());
        let paper = self.papers().map(|papers| {
            let library = papers.read(cx);
            model::entry_paper(&library.papers, &key, summary, &library.fetching.states).1
        });
        let year_text = summary.year.clone();
        let year = |cx: &Context<Self>| {
            div()
                .flex_none()
                .text_role(
                    if narrow {
                        TextRole::Caption
                    } else {
                        TextRole::Typeset
                    },
                    cx,
                )
                .text_color(palette.text_secondary)
                .child(year_text.clone())
        };
        let title = div()
            .min_w_0()
            .truncate()
            .text_role(TextRole::Typeset, cx)
            .text_color(if summary.title.is_empty() {
                palette.text_secondary
            } else {
                palette.text
            })
            .child(if summary.title.is_empty() {
                SharedString::from(t!("Untitled"))
            } else {
                summary.title.clone().into()
            });
        let meta = div()
            .flex()
            .min_w_0()
            .gap(px(6.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .whitespace_nowrap()
            .when(narrow && !summary.year.is_empty(), |meta| {
                meta.child(year(cx))
            })
            .when(!summary.short_authors.is_empty(), |meta| {
                meta.child(
                    div()
                        .flex_none()
                        .max_w(relative_share(0.6))
                        .truncate()
                        .child(summary.short_authors.clone()),
                )
            })
            .when(!summary.venue.is_empty(), |meta| {
                meta.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .italic()
                        .child(summary.venue.clone()),
                )
            });
        let chip = div()
            .max_w(px(150.))
            .truncate()
            .px(px(4.))
            .rounded(px(4.))
            .bg(palette.hover)
            .font_family(editor_font)
            .text_role(TextRole::Micro, cx)
            .text_color(palette.text)
            .child(key.clone());
        let use_mark = if unused {
            Some(
                div()
                    .px(px(5.))
                    .rounded(px(4.))
                    .bg(palette.warning_soft)
                    .text_role(TextRole::Micro, cx)
                    .text_color(mix(palette.warning, palette.text, 0.3))
                    .child(t!("Unused"))
                    .into_any_element(),
            )
        } else {
            (cited > 0).then(|| {
                div()
                    .id(("bib-row-cited", index))
                    .flex()
                    .items_center()
                    .gap(px(3.))
                    .tooltip(tooltip(t!(
                        "Citations in the manuscript: {citedCount}",
                        citedCount = cited
                    )))
                    .text_role(TextRole::Micro, cx)
                    .text_color(palette.text_secondary)
                    // One dot a citation, up to five; the count says the rest.
                    .child(
                        div().flex().gap(px(2.)).children(
                            (0..cited.min(5))
                                .map(|_| div().size(px(4.)).rounded_full().bg(palette.brand_weft)),
                        ),
                    )
                    .child(cited.to_string())
                    .into_any_element()
            })
        };
        let foot = div()
            .flex()
            .flex_none()
            .gap(px(4.))
            .map(|foot| {
                if narrow {
                    foot.items_center()
                } else {
                    foot.flex_col().items_end()
                }
            })
            .child(chip)
            .children(use_mark);
        let paper_control = paper
            .filter(|state| *state != PaperState::None)
            .map(|state| {
                let (icon, label) = match state {
                    PaperState::Open => (Icon::BOOK_OPEN, t!("Open paper")),
                    PaperState::Download => (Icon::FILE_DOWN, t!("Download and open")),
                    _ => (Icon::LOADER, t!("Downloading…")),
                };
                let ink = if selected || state == PaperState::Downloading {
                    palette.text
                } else {
                    palette.text_secondary
                };
                div()
                    .id(("bib-row-paper", index))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.hover))
                    .tooltip(tooltip(label))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        this.open_paper(index, window, cx)
                    }))
                    .child(icon.element(ICON, ink))
            });
        let select_key = key.clone();
        let body = if narrow {
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .gap(px(2.))
                .child(title)
                .child(meta)
                .child(foot.mt(px(2.)))
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(12.))
                .child(
                    div()
                        .w(px(YEAR_COLUMN))
                        .flex()
                        .justify_end()
                        .child(year(cx)),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.))
                        .child(title)
                        .child(meta),
                )
                .child(foot)
                .into_any_element()
        };
        let rule_inset = if narrow { 12. } else { 12. + YEAR_COLUMN + 12. };
        div()
            .id(("bib-row", index))
            .relative()
            .flex()
            .items_center()
            .gap(px(8.))
            .h(px(height))
            .pl(px(12.))
            .pr(px(16.))
            .cursor_default()
            .map(|row| {
                if selected {
                    row.bg(palette.raised).shadow(vec![
                        weft_edge(palette.brand_weft),
                        lattice_ui::elevation::ring(palette.line),
                    ])
                } else {
                    row.hover(|style| style.bg(palette.hover))
                }
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                window.focus(&this.focus, cx);
                this.select(select_key.clone(), Some(index), true, cx);
            }))
            .child(body)
            .children(paper_control)
            .when(!selected, |row| {
                row.child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left(px(rule_inset))
                        .right(px(16.))
                        .h(px(1.))
                        .bg(palette.line),
                )
            })
            .into_any_element()
    }

    fn list(&mut self, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let shown = self.shown(cx);
        // Consumed by the list that draws it: a narrow pane showing the
        // reference keeps it for when the list comes back.
        let reveal = self.reveal.take();
        if shown.is_empty() {
            let empty_file = self.rows.is_empty();
            let filtered = !self.query.read(cx).value().is_empty() || self.filter != BibFilter::All;
            return div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(10.))
                .px(px(16.))
                .py(px(32.))
                .when(empty_file, |empty| empty.size_full().justify_center())
                .child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text_secondary)
                        .child(if empty_file {
                            t!("No references yet")
                        } else {
                            t!("No matching references")
                        }),
                )
                .when(empty_file, |empty| {
                    empty.child(
                        Button::new("bib-empty-add", t!("Add reference"))
                            .compact()
                            .on_click(cx.listener(|this, _, window, cx| this.open_add(window, cx))),
                    )
                })
                .when(!empty_file && filtered, |empty| {
                    empty.child(
                        Button::new("bib-show-all", t!("Show all references"))
                            .compact()
                            .ghost()
                            .on_click(cx.listener(|this, _, window, cx| this.show_all(window, cx))),
                    )
                })
                .into_any_element();
        }
        let narrow = width <= NARROW_LIST_WIDTH;
        let height = if narrow {
            NARROW_ROW_HEIGHT
        } else {
            ROW_HEIGHT
        };
        if let Some((key, index)) = reveal
            && let Some(row) = self.row_at(&key, index)
            && let Some(at) = shown.iter().position(|index| *index == row.index)
        {
            self.scroll.scroll_to_item(at, gpui::ScrollStrategy::Center);
        }
        uniform_list(
            "bib-rows",
            shown.len(),
            cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                range
                    .map(|at| this.row(shown[at], narrow, height, cx))
                    .collect()
            }),
        )
        .track_scroll(&self.scroll)
        .size_full()
        .into_any_element()
    }

    fn unreadable(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(error) = self.error.clone() else {
            return div().into_any_element();
        };
        let line = error.line as u32;
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .px(px(24.))
            .child(
                div()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .child(t!("This bibliography can't be shown as a list")),
            )
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(super::unreadable_reason(&error)),
            )
            .child(
                Button::new("bib-go-to-error", t!("Go to the error"))
                    .compact()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let path = this.path.clone();
                        this.open_line(path, line, cx)
                    })),
            )
            .into_any_element()
    }

    fn divider(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let ink = if self.resizing {
            palette.line_strong
        } else {
            palette.line
        };
        div()
            .id("bib-divider")
            .relative()
            .flex_none()
            .w(px(1.))
            .h_full()
            .bg(ink)
            .cursor_col_resize()
            .hover(|style| style.bg(palette.line_strong))
            .child(div().absolute().top_0().bottom_0().left(px(-4.)).w(px(9.)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, _, cx| {
                    this.resizing = true;
                    cx.notify();
                }),
            )
            .on_click(cx.listener(|this, event: &ClickEvent, _, cx| {
                if event.click_count() == 2 {
                    this.reset_ratio(cx);
                }
            }))
            .into_any_element()
    }
}

/// The weft's edge down the left of the reference in front, inside it.
fn weft_edge(color: Hsla) -> gpui::BoxShadow {
    gpui::BoxShadow {
        color,
        offset: gpui::point(px(2.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(0.),
        inset: true,
    }
}

/// A share of the parent's width.
fn relative_share(share: f32) -> gpui::DefiniteLength {
    gpui::relative(share)
}

impl Render for BibEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        self.ensure_detail(window, cx);
        let width = self.width.get();
        let one_at_a_time = width > 0. && width <= ONE_AT_A_TIME;
        let tracks = (width - 1.).max(0.);
        let list_width = (tracks * list_ratio()).clamp(
            LIST_MIN_WIDTH,
            (tracks - DETAIL_MIN_WIDTH).max(LIST_MIN_WIDTH),
        );
        let detail_shown = self.detail_open && self.selected_row().is_some();
        let measure = {
            let cell = self.width.clone();
            let origin = self.body_origin.clone();
            let view = cx.entity().downgrade();
            canvas(
                move |bounds, _, cx| {
                    origin.set(f32::from(bounds.origin.x));
                    let width = f32::from(bounds.size.width);
                    if (cell.get() - width).abs() > 0.5 {
                        cell.set(width);
                        let view = view.clone();
                        cx.defer(move |cx| {
                            view.update(cx, |_, cx| cx.notify()).ok();
                        });
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full()
        };
        let body =
            if self.error.is_some() {
                self.unreadable(cx)
            } else if one_at_a_time {
                if detail_shown {
                    self.render_detail(true, cx)
                } else {
                    self.list(width, cx)
                }
            } else {
                let left = self.body_left();
                div()
                    .flex()
                    .size_full()
                    .min_h_0()
                    .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                        if this.resizing {
                            let x = f32::from(event.position.x) - left;
                            this.set_ratio_from(x, cx);
                        }
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.resizing = false;
                            cx.notify();
                        }),
                    )
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.resizing = false;
                            cx.notify();
                        }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .w(px(list_width))
                            .h_full()
                            .child(self.list(list_width, cx)),
                    )
                    .child(self.divider(cx))
                    .child(div().flex_1().min_w_0().h_full().child(
                        if self.selected_row().is_some() {
                            self.render_detail(false, cx)
                        } else {
                            no_selection(palette.text_secondary, cx)
                        },
                    ))
                    .into_any_element()
            };
        div()
            .id("bib-visual")
            .key_context("BibEditor")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.editor)
            .text_color(palette.text)
            .when(self.resizing, |root| root.cursor_col_resize())
            .when(self.error.is_none(), |root| root.child(self.toolbar(cx)))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(body)
                    .child(measure),
            )
            .children(self.adding.clone())
    }
}

impl BibEditor {
    /// Where the body starts in the window, for the divider's drag.
    fn body_left(&self) -> f32 {
        self.body_origin.get()
    }
}

fn no_selection(ink: Hsla, cx: &App) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .child(Icon::BOOK_OPEN.element(ICON_LARGE, ink))
        .child(
            div()
                .text_role(TextRole::Body, cx)
                .text_color(ink)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .child(t!("No reference selected")),
        )
        .into_any_element()
}
