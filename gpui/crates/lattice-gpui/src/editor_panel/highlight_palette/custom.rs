//! The highlight palette's custom colour view (`highlight-palette.tsx`'s
//! `view === "custom"`, around `ColorPicker`): back to the highlighters;
//! the selection set on white paper in the reading serif under the draft,
//! as the PDF prints it in either theme; whether the paper's black ink reads
//! on it, with the ratio, and Lighten when it does not; the picker's field,
//! hue strip, eyedropper and hex row (`lattice_ui::components::ColorPicker`);
//! the colours this document uses, the writer's own and the paper tones;
//! and Cancel and Highlight ↵. The draft is applied once, by Highlight or
//! Return, since a highlight writes LaTeX source.

use gpui::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, StatefulInteractiveElement as _, Styled as _, Subscription,
    Window, div, prelude::FluentBuilder as _, px, rgb,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Appearance, Icon, TextRole, TextRoleStyle as _,
    accent_fit::{contrast_ratio, fit_contrast},
    color,
    components::{Button, ColorPicker, ColorPickerEvent, SwatchGrid},
    tokens::{SPACING_2, SPACING_4, SPACING_5},
};

use super::{PAPER_INK, PAPER_TONES, READABLE, is_hex, prefs};
use crate::editor_panel::{EditorPanel, selection_toolbar::ToolbarAction};

/// The contrast Lighten fits a too-dark colour to (`LIGHTENED`).
const LIGHTENED: f64 = 9.;
/// The picker's width (`.color-picker`).
pub(super) const WIDTH: f32 = lattice_ui::components::PICKER_WIDTH;

/// The custom view's picker, while it is open.
pub(super) struct Custom {
    picker: Entity<ColorPicker>,
    _events: Subscription,
}

impl EditorPanel {
    /// Open the custom view on the highlight around the selection, or the
    /// pen's colour.
    pub(in crate::editor_panel) fn open_custom(
        &mut self,
        current: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let start = current
            .filter(|hex| is_hex(hex))
            .unwrap_or_else(|| prefs(cx).last.clone());
        let picker = cx.new(|cx| {
            let picker = ColorPicker::new(&start, window, cx);
            if crate::screen_color::available() {
                picker
            } else {
                picker.without_eyedropper()
            }
        });
        let events = cx.subscribe_in(
            &picker,
            window,
            |this, picker, event, window, cx| match event {
                ColorPickerEvent::Confirm(hex) => {
                    this.toolbar_action(ToolbarAction::Highlight(hex.clone()), window, cx)
                }
                ColorPickerEvent::Change(_) => cx.notify(),
                ColorPickerEvent::Sample => {
                    let sampled = crate::screen_color::sample();
                    let picker = picker.downgrade();
                    cx.spawn_in(window, async move |_, cx| {
                        if let Ok(Some(hex)) = sampled.await {
                            let _ = picker.update_in(cx, |picker, window, cx| {
                                picker.set_hex(&hex, window, cx)
                            });
                        }
                    })
                    .detach();
                }
            },
        );
        self.toolbar.palette.custom = Some(Custom {
            picker,
            _events: events,
        });
        cx.notify();
    }

    /// The custom view's picker while it is open, for scripted runs.
    pub fn custom_picker(&self) -> Option<Entity<ColorPicker>> {
        self.toolbar
            .palette
            .custom
            .as_ref()
            .map(|custom| custom.picker.clone())
    }
}

/// How black ink reads on `hex`: its ratio, and the colour Lighten would
/// take when it is under [`READABLE`].
fn legibility(hex: &str) -> (f64, Option<String>) {
    let value = color::hex_value(hex).unwrap_or(0xFFFFFF);
    let ratio = contrast_ratio(value, PAPER_INK);
    let fix = (ratio < f64::from(READABLE)).then(|| {
        color::hex_of(fit_contrast(
            value,
            &[PAPER_INK],
            LIGHTENED,
            Appearance::Dark,
        ))
    });
    (ratio, fix)
}

/// The custom view: everything under the palette's back row.
pub(super) fn view(
    custom: &Custom,
    sample: String,
    document: Vec<String>,
    window: &mut Window,
    cx: &mut Context<EditorPanel>,
) -> AnyElement {
    let _ = window;
    let palette = cx.palette().clone();
    let picker = custom.picker.clone();
    let draft = picker.read(cx).hex(cx);
    let invalid = picker.read(cx).invalid(cx);
    let shown = draft
        .clone()
        .unwrap_or_else(|| color::hsv_hex(picker.read(cx).hsv()));
    let sample = {
        let text = sample.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            t!("Highlighted text").to_string()
        } else {
            text.chars().take(64).collect()
        }
    };
    let ink = rgb(PAPER_INK);
    let display = cx.lattice().fonts.display.clone();
    let preview = div()
        .min_h(px(52.))
        .py(SPACING_4)
        .px(SPACING_5)
        .rounded(px(6.))
        .bg(rgb(0xFFFFFF))
        .border_1()
        .border_color(gpui::Hsla::from(ink).opacity(0.1))
        .text_role(TextRole::Typeset, cx)
        .font_family(display)
        .text_color(ink)
        // The `<mark>`: the words' own width, not the line's.
        .child(
            div().flex().items_start().child(
                div()
                    .py(px(1.))
                    .px(px(2.))
                    .rounded(px(2.))
                    .bg(super::hex_color(&shown))
                    .child(sample),
            ),
        );
    let (ratio, fix) = legibility(&shown);
    let readable = fix.is_none();
    let verdict = div()
        .min_h(px(20.))
        .mt(px(-4.))
        .flex()
        .items_center()
        .gap(SPACING_2)
        .text_role(TextRole::Micro, cx)
        .text_color(if readable {
            palette.text_secondary
        } else {
            palette.warning
        })
        .child(if readable {
            Icon::CHECK.element(px(12.), palette.success)
        } else {
            Icon::TRIANGLE_ALERT.element(px(12.), palette.warning)
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .flex()
                .items_center()
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(if readable {
                            t!("Black text reads clearly")
                        } else {
                            t!("Too dark for black text")
                        }),
                )
                .child(
                    div()
                        .flex_none()
                        .ml(SPACING_2)
                        .text_color(palette.line_number)
                        .child(format!("{ratio:.1}:1")),
                ),
        )
        .when_some(fix, |this, fix| {
            let picker = picker.clone();
            this.child(
                div()
                    .id("highlight-lighten")
                    .h(px(20.))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .rounded(px(4.))
                    .bg(palette.warning_soft)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .cursor_pointer()
                    .child(t!("Lighten"))
                    .on_click(move |_, window, cx| {
                        picker.update(cx, |picker, cx| picker.set_hex(&fix, window, cx))
                    }),
            )
        });
    let prefs = prefs(cx).clone();
    let grid = |id: &'static str, label: &str, colors: Vec<String>| {
        let picker = picker.clone();
        (!colors.is_empty()).then(|| {
            SwatchGrid::new(
                id,
                label.to_string(),
                colors,
                draft.clone(),
                move |hex, window, cx| {
                    picker.update(cx, |picker, cx| picker.set_hex(hex, window, cx))
                },
            )
        })
    };
    let confirm = picker.clone();
    let footer = div()
        .mx(px(-8.))
        .p(SPACING_4)
        .border_t_1()
        .border_color(palette.line)
        .flex()
        .justify_end()
        .gap(px(6.))
        .child(
            Button::new("highlight-custom-cancel", t!("Cancel"))
                .ghost()
                .compact()
                // The palette closes; the toolbar stays (`onCancel`).
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toolbar.menu = None;
                    this.toolbar.palette.custom = None;
                    window.focus(&this.editor.focus_handle(cx), cx);
                    cx.notify();
                })),
        )
        .child(
            Button::new("highlight-custom-apply", t!("Highlight"))
                .primary()
                .compact()
                .trailing_icon(Icon::CORNER_DOWN_LEFT)
                .disabled(invalid)
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(hex) = confirm.read(cx).hex(cx) {
                        this.toolbar_action(ToolbarAction::Highlight(hex), window, cx);
                    }
                })),
        );
    div()
        .w(px(WIDTH))
        .px(SPACING_4)
        .pt(SPACING_4)
        .flex()
        .flex_col()
        .gap(SPACING_4)
        .child(preview)
        .child(verdict)
        .child(picker.clone())
        .children(grid(
            "highlight-swatches-document",
            t!("In this document"),
            document.into_iter().take(8).collect(),
        ))
        .children(grid(
            "highlight-swatches-yours",
            t!("Your colours"),
            prefs.custom,
        ))
        .children(grid(
            "highlight-swatches-paper",
            t!("Paper tones"),
            PAPER_TONES.iter().map(|hex| hex.to_string()).collect(),
        ))
        .child(footer)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::legibility;

    // WCAG's 4.5:1 for body text is the line: the default highlighter reads
    // well over it, and a mid grey does not and is offered a lighter one
    // that reads at about 9:1.
    #[test]
    fn a_too_dark_colour_is_offered_a_lighter_one() {
        let (ratio, fix) = legibility("#FFF1A6");
        assert!(ratio > 11. && fix.is_none(), "{ratio}");
        let (ratio, fix) = legibility("#777777");
        assert!(ratio < 4.5, "{ratio}");
        let fix = fix.expect("a lighter grey");
        let (lightened, again) = legibility(&fix);
        assert!(lightened >= 8.9 && again.is_none(), "{fix} at {lightened}");
    }
}
