//! The window's side of the Overleaf collaboration panel
//! (`overleaf::collab`): the titlebar's comments button beside the Overleaf
//! control, with what is waiting (open threads and the open file's
//! suggestions); the panel in the workspace's "comments" view; a comment's
//! passage shown in its file; and "Annotate selection", the Tauri app's
//! selection toolbar's Annotate, which starts a thread on the selection of a
//! file live with Overleaf.

use gpui::{AnyElement, Context, IntoElement, Window, actions};
use lattice_i18n::t;
use lattice_ui::{Icon, components::IconButton, components::Surface};

use super::Shell;
use crate::overleaf::collab::{CollabEvent, CollabTab};

actions!(
    lattice,
    [
        AnnotateSelection,
        MarginReviewAuto,
        MarginReviewMarkers,
        MarginReviewOff
    ]
);

impl Shell {
    /// The comments button, for a linked project.
    pub(super) fn overleaf_collab_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let bridge = self.overleaf.read(cx);
        bridge.link()?;
        let threads = bridge
            .threads()
            .iter()
            .filter(|thread| !thread.resolved)
            .count();
        let changes = self
            .active_editor()
            .and_then(|editor| bridge.live_review(editor.read(cx).relative()))
            .map_or(0, |review| review.changes.len());
        let waiting = threads + changes;
        let tooltip = if waiting > 0 {
            t!(
                "Overleaf comments and chat, {count} waiting",
                count = waiting
            )
            .to_string()
        } else {
            t!("Overleaf comments and chat").to_string()
        };
        let mut button = IconButton::new("titlebar-overleaf-collab", Icon::MESSAGE_SQUARE_TEXT)
            .surface(Surface::Titlebar)
            .on(waiting > 0)
            .tooltip(tooltip)
            .on_click(
                cx.listener(|this, _, window, cx| this.open_overleaf_collab(None, window, cx)),
            );
        if waiting > 0 {
            button = button.badge(waiting.to_string());
        }
        Some(button.into_any_element())
    }

    /// Bring the panel on screen, on `tab` when given.
    pub(crate) fn open_overleaf_collab(
        &mut self,
        tab: Option<CollabTab>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(tab) = tab {
            self.overleaf_collab
                .update(cx, |panel, cx| panel.set_tab(tab, cx));
        }
        self.reveal_tool("comments", window, cx);
    }

    /// What the panel asked of the window.
    pub(super) fn on_collab_event(
        &mut self,
        event: &CollabEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let CollabEvent::Reveal { path, position } = event;
        let Some(root) = self.root(cx) else {
            return;
        };
        let text = lattice_core::project::read_file(&root, path).unwrap_or_default();
        let units: Vec<u16> = text.encode_utf16().collect();
        let before =
            String::from_utf16_lossy(&units[..(*position).max(0).min(units.len() as i64) as usize]);
        let line = before.matches('\n').count() as u32 + 1;
        self.open_path(root.join(path), Some(line), window, cx);
    }

    /// Start a thread on the selection, in a file live with Overleaf.
    pub(crate) fn annotate_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        let path = editor.read(cx).relative().to_string();
        if self.overleaf.read(cx).live_file() != Some(path.as_str()) {
            crate::notices::show(
                crate::notices::Notice::new(
                    lattice_ui::components::ToastLevel::Info,
                    t!("Comments go to Overleaf once this file is open live with it."),
                ),
                cx,
            );
            return;
        }
        let Some((from, quote)) = editor.read(cx).overleaf_selection(cx) else {
            return;
        };
        self.overleaf_collab.update(cx, |panel, cx| {
            panel.compose_comment(path, from, quote, window, cx)
        });
        self.reveal_tool("comments", window, cx);
    }
}
