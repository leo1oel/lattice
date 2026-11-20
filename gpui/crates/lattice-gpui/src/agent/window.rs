//! The Agent in a window of its own (#1202), for a writer who keeps the
//! editor on one screen and the Agent on another, as the live PDF has one
//! (`crate::pdf::window`).
//!
//! The window shows the Agent panel's own surface: the same page, moved, not
//! built again (`Island` follows the window that draws it, and
//! gpui-webview moves its WKWebView there), so the thread, the draft and a
//! running turn carry over. The panel it came from keeps the surface and
//! everything the shell asks of it; its place in the dock shows the way back.
//! The window opens where it was last left for the project, 480 by 760 the
//! first time; closing it is the same as Return to workspace.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, WeakEntity, Window,
    WindowBounds, WindowOptions, div, px, size,
};
use lattice_ui::ActiveLattice as _;

use super::{SynaraPanel, SynaraSurface};
use crate::{
    pdf::preferences::{ProjectWindow, WindowFrame},
    shell::commands::{CloseTab, CloseWindow, CommandPalette},
    window_place,
};

const DEFAULT_SIZE: (f32, f32) = (480., 760.);
const MIN_SIZE: (f32, f32) = (360., 420.);

pub struct AgentWindow {
    surface: Entity<SynaraSurface>,
    /// The panel the Agent came from, which takes it back.
    owner: WeakEntity<SynaraPanel>,
    _theme: gpui::Subscription,
    _placed: gpui::Subscription,
}

impl AgentWindow {
    /// Open the window around `owner`'s surface for `project`; `focus`
    /// brings it forward, else it opens behind the workspace.
    pub fn open(
        owner: WeakEntity<SynaraPanel>,
        surface: Entity<SynaraSurface>,
        project: Option<PathBuf>,
        title: SharedString,
        focus: bool,
        cx: &mut App,
    ) -> anyhow::Result<AnyWindowHandle> {
        let min = size(px(MIN_SIZE.0), px(MIN_SIZE.1));
        let (bounds, display_id) = project
            .as_deref()
            .and_then(frame)
            .and_then(|frame| window_place::reopen(&frame, min, cx))
            .map_or_else(
                || {
                    let default = size(px(DEFAULT_SIZE.0), px(DEFAULT_SIZE.1));
                    (Bounds::centered(None, default, cx), None)
                },
                |(bounds, display)| (bounds, Some(display)),
            );
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            display_id,
            window_min_size: Some(min),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some(title),
                ..Default::default()
            }),
            focus,
            ..Default::default()
        };
        let kept = surface.downgrade();
        let placed = project.clone();
        let panel = owner.clone();
        let (handle, _) = gpui_kit::open_window(options, cx, |window, cx| {
            // The interface size every window takes.
            crate::interface_zoom::apply(window, cx);
            // Its title bar in the theme's appearance, as the workspace's.
            crate::window_material::pin_appearance(window, cx);
            cx.new(|cx| AgentWindow {
                surface,
                owner: panel,
                _theme: cx.observe_global_in::<lattice_ui::LatticeTheme>(
                    window,
                    |_, window, cx| {
                        crate::window_material::pin_appearance(window, cx);
                    },
                ),
                _placed: window_place::keep_placed(window, cx, move |frame| {
                    if let Some(root) = placed.as_deref() {
                        update(root, |remembered| remembered.frame = Some(frame));
                    }
                }),
            })
        })?;
        handle.update(cx, |_, window, cx| {
            window.on_window_should_close(cx, move |window, cx| {
                remember_frame(project.as_deref(), window, cx);
                if let Some(surface) = kept.upgrade() {
                    let_go(&surface, cx);
                }
                if let Some(owner) = owner.upgrade() {
                    // In the workspace's own window, once this event is over.
                    cx.defer(move |cx| {
                        owner.update(cx, |panel, cx| panel.dock(false, cx));
                    });
                }
                true
            });
            if focus {
                window.activate_window();
            }
        })?;
        Ok(handle)
    }
}

/// Close the window, remembering where it was left for `project`; the
/// page leaves it first, as it is.
pub(super) fn close(
    handle: AnyWindowHandle,
    surface: &Entity<SynaraSurface>,
    project: Option<&Path>,
    cx: &mut App,
) {
    let_go(surface, cx);
    handle
        .update(cx, |_, window, cx| {
            remember_frame(project, window, cx);
            window.remove_window();
        })
        .ok();
}

/// Take the surface's page out of the window, which is closing.
fn let_go(surface: &Entity<SynaraSurface>, cx: &mut App) {
    if let Some(island) = surface.read(cx).island().cloned() {
        island.update(cx, |island, cx| island.leave_window(cx));
    }
}

fn remember_frame(project: Option<&Path>, window: &Window, cx: &App) {
    let Some(root) = project else {
        return;
    };
    let frame = window_place::frame_of(window, cx);
    update(root, |remembered| remembered.frame = Some(frame));
}

impl AgentWindow {
    /// ⌘W and ⌘⇧W: the Agent goes back to its panel, as the window's close
    /// button takes it, once this window's event is over.
    fn return_to_workspace(&mut self, cx: &mut Context<Self>) {
        let owner = self.owner.clone();
        cx.defer(move |cx| {
            owner.update(cx, |panel, cx| panel.dock(true, cx)).ok();
        });
    }

    /// ⌘K: the workspace's palette, in front, as the PDF's window has none of
    /// its own.
    fn open_palette(&mut self, cx: &mut Context<Self>) {
        let Some(home) = self.owner.upgrade().map(|panel| panel.read(cx).home) else {
            return;
        };
        cx.defer(move |cx| {
            home.update(cx, |_, window, cx| {
                window.activate_window();
                window.dispatch_action(Box::new(CommandPalette), cx);
            })
            .ok();
        });
    }
}

impl Render for AgentWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        div()
            .on_action(cx.listener(|this, _: &CloseTab, _, cx| this.return_to_workspace(cx)))
            .on_action(cx.listener(|this, _: &CloseWindow, _, cx| this.return_to_workspace(cx)))
            .on_action(cx.listener(|this, _: &CommandPalette, _, cx| this.open_palette(cx)))
            .size_full()
            .bg(palette.editor)
            .text_color(palette.text)
            .child(self.surface.clone())
    }
}

// ---- What is remembered ----------------------------------------------------

/// Per project, whether its Agent is in a window of its own and where that
/// window was left, in `agent-window.json` in the app's state directory
/// (`LATTICE_GPUI_STATE_DIR` names another, empty for none; a scripted run
/// keeps it in memory), as the PDF's is kept in `pdf.json`.
struct Store {
    file: Option<PathBuf>,
    windows: BTreeMap<PathBuf, ProjectWindow>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let file = state_dir().map(|dir| dir.join("agent-window.json"));
        let windows = file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Mutex::new(Store { file, windows })
    })
}

fn state_dir() -> Option<PathBuf> {
    match std::env::var_os("LATTICE_GPUI_STATE_DIR") {
        Some(dir) if dir.is_empty() => None,
        Some(dir) => Some(PathBuf::from(dir)),
        None if std::env::args().any(|arg| arg == "--scenario") => None,
        None => dirs::data_dir().map(|dir| dir.join(crate::flavor::current().folder)),
    }
}

/// Whether `root`'s Agent was left in a window of its own.
pub fn is_open(root: &Path) -> bool {
    remembered(root).open
}

/// Where `root`'s Agent window was last left.
pub fn frame(root: &Path) -> Option<WindowFrame> {
    remembered(root).frame
}

fn remembered(root: &Path) -> ProjectWindow {
    store()
        .lock()
        .ok()
        .and_then(|store| store.windows.get(root).cloned())
        .unwrap_or_default()
}

/// Change what `root`'s window remembers, and write it when it changed.
pub(crate) fn update(root: &Path, change: impl FnOnce(&mut ProjectWindow)) {
    let Ok(mut store) = store().lock() else {
        return;
    };
    let entry = store.windows.entry(root.to_path_buf()).or_default();
    let before = entry.clone();
    change(entry);
    if *entry == before {
        return;
    }
    if let Some(file) = store.file.clone()
        && let Err(error) = write_json(&file, &store.windows)
    {
        log::warn!("could not save the Agent window's place: {error:#}");
    }
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}
