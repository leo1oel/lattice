//! The live PDF in a window of its own, for a writer who keeps the editor on
//! one screen and the PDF on another (`src-tauri/src/pdf_window.rs`,
//! `src/pdf/pdf-window-page.tsx`).
//!
//! The window holds a viewer and nothing else; the PDF panel that opened it
//! keeps the build, SyncTeX and the documents, and everything the reader
//! asks there (a jump to the source, Reveal cursor in PDF, Build, Return to
//! workspace) goes back to it. It opens where it was last left for the
//! project, at the place the panel showed, 760 by 880 the first time;
//! closing it is the same as Return to workspace.

use std::path::{Path, PathBuf};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, WeakEntity, Window, WindowBounds,
    WindowOptions, div, point, px, size,
};
use lattice_ui::{ActiveLattice as _, Icon};

use super::{
    panel::PdfPanel,
    preferences::{self, WindowFrame},
    view::{PdfView, PdfViewEvent, ToolbarAction, ViewPlace},
};

const DEFAULT_SIZE: (f32, f32) = (760., 880.);
const MIN_SIZE: (f32, f32) = (420., 360.);

pub struct PdfWindow {
    view: Entity<PdfView>,
    _subscription: gpui::Subscription,
}

impl PdfWindow {
    /// Open the window for `owner`'s live PDF in `project`, showing `source`
    /// at `place`; `focus` brings it forward, else it opens behind the
    /// workspace.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        owner: WeakEntity<PdfPanel>,
        project: Option<PathBuf>,
        title: SharedString,
        source: Option<PathBuf>,
        place: ViewPlace,
        building: bool,
        outline: Option<super::OutlineState>,
        focus: bool,
        cx: &mut App,
    ) -> anyhow::Result<(AnyWindowHandle, Entity<PdfView>)> {
        let remembered = project
            .as_deref()
            .and_then(|root| preferences::get().window(root).frame);
        let bounds = match remembered {
            Some(frame) => Bounds {
                origin: point(px(frame.x), px(frame.y)),
                size: size(
                    px(frame.width.max(MIN_SIZE.0)),
                    px(frame.height.max(MIN_SIZE.1)),
                ),
            },
            None => Bounds::centered(None, size(px(DEFAULT_SIZE.0), px(DEFAULT_SIZE.1)), cx),
        };
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1))),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some(title),
                ..Default::default()
            }),
            focus,
            ..Default::default()
        };
        let (handle, window_view) = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| {
                let view = cx.new(|cx| {
                    let mut view = PdfView::new(window, cx);
                    view.set_can_reveal(true, cx);
                    view.set_build(true, building, cx);
                    view.set_action(
                        Some(ToolbarAction {
                            label: "Return to workspace".into(),
                            icon: Icon::SQUARE_ARROW_DOWN_LEFT,
                        }),
                        cx,
                    );
                    view.restore_place(place);
                    view.set_outline(outline.clone(), cx);
                    if let Some(source) = source.clone() {
                        view.open(source, window, cx);
                    }
                    view
                });
                let subscription = cx.subscribe_in(&view, window, {
                    let owner = owner.clone();
                    move |_, _, event: &PdfViewEvent, window, cx| {
                        let owner = owner.clone();
                        match event {
                            // Return to workspace: the panel takes the PDF
                            // back and closes the window; without its panel,
                            // the window just closes.
                            PdfViewEvent::Action if owner.upgrade().is_none() => {
                                window.remove_window()
                            }
                            PdfViewEvent::Action => with_owner(&owner, cx, |panel, window, cx| {
                                panel.dock(true, window, cx)
                            }),
                            other => forward(&owner, other, cx),
                        }
                    }
                });
                PdfWindow {
                    view,
                    _subscription: subscription,
                }
            })
        })?;
        let view = window_view.read(cx).view.clone();
        handle.update(cx, |_, window, cx| {
            let owner = owner.clone();
            window.on_window_should_close(cx, move |window, cx| {
                remember_frame(project.as_deref(), window);
                with_owner(&owner, cx, |panel, window, cx| {
                    panel.dock(false, window, cx)
                });
                true
            });
            if focus {
                window.activate_window();
            }
        })?;
        Ok((handle, view))
    }
}

/// Close the window, remembering where it was left for `project`.
pub(super) fn close(handle: AnyWindowHandle, project: Option<&Path>, cx: &mut App) {
    handle
        .update(cx, |_, window, _| {
            remember_frame(project, window);
            window.remove_window();
        })
        .ok();
}

fn remember_frame(project: Option<&Path>, window: &Window) {
    let Some(root) = project else {
        return;
    };
    let bounds = window.window_bounds().get_bounds();
    let frame = WindowFrame {
        x: f32::from(bounds.origin.x),
        y: f32::from(bounds.origin.y),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
    };
    preferences::update(|preferences| preferences.window_mut(root).frame = Some(frame));
}

/// Ask the panel something in its own window, once the window's event is
/// over.
fn with_owner(
    owner: &WeakEntity<PdfPanel>,
    cx: &mut App,
    ask: impl FnOnce(&mut PdfPanel, &mut Window, &mut Context<PdfPanel>) + 'static,
) {
    let Some(owner) = owner.upgrade() else {
        return;
    };
    cx.defer(move |cx| {
        let home = owner.read(cx).home();
        home.update(cx, |_, window, cx| {
            owner.update(cx, |panel, cx| ask(panel, window, cx));
        })
        .ok();
    });
}

/// What the reader asks in the window goes to the panel, as if asked there.
fn forward(owner: &WeakEntity<PdfPanel>, event: &PdfViewEvent, cx: &mut App) {
    let Some(owner) = owner.upgrade() else {
        return;
    };
    let event = match event {
        PdfViewEvent::SourceAt { page, x, y } => super::PdfEvent::SourceAt {
            document: None,
            page: *page,
            x: *x,
            y: *y,
        },
        PdfViewEvent::RevealCursor => super::PdfEvent::RevealCursor { document: None },
        PdfViewEvent::Build => super::PdfEvent::Build { document: None },
        PdfViewEvent::Outline { path, line } => super::PdfEvent::Outline {
            path: path.clone(),
            line: *line,
        },
        PdfViewEvent::Action => return,
    };
    owner.update(cx, |_, cx| cx.emit(event));
}

impl Render for PdfWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        div()
            .size_full()
            .bg(palette.editor)
            .text_color(palette.text)
            .child(self.view.clone())
    }
}
