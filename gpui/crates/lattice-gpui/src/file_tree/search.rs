//! The tree's type-to-filter, as the Tauri app's Pierre tree has it
//! (`search: true`, `fileTreeSearchMode: "hide-non-matches"`).
//!
//! A letter or digit typed in the tree, with no ⌘, ⌃ or ⌥, opens a field
//! over the rows seeded with it. The query, trimmed and lower-cased with
//! `\` read as `/`, is a substring of a row's project-relative path (a
//! folder's ending in `/`): the rows that match and the folders on the way
//! stay, opened, and the rest are hidden; nothing matching leaves the tree
//! empty, and an empty query shows it all as it was. Rows that match are
//! drawn as any row, and a drag waits until the query is empty.
//!
//! In the field ↑ and ↓ move among the matches without selecting (the
//! Tauri app draws no mark for that focus either), Enter picks the one in
//! focus, as a click does, and Escape closes it. A click on a row, a
//! rename or leaving the field closes it too. Closing puts back the folders
//! that were open before, with the selected rows' folders opened.
//!
//! One step differs on purpose: after Escape the keyboard is back in the
//! tree, where the Tauri app leaves it nowhere.

use std::collections::HashSet;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement as _, KeyDownEvent,
    ParentElement as _, Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_core::models::FileNode;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, interaction::mix};

use super::FileTreePanel;

pub(super) struct TreeSearch {
    pub(super) input: Entity<InputState>,
    /// The query as matched: trimmed, `\` as `/`, lower-cased.
    pub(super) query: String,
    /// The match ↑ and ↓ last moved to, which Enter picks.
    pub(super) focus: Option<String>,
    _subscriptions: [Subscription; 2],
}

/// The query `text` types, as Pierre matches it.
pub(super) fn normalize(text: &str) -> String {
    text.trim().replace('\\', "/").to_lowercase()
}

/// Whether the row at `path` matches `query` (already normalized).
pub(super) fn matches(path: &str, folder: bool, query: &str) -> bool {
    let path = path.to_lowercase();
    if folder {
        format!("{path}/").contains(query)
    } else {
        path.contains(query)
    }
}

/// The nodes that match `query` and the folders holding them; every folder
/// kept is added to `open`, since it matched or holds a match.
pub(super) fn filter_nodes(
    nodes: &[FileNode],
    query: &str,
    open: &mut HashSet<String>,
) -> Vec<FileNode> {
    nodes
        .iter()
        .filter_map(|node| {
            let folder = node.kind == "directory";
            let children = if folder {
                filter_nodes(&node.children, query, open)
            } else {
                Vec::new()
            };
            if !children.is_empty() || matches(&node.path, folder, query) {
                if folder {
                    open.insert(node.path.clone());
                }
                Some(FileNode {
                    children,
                    ..node.clone()
                })
            } else {
                None
            }
        })
        .collect()
}

/// Whether a keystroke opens the field: one letter or digit, no ⌘, ⌃, ⌥.
fn opens_search(event: &KeyDownEvent) -> Option<String> {
    let keystroke = &event.keystroke;
    let modifiers = keystroke.modifiers;
    if modifiers.platform || modifiers.control || modifiers.alt || modifiers.function {
        return None;
    }
    let typed = keystroke.key_char.as_deref()?;
    let mut chars = typed.chars();
    let first = chars.next()?;
    (chars.next().is_none() && first.is_alphanumeric()).then(|| typed.to_string())
}

impl FileTreePanel {
    /// The query the rows are filtered by, when the field holds one.
    pub(super) fn search_query(&self) -> Option<&str> {
        self.search
            .as_ref()
            .map(|search| search.query.as_str())
            .filter(|query| !query.is_empty())
    }

    /// A letter or digit typed in the tree opens the field with it.
    pub(super) fn search_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.search.is_some() || self.naming.is_some() || self.project.is_none() {
            return;
        }
        if let Some(seed) = opens_search(event) {
            cx.stop_propagation();
            self.open_search(&seed, window, cx);
        }
    }

    pub(crate) fn open_search(&mut self, seed: &str, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Search…")
                .default_value(seed.to_string())
        });
        // Focused once drawn, as the rename field is (`naming.rs`), with
        // the caret after the seed.
        let field = input.downgrade();
        let end = seed.len();
        window.on_next_frame(move |window, cx| {
            field
                .update(cx, |input, cx| {
                    input.focus(window, cx);
                    input.set_selected_range(end..end, cx);
                })
                .ok();
        });
        let subscription =
            cx.subscribe_in(
                &input,
                window,
                |this, input, event, window, cx| match event {
                    InputEvent::Change => {
                        let query = normalize(&input.read(cx).value());
                        if let Some(search) = &mut this.search {
                            search.query = query;
                        }
                        this.rebuild(cx);
                        this.focus_first_match(cx);
                    }
                    InputEvent::PressEnter { .. } => this.pick_match(window, cx),
                    InputEvent::Blur | InputEvent::Focus => {}
                },
            );
        // Focus gone from the tree, from the field or a row, closes it; a
        // press on a row only moves it into the tree, and the row's click
        // closes it once it has picked the row, so the rows hold still
        // under it.
        let focus_out = cx.on_focus_out(&self.focus_handle, window, |this, _, window, cx| {
            this.close_search(false, window, cx)
        });
        self.search = Some(TreeSearch {
            input,
            query: normalize(seed),
            focus: None,
            _subscriptions: [subscription, focus_out],
        });
        self.rebuild(cx);
        self.focus_first_match(cx);
    }

    /// The rows shown that match the query.
    pub(super) fn search_matches(&self, cx: &App) -> Vec<String> {
        let Some(query) = self.search_query() else {
            return Vec::new();
        };
        let state = self.state.read(cx);
        (0..)
            .map_while(|ix| state.entry(ix))
            .filter(|entry| matches(&entry.item().id, entry.is_folder(), query))
            .map(|entry| entry.item().id.to_string())
            .collect()
    }

    fn focus_first_match(&mut self, cx: &mut Context<Self>) {
        let first = self.search_matches(cx).into_iter().next();
        if let Some(search) = &mut self.search {
            search.focus = first;
        }
    }

    /// ↑ (`-1`) or ↓ (`1`): the previous or next match, held at the ends.
    fn step_match(&mut self, step: isize, cx: &mut Context<Self>) {
        let shown = self.search_matches(cx);
        let Some(search) = &mut self.search else {
            return;
        };
        let at = search
            .focus
            .as_ref()
            .and_then(|focus| shown.iter().position(|row| row == focus));
        let next = match at {
            Some(at) => at
                .saturating_add_signed(step)
                .min(shown.len().saturating_sub(1)),
            None => 0,
        };
        search.focus = shown.get(next).cloned();
        if let Some(ix) = search
            .focus
            .as_ref()
            .and_then(|focus| self.state.read(cx).index_of(&focus.clone().into()))
        {
            self.state.update(cx, |state, _| {
                state.scroll_to_item(ix, gpui::ScrollStrategy::Nearest)
            });
        }
        cx.notify();
    }

    /// Enter: the match in focus is picked as a click picks it, and the
    /// field closes with the keyboard on that row.
    fn pick_match(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.search.as_ref().and_then(|search| search.focus.clone()) else {
            return;
        };
        let folder = self
            .state
            .read(cx)
            .index_of(&path.clone().into())
            .and_then(|ix| self.state.read(cx).entry(ix).map(|entry| entry.is_folder()))
            .unwrap_or(false);
        self.pick(&path, folder, gpui::Modifiers::default(), cx);
        self.close_search(true, window, cx);
    }

    /// The field's keys, before the field takes them: Escape, ↑ and ↓.
    pub(super) fn search_capture(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.search.is_none() {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                self.close_search(true, window, cx);
            }
            "up" => {
                cx.stop_propagation();
                self.step_match(-1, cx);
            }
            "down" => {
                cx.stop_propagation();
                self.step_match(1, cx);
            }
            _ => {}
        }
    }

    /// Close the field: the folders open before come back, with the
    /// selected rows' folders opened so a row picked in the search stays in
    /// view. `refocus` puts the keyboard back in the tree.
    pub(crate) fn close_search(
        &mut self,
        refocus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.search.take().is_none() {
            return;
        }
        for path in self.selected_paths(cx) {
            let mut parent = path.as_str();
            while let Some((folder, _)) = parent.rsplit_once('/') {
                self.expanded.insert(folder.to_string());
                parent = folder;
            }
        }
        self.rebuild(cx);
        if let Some(path) = self.selected_paths(cx).into_iter().last()
            && let Some(ix) = self.state.read(cx).index_of(&path.into())
        {
            self.state.update(cx, |state, _| {
                state.scroll_to_item(ix, gpui::ScrollStrategy::Nearest)
            });
        }
        if refocus {
            window.focus(&self.focus_handle, cx);
        }
        cx.notify();
    }

    /// The field over the rows while the search is open: 32px, 1px from the
    /// rows' edges, 7px above them (`project-tree-css.ts`).
    pub(super) fn search_field(&self, cx: &App) -> Option<AnyElement> {
        let search = self.search.as_ref()?;
        let palette = cx.palette().clone();
        Some(
            div()
                .flex_none()
                .px(px(3.))
                .mb(px(7.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .my(px(1.))
                        .h(px(32.))
                        .pl(px(14.))
                        .pr(px(10.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(palette.field_border_hover)
                        .bg(mix(palette.input, palette.text, 0.05))
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text)
                        .child(
                            Input::new(&search.input)
                                .appearance(false)
                                .bordered(false)
                                .px_0(),
                        ),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, kind: &str, children: Vec<FileNode>) -> FileNode {
        FileNode {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            content_kind: "text".to_string(),
            size: 0,
            children,
        }
    }

    fn paths(nodes: &[FileNode], out: &mut Vec<String>) {
        for node in nodes {
            out.push(node.path.clone());
            paths(&node.children, out);
        }
    }

    // Pierre's matching (`searchHelpers.js`): a case-blind substring of the
    // whole path, so a folder's name matches it and everything inside.
    #[test]
    fn a_query_keeps_the_matches_and_the_folders_holding_them() {
        let nodes = vec![
            node("main.tex", "tex", vec![]),
            node(
                "figures",
                "directory",
                vec![node("figures/plot.png", "figure", vec![])],
            ),
            node(
                "sections",
                "directory",
                vec![
                    node("sections/Intro.tex", "tex", vec![]),
                    node("sections/method.tex", "tex", vec![]),
                ],
            ),
        ];
        let mut open = HashSet::new();
        let mut kept = Vec::new();
        paths(
            &filter_nodes(&nodes, &normalize("  INTRO "), &mut open),
            &mut kept,
        );
        assert_eq!(kept, ["sections", "sections/Intro.tex"]);
        assert_eq!(open, HashSet::from(["sections".to_string()]));

        let (mut open, mut kept) = (HashSet::new(), Vec::new());
        paths(
            &filter_nodes(&nodes, &normalize("fig"), &mut open),
            &mut kept,
        );
        assert_eq!(kept, ["figures", "figures/plot.png"]);

        // A folder's path ends in "/", so "s/" finds what is in sections/
        // and not main.tex.
        let (mut open, mut kept) = (HashSet::new(), Vec::new());
        paths(
            &filter_nodes(&nodes, &normalize("sections\\"), &mut open),
            &mut kept,
        );
        assert_eq!(
            kept,
            ["sections", "sections/Intro.tex", "sections/method.tex"]
        );

        let mut open = HashSet::new();
        assert!(filter_nodes(&nodes, "nothing", &mut open).is_empty());
    }
}
