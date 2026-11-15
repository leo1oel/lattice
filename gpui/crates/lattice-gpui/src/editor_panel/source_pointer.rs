//! The source editor's pointer beyond Zed's own: a ⌘-click (Ctrl-click off
//! macOS) on a label, citation key, `\input` or figure goes to its
//! definition (`definition.rs`), as the Tauri app's editor's click handler
//! does, and a right-click opens the editing menu.
//!
//! Right-click in the Tauri app is WebKit's own menu over the text: Cut,
//! Copy and Paste, which the GPUI app draws as its own menu with Select All,
//! the editing items of that menu, in the macOS menu bar's words (Zed's menu needs a Zed project, so it
//! never opens here). A right-click outside the selection puts the caret at
//! the pointer first, as WebKit's does.

use editor::{
    MultiBufferOffset, SelectionEffects, ToOffset as _,
    actions::{Copy, Cut, Paste, SelectAll},
};
use gpui::{
    Context, Div, Focusable as _, InteractiveElement as _, MouseButton, MouseDownEvent,
    ParentElement as _, Stateful, Window,
};
use lattice_i18n::tc;
use lattice_ui::components::{ContextMenu, MenuAction};

use super::EditorPanel;

impl EditorPanel {
    /// The source's ⌘-click and right-click, on its element.
    pub(super) fn source_pointer(
        &self,
        element: Stateful<Div>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let menu = ContextMenu::<()>::keyed("editor-source-menu", window, cx);
        let opener = menu.clone();
        let editor = self.editor().clone();
        element
            .capture_any_mouse_down(
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    let at = event.position;
                    match event.button {
                        MouseButton::Left
                            if event.modifiers.secondary(cx) && event.click_count == 1 =>
                        {
                            let offset = this
                                .lattice
                                .update(cx, |lattice, cx| lattice.character_at(at, window, cx));
                            if let Some(offset) = offset
                                && this.go_to_definition(offset, cx)
                            {
                                cx.stop_propagation();
                            }
                        }
                        MouseButton::Right => {
                            cx.stop_propagation();
                            this.caret_to_pointer(at, window, cx);
                            opener.update(cx, |menu, cx| menu.open(at, (), window, cx));
                        }
                        _ => {}
                    }
                }),
            )
            .children(ContextMenu::layer(
                &menu,
                window,
                cx,
                move |menu, _, _, cx| {
                    let focus = editor.focus_handle(cx);
                    let text = editor.read(cx);
                    let snapshot = text.buffer().read(cx).snapshot(cx);
                    let selection = text.selections.newest_anchor();
                    let selected =
                        selection.start.to_offset(&snapshot) != selection.end.to_offset(&snapshot);
                    menu.item(
                        MenuAction::dispatch_on(
                            tc!("macOS menu bar", "Cut"),
                            Box::new(Cut),
                            focus.clone(),
                        )
                        .disabled(!selected),
                    )
                    .item(
                        MenuAction::dispatch_on(
                            tc!("macOS menu bar", "Copy"),
                            Box::new(Copy),
                            focus.clone(),
                        )
                        .disabled(!selected),
                    )
                    .item(MenuAction::dispatch_on(
                        tc!("macOS menu bar", "Paste"),
                        Box::new(Paste),
                        focus.clone(),
                    ))
                    .separator()
                    .item(MenuAction::dispatch_on(
                        tc!("macOS menu bar", "Select All"),
                        Box::new(SelectAll),
                        focus,
                    ))
                },
            ))
    }

    /// A right-click outside the selection puts the caret under the pointer.
    fn caret_to_pointer(
        &mut self,
        at: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(offset) = self
            .lattice
            .update(cx, |lattice, cx| lattice.character_at(at, window, cx))
        else {
            return;
        };
        let editor = self.editor().clone();
        editor.update(cx, |editor, cx| {
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let selection = editor.selections.newest_anchor();
            let (start, end) = (
                selection.start.to_offset(&snapshot).0,
                selection.end.to_offset(&snapshot).0,
            );
            if !(start..=end).contains(&offset) {
                editor.change_selections(SelectionEffects::no_scroll(), window, cx, |selections| {
                    selections.select_ranges([MultiBufferOffset(offset)..MultiBufferOffset(offset)])
                });
            }
        });
        let focus = self.editor().focus_handle(cx);
        window.focus(&focus, cx);
    }
}
