//! Check references drawn (`bibliography-audit.css`): the verdict and its
//! actions, what the check covered, a bar of the findings and the filters
//! (`tabs.rs`) and, with references ticked, the selection (`selection.rs`),
//! then the references grouped by what each asks of the writer,
//! fixes under the kind of change they make (`row.rs`). At 800px and wider
//! the list stands beside the finding it has open as a review queue
//! (`pane.rs`); narrower, a finding unfolds under its row. The sheet holds
//! the keyboard while it is up, for the queue's keys (`queue.rs`).

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
    relative,
};
use lattice_i18n::{comma, join_list, t};
use lattice_ui::{
    ActiveLattice as _, Icon, Palette, TextRole, TextRoleStyle as _,
    components::{Button, TrapFocus as _},
    icons::ICON,
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{Audit, Bucket, queue::Listing};
use crate::search::sheet::SheetFrame;

/// The window width from which the list and the open finding stand side by
/// side (`queueWidth`, `(min-width: 800px)`).
const QUEUE_WIDTH: f32 = 800.;
/// The sheet's content width under which a folded row keeps no Apply
/// (`@container bibliography-audit (width < 520px)`).
const ROW_APPLY_WIDTH: f32 = 520.;

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

impl Audit {
    /// The references as the list draws them: bucket headings while all
    /// are shown, fix groups inside the fixes, a row each. The row the
    /// last opening asked for is brought into view.
    fn list(
        &mut self,
        listing: &Listing,
        current: Option<usize>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut children: Vec<AnyElement> = Vec::new();
        if listing.view.is_none()
            && let Some(issues) = self.issues_list(cx)
        {
            children.push(div().pb(px(4.)).child(issues).into_any_element());
        }
        let group = |index: usize| {
            self.results
                .get(&index)
                .map(|result| super::fix_group(&result.changes))
        };
        let reveal = self.reveal.take();
        let mut revealed = None;
        for (at, index) in listing.shown.iter().copied().enumerate() {
            let bucket = listing.buckets[index];
            let previous = at.checked_sub(1).map(|at| listing.shown[at]);
            let mut rule = previous.is_some() && previous != current;
            if listing.view.is_none()
                && previous.is_none_or(|previous| listing.buckets[previous] != bucket)
            {
                children.push(self.group_head(bucket, listing.count(bucket), at == 0, cx));
                rule = false;
            }
            // Fixes under what kind they are, which says why Apply all
            // leaves the disputed ones.
            if bucket == Bucket::Fix
                && self.entries[index].inline.is_none()
                && previous.is_none_or(|previous| {
                    listing.buckets[previous] != Bucket::Fix || group(previous) != group(index)
                })
                && let Some(group) = group(index)
            {
                children.push(self.subgroup_head(group, cx));
                rule = false;
            }
            if reveal == Some(index) {
                revealed = Some(children.len());
            }
            children.push(self.row(index, listing, current, rule, cx));
        }
        if let Some(child) = revealed {
            self.scroll.scroll_to_item(child);
        }
        let list = div()
            .id("audit-rows")
            .flex()
            .flex_col()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .pb(px(16.))
            .children(children);
        if self.queue {
            // The list's share of the queue: min(340px, 42%).
            list.flex_none()
                .w(relative(0.42))
                .max_w(px(340.))
                .pr(px(8.))
                .into_any_element()
        } else {
            list.flex_1().into_any_element()
        }
    }
}

impl Render for Audit {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        self.queue = f32::from(window.viewport_size().width) >= QUEUE_WIDTH;
        self.narrow = crate::search::sheet::body_width(window) < ROW_APPLY_WIDTH;
        let listing = self.listing();
        let current = self.current(&listing);
        let count = |bucket: Bucket| listing.count(bucket);
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
                            line.child(lattice_ui::loading::loader(
                                "audit-loader",
                                ICON,
                                palette.text_secondary,
                                cx,
                            ))
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
            body.push(bar(&listing.counts, &palette));
        }
        if total > 0 && count(Bucket::Unchecked) < total {
            body.push(self.tabs(&listing, window, cx));
        }
        if let Some(bar) = self.selection_bar(cx) {
            body.push(bar);
        }
        if !self.queue && listing.settled(self.busy) {
            body.push(self.clean_note(false, cx));
        }
        if total > 0 {
            let list = self.list(&listing, current, cx);
            let findings = div().flex().flex_1().min_h_0().child(list);
            body.push(
                if self.queue {
                    findings.child(self.pane(&listing, current, cx))
                } else {
                    findings.flex_col()
                }
                .into_any_element(),
            );
        }
        let view = cx.entity().downgrade();
        let sheet = SheetFrame {
            id: "check-references",
            icon: Icon::CLIPBOARD_CHECK,
            title: t!("Check references"),
            body,
            // No foot: the header's X closes it, as the Tauri sheet's does.
            actions: Vec::new(),
            // A running check, fixes being written or a selection waiting to be
            // checked survive a stray click outside (`dirty`).
            scrim_closes: !self.busy && !self.applying && self.selected.is_empty(),
        }
        .render(window, cx, move |_, cx| {
            view.update(cx, |this, cx| this.close(cx)).ok();
        });
        // The sheet holds the keyboard, so the queue's keys are its own.
        div()
            .absolute()
            .inset_0()
            .trap_focus("check-references-keys", &self.focus)
            .key_context(super::KEY_CONTEXT)
            .on_action(cx.listener(Self::next_reference))
            .on_action(cx.listener(Self::previous_reference))
            .on_action(cx.listener(Self::apply_fix))
            .on_action(cx.listener(Self::apply_fix_chord))
            .on_action(cx.listener(Self::skip_finding))
            .child(sheet)
    }
}
