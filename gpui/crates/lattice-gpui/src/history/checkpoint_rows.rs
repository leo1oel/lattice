//! The Agent's checkpoints as rows of the History timeline, ported from the
//! Tauri app's `history-drawer.tsx` (`renderActivity` for an
//! `agent-checkpoint` item, `HistoryStat`, `.history-checkpoint-summary` in
//! `workspace-panels.css`), from the items `use-agent-checkpoints.ts` makes
//! of the snapshots Synara streams (`crate::agent::checkpoints`).
//!
//! A checkpoint row is an activity row of the Agent's: its meta line names
//! the files its turn changed and the lines it added and removed; opened, it
//! shows the turn's thread and each file's kind and counts rather than a
//! transaction's diff. Its one tool undoes the turn's file changes through
//! the Agent itself, and only for the thread the Agent panel has open; any
//! other says to open that task first.

use gpui::{
    AnyElement, App, Context, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
    div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::{format_count, locale, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    tokens::{FONT_WEIGHT_SEMIBOLD, RADIUS_CONTROL},
    typography::tabular_nums,
};

use super::{
    panel::{HistoryEvent, HistoryPanel},
    row::{RowParts, Weight},
    time,
    timeline::{self, ActivityFilter, TimelineRow},
    widgets::Control,
};
use crate::agent::checkpoints::Entry;

/// One checkpoint as the timeline shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointItem {
    pub entry: Entry,
    /// Its thread is the one the Agent panel has open.
    pub restorable: bool,
}

/// The checkpoint rows the Activity filter admits: the Agent's own.
pub(super) fn rows(items: &[CheckpointItem], filter: ActivityFilter) -> Vec<TimelineRow> {
    if !filter.admits("agent") {
        return Vec::new();
    }
    items
        .iter()
        .map(|item| TimelineRow::Checkpoint {
            at: time::parse_ms(&item.entry.timestamp).unwrap_or(0),
            item: item.clone(),
        })
        .collect()
}

/// The lines a checkpoint added and removed, over all its files.
fn totals(entry: &Entry) -> (u64, u64) {
    entry.files.iter().fold((0, 0), |(added, removed), file| {
        (added + file.additions, removed + file.deletions)
    })
}

/// "+12 −3" (`HistoryStat`): nothing when the turn changed no lines.
pub(super) fn stat(additions: u64, deletions: u64, cx: &App) -> Option<AnyElement> {
    if additions == 0 && deletions == 0 {
        return None;
    }
    let palette = cx.palette();
    Some(
        div()
            .flex()
            .flex_none()
            .gap(px(4.))
            .font_features(tabular_nums())
            .child(
                div()
                    .text_color(palette.success)
                    .child(format!("+{}", format_count(additions as i64))),
            )
            .child(
                div()
                    .text_color(palette.danger)
                    .child(format!("−{}", format_count(deletions as i64))),
            )
            .into_any_element(),
    )
}

/// Synara's name for a file's change, capitalized as the Tauri app's
/// `text-transform: capitalize` shows it.
fn kind_label(kind: &str) -> String {
    let mut chars = kind.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

impl HistoryPanel {
    /// The Agent's checkpoints, every thread's; another project's go with it.
    pub fn set_agent_checkpoints(&mut self, items: Vec<CheckpointItem>, cx: &mut Context<Self>) {
        if self.agent_checkpoints != items {
            self.agent_checkpoints = items;
            cx.notify();
        }
    }

    /// The checkpoints, for a scenario: each row's id and whether it undoes.
    pub fn agent_checkpoint_rows(&self) -> Vec<(String, bool)> {
        self.agent_checkpoints
            .iter()
            .map(|item| (item.entry.id.clone(), item.restorable))
            .collect()
    }

    /// Undo a checkpoint's turn, as its row's tool does, for a scenario.
    pub fn restore_agent_checkpoint_for_scenario(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(item) = self
            .agent_checkpoints
            .iter()
            .find(|item| item.entry.id == id && item.restorable)
        {
            cx.emit(HistoryEvent::RestoreAgentCheckpoint(item.entry.clone()));
        }
    }

    /// Open the checkpoint `id`'s summary, for a scenario.
    pub fn open_agent_checkpoint_for_scenario(&mut self, id: &str, cx: &mut Context<Self>) {
        let key = timeline::activity_key(id);
        if self.expanded.as_deref() != Some(&key) {
            self.toggle_checkpoint(key, cx);
        }
    }

    /// Open a checkpoint's summary; asked again while it is, close it. It
    /// reads nothing: the snapshot already holds what it shows.
    fn toggle_checkpoint(&mut self, key: String, cx: &mut Context<Self>) {
        self.compare_key = None;
        self.opened = None;
        self.overleaf.opened = None;
        self.entry.clear();
        let opening = self.expanded.as_deref() != Some(&key);
        self.expanded = opening.then_some(key);
        cx.notify();
    }

    pub(super) fn checkpoint_row(
        &mut self,
        item: &CheckpointItem,
        at: i64,
        first: bool,
        last: bool,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> RowParts {
        let locale = locale();
        let entry = &item.entry;
        let key = timeline::activity_key(&entry.id);
        let expanded = self.expanded.as_deref() == Some(&key);
        let files: Vec<&str> = entry.files.iter().map(|file| file.path.as_str()).collect();
        let (additions, deletions) = totals(entry);
        let meta = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .min_w_0()
            .overflow_hidden()
            .child(div().flex_none().child(t!("Agent")))
            .when(!files.is_empty(), |this| {
                this.child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(files.join(", ")),
                )
            })
            .children(stat(additions, deletions, cx))
            .into_any_element();
        let restore_title = if item.restorable {
            t!("Undo this Agent turn's file changes")
        } else {
            t!("Open this Agent task before restoring its files")
        };
        let restored = entry.clone();
        let tools = vec![
            Control::tool(
                SharedString::from(format!("history-restore-{}", entry.id)),
                Icon::ROTATE_CCW,
                restore_title,
            )
            .disabled(!item.restorable)
            .on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(HistoryEvent::RestoreAgentCheckpoint(restored.clone()))
            }))
            .into_any_element(),
        ];
        let body = expanded.then(|| summary(entry, cx));
        let toggled = key.clone();
        let on_toggle = Box::new(
            cx.listener(move |this, _, _, cx| this.toggle_checkpoint(toggled.clone(), cx)),
        );
        RowParts {
            on_toggle,
            probe: None,
            key,
            glyph: Icon::SPARKLES,
            glyph_size: 13.,
            weight: Weight::Plain,
            title: entry.label.clone().into(),
            meta: Some(meta),
            time: time::clock_time(at, locale).into(),
            time_title: time::full_time(at, locale).into(),
            tools,
            body,
            first,
            last,
        }
    }
}

/// The opened checkpoint: its thread, then each file with its kind and
/// counts (`.history-checkpoint-summary`).
fn summary(entry: &Entry, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let mut card = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .min_w_0()
        .p(px(8.))
        .border_1()
        .border_color(palette.line)
        .rounded(RADIUS_CONTROL)
        .bg(palette.window)
        .text_role(TextRole::Body, cx);
    if !entry.thread_title.is_empty() {
        card = card.child(
            div()
                .text_role(TextRole::Micro, cx)
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .text_color(palette.text_secondary)
                .child(entry.thread_title.clone()),
        );
    }
    for file in &entry.files {
        let counts = if file.additions > 0 || file.deletions > 0 {
            format!(
                " +{} −{}",
                format_count(file.additions as i64),
                format_count(file.deletions as i64)
            )
        } else {
            String::new()
        };
        card = card.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .min_w_0()
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_color(palette.text)
                        .child(file.path.clone()),
                )
                .child(
                    div()
                        .flex_none()
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .child(format!("{}{counts}", kind_label(&file.kind))),
                ),
        );
    }
    card.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::checkpoints::FileSummary;

    fn item(id: &str, files: &[(u64, u64)]) -> CheckpointItem {
        CheckpointItem {
            entry: Entry {
                id: id.into(),
                label: "Revise the introduction".into(),
                timestamp: "2026-11-14T10:00:00.000Z".into(),
                thread_id: "t".into(),
                thread_title: "Introduction revision".into(),
                turn_id: "turn".into(),
                turn_count: 1,
                checkpoint_ref: "refs/x".into(),
                files: files
                    .iter()
                    .map(|(additions, deletions)| FileSummary {
                        path: "main.tex".into(),
                        kind: "modified".into(),
                        additions: *additions,
                        deletions: *deletions,
                    })
                    .collect(),
            },
            restorable: true,
        }
    }

    #[test]
    fn only_the_agents_filters_show_checkpoints() {
        let items = [item("a", &[(4, 2)])];
        assert_eq!(rows(&items, ActivityFilter::All).len(), 1);
        assert_eq!(rows(&items, ActivityFilter::Agent).len(), 1);
        assert!(rows(&items, ActivityFilter::User).is_empty());
        assert!(rows(&items, ActivityFilter::Citation).is_empty());
        assert_eq!(rows(&items, ActivityFilter::All)[0].key(), "activity:a");
    }

    #[test]
    fn a_checkpoint_counts_every_files_lines() {
        assert_eq!(totals(&item("a", &[(4, 2), (1, 0)]).entry), (5, 2));
        assert_eq!(kind_label("modified"), "Modified");
        assert_eq!(kind_label(""), "");
    }
}
