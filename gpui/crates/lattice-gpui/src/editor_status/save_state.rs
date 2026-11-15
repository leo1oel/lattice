//! The status bar's save slot and its popover, as the Tauri app's
//! `StatusSaveState` (`status-save-state.tsx`) draws them.
//!
//! One quiet line after the caret: the text is on disk ("Saved", then its
//! age, "just now", "2m ago"), and with a linked Overleaf project, whether
//! it has reached Overleaf too ("Saved and synced"). It never alarms about
//! unsaved typing (the tab's dot says that, and autosave follows in a
//! second); working offline is neutral, its mark in the warning hue; only a
//! write that failed is red, and its popover says why, that nothing is lost,
//! and how to get the text out: Try again, or Save a copy….
//!
//! The popover (`.word-count-popover.save-state-popover`, 284px, above the
//! slot and aligned to its start, 6px off) says:
//! - a failed write: "Lattice couldn’t write main.tex", the reason in the
//!   editor's face, then Try again and Save a copy…;
//! - offline: "Working offline", when it last synced, and Try now;
//! - otherwise: "On this Mac" and when it saved, and with a link, Overleaf's
//!   state, with Sync now when edits go on the writer's word, and how to
//!   resume when the link is paused.

use gpui::{
    Anchor, AnyElement, App, IntoElement, ParentElement as _, SharedString, Styled as _,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::base::Popover;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, PopFrom, StatusItem, pop_in},
    elevation::Elevation,
    tokens::FONT_WEIGHT_SEMIBOLD,
    typography::tabular_nums,
};

use crate::{
    editor_panel::{EditorPanel, SaveStatus},
    overleaf::bridge::OverleafSaveState as Overleaf,
    shell::overleaf_flow::SyncOverleaf,
};

/// What the slot and its popover say, read from the editor once a frame.
#[derive(Clone, Debug, PartialEq)]
pub struct SaveSlot {
    pub status: SaveStatus,
    pub overleaf: Option<Overleaf>,
    /// The age of the last write ("2m ago"), nothing before the first.
    pub age: Option<String>,
    /// When the linked project last synced ("4m ago").
    pub synced: Option<String>,
    /// The file's name, for a failed write's title.
    pub file: String,
}

/// How the slot is tinted (`data-mode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Saved,
    Offline,
    Error,
}

impl SaveSlot {
    pub fn read(panel: &EditorPanel) -> Self {
        let file = panel
            .path()
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            status: panel.save_status().clone(),
            overleaf: panel.overleaf_save(),
            age: panel
                .saved_at()
                .map(|at| crate::overleaf::picker::relative_time(&at.to_rfc3339())),
            synced: panel
                .overleaf_last_sync()
                .map(crate::overleaf::picker::relative_time),
            file,
        }
    }

    fn failed(&self) -> bool {
        matches!(self.status, SaveStatus::Failed(_))
    }

    fn offline(&self) -> bool {
        self.overleaf == Some(Overleaf::Offline)
    }

    pub fn mode(&self) -> Mode {
        if self.failed() {
            Mode::Error
        } else if self.offline() {
            Mode::Offline
        } else {
            Mode::Saved
        }
    }

    /// The slot's label and mark.
    pub fn label(&self) -> (Icon, SharedString) {
        let (icon, label) = match (&self.status, self.overleaf) {
            (SaveStatus::Failed(_), _) => (Icon::CIRCLE_ALERT, t!("Couldn’t save")),
            (SaveStatus::Saving, _) => (Icon::LOADER, t!("Saving…")),
            (SaveStatus::Saved, Some(Overleaf::Offline)) => {
                (Icon::CLOUD_OFF, t!("Saved on this Mac"))
            }
            (SaveStatus::Saved, Some(Overleaf::Live)) => {
                (Icon::CLOUD_CHECK, t!("Saved and synced"))
            }
            (SaveStatus::Saved, Some(Overleaf::Syncing | Overleaf::Sending)) => {
                (Icon::LOADER, t!("Saved, syncing…"))
            }
            (SaveStatus::Saved, _) => (Icon::HARD_DRIVE, t!("Saved")),
        };
        (icon, label.into())
    }

    /// The age after the label, only where it is the disk's alone: a label
    /// that speaks of Overleaf keeps it off.
    pub fn shown_age(&self) -> Option<&str> {
        let quiet_link = matches!(
            self.overleaf,
            None | Some(Overleaf::Manual | Overleaf::Paused)
        );
        (self.status == SaveStatus::Saved && quiet_link)
            .then_some(self.age.as_deref())
            .flatten()
    }

    /// What the popover says.
    pub fn details(&self) -> Details {
        if let SaveStatus::Failed(reason) = &self.status {
            return Details {
                title: Some(t!("Lattice couldn’t write {file}", file = self.file.as_str()).into()),
                reason: (!reason.is_empty()).then(|| reason.clone()),
                rows: Vec::new(),
                actions: vec![SlotAction::Retry, SlotAction::SaveCopy],
            };
        }
        if self.offline() {
            return Details {
                title: Some(t!("Working offline").into()),
                reason: None,
                rows: vec![Row {
                    term: t!("Last synced").into(),
                    value: self
                        .synced
                        .clone()
                        .map_or_else(|| t!("Not yet").into(), Into::into),
                    note: None,
                }],
                actions: vec![SlotAction::TryNow],
            };
        }
        let disk = if self.status == SaveStatus::Saving {
            t!("Saving…").into()
        } else {
            match &self.age {
                Some(age) => t!("Saved {age}", age = age.as_str()).into(),
                None => t!("Saved").into(),
            }
        };
        let mut rows = vec![Row {
            term: t!("On this Mac").into(),
            value: disk,
            note: None,
        }];
        if let Some(state) = self.overleaf {
            let value: SharedString = match state {
                Overleaf::Live => t!("Live").into(),
                Overleaf::Syncing | Overleaf::Sending => t!("Syncing…").into(),
                Overleaf::Paused => t!("Sync paused").into(),
                _ => match &self.synced {
                    Some(synced) => t!("Synced {synced}", synced = synced.as_str()).into(),
                    None => t!("Not synced yet").into(),
                },
            };
            // Paused has no action here, so it alone says how to resume.
            let note = (state == Overleaf::Paused)
                .then(|| t!("Resume the link in Overleaf settings to sync again").into());
            rows.push(Row {
                term: t!("Overleaf").into(),
                value,
                note,
            });
        }
        let actions = if self.overleaf == Some(Overleaf::Manual) {
            vec![SlotAction::SyncNow]
        } else {
            Vec::new()
        };
        Details {
            title: None,
            reason: None,
            rows,
            actions,
        }
    }
}

/// The popover's contents.
#[derive(Clone, Debug, PartialEq)]
pub struct Details {
    pub title: Option<SharedString>,
    pub reason: Option<SharedString>,
    pub rows: Vec<Row>,
    pub actions: Vec<SlotAction>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub term: SharedString,
    pub value: SharedString,
    pub note: Option<SharedString>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotAction {
    Retry,
    SaveCopy,
    TryNow,
    SyncNow,
}

impl SlotAction {
    fn label(self) -> SharedString {
        match self {
            Self::Retry => t!("Try again"),
            Self::SaveCopy => t!("Save a copy…"),
            Self::TryNow => t!("Try now"),
            Self::SyncNow => t!("Sync now"),
        }
        .into()
    }

    fn run(self, panel: &WeakEntity<EditorPanel>, window: &mut Window, cx: &mut App) {
        match self {
            Self::Retry => {
                panel.update(cx, |panel, cx| panel.retry_save(cx)).ok();
            }
            Self::SaveCopy => {
                panel.update(cx, |panel, cx| panel.save_copy(cx)).ok();
            }
            Self::TryNow | Self::SyncNow => window.dispatch_action(Box::new(SyncOverleaf), cx),
        }
    }
}

/// The slot, opening its popover on a click. `labelled`: the label shows
/// (a narrow bar keeps the mark alone); `aged`: the age shows too.
pub fn item(
    slot: SaveSlot,
    panel: WeakEntity<EditorPanel>,
    labelled: bool,
    aged: bool,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let (icon, label) = slot.label();
    let mut trigger = StatusItem::new("save-state")
        .icon(icon)
        .parity("status/save");
    trigger = match slot.mode() {
        Mode::Error => trigger.steady_ink(palette.danger),
        Mode::Offline => trigger
            .steady_ink(palette.text_secondary)
            .icon_ink(palette.warning),
        Mode::Saved => trigger,
    };
    if labelled {
        trigger = trigger.label(label);
        if let Some(age) = slot.shown_age().filter(|_| aged) {
            // `.status-save-age`: a no-break space and 4px after the label.
            trigger = trigger.child(div().ml(px(4.)).child(format!("\u{a0}{age}")));
        }
    }
    let trigger = trigger.on_click(|_, _, _| {});
    Popover::new("save-state-popover")
        .anchor(Anchor::BottomLeft)
        .offset(px(6.))
        .trigger_with(move |_, _, _| trigger.into_any_element())
        .content(move |_, _, cx| {
            pop_in(
                "save-state-details",
                PopFrom::Below,
                details(&slot.details(), &panel, cx),
            )
        })
        .into_any_element()
}

fn details(details: &Details, panel: &WeakEntity<EditorPanel>, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let editor_font = cx.lattice().fonts.editor.clone();
    let semibold = |text: SharedString| {
        div()
            .text_role(TextRole::BodyCompact, cx)
            .font_weight(FONT_WEIGHT_SEMIBOLD)
            .text_color(palette.text)
            .child(text)
    };
    let has_rows = !details.rows.is_empty();
    let rows = details.rows.iter().enumerate().map(|(ix, row)| {
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .py(px(10.))
            .px(px(12.))
            .when(ix > 0, |this| this.border_t_1().border_color(palette.line))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .gap(px(12.))
                    .child(semibold(row.term.clone()).min_w_0())
                    .child(
                        semibold(row.value.clone())
                            .whitespace_nowrap()
                            .font_features(tabular_nums()),
                    ),
            )
            .children(row.note.clone().map(|note| {
                div()
                    .text_role(TextRole::Micro, cx)
                    .font_weight(gpui::FontWeight::NORMAL)
                    .text_color(palette.text_secondary)
                    .child(note)
            }))
    });
    let actions = (!details.actions.is_empty()).then(|| {
        div()
            .flex()
            .flex_wrap()
            .gap(px(6.))
            .px(px(12.))
            .pb(px(8.))
            .when(!has_rows, |this| this.pt(px(4.)))
            .children(details.actions.iter().enumerate().map(|(ix, &action)| {
                let panel = panel.clone();
                let button = Button::new(("save-state-action", ix), action.label()).compact();
                let button = match action {
                    SlotAction::Retry => button,
                    SlotAction::SaveCopy => button.ghost(),
                    SlotAction::TryNow | SlotAction::SyncNow => button.ghost().icon(Icon::REFRESH),
                };
                button.on_click(move |_, window, cx| action.run(&panel, window, cx))
            }))
    });
    div()
        .w(px(284.))
        .p(px(4.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .rounded(px(10.))
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .children(
            details
                .title
                .clone()
                .map(|title| semibold(title).pt(px(8.)).px(px(12.))),
        )
        .children(details.reason.clone().map(|reason| {
            div()
                .px(px(12.))
                .font_family(editor_font)
                .text_role(TextRole::Micro, cx)
                .text_color(palette.text)
                .child(reason)
        }))
        .when(has_rows, |this| {
            this.child(div().flex().flex_col().children(rows))
        })
        .children(actions)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(status: SaveStatus, overleaf: Option<Overleaf>) -> SaveSlot {
        SaveSlot {
            status,
            overleaf,
            age: Some("2m ago".into()),
            synced: Some("4m ago".into()),
            file: "main.tex".into(),
        }
    }

    // status-save-state.tsx: a failed write says which file and why, and
    // offers Try again then Save a copy….
    #[test]
    fn a_failed_write_names_the_file_and_offers_a_way_out() {
        let failed = slot(SaveStatus::Failed("disk full".into()), None);
        assert_eq!(failed.mode(), Mode::Error);
        let details = failed.details();
        assert_eq!(
            details.title.as_deref(),
            Some("Lattice couldn’t write main.tex")
        );
        assert_eq!(details.reason.as_deref(), Some("disk full"));
        assert_eq!(details.actions, [SlotAction::Retry, SlotAction::SaveCopy]);
        assert_eq!(failed.shown_age(), None);
    }

    #[test]
    fn offline_says_when_it_last_synced_and_offers_try_now() {
        let offline = slot(SaveStatus::Saved, Some(Overleaf::Offline));
        assert_eq!(offline.mode(), Mode::Offline);
        let details = offline.details();
        assert_eq!(details.title.as_deref(), Some("Working offline"));
        assert_eq!(details.rows[0].value.as_ref(), "4m ago");
        assert_eq!(details.actions, [SlotAction::TryNow]);
    }

    // The age is the disk's, so a label that speaks of Overleaf keeps it off.
    #[test]
    fn the_age_shows_only_beside_the_disk_s_own_label() {
        assert_eq!(slot(SaveStatus::Saved, None).shown_age(), Some("2m ago"));
        assert_eq!(
            slot(SaveStatus::Saved, Some(Overleaf::Manual)).shown_age(),
            Some("2m ago")
        );
        assert_eq!(
            slot(SaveStatus::Saved, Some(Overleaf::Live)).shown_age(),
            None
        );
        assert_eq!(slot(SaveStatus::Saving, None).shown_age(), None);
        let mut unsaved = slot(SaveStatus::Saved, None);
        unsaved.age = None;
        assert_eq!(unsaved.shown_age(), None);
    }

    #[test]
    fn a_manual_link_offers_sync_now_and_a_paused_one_says_how_to_resume() {
        let manual = slot(SaveStatus::Saved, Some(Overleaf::Manual)).details();
        assert_eq!(manual.rows[0].value.as_ref(), "Saved 2m ago");
        assert_eq!(manual.rows[1].value.as_ref(), "Synced 4m ago");
        assert_eq!(manual.actions, [SlotAction::SyncNow]);
        let paused = slot(SaveStatus::Saved, Some(Overleaf::Paused)).details();
        assert_eq!(paused.rows[1].value.as_ref(), "Sync paused");
        assert!(paused.rows[1].note.is_some());
        assert!(paused.actions.is_empty());
        let unlinked = slot(SaveStatus::Saved, None).details();
        assert_eq!(unlinked.rows.len(), 1);
    }
}
