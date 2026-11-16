//! The window's side of the Revision rounds sheet
//! (`crate::annotations::rounds_sheet`): opened from the Annotations panel
//! and from the round saved notice's Compare (`RoundsEvent::OpenRounds`), its
//! Open in History shows the round's entry, and its restore runs here, as
//! the Tauri app's `AnnotationRounds.restore` does: the open files' edits
//! saved first, the files written as one entry of the project's history
//! (lattice-core's `apply_annotation_restore`), then the project brought up
//! to date as after any restore.

use gpui::{AnyElement, AppContext as _, Context, Entity, IntoElement as _, Subscription, Window};
use lattice_i18n::t;

use super::{
    Shell,
    parts::{Part, no_commands},
};
use crate::annotations::{
    rounds_sheet::{RoundsSheet, RoundsSheetEvent},
    store,
};

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(SheetFlow::default()),
    views: &[],
    actions: |element, _| element,
    commands: no_commands,
};

#[derive(Default)]
pub(crate) struct SheetFlow {
    sheet: Option<(Entity<RoundsSheet>, Subscription)>,
}

impl Shell {
    /// Show the Revision rounds sheet over the project's rounds.
    pub(super) fn open_rounds_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let notes = store::try_store(cx)
            .and_then(|store| store.read(cx).notes(&root).cloned())
            .unwrap_or_default();
        let linked = self.overleaf.read(cx).link().is_some();
        let rounds = self.annotation_rounds();
        let source_root = root.clone();
        let sheet = cx.new(|cx| {
            RoundsSheet::new(
                root,
                &notes.rounds,
                notes.annotations,
                linked,
                move |path, cx| rounds.read(cx).read_source(&source_root, path, cx),
                cx,
            )
        });
        let subscription = cx.subscribe_in(&sheet, window, Self::on_rounds_sheet_event);
        self.parts.get_mut::<SheetFlow>().sheet = Some((sheet, subscription));
        cx.notify();
    }

    /// The sheet, for the window to draw over everything.
    pub(super) fn rounds_sheet(&self) -> Option<AnyElement> {
        let (sheet, _) = self.parts.get::<SheetFlow>().sheet.as_ref()?;
        Some(sheet.clone().into_any_element())
    }

    /// The sheet, while it is up (for a scenario).
    pub(crate) fn rounds_sheet_entity(&self) -> Option<Entity<RoundsSheet>> {
        self.parts
            .get::<SheetFlow>()
            .sheet
            .as_ref()
            .map(|(sheet, _)| sheet.clone())
    }

    pub(super) fn rounds_sheet_open(&self) -> bool {
        self.parts.get::<SheetFlow>().sheet.is_some()
    }

    fn close_rounds_sheet(&mut self, cx: &mut Context<Self>) {
        self.parts.get_mut::<SheetFlow>().sheet = None;
        cx.notify();
    }

    fn on_rounds_sheet_event(
        &mut self,
        sheet: &Entity<RoundsSheet>,
        event: &RoundsSheetEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            RoundsSheetEvent::Close => self.close_rounds_sheet(cx),
            RoundsSheetEvent::OpenInHistory(id) => {
                self.close_rounds_sheet(cx);
                self.open_history(window, cx);
                self.history
                    .update(cx, |history, cx| history.focus_entry(id, cx));
            }
            RoundsSheetEvent::Restore { label, files } => {
                self.restore_round(sheet.clone(), label.clone(), files.clone(), window, cx)
            }
        }
    }

    /// Save the open files' edits, write `files` as one restore, and bring
    /// the project up to date; a failure stays in the sheet, saying why.
    fn restore_round(
        &mut self,
        sheet: Entity<RoundsSheet>,
        label: String,
        files: Vec<(String, String)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let saved = self.save_editors(cx);
        cx.spawn_in(window, async move |this, cx| {
            if !saved.await {
                sheet.update(cx, |sheet, cx| {
                    sheet.restore_failed(
                        t!("Save pending edits before restoring a round.").into(),
                        cx,
                    )
                });
                return;
            }
            let written = cx
                .background_executor()
                .spawn(async move {
                    lattice_core::project::apply_annotation_restore(&root, &label, files)
                })
                .await;
            this.update_in(cx, |this, window, cx| match written {
                Ok(_) => {
                    this.close_rounds_sheet(cx);
                    this.reload_after_restore(window, cx);
                }
                Err(error) => sheet.update(cx, |sheet, cx| sheet.restore_failed(error, cx)),
            })
            .ok();
        })
        .detach();
    }
}
