//! A reference's row and the headings over them (`.bibliography-audit-row`,
//! `-group`, `-subgroup` in `bibliography-audit.css`): its checkbox
//! (`selection.rs`), the status mark, the title over its key, file and line
//! (with an inline reference's `\bibitem` tag and an applied fix's), what
//! the check said and a publisher's notice; at the end Apply, below the queue's width while the
//! finding is folded, and a chevron. The row lights under the pointer and
//! while open; in the queue the open one takes the selected surface and its
//! chevron stays put, while narrower it turns and the finding unfolds under
//! the row's text.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::Button, icons::ICON_SMALL,
    interaction::mix, tokens::FONT_WEIGHT_MEDIUM,
};

use super::{Audit, Bucket, FixGroup, detail::BIBITEM, mark, queue::Listing};

/// Where a row's text starts: its padding, the checkbox, the mark and the
/// gaps after each (the hairline's `calc(var(--space-4) * 3 +
/// var(--control-size-checkbox) + 18px)`).
pub(super) const TEXT_INSET: f32 = 8. + 14. + 8. + 18. + 8.;

impl Audit {
    /// A bucket's heading over its rows: its mark, name and count.
    pub(super) fn group_head(
        &self,
        bucket: Bucket,
        count: usize,
        first: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette();
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .mt(px(if first { 4. } else { 16. }))
            .mb(px(4.))
            .text_role(TextRole::Caption, cx)
            .font_weight(FONT_WEIGHT_MEDIUM)
            .text_color(palette.text)
            .child(mark::mark(
                ("audit-group-mark", bucket as usize),
                bucket,
                false,
                mark::SMALL,
                cx,
            ))
            .child(bucket.label())
            .child(
                div()
                    .font_weight(gpui::FontWeight::NORMAL)
                    .text_color(palette.text_secondary)
                    .child(count.to_string()),
            )
            .into_any_element()
    }

    /// A fix group's heading inside Fixes to review: what Apply all takes,
    /// then what it leaves.
    pub(super) fn subgroup_head(&self, group: FixGroup, cx: &Context<Self>) -> AnyElement {
        div()
            .px(px(8.))
            .mt(px(8.))
            .mb(px(2.))
            .text_role(TextRole::Caption, cx)
            .text_color(cx.palette().text_secondary)
            .child(group.label())
            .into_any_element()
    }

    /// Reference `index`'s row; `rule`: a hairline over it, between rows.
    pub(super) fn row(
        &self,
        index: usize,
        listing: &Listing,
        current: Option<usize>,
        rule: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let editor = cx.lattice().fonts.editor.clone();
        let entry = &self.entries[index];
        let bucket = listing.buckets[index];
        let applied = self.applied.contains(&index);
        let message =
            super::summary::summary(self.results.get(&index), bucket, entry.inline.is_some());
        let open = current == Some(index);
        let queue = self.queue;
        let notice = self
            .results
            .get(&index)
            .and_then(super::detail::notice_line);
        let tertiary = palette.text_secondary.opacity(0.8);
        let place = match entry.line {
            Some(line) => format!("{}:{line}", entry.path),
            None => entry.path.clone(),
        };
        let tag = |text: String, success: bool| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(2.))
                .ml(px(6.))
                .px(px(4.))
                .rounded(px(4.))
                .when(!success, |tag| {
                    tag.border_1()
                        .border_color(palette.line)
                        .font_family(editor.clone())
                })
                .when(success, |tag| {
                    tag.text_color(palette.success)
                        .child(Icon::CHECK.element(px(11.), palette.success))
                })
                .child(text)
        };
        let meta = div()
            .flex()
            .items_center()
            .min_w_0()
            .text_role(TextRole::Micro, cx)
            .text_color(tertiary)
            .child(
                div()
                    .flex_none()
                    .max_w(px(220.))
                    .truncate()
                    .mr(px(6.))
                    .font_family(editor.clone())
                    .child(entry.key.clone()),
            )
            .child(div().min_w_0().truncate().child(place))
            .when(entry.inline.is_some(), |meta| {
                meta.child(tag(BIBITEM.into(), false))
            })
            .when(applied, |meta| meta.child(tag(t!("Applied").into(), true)));
        let text = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(2.))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Body, cx)
                    .text_color(if bucket == Bucket::Verified {
                        palette.text_secondary
                    } else {
                        palette.text
                    })
                    .child(super::entry_title(entry)),
            )
            .child(meta)
            .when(!message.is_empty(), |text| {
                text.child(
                    div()
                        .line_clamp(if queue { 1 } else { 2 })
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(message),
                )
            })
            // A publisher's notice shows on the row, before it is opened.
            .when_some(notice, |text, (line, kind)| {
                let ink = if kind == "retracted" {
                    mix(palette.danger, palette.text, 0.2)
                } else {
                    mix(palette.warning, palette.text, 0.22)
                };
                text.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .min_w_0()
                        .text_role(TextRole::Caption, cx)
                        .text_color(ink)
                        .child(Icon::TRIANGLE_ALERT.element(ICON_SMALL, ink))
                        .child(div().min_w_0().truncate().child(line)),
                )
            });
        let chevron = Icon::CHEVRON_RIGHT.element(
            px(14.),
            if queue && open {
                palette.text_secondary
            } else {
                tertiary
            },
        );
        let chevron = if open && !queue {
            chevron
                .with_transformation(gpui::Transformation::rotate(gpui::percentage(0.25)))
                .into_any_element()
        } else {
            chevron.into_any_element()
        };
        // Apply stays with the folded row; a narrow sheet keeps it in the
        // opened finding only.
        let quick_apply =
            !queue && !open && bucket == Bucket::Fix && entry.inline.is_none() && !self.narrow;
        let actions = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .when(quick_apply, |actions| {
                actions.child(
                    Button::new(("audit-row-apply", index), t!("Apply"))
                        .tinted()
                        .compact()
                        .disabled(!self.can_apply(index))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.apply_and_advance(index, cx)),
                        ),
                )
            })
            .child(chevron);
        let head = div()
            .id(("audit-row", index))
            .flex()
            .items_start()
            .gap(px(8.))
            .px(px(8.))
            .py(px(10.))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(index, cx)))
            .child(self.row_check(index, cx))
            .child(mark::mark(
                ("audit-mark", index),
                bucket,
                self.checking.contains(&index),
                mark::ROW,
                cx,
            ))
            .child(text)
            .child(actions);
        div()
            .id(("audit-row-box", index))
            .group(super::selection::ROW_GROUP)
            .relative()
            .flex()
            .flex_col()
            .rounded(px(6.))
            .when(open, |row| {
                row.bg(if queue {
                    palette.row_selected
                } else {
                    palette.hover
                })
            })
            .when(!open, |row| row.hover(|style| style.bg(palette.hover)))
            // The hairline between rows, from where the text starts; an open
            // row stands on its own surface instead.
            .when(rule && !open, |row| {
                row.child(
                    div()
                        .absolute()
                        .top_0()
                        .left(px(TEXT_INSET))
                        .right(px(8.))
                        .h(px(1.))
                        .bg(palette.line),
                )
            })
            .child(head)
            .when(open && !queue, |row| {
                row.child(
                    div()
                        .pl(px(TEXT_INSET))
                        .pr(px(8.))
                        .pt(px(2.))
                        .pb(px(12.))
                        .child(self.finding(index, listing, cx)),
                )
            })
            .into_any_element()
    }
}
