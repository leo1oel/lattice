//! Which rows are selected, as the Tauri app's tree selects them (Pierre's
//! selection in `src/project/project-file-tree.tsx`):
//!
//! - A click selects only its row; ⌘-click adds or removes one row; ⇧-click
//!   selects the rows shown from the last clicked row to this one.
//! - A row's menu, a drag and ⌘C act on the whole selection when the row is
//!   in it, else on that row alone (`selectionIncluding`), and a row inside a
//!   selected folder goes with its folder (`normalizePointerDraggedPaths`).
//! - The arrow keys move Kit's tree's own selection: a row it moves to
//!   becomes the one row selected.
//! - Opening a file the selection does not hold selects it alone, its folders
//!   opened down to it and its row brought into view, once each time it
//!   opens; opening one the selection holds keeps the rest, so the next drag
//!   or delete is still a batch.

use gpui::{
    App, ClickEvent, Context, KeyDownEvent, Modifiers, ScrollStrategy, SharedString, Window,
};

use super::{FileTreeEvent, FileTreePanel};

#[derive(Default)]
pub(super) struct Selection {
    /// The selected rows, project-relative, in the order they were chosen.
    paths: Vec<String>,
    /// Where a ⇧-click's range starts: the row last clicked without ⇧.
    anchor: Option<String>,
    /// The row Kit's tree had selected when this selection was made: when its
    /// selection has moved on since (an arrow key), its row is the selection.
    cursor: Option<String>,
}

impl Selection {
    pub(super) fn only(&mut self, path: &str) {
        self.paths = vec![path.to_string()];
        self.anchor = Some(path.to_string());
        self.cursor = Some(path.to_string());
    }

    /// ⌘-click: add the row, or take it out.
    pub(super) fn toggle(&mut self, path: &str) {
        if let Some(ix) = self.paths.iter().position(|selected| selected == path) {
            self.paths.remove(ix);
        } else {
            self.paths.push(path.to_string());
        }
        self.anchor = Some(path.to_string());
        self.cursor = Some(path.to_string());
    }

    /// ⇧-click: the rows from the anchor to `path`, in `rows`' order (the
    /// rows shown). Without an anchor on screen it selects `path` alone.
    pub(super) fn extend(&mut self, path: &str, rows: &[String]) {
        let anchor = self
            .anchor
            .as_deref()
            .and_then(|anchor| rows.iter().position(|row| row == anchor));
        let (Some(from), Some(to)) = (anchor, rows.iter().position(|row| row == path)) else {
            self.only(path);
            return;
        };
        let (start, end) = (from.min(to), from.max(to));
        self.paths = rows[start..=end].to_vec();
        self.cursor = Some(path.to_string());
    }

    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }

    /// Keep only the rows `keep` says are still there.
    pub(super) fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.paths.retain(|path| keep(path));
        if self.anchor.as_deref().is_some_and(|anchor| !keep(anchor)) {
            self.anchor = None;
        }
    }

    pub(super) fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// The selection as Kit's tree's row `kit` leaves it.
    pub(super) fn effective(&self, kit: Option<&str>) -> Vec<String> {
        match kit {
            Some(kit) if self.cursor.as_deref() != Some(kit) => vec![kit.to_string()],
            _ => self.paths.clone(),
        }
    }
}

/// `paths` without repeats, and without a row whose folder is among them:
/// it goes with its folder.
pub(super) fn outermost(paths: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for path in paths {
        if kept.contains(path) {
            continue;
        }
        let inside = paths
            .iter()
            .any(|other| other != path && path.starts_with(&format!("{other}/")));
        if !inside {
            kept.push(path.clone());
        }
    }
    kept
}

/// What a row's menu, drag or ⌘C acts on: the selection when it holds
/// `path`, else `path` alone.
pub(super) fn including(selected: &[String], path: &str) -> Vec<String> {
    if selected.iter().any(|selected| selected == path) {
        outermost(selected)
    } else {
        vec![path.to_string()]
    }
}

impl FileTreePanel {
    /// The selected rows, project-relative, in the order chosen.
    pub(crate) fn selected_paths(&self, cx: &App) -> Vec<String> {
        let kit = self
            .state
            .read(cx)
            .selected_entry()
            .map(|entry| entry.item().id.to_string());
        self.selection.effective(kit.as_deref())
    }

    /// The rows shown, top to bottom, project-relative.
    pub(super) fn shown_rows(&self, cx: &App) -> Vec<String> {
        let state = self.state.read(cx);
        (0..)
            .map_while(|ix| state.entry(ix))
            .map(|entry| entry.item().id.to_string())
            .collect()
    }

    /// Point Kit's tree's selection, the keyboard's row, at `path`.
    fn point_kit_at(&mut self, path: Option<&str>, cx: &mut Context<Self>) {
        let ix = path.and_then(|path| {
            self.state
                .read(cx)
                .index_of(&SharedString::from(path.to_string()))
        });
        self.state
            .update(cx, |state, cx| state.set_selected_index(ix, cx));
    }

    /// After Kit's tree took new rows (which drops its selection): the
    /// selection keeps what is still there, the keyboard's row with it, and a
    /// file waiting to be revealed is revealed when its row has arrived.
    pub(super) fn settle_selection(&mut self, cx: &mut Context<Self>) {
        let rows = self.all_paths(cx);
        self.selection.retain(|path| rows.contains(path));
        let cursor = self.selection.cursor().map(str::to_string);
        self.point_kit_at(cursor.as_deref(), cx);
        self.reveal_pending(cx);
    }

    /// A click on the row at `path`, before Kit's tree sees it: ⌘ and ⇧ pick
    /// rows and stop there, so the click neither opens nor toggles; a plain
    /// click selects the row alone and goes on to Kit's tree, which toggles a
    /// folder, and a file's row opens.
    pub(super) fn click_row(
        &mut self,
        path: &str,
        folder: bool,
        event: &ClickEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pick(path, folder, event.modifiers(), cx) {
            cx.stop_propagation();
        }
    }

    /// What a click with `modifiers` does to the row at `path`; true when it
    /// only picked rows, which Kit's tree must not see.
    pub(super) fn pick(
        &mut self,
        path: &str,
        folder: bool,
        modifiers: Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        let Modifiers {
            platform, shift, ..
        } = modifiers;
        if platform || shift {
            if shift {
                let rows = self.shown_rows(cx);
                self.selection.extend(path, &rows);
            } else {
                self.selection.toggle(path);
            }
            self.point_kit_at(Some(path), cx);
            self.redraw_rows(cx);
            return true;
        }
        self.selection.only(path);
        self.redraw_rows(cx);
        if !folder && let Some(project) = &self.project {
            let absolute = project.read(cx).root().join(path);
            cx.emit(FileTreeEvent::Open(absolute));
        }
        false
    }

    /// Enter names the one selected row anew (`project-file-tree.tsx`); with
    /// several selected it does nothing.
    pub(super) fn rename_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let keystroke = &event.keystroke;
        if keystroke.key != "enter" || keystroke.modifiers.modified() || self.naming.is_some() {
            return;
        }
        if let [path] = self.selected_paths(cx).as_slice() {
            cx.stop_propagation();
            self.begin_rename(path.clone(), window, cx);
        }
    }

    /// The file in front changed: unless the selection holds it, select it
    /// alone, and bring its row into view the first time it is open.
    pub(super) fn follow_current(&mut self, cx: &mut Context<Self>) {
        let Some(relative) = self.current_relative(cx) else {
            return;
        };
        if !self.selected_paths(cx).contains(&relative) {
            self.selection.only(&relative);
        }
        if self.revealed.as_deref() != Some(relative.as_str()) {
            self.reveal = Some(vec![relative]);
        }
        self.reveal_pending(cx);
    }

    /// Select `paths` and bring the first into view, opening the folders down
    /// to each: what an import does with what it brought in. Rows that have
    /// not reached the tree yet wait for its next scan.
    pub(crate) fn reveal_paths(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        self.reveal_selects = true;
        self.reveal = Some(paths);
        self.reveal_pending(cx);
    }

    fn reveal_pending(&mut self, cx: &mut Context<Self>) {
        let Some(paths) = self.reveal.clone() else {
            return;
        };
        let known = self.all_paths(cx);
        if !paths.iter().all(|path| known.contains(path)) {
            return;
        }
        self.reveal = None;
        for path in &paths {
            let id = SharedString::from(path.clone());
            self.state.update(cx, |state, cx| {
                state.reveal_item(&id, ScrollStrategy::Nearest, cx)
            });
        }
        if std::mem::take(&mut self.reveal_selects) {
            self.selection.only(&paths[0]);
            for path in &paths[1..] {
                self.selection.toggle(path);
            }
            self.selection.anchor = Some(paths[0].clone());
            self.selection.cursor = Some(paths[0].clone());
        } else {
            self.revealed = Some(paths[0].clone());
        }
        let cursor = self.selection.cursor().map(str::to_string);
        self.point_kit_at(cursor.as_deref(), cx);
        if let Some(ix) = self
            .state
            .read(cx)
            .index_of(&SharedString::from(paths[0].clone()))
        {
            self.state
                .update(cx, |state, _| state.scroll_to_item(ix, ScrollStrategy::Nearest));
        }
        self.remember_expanded(cx);
        self.redraw_rows(cx);
    }

    /// The open file, project-relative, when it is in the project.
    fn current_relative(&self, cx: &App) -> Option<String> {
        let root = self.project.as_ref()?.read(cx).root().to_path_buf();
        let relative = self.current.as_ref()?.strip_prefix(&root).ok()?;
        Some(relative.to_string_lossy().replace('\\', "/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn command_adds_and_removes_and_shift_takes_the_range_shown() {
        let shown = rows(&["chapters", "chapters/a.tex", "chapters/b.tex", "main.tex"]);
        let mut selection = Selection::default();
        selection.only("chapters/a.tex");
        selection.toggle("main.tex");
        assert_eq!(selection.effective(None), rows(&["chapters/a.tex", "main.tex"]));
        // ⇧ runs from the last row clicked, either way up.
        selection.extend("chapters/b.tex", &shown);
        assert_eq!(selection.effective(None), rows(&["chapters/b.tex", "main.tex"]));
        selection.extend("chapters", &shown);
        assert_eq!(selection.effective(None), shown);
        // ⌘ on a selected row takes it out.
        selection.toggle("chapters");
        assert_eq!(
            selection.effective(None),
            rows(&["chapters/a.tex", "chapters/b.tex", "main.tex"])
        );
    }

    #[test]
    fn an_arrow_key_moving_kits_row_makes_it_the_selection() {
        let mut selection = Selection::default();
        selection.only("a.tex");
        selection.toggle("b.tex");
        assert_eq!(selection.effective(Some("b.tex")), rows(&["a.tex", "b.tex"]));
        assert_eq!(selection.effective(Some("c.tex")), rows(&["c.tex"]));
    }

    #[test]
    fn a_batch_is_the_selection_holding_the_row_with_folders_taking_their_rows() {
        let selected = rows(&["figures", "figures/plot.png", "main.tex", "main.tex"]);
        assert_eq!(including(&selected, "main.tex"), rows(&["figures", "main.tex"]));
        // A row outside the selection goes alone.
        assert_eq!(including(&selected, "notes.md"), rows(&["notes.md"]));
        // A look-alike name is not inside the folder.
        assert_eq!(outermost(&rows(&["fig", "figures/a.png"])), rows(&["fig", "figures/a.png"]));
    }
}
