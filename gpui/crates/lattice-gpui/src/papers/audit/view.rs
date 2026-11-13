//! Check references drawn (`bibliography-audit.css`): what the check
//! covered and Check all, the findings' buckets as pills with their counts,
//! then one row per reference in a raised list, ordered by what it asks of
//! the writer, each with its status mark, citation key, title and what the
//! check said. A row opens its finding under it: the field changes a fix
//! makes, a candidate's reasons, and Apply, Keep mine and Open in source.
//! At the foot, Apply all takes the fixes that only fill in or publish.

use gpui::{
    AnyElement, Context, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_ui::{
    ActiveLattice as _, Icon, Palette, TextRole, TextRoleStyle as _, components::Button,
    icons::ICON, interaction::mix, tokens::FONT_WEIGHT_MEDIUM,
};

use super::{Audit, Bucket};
use crate::search::sheet::SheetFrame;

fn mark(bucket: Bucket, checking: bool, palette: &Palette) -> (Icon, Hsla) {
    if checking {
        return (Icon::LOADER, palette.text_secondary);
    }
    match bucket {
        Bucket::Fix => (Icon::WRENCH, palette.accent),
        Bucket::Review => (
            Icon::TRIANGLE_ALERT,
            mix(palette.warning, palette.text, 0.22),
        ),
        Bucket::Incomplete => (Icon::CIRCLE_ALERT, palette.text_secondary),
        Bucket::Unchecked => (Icon::CIRCLE_DOT, palette.text_secondary),
        Bucket::Kept => (Icon::CHECK, palette.text_secondary),
        Bucket::Verified => (Icon::CIRCLE_CHECK, palette.success),
    }
}

impl Audit {
    fn pills(&self, counts: &[(Bucket, usize)], cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let total = self.entries.len();
        let pill = |id: SharedString,
                    label: String,
                    count: usize,
                    on: bool,
                    view: Option<Bucket>,
                    cx: &mut Context<Self>| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(6.))
                .h(px(26.))
                .px(px(8.))
                .rounded_full()
                .cursor_pointer()
                .when(on, |pill| pill.bg(palette.text.opacity(0.07)))
                .when(!on, |pill| pill.hover(|style| style.bg(palette.hover)))
                .text_role(TextRole::Caption, cx)
                .text_color(if on {
                    palette.text
                } else {
                    palette.text_secondary
                })
                .on_click(cx.listener(move |this, _, _, cx| this.set_view(view, cx)))
                .child(label)
                .child(count.to_string())
        };
        let mut pills = div().flex().flex_wrap().gap(px(4.)).child(pill(
            "audit-all".into(),
            "All".into(),
            total,
            self.view.is_none(),
            None,
            cx,
        ));
        for (bucket, count) in counts.iter().filter(|(_, count)| *count > 0) {
            pills = pills.child(pill(
                SharedString::from(format!("audit-{bucket:?}")),
                bucket.label().into(),
                *count,
                self.view == Some(*bucket),
                Some(*bucket),
                cx,
            ));
        }
        pills.into_any_element()
    }

    fn finding(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor = cx.lattice().fonts.editor.clone();
        let Some(result) = self.results.get(&index).cloned() else {
            return div()
                .px(px(12.))
                .pb(px(12.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child("Not checked yet.")
                .into_any_element();
        };
        let bucket = self.bucket(index);
        let inline = self
            .entries
            .get(index)
            .is_some_and(|entry| entry.inline.is_some());
        let changes = result
            .candidate
            .as_ref()
            .map(|candidate| candidate.changes.clone())
            .unwrap_or_else(|| result.changes.clone());
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .px(px(12.))
            .pb(px(12.))
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text)
                    .child(result.message.clone()),
            );
        if !changes.is_empty() {
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .p(px(8.))
                    .rounded(px(6.))
                    .bg(palette.text.opacity(0.03))
                    .children(changes.into_iter().map(|change| {
                        div()
                            .flex()
                            .gap(px(8.))
                            .text_role(TextRole::Caption, cx)
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(96.))
                                    .truncate()
                                    .font_family(editor.clone())
                                    .text_size(px(11.))
                                    .text_color(palette.text_secondary)
                                    .child(change.field.to_lowercase()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .flex_1()
                                    .min_w_0()
                                    .when(!change.before.is_empty(), |values| {
                                        values.child(
                                            div()
                                                .text_color(mix(palette.danger, palette.text, 0.25))
                                                .line_through()
                                                .child(change.before),
                                        )
                                    })
                                    .when(!change.after.is_empty(), |values| {
                                        values.child(
                                            div()
                                                .text_color(mix(palette.success, palette.text, 0.2))
                                                .child(change.after),
                                        )
                                    }),
                            )
                    })),
            );
        }
        if let Some(candidate) = &result.candidate {
            body = body.children(candidate.reasons.iter().map(|reason| {
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(format!("• {reason}"))
            }));
        }
        if !result.disagreements.is_empty() {
            body = body.child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(format!(
                        "Crossref differs on {}; the conference's own export is kept.",
                        result.disagreements.join(", ")
                    )),
            );
        }
        let can_apply = bucket == Bucket::Fix && !inline && result.after.is_some();
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .when(can_apply, |actions| {
                    actions.child(
                        Button::new(("audit-apply", index), "Apply")
                            .tinted()
                            .compact()
                            .disabled(self.applying || self.busy)
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.apply(vec![index], cx)),
                            ),
                    )
                })
                .when(bucket == Bucket::Review, |actions| {
                    actions.child(
                        Button::new(("audit-keep", index), "Keep mine")
                            .compact()
                            .on_click(cx.listener(move |this, _, _, cx| this.keep(index, cx))),
                    )
                })
                .child(
                    Button::new(("audit-again", index), "Check again")
                        .compact()
                        .ghost()
                        .disabled(self.busy)
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.check(Some(vec![index]), cx)),
                        ),
                )
                .child(
                    Button::new(("audit-source", index), "Open in source")
                        .compact()
                        .ghost()
                        .icon(Icon::EXTERNAL_LINK)
                        .on_click(cx.listener(move |this, _, _, cx| this.open_source(index, cx))),
                ),
        );
        body.into_any_element()
    }

    fn row(&self, index: usize, first: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor = cx.lattice().fonts.editor.clone();
        let entry = &self.entries[index];
        let bucket = self.bucket(index);
        let (icon, ink) = mark(bucket, self.checking.contains(&index), &palette);
        let message = self
            .results
            .get(&index)
            .map(|result| result.message.clone())
            .unwrap_or_default();
        let open = self.open == Some(index);
        div()
            .flex()
            .flex_col()
            .when(!first, |row| row.border_t_1().border_color(palette.line))
            .child(
                div()
                    .id(("audit-row", index))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(8.))
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.hover))
                    .when(open, |row| row.bg(palette.row_selected))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(index, cx)))
                    .child(div().flex_none().child(icon.element(ICON, ink)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(px(8.))
                                    .min_w_0()
                                    .child(
                                        div()
                                            .flex_none()
                                            .max_w(px(220.))
                                            .truncate()
                                            .font_family(editor)
                                            .text_size(px(11.))
                                            .text_color(palette.text_secondary)
                                            .child(entry.key.clone()),
                                    )
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_role(TextRole::Body, cx)
                                            .text_color(palette.text)
                                            .child(entry.title.clone()),
                                    ),
                            )
                            .when(!message.is_empty(), |text| {
                                text.child(
                                    div()
                                        .truncate()
                                        .text_role(TextRole::Caption, cx)
                                        .text_color(palette.text_secondary)
                                        .child(message),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_role(TextRole::Caption, cx)
                            .text_color(ink)
                            .child(bucket.label()),
                    ),
            )
            .when(open, |row| row.child(self.finding(index, cx)))
            .into_any_element()
    }
}

impl Render for Audit {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let buckets: Vec<Bucket> = (0..self.entries.len())
            .map(|index| self.bucket(index))
            .collect();
        let counts: Vec<(Bucket, usize)> = Bucket::ORDER
            .iter()
            .map(|bucket| {
                (
                    *bucket,
                    buckets.iter().filter(|value| *value == bucket).count(),
                )
            })
            .collect();
        // A filter whose last finding was resolved falls back to everything.
        let view = self.view.filter(|view| {
            counts
                .iter()
                .any(|(bucket, count)| bucket == view && *count > 0)
        });
        let shown: Vec<usize> = Bucket::ORDER
            .iter()
            .filter(|bucket| view.is_none_or(|view| view == **bucket))
            .flat_map(|bucket| {
                let buckets = &buckets;
                (0..buckets.len()).filter(move |index| buckets[*index] == *bucket)
            })
            .collect();
        let files = self.coverage.len();
        let covered = match (self.entries.len(), files) {
            (0, _) => "No references found".to_string(),
            (1, 1) => "1 reference in 1 file".to_string(),
            (count, 1) => format!("{count} references in 1 file"),
            (count, files) => format!("{count} references in {files} files"),
        };
        let mut body: Vec<AnyElement> = vec![
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(if self.loading {
                            "Reading references…".to_string()
                        } else {
                            covered
                        }),
                )
                .child(if self.busy {
                    Button::new(
                        "audit-stop",
                        if self.stopping { "Stopping…" } else { "Stop" },
                    )
                    .compact()
                    .disabled(self.stopping)
                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx)))
                    .into_any_element()
                } else {
                    Button::new("audit-check-all", "Check all")
                        .tinted()
                        .compact()
                        .icon(Icon::CLIPBOARD_CHECK)
                        .disabled(self.loading || self.entries.is_empty() || self.applying)
                        .on_click(cx.listener(|this, _, _, cx| this.check(None, cx)))
                        .into_any_element()
                })
                .into_any_element(),
        ];
        if let Some(error) = self.error.clone() {
            body.push(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(mix(palette.danger, palette.text, 0.2))
                    .child(error)
                    .into_any_element(),
            );
        }
        if !self.entries.is_empty() {
            body.push(self.pills(&counts, cx));
            let mut list = div()
                .id("audit-rows")
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .rounded(px(10.))
                .border_1()
                .border_color(palette.line)
                .bg(palette.raised);
            for (at, index) in shown.iter().enumerate() {
                list = list.child(self.row(*index, at == 0, cx));
            }
            body.push(list.into_any_element());
        }
        let updates = self.updates();
        let done = counts
            .iter()
            .filter(|(bucket, _)| matches!(bucket, Bucket::Verified | Bucket::Kept))
            .map(|(_, count)| count)
            .sum::<usize>();
        let checking = self.checking.len();
        let summary = if self.busy {
            format!("Checking… {done} of {} settled", self.entries.len())
        } else {
            let open: usize = counts
                .iter()
                .filter(|(bucket, _)| bucket.actionable())
                .map(|(_, count)| count)
                .sum();
            match open {
                0 if !self.entries.is_empty() && checking == 0 && counts[3].1 == 0 => {
                    "Every reference is settled".to_string()
                }
                0 => String::new(),
                1 => "1 finding to act on".to_string(),
                open => format!("{open} findings to act on"),
            }
        };
        let mut actions: Vec<AnyElement> = vec![
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child(summary)
                .into_any_element(),
        ];
        if !updates.is_empty() {
            let label = if updates.len() == 1 {
                "Apply 1 fix".to_string()
            } else {
                format!("Apply {} fixes", updates.len())
            };
            actions.push(
                Button::new("audit-apply-all", label)
                    .primary()
                    .icon(Icon::CHECK)
                    .disabled(self.applying || self.busy)
                    .on_click(cx.listener(move |this, _, _, cx| this.apply(updates.clone(), cx)))
                    .into_any_element(),
            );
        }
        actions.push(
            Button::new("audit-close", "Close")
                .on_click(cx.listener(|this, _, _, cx| this.close(cx)))
                .into_any_element(),
        );
        let view = cx.entity().downgrade();
        SheetFrame {
            id: "check-references",
            icon: Icon::CLIPBOARD_CHECK,
            title: "Check references",
            body,
            actions,
            scrim_closes: !self.busy,
        }
        .render(window, cx, move |_, cx| {
            view.update(cx, |this, cx| this.close(cx)).ok();
        })
    }
}
