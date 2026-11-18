//! The frame Find and Replace in project stand in: the app's `SheetDialog`
//! (`.modal.sheet-dialog`, `src/styles/dialogs.css`), Settings' size (860 ×
//! 640, the window less 20px a side), 14px corners on the lift at the
//! dialog level, centred over the dialog scrim. Its 40px header holds the
//! sheet's 16px icon, its title and the X over a hairline; the content
//! stands 14px in with 12px between its parts; actions, when it has them,
//! sit at the foot over a hairline. It rises in on the slow tier, as every
//! dialog does. ⎋ and a press on the scrim close it (a sheet holding
//! unsaved input keeps the scrim press, as the app's `dirty` does).

use gpui::{
    AnyElement, App, ElementId, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, ParentElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, TrapFocus as _, rise_in},
    icons::ICON_LARGE,
    tokens::CONTAINER_DIALOG_LARGE,
};

/// The sheet's content inset (`--drawer-content-inset`).
pub const INSET: f32 = 14.;

/// The sheet's width in this window: Settings' size, the window less 20px
/// a side.
fn sheet_width(window: &Window) -> gpui::Pixels {
    CONTAINER_DIALOG_LARGE
        .to_pixels(window.rem_size())
        .min(window.viewport_size().width - px(40.))
}

/// How wide the sheet's content is, inside its inset: what a container
/// query on the sheet measures.
pub fn body_width(window: &Window) -> f32 {
    f32::from(sheet_width(window)) - 2. * INSET
}

pub struct SheetFrame {
    pub id: &'static str,
    pub icon: Icon,
    pub title: &'static str,
    pub body: Vec<AnyElement>,
    pub actions: Vec<AnyElement>,
    /// A press on the scrim closes it too.
    pub scrim_closes: bool,
}

impl SheetFrame {
    pub fn render(
        self,
        window: &mut Window,
        cx: &mut App,
        on_close: impl Fn(&mut Window, &mut App) + Clone + 'static,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = sheet_width(window);
        let height = px(640.).min(viewport.height - px(40.));
        let child = |name: &'static str| ElementId::Name(format!("{}-{name}", self.id).into());
        let close_x = on_close.clone();
        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .h(px(40.))
            .pl(px(INSET))
            .pr(px(8.))
            .border_b_1()
            .border_color(palette.line)
            .child(self.icon.element(ICON_LARGE, palette.text))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .child(self.title),
            )
            .child(
                IconButton::new(child("close"), Icon::CLOSE)
                    .frame(px(24.), px(24.))
                    .tooltip("Close")
                    .on_click(move |_, window, cx| close_x(window, cx)),
            );
        let card = div()
            .id(child("card"))
            .w(width)
            .h(height)
            .flex()
            .flex_col()
            .rounded(px(14.))
            .overflow_hidden()
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .p(px(INSET))
                    .children(self.body),
            )
            .when(!self.actions.is_empty(), |card| {
                card.child(
                    div()
                        .flex()
                        .flex_none()
                        .justify_end()
                        .gap(px(8.))
                        .px(px(INSET))
                        .pt(px(12.))
                        .pb(px(INSET))
                        .border_t_1()
                        .border_color(palette.line)
                        .children(self.actions),
                )
            });
        let close_key = on_close.clone();
        let close_scrim = on_close;
        let scrim_closes = self.scrim_closes;
        // The fence Tab stays inside. Its handle is the sheet's own, never
        // focused itself: the trap holds whenever focus is anywhere in the
        // sheet, which is where its owner puts it (a field, or its own handle
        // on the wrapper around this frame).
        let trap = window
            .use_keyed_state(child("trap"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        lattice_ui::components::claim_focus_on_open(child("claim"), &trap, window, cx);
        div()
            .id(child("scrim"))
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(scrim(&palette))
            .occlude()
            .trap_focus(child("trap-scope"), &trap)
            .capture_key_down(move |event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    close_key(window, cx);
                }
            })
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                if scrim_closes {
                    close_scrim(window, cx);
                }
            })
            .child(rise_in(child("rise"), card))
            .into_any_element()
    }
}

fn scrim(palette: &lattice_ui::Palette) -> Hsla {
    palette.scrim
}
