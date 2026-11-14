//! The window's own layers over the workspace, and how they stack.
//!
//! They draw deferred, on gpui-fast's overlay surface, so a webview island
//! (a native view between GPUI's base content and its overlays) never
//! covers them: the palette, the shortcut sheet, quick open and find in
//! project, Settings, the welcome flow's dialogs, the interface-size pill
//! and, above them all, the toasts.
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
    /// Whether any of the window's dialogs is up: the overlays
    /// `window_overlays` draws and the dialogs `render` draws over them.
    pub(super) fn dialog_open(&self, cx: &gpui::App) -> bool {
        self.palette.is_some()
            || self.shortcuts.is_some()
            || self.settings.is_some()
            || !self.document_overlays().is_empty()
            || !self.lobby_dialogs().is_empty()
            || !self.overleaf_overlays().is_empty()
            || self.tex_setup.read(cx).dialog_open()
            || self.conflict.is_some()
            || self.sheets.arxiv.is_some()
            || self.sheets.figures.is_some()
            || self.sheets.whats_new.is_some()
            || self.references.rename.is_some()
            || self.confirm.read(cx).is_open()
    }

    /// The window's overlays, each deferred at its priority.
    pub(super) fn window_overlays(&self) -> Vec<AnyElement> {
        let mut overlays: Vec<AnyElement> = Vec::new();
        let dialogs = self
            .palette
            .clone()
            .map(|palette| palette.into_any_element())
            .into_iter()
            .chain(self.shortcuts.clone().map(|sheet| sheet.into_any_element()))
            .chain(
                self.settings
                    .clone()
                    .map(|settings| settings.into_any_element()),
            )
            .chain(self.document_overlays())
            .chain(self.lobby_dialogs())
            .chain(self.overleaf_overlays())
            .chain(Some(self.zoom_hud.clone().into_any_element()));
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
