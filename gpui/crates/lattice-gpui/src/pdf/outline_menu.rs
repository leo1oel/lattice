//! The toolbar's Outline (`src/canvas/document-outline.tsx`): the
//! manuscript's headings in a 190px popover under the button, nested as the
//! document nests them, the section the caret is in marked; a row opens its
//! line in the editor and shows the same place in the PDF.
//!
//! Only the live PDF offers it, and only while the document in front is a
//! LaTeX source (the host sets the outline, or none).

use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::base::Popover as BasePopover;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, MenuSurface, PopFrom, pop_in},
    fluid_hover::{FluidHover, ItemKind},
    scrollbar::FluidScrollbar,
    shape,
};

use super::view::{PdfView, PdfViewEvent};
use crate::outline::Heading;

/// What the Outline lists: the headings, and the one the caret is in.
#[derive(Clone, Default)]
pub struct OutlineState {
    pub headings: Rc<[Heading]>,
    pub active: Option<usize>,
}

impl PdfView {
    /// Offer the Outline with `outline` (`None`: no Outline button).
    pub fn set_outline(&mut self, outline: Option<OutlineState>, cx: &mut Context<Self>) {
        self.outline = outline;
        cx.notify();
    }

    pub fn has_outline(&self) -> bool {
        self.outline.is_some()
    }

    pub(super) fn outline_trigger(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let outline = self.outline.clone()?;
        let view = cx.entity();
        let trigger = IconButton::new("pdf-outline", Icon::LIST_TREE)
            .frame(px(24.), px(28.))
            .tooltip(t!("Show outline"));
        Some(
            BasePopover::new("pdf-outline-popover")
                .anchor(gpui::Anchor::TopLeft)
                .offset(px(7.))
                .trigger(trigger)
                .content(move |_, window, cx| {
                    let popover = cx.entity();
                    let close = move |window: &mut Window, cx: &mut App| {
                        popover.update(cx, |state, cx| state.dismiss(window, cx));
                    };
                    pop_in(
                        "pdf-outline-card",
                        PopFrom::Above,
                        outline_card(&outline, view.clone(), close, window, cx),
                    )
                })
                .into_any_element(),
        )
    }
}

fn outline_card(
    outline: &OutlineState,
    view: gpui::Entity<PdfView>,
    close: impl Fn(&mut Window, &mut App) + Clone + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    // The rows light with the menu's one gliding fill in the accent wash
    // (`editor-workspace.css`, `.document-outline-popover`); the section the
    // caret is in keeps its own (`preserveSelection`). The list scrolls
    // under Lattice's scrollbar.
    let hover = FluidHover::new("pdf-outline-hover", window, cx)
        .fill(palette.accent_soft)
        .radius(shape::RADIUS_CHIP);
    let scroll = window
        .use_keyed_state("pdf-outline-scroll", cx, |_, _| ScrollHandle::new())
        .read(cx)
        .clone();
    let header = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .h(px(30.))
        .px(px(8.))
        .border_b_1()
        .border_color(palette.line)
        .text_role(TextRole::Micro, cx)
        .font_weight(gpui::FontWeight(650.))
        .text_color(palette.text_secondary)
        .child(Icon::LIST_TREE.element(px(13.), palette.text_secondary))
        .child(t!("Outline"));
    let body = if outline.headings.is_empty() {
        div()
            .mx(px(10.))
            .my(px(12.))
            .text_role(TextRole::Micro, cx)
            .text_color(palette.text_secondary)
            .child(t!("No sections yet"))
            .into_any_element()
    } else {
        let rows: Vec<AnyElement> = outline
            .headings
            .iter()
            .enumerate()
            .map(|(ix, heading)| {
                let active = outline.active == Some(ix);
                let quiet = heading.level >= 4;
                let (path, line) = (heading.path.clone(), heading.line);
                let view = view.clone();
                let close = close.clone();
                let accent = palette.accent;
                let row = div()
                    .id(SharedString::from(format!("pdf-outline-{ix}")))
                    .flex()
                    .items_center()
                    .min_h(px(26.))
                    .ml(px(6. * heading.depth as f32))
                    .px(px(7.))
                    .py(px(4.))
                    .rounded(px(4.))
                    .cursor_pointer()
                    .text_role(TextRole::Micro, cx)
                    .text_color(if active {
                        accent
                    } else if quiet {
                        palette.text_secondary
                    } else {
                        palette.text
                    })
                    .when(active, |row| {
                        row.bg(palette.accent_soft)
                            .font_weight(gpui::FontWeight(650.))
                    })
                    .hover(move |style| style.text_color(accent))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(heading.title.clone()),
                    )
                    .on_click(move |_, window, cx| {
                        close(window, cx);
                        let (path, line) = (path.clone(), line);
                        view.update(cx, |_, cx| cx.emit(PdfViewEvent::Outline { path, line }));
                    });
                let kind = if active {
                    ItemKind::skip()
                } else {
                    ItemKind::target()
                };
                hover.item_as(ix, kind, row)
            })
            .collect();
        div()
            .relative()
            .child(hover.highlight())
            .child(
                div()
                    .id("pdf-outline-list")
                    .max_h(px(372.))
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .py(px(4.))
                    .children(rows),
            )
            .child(FluidScrollbar::vertical("pdf-outline-scrollbar", &scroll))
            .into_any_element()
    };
    MenuSurface::new()
        .w(px(190.))
        .max_h(px(420.))
        .p(px(4.))
        .child(header)
        .child(body)
        .into_any_element()
}
