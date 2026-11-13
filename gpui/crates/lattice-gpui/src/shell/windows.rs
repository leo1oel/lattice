//! Windows, and the projects in each (`src/app/window-projects.ts`).
//!
//! Every window registers its shell, so app-wide hooks (the dock's close and
//! menu items, the menu bar) find the window they act in. A window holds
//! one or more projects: a second project opened in it shows tabs in the
//! titlebar, each remembering its own layout; ⌃Tab and ⌃⇧Tab go round them
//! and the last one left folds the tabs back into the project's title. A
//! project moves to a window of its own from its tab's menu.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use gpui::{
    AnyWindowHandle, App, Bounds, Context, Entity, Global, Pixels, SharedString, WeakEntity,
    Window, WindowId, point, px, size,
};
use lattice_i18n::t;

use super::Shell;

#[derive(Default)]
struct Shells(HashMap<WindowId, WeakEntity<Shell>>);

impl Global for Shells {}

/// How far a new window steps down and right from the one it opens from.
const CASCADE: f32 = 28.;

pub(super) fn register(window: AnyWindowHandle, shell: &Entity<Shell>, cx: &mut App) {
    cx.default_global::<Shells>()
        .0
        .insert(window.window_id(), shell.downgrade());
}

/// The project the shell in `window` shows, if any.
pub(crate) fn root_of(window: AnyWindowHandle, cx: &App) -> Option<PathBuf> {
    let shell = cx
        .try_global::<Shells>()?
        .0
        .get(&window.window_id())?
        .upgrade()?;
    shell.read(cx).root(cx)
}

/// The window showing the project at `root`, if one does.
pub(crate) fn window_showing(root: &std::path::Path, cx: &App) -> Option<AnyWindowHandle> {
    window_showing_except(root, None, cx)
}

/// [`window_showing`], leaving out `except`: a shell asking from inside its
/// own update cannot be read, and knows its own project.
pub(crate) fn window_showing_except(
    root: &std::path::Path,
    except: Option<WindowId>,
    cx: &App,
) -> Option<AnyWindowHandle> {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    cx.windows().into_iter().find(|handle| {
        Some(handle.window_id()) != except
            && root_of(*handle, cx).is_some_and(|shown| shown == root || shown == canonical)
    })
}

/// The window showing the project at `root`, and its shell, for a scenario.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn shell_showing(
    root: &std::path::Path,
    cx: &App,
) -> Option<(AnyWindowHandle, Entity<Shell>)> {
    let handle = window_showing(root, cx)?;
    let shell = cx
        .try_global::<Shells>()?
        .0
        .get(&handle.window_id())?
        .upgrade()?;
    Some((handle, shell))
}

/// Run `f` on the shell of each window `which` picks, in its own window.
pub(crate) fn for_shells(
    cx: &mut App,
    which: impl Fn(WindowId) -> bool,
    mut f: impl FnMut(&mut Shell, &mut Window, &mut Context<Shell>),
) {
    let shells: Vec<(WindowId, Entity<Shell>)> = cx
        .try_global::<Shells>()
        .map(|shells| {
            shells
                .0
                .iter()
                .filter(|(id, _)| which(**id))
                .filter_map(|(id, shell)| Some((*id, shell.upgrade()?)))
                .collect()
        })
        .unwrap_or_default();
    for handle in cx.windows() {
        if let Some((_, shell)) = shells.iter().find(|(id, _)| *id == handle.window_id()) {
            handle
                .update(cx, |_, window, cx| {
                    shell.update(cx, |shell, cx| f(shell, window, cx))
                })
                .ok();
        }
    }
}

/// A new window, opening `root` when given, a step down and right from the
/// window at `from` (else the window in front). A caller inside a window's
/// update passes that window's bounds: the window being updated cannot be
/// read through its handle.
pub fn new_window(root: Option<PathBuf>, from: Option<Bounds<Pixels>>, cx: &mut App) {
    let from = from.or_else(|| {
        cx.active_window()
            .and_then(|window| window.update(cx, |_, window, _| window.bounds()).ok())
    });
    let bounds = from.map(|bounds| Bounds {
        origin: point(bounds.origin.x + px(CASCADE), bounds.origin.y + px(CASCADE)),
        size: bounds.size,
    });
    match Shell::open_window_with(root, bounds, cx) {
        Ok(_) => cx.activate(true),
        Err(error) => log::error!("could not open a window: {error:#}"),
    }
}

impl Shell {
    /// The project in front, moved to a window of its own once its edits
    /// are saved, as `should_close` saves them; this window goes on with its
    /// next project, or closes when it held no other. A save that fails or
    /// is held keeps the project here, with the save's notice.
    pub(crate) fn open_in_new_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        self.save_layout(cx);
        let saved = self.save_before_leaving(cx);
        cx.spawn_in(window, async move |this, cx| {
            if let Some(saved) = saved
                && !saved.await
            {
                return;
            }
            this.update_in(cx, |this, window, cx| {
                let from = window.bounds();
                if this.projects.len() > 1 {
                    this.close_project(&root, window, cx);
                } else {
                    window.remove_window();
                }
                new_window(Some(root), Some(from), cx);
            })
            .ok();
        })
        .detach();
    }

    /// Step the interface size from a key, the menu or the palette, and
    /// raise this window's size pill.
    pub(crate) fn zoom_interface(
        &mut self,
        change: crate::interface_zoom::Change,
        cx: &mut Context<Self>,
    ) {
        crate::interface_zoom::zoom(change, cx);
        self.reveal_zoom_hud(cx);
    }

    /// Raise this window's interface size pill.
    pub(crate) fn reveal_zoom_hud(&mut self, cx: &mut Context<Self>) {
        self.zoom_hud.update(cx, |hud, cx| hud.reveal(cx));
    }

    /// The interface size pill, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn zoom_hud(&self) -> &Entity<crate::interface_zoom::ZoomHud> {
        &self.zoom_hud
    }

    /// The project `step` tabs along, round the window's projects.
    pub(crate) fn step_project(
        &mut self,
        step: isize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(current) = self
            .root(cx)
            .and_then(|root| self.projects.iter().position(|p| p.root == root))
        else {
            return;
        };
        let count = self.projects.len() as isize;
        if count < 2 {
            return;
        }
        let next = (current as isize + step).rem_euclid(count) as usize;
        let root = self.projects[next].root.clone();
        self.open_project(root, window, cx);
    }

    pub(crate) fn switch_project(
        &mut self,
        root: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.root(cx).as_ref() != Some(&root) {
            self.open_project(root, window, cx);
        }
    }

    /// Open `root` in place of the project shown, once the shown project's
    /// edits are saved, taking the `closing` project's tab out with it. A
    /// save that fails or is held keeps the shown project, its editors and
    /// the save's notice, as closing the window does.
    pub(super) fn leave_for(
        &mut self,
        root: PathBuf,
        closing: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Leaving ends this project's shells: ask first while a command
        // runs in one (`confirmLeavingProject`).
        if self.root(cx).is_some_and(|current| current != root)
            && self.ask_before_leaving(root.clone(), closing.clone(), cx)
        {
            return;
        }
        self.leave_now(root, closing, window, cx);
    }

    pub(super) fn leave_now(
        &mut self,
        root: PathBuf,
        closing: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save_layout(cx);
        let saved = self.save_before_leaving(cx);
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            if let Some(saved) = saved
                && !saved.await
            {
                return;
            }
            match crate::project::open(root.clone(), cx).await {
                Ok(project) => {
                    this.update_in(cx, |this, window, cx| {
                        this.set_project(project, window, cx);
                        if let Some(closing) = closing {
                            this.projects.retain(|p| p.root != closing);
                        }
                    })
                    .ok();
                }
                Err(error) => {
                    log::error!("could not open {}: {error}", root.display());
                    cx.update(|_, cx| {
                        crate::notices::error(t!("Could not open the project"), error, cx)
                    })
                    .ok();
                }
            }
        }));
    }

    /// Take `root` out of this window. The one shown goes once its right-hand
    /// neighbour (else its left) is open in its place, which waits for its
    /// edits to be saved (`leave_for`).
    pub(crate) fn close_project(
        &mut self,
        root: &PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self.projects.iter().position(|p| p.root == *root) else {
            return;
        };
        if self.projects.len() < 2 {
            return;
        }
        if self.root(cx).as_ref() == Some(root) {
            let next = self
                .projects
                .get(index + 1)
                .or_else(|| index.checked_sub(1).and_then(|ix| self.projects.get(ix)))
                .map(|p| p.root.clone());
            if let Some(next) = next {
                self.leave_for(next, Some(root.clone()), window, cx);
            }
            return;
        }
        self.projects.retain(|p| p.root != *root);
        cx.notify();
    }

    /// `root` given a window of its own, out of this one.
    pub(crate) fn move_project_to_window(
        &mut self,
        root: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.root(cx).as_ref() == Some(&root) {
            self.open_in_new_window(window, cx);
        } else {
            self.projects.retain(|p| p.root != root);
            cx.notify();
            new_window(Some(root), Some(window.bounds()), cx);
        }
    }
}

/// A new window's size: 1440×900, or `LATTICE_WINDOW_SIZE` (`1015x680`), which
/// lets a run lay the window out as a smaller screen would (GitHub's runners
/// shrink the window to about 1015px wide).
pub(super) fn window_size() -> gpui::Size<gpui::Pixels> {
    std::env::var("LATTICE_WINDOW_SIZE")
        .ok()
        .and_then(|value| {
            let (width, height) = value.split_once('x')?;
            Some(size(
                px(width.trim().parse().ok()?),
                px(height.trim().parse().ok()?),
            ))
        })
        .unwrap_or_else(|| size(px(1440.), px(900.)))
}

#[cfg(target_os = "macos")]
pub(super) fn titlebar_options() -> Option<gpui::TitlebarOptions> {
    // Lattice draws its own 40px titlebar with the traffic lights centred in
    // it, 20px from the top (src-tauri/src/traffic_lights.rs).
    Some(gpui::TitlebarOptions {
        title: None,
        appears_transparent: true,
        traffic_light_position: Some(gpui::point(px(14.), px(13.))),
    })
}

/// Elsewhere the system keeps its title bar, and Lattice's sits under it.
#[cfg(not(target_os = "macos"))]
pub(super) fn titlebar_options() -> Option<gpui::TitlebarOptions> {
    None
}

/// The name of a project as its tab shows it: the name in its manifest,
/// else the folder's.
pub(super) fn project_display_name(root: &Path) -> SharedString {
    lattice_core::project::read_manifest(root)
        .ok()
        .map(|manifest| manifest.name)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
        .into()
}
