//! The window's own layers over the workspace, and how they stack.
//!
//! They draw deferred, on gpui-fast's overlay surface, so a webview island
//! (a native view between GPUI's base content and its overlays) never
//! covers them: the palette, the shortcut sheet, quick open and find in
//! project, Settings, the welcome flow's dialogs and, above them all, the
//! toasts.
//! (Dialogs built on `ModalLayer` defer themselves.)

use gpui::{AnyElement, IntoElement as _, deferred};

use super::Shell;

/// The deferred draw priorities of the window's own layers, beside GPUI
/// Kit's (its dialogs from 10, popups 100, tooltips 200): a webview island's
/// chrome (its zoom controls and scrollbar) at 0, the floating panels above
/// it, the window's dialogs with Kit's, and the toasts above the dialogs,
/// as the Tauri app stacks them.
pub(crate) const FLOATING_PRIORITY: usize = 5;
pub(super) const OVERLAY_PRIORITY: usize = 10;
pub(super) const TOAST_PRIORITY: usize = 50;

impl Shell {
    /// The window's overlays, each deferred at its priority.
    pub(super) fn window_overlays(&self) -> Vec<AnyElement> {
        let mut overlays: Vec<AnyElement> = Vec::new();
        let dialogs = self
            .palette
            .clone()
            .map(|palette| palette.into_any_element())
            .into_iter()
            .chain(self.shortcuts.clone().map(|sheet| sheet.into_any_element()))
            .chain(self.settings.clone().map(|settings| settings.into_any_element()))
            .chain(self.document_overlays())
            .chain(self.lobby_dialogs());
        for dialog in dialogs {
            overlays.push(
                deferred(dialog)
                    .with_priority(OVERLAY_PRIORITY)
                    .into_any_element(),
            );
        }
        overlays.push(
            deferred(self.notices.clone().into_any_element())
                .with_priority(TOAST_PRIORITY)
                .into_any_element(),
        );
        overlays
    }
}
