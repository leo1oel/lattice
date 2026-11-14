//! The picker of [`CompareView`]: the versions listed with From and To
//! radios that cannot cross, the range between them washed in the accent,
//! and the rows that show the automatic versions and load older ones
//! (`compare-versions.tsx`'s version table).

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::git::GitLogEntry;
use lattice_i18n::{format_count, join_phrases, locale, t};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    interaction::tab_stop,
    scrollbar::FluidScrollbar,
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_PANEL, RADIUS_PILL},
};

use super::{CompareView, NOW};
use crate::history::{messages, time, widgets::Control};

/// Six rows and a half of the picker show; the next one shows there are more.
const PICKER_ROWS: f32 = 6.5;
const PICKER_ROW: f32 = 44.;

impl CompareView {
    /// The picker for the sides `from` and `to` of `entries`.
    pub(super) fn render_picker(
        &self,
        entries: &[GitLogEntry],
        from: &str,
        to: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let locale = locale();
        let automatic: Vec<&GitLogEntry> = entries
            .iter()
            .filter(|entry| messages::is_automatic(&entry.message))
            .collect();
        let listed: Vec<&GitLogEntry> = entries
            .iter()
            .filter(|entry| {
                self.show_automatic
                    || !messages::is_automatic(&entry.message)
                    || entry.hash == from
                    || entry.hash == to
            })
            .collect();
        let rows: Vec<Option<&GitLogEntry>> = std::iter::once(None)
            .chain(listed.iter().map(|entry| Some(*entry)))
            .collect();
        let index_of = |side: &str| {
            rows.iter()
                .position(|row| match row {
                    None => side == NOW,
                    Some(entry) => entry.hash == side,
                })
                .unwrap_or(usize::MAX)
        };
        let (from_index, to_index) = (index_of(from), index_of(to));

        let narrow = self.width.get() < px(420.);
        let column = if narrow { px(36.) } else { px(44.) };
        let picker_head = div()
            .relative()
            .children(lattice_ui::parity::probe("compare/picker/head"))
            .flex()
            .items_center()
            .h(px(28.))
            .pl(if narrow { px(10.) } else { px(12.) })
            .pr(if narrow { px(4.) } else { px(8.) })
            .border_b_1()
            .border_color(palette.line)
            .text_role(TextRole::Micro, cx)
            .text_color(palette.text_secondary)
            .child(div().flex_1().min_w_0().child(t!("Version")))
            .child(div().w(column).flex().justify_center().child(t!("From")))
            .child(div().w(column).flex().justify_center().child(t!("To")));
        let picker_rows = rows.iter().enumerate().map(|(index, row)| {
            let side = row.map_or(NOW.to_string(), |entry| entry.hash.clone());
            let name = Self::side_name(&side, entries);
            let in_range = index >= to_index && index <= from_index;
            let automatic_row = row.is_some_and(|entry| messages::is_automatic(&entry.message));
            let meta = row.map(|entry| {
                let at = time::parse_ms(&entry.timestamp).unwrap_or(0);
                let author = if entry.author_name.is_empty() {
                    t!("Unknown").to_string()
                } else {
                    entry.author_name.clone()
                };
                join_phrases(&[
                    format!(
                        "{} {}",
                        time::day_name(at, locale),
                        time::clock_time(at, locale)
                    ),
                    author,
                ])
            });
            let entry = row.cloned();
            let from_entry = entry.clone();
            let to_entry = entry.clone();
            div()
                .relative()
                .when(index == 0, |this| {
                    this.children(lattice_ui::parity::probe("compare/picker/row"))
                })
                .flex()
                .items_center()
                .min_h(px(PICKER_ROW))
                .pl(if narrow { px(10.) } else { px(12.) })
                .pr(if narrow { px(4.) } else { px(8.) })
                .when(index > 0, |this| {
                    this.border_t_1().border_color(palette.line)
                })
                .when(in_range, |this| this.bg(palette.accent.opacity(0.05)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .py(px(6.))
                        .child(
                            div()
                                .min_w_0()
                                .line_clamp(2)
                                .text_role(TextRole::Caption, cx)
                                .font_weight(if automatic_row {
                                    gpui::FontWeight::NORMAL
                                } else {
                                    FONT_WEIGHT_MEDIUM
                                })
                                .text_color(if automatic_row {
                                    palette.text_secondary
                                } else {
                                    palette.text
                                })
                                .child(name.clone()),
                        )
                        .children(meta.map(|meta| {
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_role(TextRole::Micro, cx)
                                .text_color(palette.text_secondary)
                                .child(meta)
                        })),
                )
                .child(div().w(column).flex().justify_center().child(radio(
                    SharedString::from(format!("compare-from-{index}")),
                    t!("From {name}", name = &name),
                    from == side,
                    index <= to_index,
                    cx.listener(move |this, _, _, cx| this.pick(true, from_entry.clone(), cx)),
                    cx,
                )))
                .child(div().w(column).flex().justify_center().child(radio(
                    SharedString::from(format!("compare-to-{index}")),
                    t!("To {name}", name = &name),
                    to == side,
                    index >= from_index,
                    cx.listener(move |this, _, _, cx| this.pick(false, to_entry.clone(), cx)),
                    cx,
                )))
                .into_any_element()
        });
        let hidden = automatic
            .iter()
            .filter(|entry| !listed.iter().any(|listed| listed.hash == entry.hash))
            .count();
        let picker = div()
            .relative()
            .children(lattice_ui::parity::bordered_probe(
                "compare/picker",
                gpui::Edges::all(px(1.)),
            ))
            .border_1()
            .border_color(palette.line)
            .rounded(RADIUS_PANEL)
            .bg(palette.raised)
            .overflow_hidden()
            .child(picker_head)
            .child(
                div()
                    .relative()
                    .child(
                        div()
                            .id("compare-picker-rows")
                            .max_h(px(PICKER_ROW * PICKER_ROWS))
                            .overflow_y_scroll()
                            .track_scroll(&self.picker_scroll)
                            .children(picker_rows),
                    )
                    .child(FluidScrollbar::vertical(
                        "compare-picker-scrollbar",
                        &self.picker_scroll,
                    )),
            )
            .when(!automatic.is_empty(), |this| {
                let label = if self.show_automatic {
                    t!("Hide automatic versions").to_string()
                } else {
                    t!("Show {0} automatic versions", format_count(hidden as i64))
                };
                this.child(picker_more(
                    "compare-picker-automatic",
                    label,
                    cx.listener(|this, _, _, cx| {
                        this.show_automatic = !this.show_automatic;
                        cx.notify();
                    }),
                    cx,
                ))
            })
            .when(self.has_older, |this| {
                let panel = self.panel.clone();
                this.child(picker_more(
                    "compare-picker-older",
                    t!("Load older versions").into(),
                    move |_, _, cx: &mut gpui::App| {
                        panel.update(cx, |panel, cx| panel.load_older(cx)).ok();
                    },
                    cx,
                ))
            });
        picker.into_any_element()
    }
}

/// A picker's radio: a 14px ring, filled in the accent when chosen; one that
/// would cross the other side steps back to a quarter.
fn radio(
    id: SharedString,
    label: String,
    checked: bool,
    disabled: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    cx: &mut Context<CompareView>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let element = div()
        .id(id)
        .size(px(14.))
        .rounded(RADIUS_PILL)
        .flex()
        .items_center()
        .justify_center()
        .when(disabled, |this| this.opacity(0.25))
        .map(|this| {
            if checked {
                this.bg(palette.accent)
                    .child(div().size(px(6.)).rounded(RADIUS_PILL).bg(gpui::white()))
            } else {
                this.border_1()
                    .border_color(palette.line_strong)
                    .bg(palette.raised)
            }
        })
        .tooltip(move |_, cx| {
            lattice_ui::components::LatticeTooltip::view(label.clone(), None, cx)
        });
    if disabled {
        element.into_any_element()
    } else {
        tab_stop(element.cursor_pointer().on_click(on_click)).into_any_element()
    }
}

/// `.compare-picker-more`: a full-width quiet row under the picker.
fn picker_more(
    id: &'static str,
    label: String,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    _cx: &mut Context<CompareView>,
) -> AnyElement {
    Control::row(id, label)
        .on_click(on_click)
        .into_any_element()
}
