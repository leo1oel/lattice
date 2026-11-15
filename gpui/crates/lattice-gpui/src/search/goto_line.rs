//! Go to line (⌘G, `src/editor/goto-line-dialog.tsx`, `.goto-line-modal`):
//! a 420px dialog titled Go to line, its Line field beside "of N", the
//! caret's line selected in it so a typed number replaces it, Enter or Go
//! going there clamped to the document's lines, Cancel or ⎋ closing.

use gpui::{
    AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Button, Field, LayerPlacement, ModalLayer, rise_in},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR, RADIUS_DIALOG},
};

/// What the dialog asks of the window.
pub enum GotoLineEvent {
    Go(u32),
    Close,
}

pub struct GotoLineDialog {
    field: Entity<InputState>,
    max_line: u32,
    _enter: Subscription,
}

impl EventEmitter<GotoLineEvent> for GotoLineDialog {}

impl GotoLineDialog {
    /// Over a document of `max_line` lines, the caret on `line`.
    pub fn new(line: u32, max_line: u32, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = cx.new(|cx| {
            let mut input = InputState::new(window, cx).default_value(line.to_string());
            input.select_all(window, cx);
            input
        });
        let enter = cx.subscribe(&field, |this, _, event, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.submit(cx);
            }
        });
        Self {
            field,
            max_line: max_line.max(1),
            _enter: enter,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let value = self.field.read(cx).value().to_string();
        if let Some(line) = target_line(&value, self.max_line) {
            cx.emit(GotoLineEvent::Go(line));
        }
    }
}

/// The line a typed value goes to: rounded and clamped to `1..=max_line`,
/// or none for what is not a number (`Number(value)` in the Tauri app).
fn target_line(value: &str, max_line: u32) -> Option<u32> {
    let value = value.trim();
    let number: f64 = if value.is_empty() {
        0.
    } else {
        value.parse().ok()?
    };
    if !number.is_finite() {
        return None;
    }
    Some((number.round().max(1.) as u32).min(max_line.max(1)))
}

impl Render for GotoLineDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(420.).min(window.viewport_size().width - px(40.));
        let card = div()
            .w(width)
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .child(
                div()
                    .mb(px(4.))
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(t!("Go to line")),
            )
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text)
                    .child(t!("Line"))
                    // The range stands beside the field ("of 340").
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(div().flex_1().min_w_0().child(Field::new(&self.field)))
                            .child(
                                div()
                                    .flex_none()
                                    .font_weight(FONT_WEIGHT_REGULAR)
                                    .text_color(palette.text_secondary)
                                    .child(t!("of {maxLine}", maxLine = self.max_line)),
                            ),
                    ),
            )
            .child(
                div()
                    .mt(px(24.))
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        Button::new("goto-line-cancel", t!("Cancel"))
                            .ghost()
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(GotoLineEvent::Close))),
                    )
                    .child(
                        Button::new("goto-line-go", t!("Go"))
                            .primary()
                            .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
                    ),
            );
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "goto-line",
            LayerPlacement::UpperThird,
            rise_in("goto-line-rise", card),
            move |_, cx| {
                this.update(cx, |_, cx| cx.emit(GotoLineEvent::Close)).ok();
            },
        )
        .initial_focus(gpui::Focusable::focus_handle(self.field.read(cx), cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_line_is_rounded_and_kept_within_the_document() {
        // `Math.min(maxLine, Math.max(1, Math.round(Number(value))))`.
        assert_eq!(target_line("12", 40), Some(12));
        assert_eq!(target_line(" 3.6 ", 40), Some(4));
        assert_eq!(target_line("900", 40), Some(40));
        assert_eq!(target_line("0", 40), Some(1));
        assert_eq!(target_line("-5", 40), Some(1));
        // `Number("")` is 0, which goes to the first line.
        assert_eq!(target_line("", 40), Some(1));
        assert_eq!(target_line("twelve", 40), None);
    }
}
