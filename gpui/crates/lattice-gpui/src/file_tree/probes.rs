//! What a scenario reads from the tree and does to it, as a pointer or the
//! keyboard would.

use gpui::{App, Context, Focusable as _, SharedString, Window};

use super::{FileTreeEvent, FileTreePanel};

impl FileTreePanel {
    /// Drop the row at `path` on the folder `target`, as a drag ending there
    /// does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn drop_on(&mut self, path: String, target: String, cx: &mut Context<Self>) {
        cx.emit(FileTreeEvent::Move {
            paths: vec![path],
            target,
        });
    }

    /// The row being named, its field's text and whether the field has
    /// focus, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn naming_state(&self, window: &Window, cx: &App) -> Option<(String, String, bool)> {
        self.naming.as_ref().map(|naming| {
            let input = naming.input.read(cx);
            (
                naming.path.clone(),
                input.value().to_string(),
                input.focus_handle(cx).is_focused(window),
            )
        })
    }

    /// Give the row being named `name` and confirm it as Enter does, for a
    /// scenario. Typing into the field is GPUI Kit's own, and takes a window
    /// that draws: a scripted run on a locked screen gets no frames.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn confirm_name(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.naming.as_ref().map(|naming| naming.input.clone()) else {
            return;
        };
        input.update(cx, |input, cx| {
            input.set_value(name.to_string(), window, cx)
        });
        self.commit_naming(true, window, cx);
    }

    /// Select the row at `path` and give the tree the keyboard, as a click
    /// on the row does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn select_row(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let id = SharedString::from(path.to_string());
        let Some(ix) = self.state.read(cx).index_of(&id) else {
            return false;
        };
        self.state
            .update(cx, |state, cx| state.set_selected_index(Some(ix), cx));
        self.selection.only(path);
        window.focus(&self.focus_handle, cx);
        self.redraw_rows(cx);
        true
    }

    /// The selected rows, project-relative, and the folders kept open for
    /// the project, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn selection_state(&self, cx: &App) -> (Vec<String>, Vec<String>) {
        let mut open: Vec<String> = self.expanded.iter().cloned().collect();
        open.sort();
        (self.selected_paths(cx), open)
    }

    /// The folder + makes a new LaTeX file in, "" for the project root, for
    /// a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn new_entry_folder(&self, cx: &App) -> String {
        self.selection_folder(cx)
    }

    /// The folders kept open for the project across runs, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn remembered_open(&self, cx: &App) -> Vec<String> {
        self.project
            .as_ref()
            .map(|project| {
                super::memory::expanded(project.read(cx).root())
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The rows on screen, project-relative, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn row_paths(&self, cx: &App) -> Vec<String> {
        let state = self.state.read(cx);
        (0..)
            .map_while(|ix| state.entry(ix))
            .map(|entry| entry.item().id.to_string())
            .collect()
    }

    /// The folder a drag over the tree is aimed at now, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn drop_folder(&self, cx: &App) -> Option<String> {
        self.aim.borrow().folder(cx)
    }

    /// What the rows' fluid hover shows, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn hover_snapshot(&self, cx: &App) -> Option<lattice_ui::fluid_hover::FluidHoverSnapshot> {
        self.hover.as_ref().map(|hover| hover.snapshot(cx))
    }

    /// Whether the rows' context menu is open and holds focus, for a scripted
    /// check.
    pub fn row_menu_focused(&self, window: &Window, cx: &App) -> bool {
        self.row_menu
            .as_ref()
            .is_some_and(|menu| menu.read(cx).is_focused(window))
    }

    /// The row whose context menu is open (its path), for a scripted check.
    pub fn row_menu_target(&self, cx: &App) -> Option<String> {
        self.row_menu
            .as_ref()
            .and_then(|menu| menu.read(cx).target().map(|(path, _)| path.clone()))
    }

    /// What Delete in the row menu of `path` does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn delete_from_menu(&mut self, path: &str, cx: &mut Context<Self>) {
        let paths = super::including(&self.selected_paths(cx), path);
        self.ask_delete(paths, cx);
    }

    /// The type-to-filter field's text, its query, the match in focus and
    /// whether the field has the keyboard, while it is open, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn search_state(
        &self,
        window: &Window,
        cx: &App,
    ) -> Option<(String, String, Option<String>, bool)> {
        self.search.as_ref().map(|search| {
            let input = search.input.read(cx);
            (
                input.value().to_string(),
                search.query.clone(),
                search.focus.clone(),
                input.focus_handle(cx).is_focused(window),
            )
        })
    }

    /// Put `text` in the open filter field, as typing it there does, for a
    /// scenario: typing into the field is GPUI Kit's own (`confirm_name`).
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn type_in_search(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.search.as_ref().map(|search| search.input.clone()) else {
            return;
        };
        input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
        if let Some(search) = &mut self.search {
            search.query = super::search::normalize(text);
        }
        self.rebuild(cx);
        let first = self.search_matches(cx).into_iter().next();
        if let Some(search) = &mut self.search {
            search.focus = first;
        }
    }

    /// The pinned folders' paths and tops, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn pinned_state(&self, cx: &App) -> Vec<(String, f32)> {
        let state = self.state.read(cx);
        self.pinned_rows(cx)
            .into_iter()
            .filter_map(|pin| Some((state.entry(pin.ix)?.item().id.to_string(), pin.top)))
            .collect()
    }

    /// How far the rows are scrolled, in rows, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scrolled_rows(&self, cx: &App) -> f32 {
        let scroll = self.state.read(cx).scroll_handle().clone();
        -f32::from(scroll.0.borrow().base_handle.offset().y) / super::motion::ROW
    }

    /// The folder moving, whether it opened, and how many rows it moves,
    /// for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn motion_state(&self, cx: &App) -> Option<(String, bool, usize)> {
        let motion = self.motion.as_ref()?;
        let folder = self
            .state
            .read(cx)
            .entry(motion.folder)?
            .item()
            .id
            .to_string();
        Some((folder, motion.opened, motion.rows))
    }

    /// Every row's id, shown or inside a closed folder, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn all_row_ids(&self, _: &App) -> std::rc::Rc<std::collections::HashSet<String>> {
        self.known.clone()
    }

    /// Scroll the rows to `rows` down, as the scrollbar would, for a
    /// scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scroll_rows_to(&mut self, rows: f32, cx: &mut Context<Self>) {
        let scroll = self.state.read(cx).scroll_handle().clone();
        let y = gpui::px(-rows * super::motion::ROW);
        scroll
            .0
            .borrow()
            .base_handle
            .set_offset(gpui::point(gpui::px(0.), y));
        self.redraw_rows(cx);
    }
}
