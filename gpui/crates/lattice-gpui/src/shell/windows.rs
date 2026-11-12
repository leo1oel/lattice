//! Windows, and the projects in each (`src/app/window-projects.ts`).
//!
//! Every window registers its shell, so app-wide hooks (the dock's close and
//! menu items, the menu bar) find the window they act in. A window holds
//! one or more projects: a second project opened in it shows tabs in the
//! titlebar, each remembering its own layout; ⌃Tab and ⌃⇧Tab go round them
//! and the last one left folds the tabs back into the project's title. A
//! project moves to a window of its own from its tab's menu.

use std::{collections::HashMap, path::PathBuf};

use gpui::{
    AnyWindowHandle, App, Bounds, Context, Entity, Global, WeakEntity, Window, WindowId, point, px,
    size,
};

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

/// The shell of the window `window`.
pub fn shell_for(window: &Window, cx: &App) -> Option<Entity<Shell>> {
    cx.try_global::<Shells>()?
        .0
        .get(&window.window_handle().window_id())?
        .upgrade()
}

/// A new window, opening `root` when given, a step down and right from the
/// window in front.
pub fn new_window(root: Option<PathBuf>, cx: &mut App) {
    let bounds = cx
        .active_window()
        .and_then(|window| window.update(cx, |_, window, _| window.bounds()).ok())
        .map(|bounds| Bounds {
            origin: point(bounds.origin.x + px(CASCADE), bounds.origin.y + px(CASCADE)),
            size: bounds.size,
        })
        .or_else(|| Some(Bounds::centered(None, size(px(1440.), px(900.)), cx)));
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
                if this.projects.len() > 1 {
                    this.close_project(&root, window, cx);
                } else {
                    window.remove_window();
                }
                new_window(Some(root), cx);
            })
            .ok();
        })
        .detach();
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

    /// Take `root` out of this window, switching to its right-hand
    /// neighbour (else its left) first when it is the one shown.
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
                self.open_project(next, window, cx);
            }
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
            new_window(Some(root), cx);
        }
    }
}
