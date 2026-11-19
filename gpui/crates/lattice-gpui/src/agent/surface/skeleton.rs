//! The Agent panel's placeholder while its page starts, the Tauri app's
//! `AgentPanelSkeleton` (`src/agent/agent-panel-skeleton.tsx`, `.css`): the
//! panel the Agent opens on, a new thread, measured from the rendered
//! Synara embed. The 28px header (the thread menu and two controls), the
//! "Work on this paper" heading, its description and four suggestions
//! centred a little below the middle of the room left, the 43px pill
//! composer and the model button under it, all on the sidebar's ground in
//! the subtle and strong border inks with the sheen crossing them. A panel
//! 330px wide or more gets the suggestions' taller rows with their
//! descriptions, as Synara's own container query does. It waits on the
//! loading clock first, so a page that draws at once shows nothing.

use std::{cell::Cell, rc::Rc, time::Instant};

use gpui::{
    AnyElement, App, Div, Hsla, IntoElement, ParentElement as _, Pixels, Styled as _, Window,
    canvas, div, prelude::FluentBuilder as _, px, relative,
};
use lattice_ui::{ActiveLattice as _, reveal::loading_opacity};

use super::{SurfaceKind, SynaraSurface};

/// The suggestions' title widths (%): Polish, Revise, Proofread, Check references.
const SUGGESTIONS: [f32; 4] = [24., 26., 38., 66.];
/// From this width the suggestions take their described form.
const WIDE: f32 = 330.;

impl SynaraSurface {
    /// Since when the Agent's page has been asked to open without drawing:
    /// the skeleton stands over it meanwhile, unless the page failed.
    pub fn awaiting_page(&self) -> Option<Instant> {
        self.opening
            .filter(|_| self.kind == SurfaceKind::Agent && self.root.is_some())
    }
}

/// A bar of the skeleton: a pill `height` tall in `ink`.
fn bar(height: f32, ink: Hsla) -> Div {
    div().flex_none().h(px(height)).rounded_full().bg(ink)
}

/// The skeleton over a panel `width` wide, as last measured.
pub(super) fn agent(
    started: Instant,
    width: Rc<Cell<Pixels>>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let opacity = loading_opacity("agent-panel-skeleton", started, window, cx);
    let (subtle, strong, ground) = (palette.line, palette.line_strong, palette.side_panel);
    let wide = f32::from(width.get()) >= WIDE;
    let control = |radius: f32, w: f32| {
        div()
            .flex_none()
            .w(px(w))
            .h(px(28.))
            .rounded(px(radius))
            .bg(subtle)
    };
    let header = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .h(px(28.))
        .child(bar(10., strong).w(px(71.)).ml(px(8.)))
        .child(control(8., 65.).ml_auto())
        .child(control(8., 28.));
    let suggestion = |title: f32| {
        let tile = if wide { 32. } else { 24. };
        div()
            .flex()
            .items_center()
            .gap(px(if wide { 8. } else { 10. }))
            .h(px(if wide { 58. } else { 36. }))
            .px(px(if wide { 8. } else { 6. }))
            .border_1()
            .border_color(subtle)
            .rounded(px(8.))
            .child(div().flex_none().size(px(tile)).rounded(px(8.)).bg(subtle))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(bar(8., subtle).w(relative(title / 100.)))
                    .when(wide, |this| this.child(bar(6., subtle).w(relative(0.72)))),
            )
    };
    let description = div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .py(px(5.))
        .mb(px(if wide { 8. } else { 6. }))
        .child(bar(8., subtle).w(relative(0.92)))
        .when(!wide, |this| this.child(bar(8., subtle).w(relative(0.48))));
    let body = div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .justify_center()
        .gap(px(if wide { 8. } else { 6. }))
        .pt(px(13.))
        .px(px(4.))
        .child(
            bar(14., strong)
                .w(relative(0.72))
                .mt(px(6.))
                .mb(px(if wide { 4. } else { 6. })),
        )
        .child(description)
        .children(SUGGESTIONS.iter().map(|title| suggestion(*title)));
    let round = || div().flex_none().size(px(28.)).rounded_full().bg(subtle);
    let composer = div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(8.))
        .h(px(43.))
        .px(px(6.))
        .border_1()
        .border_color(subtle)
        .rounded_full()
        .child(round())
        .child(bar(8., subtle).w(relative(0.44)))
        .child(round().ml_auto())
        .child(round());
    let model = bar(8., subtle)
        .w(px(60.))
        .mt(px(18.))
        .mb(px(12.))
        .mr(px(20.))
        .ml_auto();
    div()
        .absolute()
        .inset_0()
        .overflow_hidden()
        .bg(ground)
        .child(
            canvas(
                move |bounds, _, _| width.set(bounds.size.width),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .pt(px(8.))
                .px(px(12.))
                .pb(px(6.))
                .opacity(opacity)
                .child(header)
                .child(body)
                .child(composer)
                .child(model)
                .children(lattice_ui::loading::sheen("agent-panel-sheen", ground, cx)),
        )
        .into_any_element()
}
