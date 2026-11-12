//! The live PDF in a window of its own, for a writer who keeps the editor on
//! one screen and the PDF on another (`src-tauri/src/pdf_window.rs`,
//! `src/pdf/pdf-window-page.tsx`).
//!
//! The window holds a viewer and nothing else; the PDF panel that opened it
//! keeps the build, SyncTeX and the documents, and everything the reader
//! asks there (a jump to the source, Reveal cursor in PDF, Build, Return to
//! workspace) goes back to it. It opens where it was last left for the
//! PDF's folder, at the place the panel showed, 760 by 880 the first time;
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
    preferences::{self, ProjectWindow, WindowFrame},
    view::{PdfView, PdfViewEvent, ToolbarAction, ViewPlace},
};

const DEFAULT_SIZE: (f32, f32) = (760., 880.);
const MIN_SIZE: (f32, f32) = (420., 360.);

pub struct PdfWindow {
    view: Entity<PdfView>,
    _subscription: gpui::Subscription,
}

impl PdfWindow {
    /// Open the window for `owner`'s live PDF, showing `source` at `place`.
    pub fn open(
        owner: WeakEntity<PdfPanel>,
        title: SharedString,
        source: Option<PathBuf>,
        place: ViewPlace,
        building: bool,
        outline: Option<super::OutlineState>,
        cx: &mut App,
    ) -> anyhow::Result<(AnyWindowHandle, Entity<PdfView>)> {
        let key = frame_key(source.as_deref());
        let remembered = key
            .as_ref()
            .and_then(|key| preferences::get().windows.get(key).and_then(|w| w.frame));
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
                            // Return to workspace: the window goes and the
                            // panel takes the PDF back.
                            PdfViewEvent::Action => {
                                window.remove_window();
                                notify_closed(&owner, cx);
                            }
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
            let key = key.clone();
            window.on_window_should_close(cx, move |window, cx| {
                remember_frame(key.as_ref(), window);
                notify_closed(&owner, cx);
                true
            });
            window.activate_window();
        })?;
        Ok((handle, view))
    }
}

/// The PDF's folder names its window's frame: the project, for a compiled
/// PDF beside its document.
fn frame_key(source: Option<&Path>) -> Option<PathBuf> {
    source.and_then(Path::parent).map(Path::to_path_buf)
}

fn remember_frame(key: Option<&PathBuf>, window: &Window) {
    let Some(key) = key.cloned() else {
        return;
    };
    let bounds = window.window_bounds().get_bounds();
    let frame = WindowFrame {
        x: f32::from(bounds.origin.x),
        y: f32::from(bounds.origin.y),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
    };
    preferences::update(|preferences| {
        preferences
            .windows
            .entry(key)
            .or_insert_with(ProjectWindow::default)
            .frame = Some(frame);
    });
}

/// The window went: the panel takes the PDF back, in its own window.
fn notify_closed(owner: &WeakEntity<PdfPanel>, cx: &mut App) {
    let Some(owner) = owner.upgrade() else {
        return;
    };
    cx.defer(move |cx| {
        let home = owner.read(cx).home();
        home.update(cx, |_, window, cx| {
            owner.update(cx, |panel, cx| panel.window_closed(window, cx));
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
