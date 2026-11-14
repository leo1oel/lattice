//! Saving the window's open editors: before the window closes or another
//! project takes its place (held until every save lands, kept open when one
//! cannot), and ⌘S, which saves and builds as the Tauri app's "Save and
//! build" does.

use gpui::{Context, Entity, Task, Window};

use super::{Save, Shell, build::BuildRequest};
use crate::editor_panel::EditorPanel;

impl Shell {
    /// The window is closing: unsaved edits are saved first, and the window
    /// closes once they are, staying open (with the save's notice) when one
    /// could not be.
    pub(super) fn should_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.overlay_writing(cx) {
            return false;
        }
        let Some(saved) = self.save_before_leaving(cx) else {
            return true;
        };
        cx.spawn_in(window, async move |this, cx| {
            if saved.await
                && !this
                    .read_with(cx, |this, cx| this.overlay_writing(cx))
                    .unwrap_or(false)
            {
                cx.update(|window, _| window.remove_window()).ok();
            }
        })
        .detach();
        false
    }

    /// Save every editor holding unsaved edits: `None` when none does, else
    /// a task that resolves true once each is saved, false when one could
    /// not be (its notice says why).
    pub(super) fn save_before_leaving(&mut self, cx: &mut Context<Self>) -> Option<Task<bool>> {
        let saves = Self::save_dirty(&self.open_editors(), cx);
        if saves.is_empty() {
            return None;
        }
        Some(cx.spawn(async move |_, _| {
            for save in saves {
                match save.await {
                    Ok(true) => {}
                    Ok(false) => return false,
                    Err(error) => {
                        log::error!("{error:#}");
                        return false;
                    }
                }
            }
            true
        }))
    }

    /// Close the window as its close button does (`should_close`).
    pub(crate) fn close_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.should_close(window, cx) {
            window.remove_window();
        }
    }

    /// Start saving each of `editors` that holds unsaved edits.
    pub(super) fn save_dirty(
        editors: &[Entity<EditorPanel>],
        cx: &mut Context<Self>,
    ) -> Vec<Task<anyhow::Result<bool>>> {
        let dirty: Vec<_> = editors
            .iter()
            .filter(|editor| editor.read(cx).is_dirty(cx))
            .cloned()
            .collect();
        dirty
            .into_iter()
            .map(|editor| editor.update(cx, |editor, cx| editor.save(cx)))
            .collect()
    }

    /// Save what the editors hold, answering whether every write landed.
    pub(super) fn save_editors(&mut self, cx: &mut Context<Self>) -> Task<bool> {
        let saves = Self::save_dirty(&self.open_editors(), cx);
        cx.spawn(async move |_, _| {
            for save in saves {
                match save.await {
                    Ok(true) => {}
                    Ok(false) => return false,
                    Err(error) => {
                        log::error!("{error:#}");
                        return false;
                    }
                }
            }
            true
        })
    }

    pub(super) fn save_in_background(&mut self, cx: &mut Context<Self>) {
        let editors = self.open_editors();
        for save in Self::save_dirty(&editors, cx) {
            cx.spawn(async move |_, _| {
                if let Err(error) = save.await {
                    log::error!("{error:#}");
                }
            })
            .detach();
        }
    }

    /// ⌘S: save, then build, as the Tauri app's "Save and build" does; only
    /// a save when there is no document to build. A build under way queues
    /// the next one, which would save only once it starts, so the save is
    /// made now.
    pub(super) fn save_all(&mut self, _: &Save, window: &mut Window, cx: &mut Context<Self>) {
        let build = self.has_document(cx);
        if !build || self.build_task.is_some() {
            self.save_in_background(cx);
        }
        if build {
            self.run_build(BuildRequest::requested(), window, cx);
        }
    }
}
