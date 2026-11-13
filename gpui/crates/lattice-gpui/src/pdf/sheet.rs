//! Drawing the viewer: the toolbar over the pages, or the state that stands
//! in for them (no PDF yet, loading, a PDF that could not be read).
//!
//! The pages scroll in one container inside an 8px border, each a sheet of
//! paper with its own shadow, placed where `layout.rs` puts it; only the
//! pages near the viewport are in the tree at all. Over each page, in this
//! order: its image (and its full-size part), the search hits, the
//! selection, the SyncTeX mark, and the links' hit areas.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, Context, CursorStyle, DispatchPhase, Entity, Hsla,
    InteractiveElement as _, IntoElement, MouseButton, ObjectFit, ParentElement as _, Render,
    ScrollEvent, SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _,
    Window, canvas, div, img, prelude::FluentBuilder as _, px, rgb,
};
use gpui_kit::component::scroll::Scrollbar;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, Palette, TextRole, TextRoleStyle as _,
    components::{Button, EmptyState, ErrorState},
    elevation,
};

use super::{
    dark::{DARK_PAGE, DARK_PAGE_MARK},
    layout::{PAGE_INSET, Rect},
    view::{PdfView, PdfViewEvent, SYNC_MARK_HOLD, SyncMark},
};

/// The editor's selection blue at 35%, on the page in both themes
/// (`.pdf-sel-rect`).
const SELECTION_TINT: u32 = 0x3d7af2;

impl Render for PdfView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.prepare_frame(window, cx);
        let palette = cx.palette().clone();
        let view = cx.entity().downgrade();
        let width = self.width;
        let body = self.body(cx);
        div()
            .id("pdf-view")
            .key_context("PdfView")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.pdf_ground)
            .child(self.toolbar(window, cx))
            .child(body)
            // The toolbar folds at 640px of the view's own width.
            .child(
                canvas(
                    move |bounds, window, cx| {
                        if bounds.size.width != width
                            && let Some(view) = view.upgrade()
                        {
                            view.update(cx, |this, _| this.width = bounds.size.width);
                            redraw_next_frame(view, window);
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
    }
}

/// Draw `view` again on the next frame, for a size learned while laying
/// this one out. A notify during layout only marks the view for the next
/// frame without asking the platform for one, and a window with nothing
/// else to draw (the separate window) would then wait for input to draw it.
fn redraw_next_frame(view: Entity<PdfView>, window: &Window) {
    window.on_next_frame(move |_, cx| view.update(cx, |_, cx| cx.notify()));
}

impl PdfView {
    fn body(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let state = |content: AnyElement| {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .child(content)
                .into_any_element()
        };
        if let Err(error) = &self.engine {
            return state(
                ErrorState::new(t!("PDFium was not found"))
                    .detail(error.clone())
                    .into_any_element(),
            );
        }
        if let Some(message) = &self.message {
            // A load failure names itself, with the way out under it.
            return state(
                ErrorState::new(message.clone())
                    .detail(t!("Try building the project again"))
                    .into_any_element(),
            );
        }
        if self.document.is_none() {
            if self.loading {
                return state(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .bg(palette.raised)
                        .shadow(lattice_ui::Elevation::Popover.shadows(&palette))
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .child(Icon::LOADER.element(px(12.), palette.text_secondary))
                        .child(t!("Loading PDF…"))
                        .into_any_element(),
                );
            }
            let building = self.building;
            let empty = EmptyState::new(t!("No PDF yet")).when(self.offers_build, |this| {
                this.action(
                    Button::new(
                        "pdf-build",
                        if building {
                            t!("Building…")
                        } else {
                            t!("Build project")
                        },
                    )
                    .compact()
                    .icon(if building { Icon::LOADER } else { Icon::PLAY })
                    .disabled(building)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(PdfViewEvent::Build))),
                )
            });
            return state(empty.into_any_element());
        }
        self.pages_area(cx)
    }

    fn pages_area(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let dark = self.dark;
        let scale = self.layout.scale;
        let (_, scroll_y) = self.scroll_offset();
        let height = f32::from(self.viewport.size.height);
        let visible = self.layout.visible(scroll_y, height.max(1.));
        // A page above or below what is on screen is still in the tree when
        // part of it shows after a scroll this frame has not drawn yet.
        let first = visible.start.saturating_sub(1);
        let last = (visible.end + 1).min(self.layout.len());
        let mut pages = Vec::new();
        for ix in first..last {
            if let Some(rect) = self.layout.page(ix) {
                pages.push(self.page(ix, rect, scale, dark, &palette, cx));
            }
        }
        let view = cx.entity().downgrade();
        let sheet = div()
            .id("pdf-sheet")
            .relative()
            .w(px(self.layout.width))
            .h(px(self.layout.height))
            .children(pages)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_sheet_mouse_down))
            .on_mouse_move(cx.listener(Self::on_sheet_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_sheet_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_sheet_mouse_up));
        div()
            .id("pdf-scroll-area")
            .relative()
            .flex_1()
            .min_h_0()
            .child(
                div().absolute().inset_0().p(px(PAGE_INSET)).child(
                    div()
                        .id("pdf-pages")
                        .size_full()
                        .overflow_scroll()
                        .track_scroll(&self.scroll)
                        .on_pinch(cx.listener(|this, event, _, cx| this.on_pinch(event, cx)))
                        .child(sheet),
                ),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .child(Scrollbar::new(&self.scroll).id("pdf-scrollbar")),
            )
            // `prepare_frame` sizes the pages from the scroll area's last
            // layout, so an area laid out for the first time or at a new size
            // needs one more frame to show the pages at that size and at the
            // place the viewer was given. A window with nothing else to draw
            // (the separate window once its PDF has loaded) would not ask for
            // one, and would keep page 1 at the wrong scale.
            .child({
                let view = view.clone();
                let scroll = self.scroll.clone();
                let viewport = self.viewport.size;
                canvas(
                    move |_, window, _| {
                        if scroll.bounds().size != viewport
                            && let Some(view) = view.upgrade()
                        {
                            redraw_next_frame(view, window);
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0()
            })
            // ⌘-wheel and Ctrl-wheel zoom, taken before the pages scroll.
            .child(
                canvas(
                    |bounds, _, _| bounds,
                    move |_, bounds, window, _| {
                        let view = view.clone();
                        window.on_mouse_event(move |event: &ScrollEvent, phase, _, cx| {
                            let zoom = event.modifiers.platform || event.modifiers.control;
                            if phase != DispatchPhase::Capture
                                || !zoom
                                || !bounds.contains(&event.position)
                            {
                                return;
                            }
                            cx.stop_propagation();
                            view.update(cx, |this, cx| this.on_zoom_wheel(event, cx))
                                .ok();
                        });
                    },
                )
                .absolute()
                .inset_0(),
            )
            .into_any_element()
    }

    fn page(
        &mut self,
        ix: usize,
        rect: Rect,
        scale: f32,
        dark: bool,
        palette: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let slot = &self.pages[ix];
        let base = slot.base.image.clone();
        let detail = slot.detail.image.clone().zip(
            slot.detail
                .key
                .and_then(|key| key.region.map(|region| (key.width_px, region))),
        );
        let text = slot.text.clone();
        let ground: Hsla = if dark {
            rgb(DARK_PAGE).into()
        } else {
            palette.pdf_page
        };
        // The search hits on this page, the current one outlined.
        let current = self.find.current;
        let hits: Vec<AnyElement> = self
            .find
            .matches
            .iter()
            .enumerate()
            .filter(|(_, found)| found.page == ix)
            .flat_map(|(n, found)| {
                let is_current = current == Some(n);
                found.boxes.iter().map(move |[x0, y0, x1, y1]| {
                    let hit = div()
                        .absolute()
                        .left(px(x0 * scale))
                        .top(px(y0 * scale))
                        .w(px((x1 - x0) * scale))
                        .h(px((y1 - y0) * scale));
                    if is_current {
                        hit.bg(gpui::rgba(0xff8e007a))
                            .border_1()
                            .border_color(gpui::rgba(0xca5e00b8))
                            .into_any_element()
                    } else {
                        hit.bg(gpui::rgba(0xffd00057)).into_any_element()
                    }
                })
            })
            .collect();
        let selection: Vec<AnyElement> = match (self.selection, &text) {
            (Some(selection), Some(text)) => selection
                .range_on(ix, text.chars.len())
                .map(|range| text.highlight(range))
                .unwrap_or_default()
                .into_iter()
                .map(|[x0, y0, x1, y1]| {
                    let tint: Hsla = rgb(SELECTION_TINT).into();
                    div()
                        .absolute()
                        .left(px(x0 * scale))
                        .top(px(y0 * scale))
                        .w(px((x1 - x0) * scale))
                        .h(px((y1 - y0) * scale))
                        .bg(Hsla { a: 0.35, ..tint })
                        .into_any_element()
                })
                .collect(),
            _ => Vec::new(),
        };
        if let Some(mark) = self
            .sync_mark
            .as_mut()
            .filter(|mark| mark.page == ix && !mark.drawn)
        {
            mark.drawn = true;
            let id = mark.id;
            self.mark_drawn(id, cx);
        }
        let mark_color: Hsla = if dark {
            rgb(DARK_PAGE_MARK).into()
        } else {
            palette.accent
        };
        let mark = self
            .sync_mark
            .filter(|mark| mark.page == ix)
            .map(|mark| sync_mark(mark, scale, mark_color));
        let links: Vec<AnyElement> = text
            .as_ref()
            .map(|text| {
                text.links
                    .iter()
                    .enumerate()
                    .map(|(n, link)| {
                        div()
                            .id(SharedString::from(format!("pdf-link-{ix}-{n}")))
                            .absolute()
                            .left(px(link.x0 * scale))
                            .top(px(link.y0 * scale))
                            .w(px((link.x1 - link.x0) * scale))
                            .h(px((link.y1 - link.y0) * scale))
                            .cursor_pointer()
                            .into_any_element()
                    })
                    .collect()
            })
            .unwrap_or_default();
        div()
            .absolute()
            .left(px(rect.x))
            .top(px(rect.y))
            .w(px(rect.w))
            .h(px(rect.h))
            .bg(ground)
            .shadow(elevation::pdf_page(palette))
            .cursor(CursorStyle::IBeam)
            .when_some(base, |page, image| {
                page.child(
                    img(image)
                        .absolute()
                        .inset_0()
                        .size_full()
                        .object_fit(ObjectFit::Fill),
                )
            })
            .when_some(detail, |page, (image, (width_px, region))| {
                // The full-size part, at its place on the page.
                let to_logical = rect.w / width_px as f32;
                page.child(
                    img(image)
                        .absolute()
                        .left(px(region.x as f32 * to_logical))
                        .top(px(region.y as f32 * to_logical))
                        .w(px(region.w as f32 * to_logical))
                        .h(px(region.h as f32 * to_logical))
                        .object_fit(ObjectFit::Fill),
                )
            })
            .children(hits)
            .children(selection)
            .children(mark)
            .children(links)
            .into_any_element()
    }
}

/// The mark on a page where a jump from the source landed: an accent box
/// over the source's box (at least 18 by 12), on the compact corner, held
/// for 1.44 s and then faded on the slow exit tier.
fn sync_mark(mark: SyncMark, scale: f32, accent: Hsla) -> AnyElement {
    let wash = Hsla {
        a: accent.a * 0.16,
        ..accent
    };
    let hold = SYNC_MARK_HOLD.as_secs_f32();
    let fade = lattice_ui::Motion::SlowExit.duration().as_secs_f32();
    let total = hold + fade;
    div()
        .absolute()
        .left(px(mark.x * scale))
        .top(px(mark.y * scale))
        .w(px((mark.width * scale).max(18.)))
        .h(px((mark.height * scale).max(12.)))
        .border_2()
        .border_color(accent)
        .rounded(px(4.))
        .bg(wash)
        .with_animation(
            ("pdf-sync-mark", mark.id),
            Animation::new(Duration::from_secs_f32(total)),
            move |this, t| {
                let elapsed = t * total;
                let out = ((elapsed - hold) / fade).clamp(0., 1.);
                this.opacity(1. - lattice_ui::Motion::SlowExit.sample(out))
            },
        )
        .into_any_element()
}
