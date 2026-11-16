//! Track changes in the PDF panel (`src/canvas/project-pdf-panel.tsx`): while
//! the PDF with the changes marked builds, the "Marking changes…" pill in
//! the live preview's place at the bottom left of the pages, its dot
//! pulsing; when one could not be made, the reason over the pages, which
//! show the paper as it is now. The marked PDF itself is opened as any PDF
//! is (`shell/review_mode_flow.rs`).

use gpui::{
    Animation, AnimationExt as _, AnyElement, Context, IntoElement, ParentElement as _,
    SharedString, Styled as _, div, ease_in_out, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    motion::Motion,
    tokens::{RADIUS_CONTROL, SPACING_2, SPACING_3, SPACING_5, SPACING_6},
};

use super::PdfPanel;

/// What the panel says of the marked PDF.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Marking {
    building: bool,
    error: Option<SharedString>,
}

impl PdfPanel {
    /// The marked PDF is building, or could not be made (`error`).
    pub fn set_marking(
        &mut self,
        building: bool,
        error: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        let marking = Marking { building, error };
        if self.marking != marking {
            self.marking = marking;
            cx.notify();
        }
    }

    /// The marked PDF could not be made: the paper's own shows, with why.
    pub fn marking_failed(&self) -> bool {
        self.marking.error.is_some()
    }

    /// The reason over the pages (an `InlineMessage` at the warning level).
    pub(super) fn marking_message(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let error = self.marking.error.clone()?;
        let palette = cx.palette().clone();
        let text = format!(
            "{} {error}",
            t!(
                "The changes could not be marked in the PDF, so it shows the paper as it is now: edits included, without marks."
            )
        );
        Some(
            div()
                .flex_none()
                .mx(px(12.))
                .mt(px(8.))
                .flex()
                .items_start()
                .gap(px(6.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(
                    div()
                        .flex_none()
                        .h(px(16.))
                        .flex()
                        .items_center()
                        .child(Icon::CIRCLE_ALERT.element(px(13.), palette.warning)),
                )
                .child(div().min_w_0().flex_1().whitespace_normal().child(text))
                .into_any_element(),
        )
    }

    /// The pill while the marked PDF builds: the live preview's own, which
    /// a marked PDF never shows beside (`review-pdf-status`).
    pub(super) fn marking_pill(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if !self.marking.building {
            return None;
        }
        let palette = cx.palette().clone();
        let dot = div()
            .flex_none()
            .size(SPACING_3)
            .rounded_full()
            .bg(palette.text_secondary)
            .with_animation(
                "review-pdf-pulse",
                Animation::new(Motion::Flourish.duration() * 2).repeat(),
                |dot, delta| {
                    let half = if delta <= 0.5 {
                        delta * 2.
                    } else {
                        2. - delta * 2.
                    };
                    dot.opacity(1. - 0.65 * ease_in_out(half))
                },
            );
        Some(
            div()
                .absolute()
                .left(SPACING_6)
                .right(SPACING_6)
                .bottom(SPACING_6)
                .flex()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(SPACING_3)
                        .max_w_full()
                        .px(SPACING_5)
                        .py(SPACING_2)
                        .rounded(RADIUS_CONTROL)
                        .bg(palette.raised)
                        .shadow(Elevation::Popover.shadows(&palette))
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .whitespace_nowrap()
                        .children(lattice_ui::parity::probe("review-pdf-status"))
                        .child(dot)
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(t!("Marking changes…")),
                        ),
                )
                .into_any_element(),
        )
    }
}
