//! Check references drawn (`bibliography-audit.css`): what the check
//! covered and Check all, the findings' buckets as pills with their counts,
//! then one row per reference in a raised list, ordered by what it asks of
//! the writer, each with its status mark, citation key, title and what the
//! check said, and a publisher's notice on the work. A row opens its finding
//! under it (`detail.rs`); fixes sit under the kind of change they make.
//! At the foot, Apply all takes the fixes that only fill in or publish.

use gpui::{
    AnyElement, App, Context, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::{comma, join_list, t};
use lattice_ui::{
    ActiveLattice as _, Icon, Palette, TextRole, TextRoleStyle as _,
    components::Button,
    icons::{ICON, ICON_SMALL},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
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
    /// `view`: the filter the list shows, as `render` settled it.
    fn pills(
        &self,
        counts: &[(Bucket, usize)],
        view: Option<Bucket>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
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
            t!("All").into(),
            total,
            view.is_none(),
            None,
            cx,
        ));
        for (bucket, count) in counts.iter().filter(|(_, count)| *count > 0) {
            pills = pills.child(pill(
                SharedString::from(format!("audit-{bucket:?}")),
                bucket.label().into(),
                *count,
                view == Some(*bucket),
                Some(*bucket),
                cx,
            ));
        }
        pills.into_any_element()
    }

    fn row(&self, index: usize, first: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let editor = cx.lattice().fonts.editor.clone();
        let entry = &self.entries[index];
        let bucket = self.bucket(index);
        let (icon, ink) = mark(bucket, self.checking.contains(&index), &palette);
        let message =
            super::summary::summary(self.results.get(&index), bucket, entry.inline.is_some());
        let open = self.open == Some(index);
        let notice = self
            .results
            .get(&index)
            .and_then(super::detail::notice_line);
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
                    .child(div().flex_none().child(lattice_ui::loading::mark(("audit-mark", index), icon, ICON, ink, cx)))
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
                                            .child(super::entry_title(entry)),
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
                            })
                            // A publisher's notice shows on the row, before
                            // it is opened.
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

fn caption(text: String, cx: &App) -> AnyElement {
    div()
        .text_role(TextRole::Caption, cx)
        .text_color(cx.palette().text_secondary)
        .child(text)
        .into_any_element()
}

/// The findings as one bar, verified first; what is not checked yet is the
/// track (`.bibliography-audit-bar`).
fn bar(counts: &[(Bucket, usize)], palette: &Palette) -> AnyElement {
    let order = [
        Bucket::Verified,
        Bucket::Kept,
        Bucket::Fix,
        Bucket::Review,
        Bucket::Incomplete,
        Bucket::Unchecked,
    ];
    let mut bar = div()
        .flex()
        .gap(px(2.))
        .h(px(4.))
        .rounded_full()
        .overflow_hidden();
    for bucket in order {
        let count = counts
            .iter()
            .find(|(each, _)| *each == bucket)
            .map_or(0, |(_, count)| *count);
        if count == 0 {
            continue;
        }
        let fill = match bucket {
            Bucket::Verified => palette.success,
            Bucket::Kept => palette.success.opacity(0.45),
            Bucket::Fix => palette.info,
            Bucket::Review => palette.warning,
            Bucket::Incomplete => palette.line_strong,
            Bucket::Unchecked => palette.line,
        };
        let mut segment = div().min_w(px(4.)).bg(fill);
        // Each bucket grows by its share of the references.
        segment.style().flex_grow = Some(count as f32);
        segment.style().flex_basis = Some(gpui::Length::Definite(px(0.).into()));
        bar = bar.child(segment);
    }
    bar.into_any_element()
}

impl Audit {
    /// The report's first line: what the writer has to do
    /// (`bibliography-audit.tsx` `verdict`).
    fn verdict(&self, count: impl Fn(Bucket) -> usize) -> String {
        let total = self.entries.len();
        if self.busy {
            return if self.run_total > 0 {
                t!(
                    "Checking {completed} of {progressTotal}…",
                    completed = self.run_done.len(),
                    progressTotal = self.run_total
                )
            } else {
                t!("Reading the bibliography…").to_string()
            };
        }
        if self.loading {
            return t!("Reading the bibliography…").to_string();
        }
        if total == 0 && self.coverage.is_empty() && self.error.is_some() {
            return t!("Check references").to_string();
        }
        if total == 0 {
            return t!("No references to check").to_string();
        }
        let unchecked = count(Bucket::Unchecked);
        if unchecked == total {
            return if total == 1 {
                t!("1 reference, not checked yet").to_string()
            } else {
                t!("{total} references, not checked yet", total = total)
            };
        }
        let (fix, review) = (count(Bucket::Fix), count(Bucket::Review));
        let findings: Vec<String> = [
            (fix > 0).then(|| {
                if fix == 1 {
                    t!("1 fix to review").to_string()
                } else {
                    t!("{0} fixes to review", fix)
                }
            }),
            (review > 0).then(|| {
                if review == 1 {
                    t!("1 needs your eyes").to_string()
                } else {
                    t!("{0} need your eyes", review)
                }
            }),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !findings.is_empty() {
            return join_list(&findings);
        }
        let incomplete = count(Bucket::Incomplete);
        let left_over: Vec<String> = [
            (incomplete > 0).then(|| t!("{0} inconclusive", incomplete)),
            (unchecked > 0).then(|| t!("{0} not checked", unchecked)),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !left_over.is_empty() {
            return t!(
                "Nothing to fix, {leftOver}",
                leftOver = join_list(&left_over)
            );
        }
        let kept = count(Bucket::Kept);
        if kept > 0 {
            t!("Nothing left to review, {0} kept as written", kept)
        } else if total == 1 {
            t!("The reference is verified").to_string()
        } else {
            t!("All {total} references verified", total = total)
        }
    }

    /// Cancel check while a run is under way; else Check the outdated ones,
    /// Check all (or again), and Apply the fixes waiting.
    fn header_actions(&self, outdated: &[usize], cx: &mut Context<Self>) -> AnyElement {
        let total = self.entries.len();
        let mut actions = div().flex().flex_wrap().gap(px(6.));
        if self.busy {
            return actions
                .child(
                    Button::new(
                        "audit-stop",
                        if self.stopping {
                            t!("Stopping…")
                        } else {
                            t!("Cancel check")
                        },
                    )
                    .compact()
                    .ghost()
                    .disabled(self.stopping)
                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx))),
                )
                .into_any_element();
        }
        if !outdated.is_empty() && outdated.len() < total {
            let only = outdated.to_vec();
            actions = actions.child(
                Button::new(
                    "audit-check-outdated",
                    if only.len() == 1 {
                        t!("Check 1 reference").to_string()
                    } else {
                        t!("Check {0} references", only.len())
                    },
                )
                .compact()
                .ghost()
                .disabled(self.loading || self.applying)
                .on_click(cx.listener(move |this, _, _, cx| this.check(Some(only.clone()), cx))),
            );
        }
        let fresh = self.results.is_empty();
        actions = actions.child(
            Button::new(
                "audit-check-all",
                if fresh {
                    t!("Check all")
                } else {
                    t!("Check again")
                },
            )
            .compact()
            .ghost()
            .icon(Icon::ROTATE_CCW)
            .disabled(self.loading || total == 0 || self.applying)
            .on_click(cx.listener(|this, _, _, cx| this.check(None, cx))),
        );
        let updates = self.updates();
        if !updates.is_empty() {
            let label = if updates.len() == 1 {
                t!("Apply 1 fix").to_string()
            } else {
                t!("Apply {0} fixes", updates.len())
            };
            actions = actions.child(
                Button::new("audit-apply-all", label)
                    .tinted()
                    .compact()
                    .icon(Icon::CHECK)
                    .disabled(self.applying)
                    .on_click(cx.listener(move |this, _, _, cx| this.apply(updates.clone(), cx))),
            );
        }
        actions.into_any_element()
    }

    /// What the check read: each file and how many references it holds.
    fn coverage_line(&self, cx: &App) -> Option<AnyElement> {
        if self.coverage.is_empty() {
            return None;
        }
        let palette = cx.palette();
        let mut line = div()
            .flex()
            .flex_wrap()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary);
        for (index, (path, kind, entries)) in self.coverage.iter().enumerate() {
            let count = match (kind.as_str(), entries) {
                ("inline", 1) => t!("1 {BIBITEM}", BIBITEM = "\\bibitem"),
                ("inline", entries) => {
                    t!("{0} {BIBITEM}", entries).replace("{BIBITEM}", "\\bibitem")
                }
                (_, 1) => t!("1 entry").to_string(),
                (_, entries) => t!("{0} entries", entries),
            };
            line = line.child(
                div()
                    .flex()
                    .gap(px(4.))
                    .when(index > 0, |part| part.child(comma().trim_end().to_string()))
                    .child(
                        div()
                            .text_color(palette.text)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .child(path.clone()),
                    )
                    .child(count),
            );
        }
        Some(line.into_any_element())
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
        // A filter with nothing in it shows everything (`shownView`); the
        // writer's choice stays, for when its findings come back.
        let view = self.view.filter(|view| {
            counts
                .iter()
                .any(|(bucket, count)| bucket == view && *count > 0)
        });
        let shown: Vec<usize> = Bucket::ORDER
            .iter()
            .filter(|bucket| view.is_none_or(|view| view == **bucket))
            .flat_map(|bucket| {
                let mut indexes: Vec<usize> = (0..buckets.len())
                    .filter(|index| buckets[*index] == *bucket)
                    .collect();
                // Fixes Apply all takes first, a disputed one last.
                if *bucket == Bucket::Fix {
                    indexes.sort_by_key(|index| {
                        self.results
                            .get(index)
                            .map(|result| super::fix_group(&result.changes))
                    });
                }
                indexes
            })
            .collect();
        let count = |bucket: Bucket| {
            counts
                .iter()
                .find(|(each, _)| *each == bucket)
                .map_or(0, |(_, count)| *count)
        };
        let total = self.entries.len();
        let outdated = self.outdated();
        let mut body: Vec<AnyElement> = vec![
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap_x(px(16.))
                .gap_y(px(8.))
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w(px(160.))
                        .items_center()
                        .gap(px(8.))
                        .text_role(TextRole::Title, cx)
                        .text_color(palette.text)
                        .when(self.busy || self.loading, |line| {
                            line.child(lattice_ui::loading::loader("audit-loader", ICON, palette.text_secondary, cx))
                        })
                        .child(div().min_w_0().child(self.verdict(count))),
                )
                .child(self.header_actions(&outdated, cx))
                .into_any_element(),
        ];
        if let Some(line) = self.coverage_line(cx) {
            body.push(line);
        }
        if !outdated.is_empty() && outdated.len() < total {
            body.push(
                caption(
                    if outdated.len() == 1 {
                        t!("1 reference is new or changed since the last check. The others keep their results.").to_string()
                    } else {
                        t!(
                            "{0} references are new or changed since the last check. The others keep their results.",
                            outdated.len()
                        )
                    },
                    cx,
                ),
            );
        }
        // True while the project stays open: the run holds the sheet's
        // state when it closes (`running.rs`).
        if self.busy {
            body.push(caption(
                t!("Closing this window does not stop the check. It keeps running in the background, and the results wait here.").into(),
                cx,
            ));
        }
        if self.waiting_for_s2 {
            body.push(caption(
                t!(
                    "Partial results for {completed} of {progressTotal} references, waiting for Semantic Scholar…",
                    completed = self.run_done.len(),
                    progressTotal = self.run_total
                ),
                cx,
            ));
        }
        if let Some(error) = self.error.clone() {
            body.push(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(mix(palette.danger, palette.text, 0.2))
                    .child(error)
                    .into_any_element(),
            );
        }
        if total > 0 && (self.busy || count(Bucket::Unchecked) < total) {
            body.push(bar(&counts, &palette));
        }
        if total > 0 && count(Bucket::Unchecked) < total {
            body.push(self.pills(&counts, view, cx));
        }
        if total > 0 {
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
            if view.is_none()
                && let Some(issues) = self.issues_list(cx)
            {
                list = list.child(div().p(px(12.)).child(issues));
            }
            let group = |index: usize| {
                self.results
                    .get(&index)
                    .map(|result| super::fix_group(&result.changes))
            };
            for (at, index) in shown.iter().enumerate() {
                // Fixes under what kind they are, which says why Apply all
                // leaves the disputed ones.
                let inline = self.entries[*index].inline.is_some();
                let previous = at.checked_sub(1).map(|at| shown[at]);
                let mut headed = false;
                if buckets[*index] == Bucket::Fix
                    && !inline
                    && previous.is_none_or(|previous| {
                        buckets[previous] != Bucket::Fix || group(previous) != group(*index)
                    })
                    && let Some(group) = group(*index)
                {
                    list = list.child(
                        div()
                            .px(px(12.))
                            .pt(px(10.))
                            .pb(px(4.))
                            .when(at > 0, |head| head.border_t_1().border_color(palette.line))
                            .text_role(TextRole::Micro, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(group.label()),
                    );
                    headed = true;
                }
                list = list.child(self.row(*index, at == 0 || headed, cx));
            }
            body.push(list.into_any_element());
        }
        let mut actions: Vec<AnyElement> = vec![div().flex_1().into_any_element()];
        actions.push(
            Button::new("audit-close", t!("Close"))
                .disabled(self.applying)
                .on_click(cx.listener(|this, _, _, cx| this.close(cx)))
                .into_any_element(),
        );
        let view = cx.entity().downgrade();
        SheetFrame {
            id: "check-references",
            icon: Icon::CLIPBOARD_CHECK,
            title: t!("Check references"),
            body,
            actions,
            scrim_closes: !self.busy && !self.applying,
        }
        .render(window, cx, move |_, cx| {
            view.update(cx, |this, cx| this.close(cx)).ok();
        })
    }
}
