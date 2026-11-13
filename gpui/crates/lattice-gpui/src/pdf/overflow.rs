//! The toolbar's ⋯ menu (`src/pdf/pdf-overflow-menu.tsx`) and the fold that
//! decides what it holds.
//!
//! A narrow toolbar keeps what a reader reaches for while reading and sets
//! the rest aside in the menu, which opens on a zoom row. A typed query the
//! row has no room for folds the toolbar further (`measurePdfSearchFold`):
//! first Reveal cursor in PDF and the fit in use join the menu, then the
//! search takes the whole row until it is cleared. Nothing is ever drawn
//! over another control, and the query is never hidden.

use std::cell::Cell;

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::base::Popover as BasePopover;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, MenuItem, MenuSeparator, MenuSurface, PopFrom, pop_in},
    fluid_hover::{FluidHover, ItemKind},
    shape,
};

use super::{
    layout::{FitMode, MAX_SCALE, MIN_SCALE},
    view::{PdfView, PdfViewEvent},
};

/// What a ⋯ menu row does to the viewer.
type MenuAction = Box<dyn Fn(&mut PdfView, &mut Window, &mut Context<PdfView>)>;

/// A toolbar control's width, and the gaps the toolbar lays them out with.
const CONTROL: f32 = 24.;
const DIVIDER: f32 = 1.;
const GAP: f32 = 4.;
/// The page controls: previous, the 44px value, next, a hairline apart.
const PAGE_CONTROLS: f32 = 24. + 1. + 44. + 1. + 24.;
/// Back and forward, beside them in a wide toolbar.
const HISTORY: f32 = 6. + 24. + 1. + 24.;
/// The find field with a query: its padding and border, eight digits of the
/// query, the gap, and its match controls (Match case, Whole word, the
/// counter, previous, next, clear).
const FIELD_WITH_QUERY: f32 = 10. + 4. + 2. + 8. * 7. + 6. + (20. * 5. + 31. + 2. * 5.);

/// How far the toolbar folds: not at all, its SyncTeX and fit controls into
/// the menu, or down to the search alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fold {
    None,
    Controls,
    Search,
}

impl PdfView {
    pub(super) fn search_fold(&self) -> Fold {
        if self.find.query.is_empty() || self.document.is_none() {
            return Fold::None;
        }
        let narrow = self.narrow();
        let width = f32::from(self.width);
        let padding = if narrow { 12. } else { 16. };
        let gap = if narrow { 2. } else { 4. };
        let left = PAGE_CONTROLS + if narrow { 0. } else { HISTORY };
        let outline = if self.outline.is_some() {
            CONTROL + GAP
        } else {
            0.
        };
        let row = |controls: &[f32]| {
            controls.iter().sum::<f32>() + gap * controls.len().saturating_sub(1) as f32
        };
        // The right-hand controls kept on the row, unfolded and folded.
        let reveal: &[f32] = if self.can_reveal {
            &[CONTROL, DIVIDER]
        } else {
            &[]
        };
        let zoom: &[f32] = if narrow {
            &[]
        } else {
            &[CONTROL, 44., CONTROL, DIVIDER]
        };
        let tail: Vec<f32> = if narrow {
            vec![]
        } else {
            let action = usize::from(self.action.is_some());
            vec![CONTROL; 2 + action]
        };
        let fits: &[f32] = if narrow {
            &[CONTROL]
        } else {
            &[CONTROL, CONTROL]
        };
        let unfolded = row(&[
            zoom,
            reveal,
            fits,
            &tail,
            if narrow { &[CONTROL] } else { &[] },
        ]
        .concat());
        let folded = row(&[zoom, &tail, &[CONTROL]].concat());
        let fits_with =
            |right: f32| padding + left + GAP + outline + FIELD_WITH_QUERY + GAP + right <= width;
        if fits_with(unfolded) {
            Fold::None
        } else if fits_with(folded) {
            Fold::Controls
        } else {
            Fold::Search
        }
    }

    /// The ⋯ menu: the zoom row, then each group it stands in for.
    pub(super) fn overflow_menu(&self, fold: Fold, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity();
        let fit = self.fit;
        let shown_fit = fit.unwrap_or(FitMode::Width);
        let other_fit = match shown_fit {
            FitMode::Width => FitMode::Height,
            FitMode::Height => FitMode::Width,
        };
        let scale = self.scale;
        let can_back = self.can_go_back();
        let can_forward = self.can_go_forward();
        let can_reveal = self.can_reveal;
        let action = self.action.clone();
        let can_save = self.source.is_some();
        BasePopover::new("pdf-overflow")
            .anchor(gpui::Anchor::TopRight)
            .offset(px(6.))
            .trigger(
                IconButton::new("pdf-overflow-trigger", Icon::ELLIPSIS)
                    .frame(px(24.), px(28.))
                    .tooltip(t!("More PDF actions")),
            )
            .content(move |_, window, cx| {
                let popover = cx.entity();
                // One fill gliding between the rows, as every menu's
                // (`lattice_ui::fluid_hover`); a separator starts a section.
                let hover = FluidHover::new("pdf-overflow-hover", window, cx)
                    .fill(cx.palette().accent_soft)
                    .radius(shape::MENU.inner());
                let next_row = Cell::new(0);
                let section = Cell::new(0);
                let separator = || {
                    section.set(section.get() + 1);
                    MenuSeparator
                };
                let row = |kind: ItemKind, item: MenuItem| {
                    let ix = next_row.get();
                    next_row.set(ix + 1);
                    hover.item_as(ix, kind.section(section.get()), item.fluid())
                };
                let close = move |window: &mut Window, cx: &mut App| {
                    popover.update(cx, |state, cx| state.dismiss(window, cx));
                };
                let item = |id: &'static str,
                            label: &'static str,
                            icon: Icon,
                            checked: Option<bool>,
                            disabled: bool,
                            run: MenuAction| {
                    let view = view.clone();
                    let close = close.clone();
                    let kind = if disabled {
                        ItemKind::skip()
                    } else {
                        ItemKind::target()
                    };
                    row(
                        kind,
                        MenuItem::new(id, label)
                            .icon(icon)
                            .disabled(disabled)
                            .when_some(checked, |item, checked| item.checked(checked))
                            .on_click(move |_, window, cx| {
                                close(window, cx);
                                view.update(cx, |view, cx| run(view, window, cx));
                            }),
                    )
                };
                let fit_item = |mode: FitMode, checked: Option<bool>| {
                    let (id, label, icon) = match mode {
                        FitMode::Width => (
                            "pdf-menu-fit-width",
                            t!("Fit page to width"),
                            Icon::RECTANGLE_HORIZONTAL,
                        ),
                        FitMode::Height => (
                            "pdf-menu-fit-height",
                            t!("Fit page to height"),
                            Icon::RECTANGLE_VERTICAL,
                        ),
                    };
                    item(
                        id,
                        label,
                        icon,
                        checked,
                        false,
                        Box::new(move |view, _, cx| view.toggle_fit(mode, cx)),
                    )
                };
                let mut menu = MenuSurface::new()
                    .min_w(px(216.))
                    .child(hover.highlight())
                    .child(zoom_row(&view, scale, close.clone(), cx))
                    .child(separator());
                // Folded for a query, SyncTeX and both fits wait here, each
                // fit marked when in use; otherwise the fit not shown.
                if fold >= Fold::Controls {
                    if can_reveal {
                        menu = menu
                            .child(item(
                                "pdf-menu-reveal",
                                t!("Reveal cursor in PDF"),
                                Icon::LOCATE_FIXED,
                                None,
                                false,
                                Box::new(|_, _, cx| cx.emit(PdfViewEvent::RevealCursor)),
                            ))
                            .child(separator());
                    }
                    menu = menu
                        .child(fit_item(FitMode::Width, Some(fit == Some(FitMode::Width))))
                        .child(fit_item(
                            FitMode::Height,
                            Some(fit == Some(FitMode::Height)),
                        ));
                } else {
                    menu = menu.child(fit_item(other_fit, None));
                }
                menu = menu
                    .child(separator())
                    .child(item(
                        "pdf-menu-dark",
                        t!("Dark pages"),
                        Icon::MOON,
                        Some(super::dark::enabled()),
                        false,
                        Box::new(|view, _, cx| view.toggle_dark_pages(cx)),
                    ))
                    .child(separator())
                    .child(item(
                        "pdf-menu-back",
                        t!("Previous PDF location"),
                        Icon::CORNER_UP_LEFT,
                        None,
                        !can_back,
                        Box::new(|view, _, cx| view.navigate(false, cx)),
                    ))
                    .child(item(
                        "pdf-menu-forward",
                        t!("Next PDF location"),
                        Icon::CORNER_UP_RIGHT,
                        None,
                        !can_forward,
                        Box::new(|view, _, cx| view.navigate(true, cx)),
                    ))
                    .child(separator());
                if let Some(action) = action.clone() {
                    let view = view.clone();
                    let close = close.clone();
                    menu = menu.child(row(
                        ItemKind::target(),
                        MenuItem::new("pdf-menu-action", lattice_i18n::tr(action.label))
                            .icon(action.icon)
                            .on_click(move |_, window, cx| {
                                close(window, cx);
                                view.update(cx, |_, cx| cx.emit(PdfViewEvent::Action));
                            }),
                    ));
                }
                menu = menu.child(item(
                    "pdf-menu-save",
                    t!("Save PDF as…"),
                    Icon::DOWNLOAD,
                    None,
                    !can_save,
                    Box::new(|view, window, cx| view.save_as(window, cx)),
                ));
                pop_in("pdf-overflow-menu", PopFrom::Above, menu)
            })
            .into_any_element()
    }
}

/// The menu's zoom row: steps around the percentage, which hands off to the
/// toolbar's own field. Stepping keeps the menu open, so a reader can click
/// until the page is right.
fn zoom_row(
    view: &gpui::Entity<PdfView>,
    scale: f32,
    close: impl Fn(&mut Window, &mut App) + 'static,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let step =
        |id: &'static str, icon: Icon, label: &'static str, direction: f32, disabled: bool| {
            let view = view.clone();
            IconButton::new(id, icon)
                .frame(px(32.), px(28.))
                .tooltip(label)
                .disabled(disabled)
                .on_click(move |_, _, cx| view.update(cx, |view, cx| view.step_zoom(direction, cx)))
        };
    let percent = format!("{}%", (scale * 100.).round() as i64);
    let entry = {
        let view = view.clone();
        div()
            .id("pdf-menu-zoom-value")
            .flex()
            .items_center()
            .justify_center()
            .min_w(px(52.))
            .h(px(28.))
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|style| style.bg(palette.hover))
            .text_role(TextRole::Body, cx)
            .text_color(palette.text)
            .child(percent)
            .on_click(move |_, window, cx| {
                close(window, cx);
                view.update(cx, |view, cx| view.enter_zoom(window, cx));
            })
    };
    div()
        .flex()
        .items_center()
        .gap(px(1.))
        .py(px(1.))
        .pl(px(10.))
        .child(
            div()
                .flex_1()
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(t!("Zoom")),
        )
        .child(step(
            "pdf-menu-zoom-out",
            Icon::ZOOM_OUT,
            t!("Zoom out"),
            -1.,
            scale <= MIN_SCALE,
        ))
        .child(entry)
        .child(step(
            "pdf-menu-zoom-in",
            Icon::ZOOM_IN,
            t!("Zoom in"),
            1.,
            scale >= MAX_SCALE,
        ))
        .into_any_element()
}
