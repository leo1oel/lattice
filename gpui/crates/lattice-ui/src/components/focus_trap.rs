//! The keyboard's fence around a modal surface: while a dialog, sheet,
//! drawer or full-window picker is up, Tab and ⇧Tab cycle through its own
//! controls and never reach the window behind it, as the Tauri app's Radix
//! dialogs (`FocusScope trapped`) keep it.
//!
//! Every modal surface goes through [`TrapFocus::trap_focus`] on the element
//! that holds its focus handle: [`super::ModalLayer`] through GPUI Kit's
//! sheet host, which traps the same way, and the surfaces that draw their own
//! scrim (the palette, quick open, the shortcut sheet, the search and papers
//! sheets, the welcome flow's dialogs) directly. The trap is gpui-base's: the
//! window root (`gpui_base::Root`) takes Tab, and when focus sits inside a
//! registered trap it walks the window's tab order until it lands inside the
//! trap again, so the stops behind the surface are skipped, however many
//! there are. The innermost trap holding focus wins, so a question asked over
//! Settings fences Settings out too.

use gpui::{
    Element, ElementId, FocusHandle, InteractiveElement, ParentElement, StatefulInteractiveElement,
    Styled, Window,
};
use gpui_kit::base::FocusTrapElement as _;

/// Fence the keyboard inside a modal surface.
pub trait TrapFocus:
    InteractiveElement + ParentElement + Styled + Element + Sized + 'static
{
    /// Track `focus` on this element and confine Tab and ⇧Tab to it and
    /// what it holds while focus is inside. The surface still gives itself
    /// focus when it opens (or a field in it), and hands it back on close.
    fn trap_focus(
        self,
        id: impl Into<ElementId>,
        focus: &FocusHandle,
    ) -> impl StatefulInteractiveElement + ParentElement + Styled + Element + 'static {
        self.focus_trap(id, focus)
    }
}

impl<E: InteractiveElement + ParentElement + Styled + Element + Sized + 'static> TrapFocus for E {}

/// Once, after a modal surface first draws under `id`: when focus is not
/// inside `focus`'s element by then (its owner put it nowhere, or left it in
/// the document behind), give it `focus`, so Escape and Tab start inside, as
/// a Radix dialog takes focus when it mounts. A surface whose owner focused a
/// field in it keeps that field.
pub fn claim_focus_on_open(
    id: impl Into<ElementId>,
    focus: &FocusHandle,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    let focus = focus.clone();
    window.use_keyed_state(id, cx, |window, _| {
        window.on_next_frame(move |window, cx| {
            if !focus.contains_focused(window, cx) {
                focus.focus(window, cx);
            }
        });
    });
}

/// The trap that holds the keyboard now, the innermost one focus is inside:
/// for a check that a surface keeps it.
pub fn focus_trap_holding(window: &Window, cx: &gpui::App) -> Option<FocusHandle> {
    gpui_kit::base::active_focus_trap(window, cx)
}
