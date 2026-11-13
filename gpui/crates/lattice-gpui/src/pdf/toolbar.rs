//! The viewer's toolbar, as the Tauri app draws it (`.pdf-toolbar` in
//! `src/pdf/pdf-viewer.css`): one 40px row closed by a hairline, three
//! columns. Page navigation and location history on the left; the outline
//! and Find in PDF in the middle, taking what is left; zoom, Reveal cursor
//! in PDF, the two fits, dark pages, the host's action and Save on the
//! right.
//!
//! A toolbar 640px or narrower keeps what a reader reaches for while reading
//! (pages, search, SyncTeX and the fit in use) and moves the rest (the zoom
//! steps, the other fit, dark pages, history, the action, Save) into one
//! overflow menu behind ⋯, which opens on a zoom row. Its percentage hands
//! off to the toolbar's own zoom field, shown over the end of Find until it
//! is left.

use gpui::{
    AnyElement, App, AppContext as _, Context, Edges, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::Input;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::IconButton, icons::ICON,
    tokens::FONT_WEIGHT_REGULAR,
};

use super::{
    find::FindOptions,
    layout::{FitMode, MAX_SCALE, MIN_SCALE},
    overflow::Fold,
    view::{PdfView, PdfViewEvent},
};

/// The toolbar narrows at this width (`@container pdf-toolbar (max-width: 640px)`).
pub const NARROW: f32 = 640.;

const TOOLBAR_HEIGHT: f32 = 40.;

fn tool(id: impl Into<gpui::ElementId>, icon: Icon, label: &'static str) -> IconButton {
    IconButton::new(id, icon)
        .frame(px(24.), px(28.))
        .tooltip(label)
}

/// A match control inside the find field: 20 by 22, a 12px icon.
fn search_tool(id: impl Into<gpui::ElementId>, icon: Icon, label: &'static str) -> IconButton {
    IconButton::new(id, icon)
        .frame(px(20.), px(22.))
        .icon_size(px(12.))
        .tooltip(label)
}

fn divider(cx: &App) -> impl IntoElement {
    div()
        .flex_none()
        .w(px(1.))
        .h(px(16.))
        .bg(cx.palette().line_strong)
}

impl PdfView {
    pub(super) fn narrow(&self) -> bool {
        f32::from(self.width) <= NARROW
    }

    pub(super) fn toolbar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let narrow = self.narrow();
        let empty = self.document.is_none();
        let fold = self.search_fold();
        div()
            .id("pdf-toolbar")
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .min_h(px(TOOLBAR_HEIGHT))
            .px(px(if narrow { 6. } else { 8. }))
            .py(px(4.))
            .border_b_1()
            .border_color(palette.line)
            .bg(palette.editor)
            .children(lattice_ui::parity::bordered_probe(
                "pdf/toolbar",
                Edges {
                    bottom: px(1.),
                    ..Edges::default()
                },
            ))
            .when(fold != Fold::Search, |this| {
                this.child(self.navigation(narrow, empty, cx))
            })
            .child(self.find_controls(empty, fold, window, cx))
            .when(fold != Fold::Search, |this| {
                this.child(self.zoom_controls(narrow, empty, fold, window, cx))
            })
            .into_any_element()
    }

    fn navigation(&self, narrow: bool, empty: bool, cx: &mut Context<Self>) -> AnyElement {
        if empty {
            // An empty toolbar keeps its columns' places (`.pdf-toolbar-empty`).
            return div().flex_none().min_w(px(74.)).into_any_element();
        }
        let count = self.page_count();
        let current = self.current_page();
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(1.))
                    .child(
                        tool("pdf-previous", Icon::CHEVRON_LEFT, "Previous page")
                            .disabled(current == 0)
                            .on_click(cx.listener(|this, _, _, cx| this.step_page(-1, cx))),
                    )
                    .child(self.page_value(count, current, cx))
                    .child(
                        tool("pdf-next", Icon::CHEVRON_RIGHT, "Next page")
                            .disabled(current + 1 >= count)
                            .on_click(cx.listener(|this, _, _, cx| this.step_page(1, cx))),
                    ),
            )
            .when(!narrow, |this| {
                this.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(1.))
                        .child(
                            tool("pdf-back", Icon::CORNER_UP_LEFT, "Previous PDF location")
                                .disabled(!self.can_go_back())
                                .on_click(cx.listener(|this, _, _, cx| this.navigate(false, cx))),
                        )
                        .child(
                            tool("pdf-forward", Icon::CORNER_UP_RIGHT, "Next PDF location")
                                .disabled(!self.can_go_forward())
                                .on_click(cx.listener(|this, _, _, cx| this.navigate(true, cx))),
                        ),
                )
            })
            .into_any_element()
    }

    /// The page value: "1 / 4" in a 44 by 28 box on the compact corner, the
    /// number editable on a click.
    fn page_value(&self, count: usize, current: usize, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let total: SharedString = count.to_string().into();
        let run = |slot: usize, text: SharedString, shown: SharedString| {
            div()
                .children(lattice_ui::parity::text_probe("pdf/page", slot, text))
                .child(shown)
        };
        let editing = self.page_field.editing;
        let frame = div()
            .id("pdf-page-value")
            .relative()
            .flex_none()
            .w(px(44.))
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .whitespace_nowrap()
            .text_role(TextRole::Micro, cx)
            .font_weight(FONT_WEIGHT_REGULAR)
            .text_color(palette.text_secondary)
            .children(lattice_ui::parity::probe("pdf/page"));
        if editing {
            let digits = self
                .page_field
                .input
                .read(cx)
                .value()
                .chars()
                .count()
                .max(1);
            frame
                .bg(palette.input)
                .border_1()
                .border_color(palette.field_border_hover)
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.cancel_draft(false, window, cx);
                    }
                }))
                .child(
                    div().w(px(7. * digits as f32 + 2.)).h_full().child(
                        Input::new(&self.page_field.input)
                            .appearance(false)
                            .px_0()
                            .py_0()
                            .h_full()
                            .text_size(TextRole::Micro.font_size(Default::default(), cx)),
                    ),
                )
                .child(div().pl(px(3.)).child(format!("/ {total}")))
                .into_any_element()
        } else {
            let page: SharedString = (current + 1).to_string().into();
            frame
                .cursor_text()
                .on_click(cx.listener(|this, _, window, cx| this.edit_draft(false, window, cx)))
                .child(run(0, page.clone(), page))
                .child(run(1, "/".into(), " / ".into()))
                .child(run(2, total.clone(), total))
                .into_any_element()
        }
    }

    fn find_controls(
        &self,
        empty: bool,
        fold: Fold,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(4.))
            .children(
                (fold != Fold::Search)
                    .then(|| self.outline_trigger(cx))
                    .flatten(),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(self.find_field(empty, window, cx)),
            )
            .into_any_element()
    }

    /// Find in PDF: Lattice's compact search field, its glyph while empty;
    /// with a query, Match case, Whole word, the counter, previous, next
    /// and clear.
    fn find_field(&self, empty: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let query = !self.find.query.is_empty();
        let focused = self.find.input.read(cx).focus_handle(cx).is_focused(window);
        let hover_border = palette.field_border_hover;
        let options = self.find.options;
        let total = self.find.matches.len();
        let position: SharedString = self.match_position().into();
        div()
            .id("pdf-find")
            .relative()
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .rounded(px(11.))
            .pl(px(10.))
            .pr(px(4.))
            .bg(palette.editor)
            .border_1()
            .border_color(if focused {
                palette.field_border_hover
            } else {
                palette.field_border
            })
            .when(!focused && !empty, |this| {
                this.hover(move |style| style.border_color(hover_border))
            })
            .when(empty, |this| this.opacity(0.45))
            .children(lattice_ui::parity::bordered_probe(
                "pdf/find",
                Edges::all(px(1.)),
            ))
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.find_escape(window, cx);
                }
            }))
            .when(!query, |this| {
                this.child(Icon::SEARCH.element(ICON, palette.text_secondary))
            })
            .child(
                // One line of the caption role, centred in the field as the
                // Tauri app's input centres its text.
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .text_role(TextRole::Caption, cx)
                    .children(lattice_ui::parity::text_probe("pdf/find", 0, "Find in PDF"))
                    .child(
                        Input::new(&self.find.input)
                            .appearance(false)
                            .disabled(empty)
                            .px_0()
                            .py_0()
                            .h(TextRole::Caption.leading(Default::default()))
                            .text_size(TextRole::Caption.font_size(Default::default(), cx)),
                    ),
            )
            .when(query, |this| {
                this.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(2.))
                        .child(
                            search_tool("pdf-match-case", Icon::CASE_SENSITIVE, "Match case")
                                .on(options.match_case)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.set_find_options(
                                        FindOptions {
                                            match_case: !options.match_case,
                                            ..options
                                        },
                                        cx,
                                    )
                                })),
                        )
                        .child(
                            search_tool("pdf-whole-word", Icon::WHOLE_WORD, "Whole word")
                                .on(options.whole_word)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.set_find_options(
                                        FindOptions {
                                            whole_word: !options.whole_word,
                                            ..options
                                        },
                                        cx,
                                    )
                                })),
                        )
                        .child(
                            div()
                                .flex_none()
                                .min_w(px(31.))
                                .text_center()
                                .whitespace_nowrap()
                                .text_role(TextRole::Micro, cx)
                                .text_color(palette.text_secondary)
                                .child(position),
                        )
                        .child(
                            search_tool(
                                "pdf-find-previous",
                                Icon::CHEVRON_UP,
                                "Previous search result",
                            )
                            .disabled(total == 0)
                            .on_click(cx.listener(|this, _, _, cx| this.find_again(true, cx))),
                        )
                        .child(
                            search_tool("pdf-find-next", Icon::CHEVRON_DOWN, "Next search result")
                                .disabled(total == 0)
                                .on_click(cx.listener(|this, _, _, cx| this.find_again(false, cx))),
                        )
                        .child(
                            search_tool("pdf-find-clear", Icon::X, "Clear PDF search").on_click(
                                cx.listener(|this, _, window, cx| this.clear_find(window, cx)),
                            ),
                        ),
                )
            })
            .into_any_element()
    }

    fn zoom_controls(
        &self,
        narrow: bool,
        empty: bool,
        fold: Fold,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let folded = fold >= Fold::Controls;
        if empty {
            return div().flex_none().min_w(px(74.)).into_any_element();
        }
        let fit = self.fit;
        // A narrow toolbar keeps one fit control: the mode in use, or width
        // when neither is (a manual zoom).
        let shown_fit = fit.unwrap_or(FitMode::Width);
        let scale = self.scale;
        let dark = super::dark::enabled();
        let fit_button = |mode: FitMode, cx: &mut Context<Self>| {
            let (id, icon, label) = match mode {
                FitMode::Width => (
                    "pdf-fit-width",
                    Icon::RECTANGLE_HORIZONTAL,
                    "Fit page to width",
                ),
                FitMode::Height => (
                    "pdf-fit-height",
                    Icon::RECTANGLE_VERTICAL,
                    "Fit page to height",
                ),
            };
            tool(id, icon, label)
                .on(fit == Some(mode))
                .on_click(cx.listener(move |this, _, _, cx| this.toggle_fit(mode, cx)))
        };
        div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(if narrow { 2. } else { 4. }))
            .when(!narrow, |this| {
                this.child(
                    tool("pdf-zoom-out", Icon::ZOOM_OUT, "Zoom out")
                        .disabled(scale <= MIN_SCALE)
                        .on_click(cx.listener(|this, _, _, cx| this.step_zoom(-1., cx))),
                )
                .child(self.zoom_value(window, cx))
                .child(
                    tool("pdf-zoom-in", Icon::ZOOM_IN, "Zoom in")
                        .disabled(scale >= MAX_SCALE)
                        .on_click(cx.listener(|this, _, _, cx| this.step_zoom(1., cx))),
                )
                .child(divider(cx))
            })
            // "Zoom percentage" from the narrow menu floats the field over
            // the end of Find.
            .when(narrow && self.zoom_entry, |this| {
                this.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(gpui::relative(1.))
                        .pr(px(4.))
                        .flex()
                        .items_center()
                        .child(self.zoom_value(window, cx)),
                )
            })
            .when(self.can_reveal && !folded, |this| {
                this.child(
                    tool("pdf-locate", Icon::LOCATE_FIXED, "Reveal cursor in PDF")
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(PdfViewEvent::RevealCursor))),
                )
                .child(divider(cx))
            })
            .when(
                !folded && (!narrow || shown_fit == FitMode::Width),
                |this| this.child(fit_button(FitMode::Width, cx)),
            )
            .when(
                !folded && (!narrow || shown_fit == FitMode::Height),
                |this| this.child(fit_button(FitMode::Height, cx)),
            )
            .when(!narrow, |this| {
                this.child(
                    tool("pdf-dark-pages", Icon::MOON, "Dark pages")
                        .on(dark)
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_dark_pages(cx))),
                )
                .when_some(self.action.clone(), |this, action| {
                    this.child(
                        IconButton::new("pdf-action", action.icon)
                            .frame(px(24.), px(28.))
                            .tooltip(action.label)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(PdfViewEvent::Action))),
                    )
                })
                .child(
                    tool("pdf-save", Icon::DOWNLOAD, "Save PDF as…")
                        .disabled(self.source.is_none())
                        .on_click(cx.listener(|this, _, window, cx| this.save_as(window, cx))),
                )
            })
            .when(narrow || folded, |this| {
                this.child(self.overflow_menu(fold, cx))
            })
            .into_any_element()
    }

    /// The zoom value: the percentage, closed up to its sign, editable.
    fn zoom_value(&self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let percent = format!("{}", (self.scale * 100.).round() as i64);
        let frame = div()
            .id("pdf-zoom-value")
            .flex_none()
            .w(px(44.))
            .h(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .whitespace_nowrap()
            .text_role(TextRole::Micro, cx)
            .text_color(palette.text_secondary);
        if self.zoom_field.editing {
            frame
                .bg(palette.input)
                .border_1()
                .border_color(palette.field_border_hover)
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.cancel_draft(true, window, cx);
                    }
                }))
                .child(
                    div().w(px(22.)).h_full().child(
                        Input::new(&self.zoom_field.input)
                            .appearance(false)
                            .px_0()
                            .py_0()
                            .h_full()
                            .text_size(TextRole::Micro.font_size(Default::default(), cx)),
                    ),
                )
                .child("%")
                .into_any_element()
        } else {
            frame
                .cursor_text()
                .on_click(cx.listener(|this, _, window, cx| this.edit_draft(true, window, cx)))
                .child(format!("{percent}%"))
                .into_any_element()
        }
    }

    /// Save PDF as…: the file as it is on disk now, copied where the reader
    /// picks (`saveProjectPdf`).
    pub(super) fn save_as(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "paper.pdf".into());
        let directory = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| {
                source
                    .parent()
                    .map(|parent| parent.to_path_buf())
                    .unwrap_or_default()
            });
        let destination = cx.prompt_for_new_path(&directory, Some(&name));
        cx.spawn_in(window, async move |_, cx| {
            let Ok(Ok(Some(destination))) = destination.await else {
                return;
            };
            let copied = cx
                .background_spawn({
                    let destination = destination.clone();
                    async move { copy_pdf(&source, &destination) }
                })
                .await;
            cx.update(|_, cx| match copied {
                Ok(_) => crate::notices::info(
                    "PDF saved",
                    format!("Saved to {}", destination.display()),
                    cx,
                ),
                Err(error) => {
                    crate::notices::error("Could not save the PDF", error.to_string(), cx)
                }
            })
            .ok();
        })
        .detach();
    }
}

/// Copy the shown PDF to `destination`. Picking the file's own path leaves it
/// as it is: `fs::copy` truncates the destination before reading the source.
fn copy_pdf(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    if let (Ok(from), Ok(to)) = (source.canonicalize(), destination.canonicalize())
        && from == to
    {
        return Ok(());
    }
    std::fs::copy(source, destination).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::copy_pdf;

    const PDF: &[u8] = b"%PDF-1.5\n%%EOF\n";

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lattice-pdf-save-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("figures")).unwrap();
        dir
    }

    #[test]
    fn saving_over_itself_keeps_the_pdf() {
        let dir = scratch("self");
        let source = dir.join("figures/plot.pdf");
        std::fs::write(&source, PDF).unwrap();
        copy_pdf(&source, &dir.join("figures/../figures/plot.pdf")).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), PDF);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saving_elsewhere_copies_and_replaces() {
        let dir = scratch("copy");
        let source = dir.join("figures/plot.pdf");
        let destination = dir.join("plot.pdf");
        std::fs::write(&source, PDF).unwrap();
        std::fs::write(&destination, b"old").unwrap();
        copy_pdf(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), PDF);
        assert_eq!(std::fs::read(&source).unwrap(), PDF);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
