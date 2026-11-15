//! Windows, and the projects in each (`src/app/window-projects.ts`).
//!
//! Every window registers its shell, so app-wide hooks (the dock's close and
//! menu items, the menu bar) find the window they act in. A window holds
//! one or more projects: a second project opened in it shows tabs in the
//! titlebar, each remembering its own layout; ⌃Tab and ⌃⇧Tab go round them
//! and the last one left folds the tabs back into the project's title. A
//! project moves to a window of its own from its tab's menu.
//!
//! The first window of a launch opens where the last one was left
//! (`tauri-plugin-window-state`), and every window's minimum size follows
//! its layout's, as the Tauri app's does (`use-native-window.ts`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, DisplayId, Entity, Global, Pixels,
    SharedString, WeakEntity, Window, WindowBounds, WindowId, point, px, size,
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
    window
        .update(cx, |_, window, cx| {
            shell.update(cx, |shell, cx| shell.watch_placement(window, cx))
        })
        .ok();
}

/// The narrowest and shortest a window may be (`APP_WINDOW_MIN_WIDTH` and
/// `APP_WINDOW_MIN_HEIGHT`): room for the titlebar's controls. The live
/// minimum is the layout's own ([`minimum_width`]).
pub(crate) const MIN_WIDTH: f32 = 640.;
pub(crate) const MIN_HEIGHT: f32 = 680.;

/// The workspace's padding beside the layout (`main.workspace`'s 6px on
/// each side), which the window's minimum adds to the layout's.
const WORKSPACE_SIDES: f64 = 12.;

/// The native minimum width, in points (`minimumWindowWidth`): the layout's
/// minimum, never below [`MIN_WIDTH`], grown by the interface size, which
/// changes how many points the same layout needs, and never wider than the
/// screen can show.
pub(crate) fn minimum_width(layout: f64, scale: f32, screen: Option<f32>) -> f32 {
    let scale = if scale.is_finite() {
        scale.max(0.1)
    } else {
        1.
    };
    let content = if layout.is_finite() {
        (layout as f32).max(MIN_WIDTH)
    } else {
        MIN_WIDTH
    };
    let width = (content * scale).ceil();
    match screen {
        Some(screen) if screen.is_finite() && screen > 0. => width.min(screen.floor()),
        _ => width,
    }
}

/// The windows in full screen, which View › Enter Full Screen's title
/// follows, as AppKit's own item's does.
#[derive(Default)]
struct FullScreen(std::collections::HashSet<WindowId>);

impl Global for FullScreen {}

/// Whether the window `id` is in full screen.
pub(crate) fn is_fullscreen(id: WindowId, cx: &App) -> bool {
    cx.try_global::<FullScreen>()
        .is_some_and(|windows| windows.0.contains(&id))
}

/// Note whether `window` is in full screen now, and lay the menus out again
/// when that changed.
fn follow_fullscreen(window: &Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    let windows = &mut cx.default_global::<FullScreen>().0;
    let changed = if window.is_fullscreen() {
        windows.insert(id)
    } else {
        windows.remove(&id)
    };
    if changed {
        super::menus::refresh(cx);
    }
}

/// The minimum width each window was given last.
#[derive(Default)]
struct MinimumWidths(HashMap<WindowId, f32>);

impl Global for MinimumWidths {}

/// The minimum width `window` was given last, for a scenario.
#[cfg(target_os = "windows")]
pub(crate) fn applied_minimum_width(window: &Window, cx: &App) -> Option<f32> {
    cx.try_global::<MinimumWidths>()?
        .0
        .get(&window.window_handle().window_id())
        .copied()
}

/// Where a window is: its bounds, which GPUI gives from the top left of
/// the window's own display, and that display.
#[derive(Clone, Copy)]
pub(crate) struct Place {
    pub bounds: Bounds<Pixels>,
    pub display: Option<DisplayId>,
}

/// Where `window` is now.
pub(crate) fn place_of(window: &Window, cx: &App) -> Place {
    Place {
        bounds: window.bounds(),
        display: window.display(cx).map(|display| display.id()),
    }
}

/// Where the windows' place is remembered between launches, as the Tauri
/// app's window-state plugin remembers it: the size, the position, the
/// display, and whether the window was maximized or full screen. A scripted
/// run keeps none, so its windows open where the run puts them.
#[derive(Default)]
struct Placements {
    file: Option<PathBuf>,
    /// The place read at launch, which only the first window takes: a new
    /// window steps down from the one in front instead.
    launch: Option<Placement>,
    /// The place waiting to be written, a burst of moves written once.
    _write: Option<gpui::Task<()>>,
}

impl Global for Placements {}

/// How long a move or resize waits before its place is written.
const PLACEMENT_SETTLE: std::time::Duration = std::time::Duration::from_millis(400);

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Placement {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
    /// The display's UUID, which outlives its id across launches.
    #[serde(default)]
    display: Option<String>,
}

impl Placement {
    fn of(bounds: WindowBounds, display: Option<String>) -> Self {
        let (inner, maximized, fullscreen) = match bounds {
            WindowBounds::Windowed(inner) => (inner, false, false),
            WindowBounds::Maximized(inner) => (inner, true, false),
            WindowBounds::Fullscreen(inner) => (inner, false, true),
        };
        Self {
            x: f32::from(inner.origin.x),
            y: f32::from(inner.origin.y),
            width: f32::from(inner.size.width),
            height: f32::from(inner.size.height),
            maximized,
            fullscreen,
            display,
        }
    }

    fn bounds(&self) -> Option<WindowBounds> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite())
            || self.width < MIN_WIDTH / 2.
            || self.height < MIN_HEIGHT / 2.
        {
            return None;
        }
        let inner = Bounds {
            origin: point(px(self.x), px(self.y)),
            size: size(px(self.width), px(self.height)),
        };
        Some(if self.fullscreen {
            WindowBounds::Fullscreen(inner)
        } else if self.maximized {
            WindowBounds::Maximized(inner)
        } else {
            WindowBounds::Windowed(inner)
        })
    }
}

/// Read the place the last window was left in, from the state folder
/// (`None`: a run that remembers none).
pub(crate) fn init_placements(state: Option<PathBuf>, cx: &mut App) {
    let file = state.map(|state| state.join("window-state.json"));
    let launch = file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<Placement>(&text).ok());
    cx.set_global(Placements {
        file,
        launch,
        _write: None,
    });
}

/// The first window's place and display: where the last one was left, on
/// the display it was on (the main one when that display is gone), when
/// enough of it still shows there, else centred at the default size. Taken
/// once.
pub(super) fn launch_bounds(cx: &mut App) -> (WindowBounds, Option<DisplayId>) {
    let remembered = if cx.has_global::<Placements>() {
        cx.global_mut::<Placements>().launch.take()
    } else {
        None
    };
    // `LATTICE_WINDOW_SIZE` lays a run out as a smaller screen would.
    let sized = std::env::var_os("LATTICE_WINDOW_SIZE").is_some();
    remembered
        .filter(|_| !sized)
        .and_then(|placement| {
            let bounds = placement.bounds()?;
            let display = placement
                .display
                .as_deref()
                .and_then(|uuid| {
                    cx.displays()
                        .into_iter()
                        .find(|display| display.uuid().is_ok_and(|id| id.to_string() == uuid))
                })
                .or_else(|| cx.primary_display())?;
            reaches(bounds.get_bounds(), display.bounds()).then(|| (bounds, Some(display.id())))
        })
        .unwrap_or_else(|| {
            (
                WindowBounds::Windowed(Bounds::centered(None, window_size(), cx)),
                None,
            )
        })
}

/// Whether enough of `bounds` shows on `screen` to grab it, both from the
/// screen's top left: a display rearranged or swapped since can leave a
/// place nobody could reach.
fn reaches(bounds: Bounds<Pixels>, screen: Bounds<Pixels>) -> bool {
    let overlap = screen.intersect(&bounds);
    f32::from(overlap.size.width) >= 100. && f32::from(overlap.size.height) >= 40.
}

/// Keep `bounds` on `display` to be written once the window has settled.
fn remember(bounds: WindowBounds, display: Option<String>, cx: &mut App) {
    let Some(file) = cx
        .try_global::<Placements>()
        .and_then(|placements| placements.file.clone())
    else {
        return;
    };
    let placement = Placement::of(bounds, display);
    let write = cx.spawn(async move |cx| {
        cx.background_executor().timer(PLACEMENT_SETTLE).await;
        cx.background_spawn(async move {
            if let Some(folder) = file.parent() {
                std::fs::create_dir_all(folder).ok();
            }
            if let Ok(text) = serde_json::to_string(&placement) {
                let temporary = file.with_extension("json.tmp");
                if std::fs::write(&temporary, text).is_ok() {
                    std::fs::rename(&temporary, &file).ok();
                }
            }
        })
        .await;
    });
    cx.global_mut::<Placements>()._write = Some(write);
}

/// How many windows have a build under way, for a restart's warning.
pub(crate) fn running_builds(cx: &App) -> usize {
    cx.try_global::<Shells>().map_or(0, |shells| {
        shells
            .0
            .values()
            .filter_map(|shell| shell.upgrade())
            .filter(|shell| shell.read(cx).building())
            .count()
    })
}

/// The shell drawn in `window`, if it is a workspace window.
pub(crate) fn shell_of(window: AnyWindowHandle, cx: &App) -> Option<Entity<Shell>> {
    cx.try_global::<Shells>()?
        .0
        .get(&window.window_id())?
        .upgrade()
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

/// Whether a sheet in any window is writing to its project.
pub(crate) fn any_overlay_writing(cx: &App) -> bool {
    cx.try_global::<Shells>().is_some_and(|shells| {
        shells
            .0
            .values()
            .filter_map(|shell| shell.upgrade())
            .any(|shell| shell.read(cx).overlay_writing(cx))
    })
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
/// window at `from` (else the window in front), on its display. A caller
/// inside a window's update passes that window's place: the window being
/// updated cannot be read through its handle.
pub fn new_window(root: Option<PathBuf>, from: Option<Place>, cx: &mut App) {
    let from = from.or_else(|| {
        cx.active_window()
            .and_then(|window| window.update(cx, |_, window, cx| place_of(window, cx)).ok())
    });
    let place = from.map(|from| Place {
        bounds: Bounds {
            origin: point(
                from.bounds.origin.x + px(CASCADE),
                from.bounds.origin.y + px(CASCADE),
            ),
            size: from.bounds.size,
        },
        display: from.display,
    });
    match Shell::open_window_with(root, place, cx) {
        Ok(_) => cx.activate(true),
        Err(error) => log::error!("could not open a window: {error:#}"),
    }
}

/// The Dock icon clicked with no window open: a window again, reopening
/// the project used last as a launch does.
pub(crate) fn reopen(cx: &mut App) {
    match Shell::open_window(None, cx) {
        Ok((window, shell)) => {
            window
                .update(cx, |_, window, cx| {
                    shell.update(cx, |shell, cx| shell.launch(window, cx))
                })
                .ok();
            cx.activate(true);
        }
        Err(error) => log::error!("could not reopen Lattice: {error:#}"),
    }
}

impl Shell {
    /// Remember where the window goes, and keep its minimum size the
    /// layout's (`useWindowMinimumSize`): the layout's own minimum, grown by
    /// the interface size, never wider than the screen.
    fn watch_placement(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.observe_window_bounds(window, |this, window, cx| {
            let display = window
                .display(cx)
                .and_then(|display| display.uuid().ok())
                .map(|uuid| uuid.to_string());
            remember(window.window_bounds(), display, cx);
            follow_fullscreen(window, cx);
            this.apply_minimum_size(window, cx);
        })
        .detach();
        cx.observe_in(&self.workspace.clone(), window, |this, _, window, cx| {
            this.apply_minimum_size(window, cx)
        })
        .detach();
        cx.observe_global_in::<crate::settings::AppSettings>(window, |this, window, cx| {
            this.apply_minimum_size(window, cx)
        })
        .detach();
        self.apply_minimum_size(window, cx);
    }

    /// The layout's own minimum width, the workspace's padding included.
    pub(crate) fn layout_minimum_width(&self, cx: &App) -> f64 {
        self.workspace.read(cx).engine().min_width() + WORKSPACE_SIDES
    }

    fn apply_minimum_size(&self, window: &mut Window, cx: &mut Context<Self>) {
        let layout = self.layout_minimum_width(cx);
        let screen = window
            .display(cx)
            .map(|display| f32::from(display.visible_bounds().size.width));
        let width = minimum_width(layout, crate::interface_zoom::scale(cx), screen);
        // Setting an unchanged minimum still makes AppKit re-clamp the window.
        let applied = cx.default_global::<MinimumWidths>();
        if applied.0.insert(window.window_handle().window_id(), width) == Some(width) {
            return;
        }
        #[cfg(target_os = "macos")]
        if let Ok(native) = crate::native::native(window) {
            crate::native::set_content_min_size(native, width.into(), MIN_HEIGHT.into());
        }
    }

    /// The project in front, moved to a window of its own once its edits
    /// are saved, as `should_close` saves them; this window goes on with its
    /// next project, or closes when it held no other. A save that fails or
    /// is held keeps the project here, with the save's notice.
    pub(crate) fn open_in_new_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay_writing(cx) {
            return;
        }
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
                if this.overlay_writing(cx) {
                    return;
                }
                let from = place_of(window, cx);
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
        if self.overlay_writing(cx) {
            return;
        }
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
        // A sheet still writing keeps its project (checked again here: the
        // shells' confirmation can answer after a write began).
        if self.overlay_writing(cx) {
            return;
        }
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
                        if this.overlay_writing(cx) {
                            return;
                        }
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
        if self.overlay_writing(cx) {
            return;
        }
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
        if self.overlay_writing(cx) {
            return;
        }
        if self.root(cx).as_ref() == Some(&root) {
            self.open_in_new_window(window, cx);
        } else {
            self.projects.retain(|p| p.root != root);
            cx.notify();
            new_window(Some(root), Some(place_of(window, cx)), cx);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_minimum_follows_the_layout_and_the_interface_size_within_the_screen() {
        // window-layout.test.ts's expectations.
        assert_eq!(minimum_width(500., 1., None), MIN_WIDTH);
        assert_eq!(minimum_width(900., 1., None), 900.);
        assert_eq!(minimum_width(900., 1.25, None), 1125.);
        assert_eq!(minimum_width(900., 1.25, Some(1000.4)), 1000.);
        assert_eq!(minimum_width(f64::NAN, 1., None), MIN_WIDTH);
        assert_eq!(minimum_width(700., f32::NAN, None), 700.);
    }

    #[test]
    fn a_place_is_kept_with_its_state_and_a_broken_one_is_dropped() {
        let inner = Bounds {
            origin: point(px(40.), px(60.)),
            size: size(px(1200.), px(800.)),
        };
        for bounds in [
            WindowBounds::Windowed(inner),
            WindowBounds::Maximized(inner),
            WindowBounds::Fullscreen(inner),
        ] {
            let display = Some("9C1E2A3B-0000-4000-8000-000000000001".to_string());
            let text = serde_json::to_string(&Placement::of(bounds, display.clone())).unwrap();
            let read: Placement = serde_json::from_str(&text).unwrap();
            assert_eq!(read.bounds(), Some(bounds));
            assert_eq!(read.display, display);
        }
        let tiny = Placement {
            x: 0.,
            y: 0.,
            width: 10.,
            height: 10.,
            maximized: false,
            fullscreen: false,
            display: None,
        };
        assert_eq!(tiny.bounds(), None);
        let older: Placement =
            serde_json::from_str(r#"{"x":1,"y":2,"width":900,"height":700}"#).unwrap();
        assert_eq!(
            older.bounds().map(|bounds| bounds.get_bounds().size.width),
            Some(px(900.))
        );
        assert_eq!(older.display, None);
    }

    #[test]
    fn a_place_counts_only_when_enough_of_it_shows_on_its_display() {
        // A 1440×900 display, its own top left at the origin, as GPUI gives
        // a display's bounds and the window's on it.
        let screen = Bounds {
            origin: point(px(0.), px(0.)),
            size: size(px(1440.), px(900.)),
        };
        let at = |x: f32, y: f32| Bounds {
            origin: point(px(x), px(y)),
            size: size(px(1200.), px(800.)),
        };
        assert!(reaches(at(100., 100.), screen));
        // 100×40 left on screen is still a titlebar to grab; less is not.
        assert!(reaches(at(1340., 860.), screen));
        assert!(!reaches(at(1341., 100.), screen));
        assert!(!reaches(at(100., 861.), screen));
        // Left of a display that is no longer there.
        assert!(!reaches(at(-2000., 100.), screen));
    }
}
