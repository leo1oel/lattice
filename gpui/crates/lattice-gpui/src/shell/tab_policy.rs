//! Preview tabs, pinned tabs and tab eviction, as the Tauri app keeps its
//! document tabs (`trellis-tab-policy.ts`, `trellis-document-tabs.tsx`).
//!
//! - A quick look (a click on a tree row, a Quick open pick, a project
//!   search hit) opens its document as its panel's preview tab, its title
//!   in italics, in the place of the panel's preview tab before it, which
//!   closes. A file already open is only brought forward.
//! - A preview is kept, a tab like any other, once it is edited, its tab is
//!   double-clicked or dragged, its tree row is double-clicked, Keep open or
//!   Pin tab is chosen in its menu, or it is opened any other way.
//! - Pin tab marks a tab (a pin in its close slot until the pointer is over
//!   it); a pinned tab is never replaced or evicted. Both flags are the file
//!   view's params, so they are saved with the layout.
//! - A document opened into a strip without room for it closes the panel's
//!   tabs it can spare: previews first, then the least recently used, never
//!   a pinned one, the one opening, the one in front, one edited this
//!   session or a root `.tex` (one holding `\documentclass`). Nothing says so:
//!   it is a close like any other.

use std::collections::{HashMap, HashSet};

use gpui::{App, Context, Window};
use lattice_ui::{
    TextRole,
    components::{TAB_GAP, TabFit},
    typography::shaped_width,
};
use trellis::{
    model::{LayoutDocument, LayoutNode, Placement},
    runtime::engine::OpenOptions,
};

use super::{Shell, trellis_layout::file_key};

/// The narrowest a document tab measures for room (`TAB_MIN_WIDTH`, the
/// strip's `--trellis-tab-min`).
const TAB_MIN: f32 = 100.;
/// The widest a document tab draws (`skin.rs`).
const TAB_MAX: f32 = 200.;

/// The views of the panel `panel`, in strip order.
fn panel_views(doc: &LayoutDocument, panel: &str) -> Vec<String> {
    match trellis::model::find_node(doc.root.as_ref(), panel) {
        Some(LayoutNode::Panel(node)) => node.views.clone(),
        _ => Vec::new(),
    }
}

/// What the shell keeps for its document tabs between opens.
#[derive(Default)]
pub(crate) struct TabPolicy {
    /// The document the next open is a quick look at.
    preview_key: Option<String>,
    /// Documents edited this session, which are never evicted.
    held: HashSet<String>,
    /// When each document was last in front, by a counter.
    used: HashMap<String, u64>,
    clock: u64,
    /// A document just opened into `panel`, whose strip is to make room.
    evict: Option<(String, String)>,
}

/// A tab in the strip, as eviction weighs it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StripTab {
    pub(crate) view: String,
    /// The document, for a file tab; none for a named panel's.
    pub(crate) key: Option<String>,
    pub(crate) width: f32,
    pub(crate) preview: bool,
    pub(crate) pinned: bool,
    pub(crate) used: u64,
}

/// The tabs to close so `incoming` fits in `room` (`chooseEvictions`): the
/// strip is short by its tabs' widths and gaps plus the incoming tab's, past
/// its room; previews go first, then the least recently used, then the
/// first in the strip, until that much is freed.
pub(crate) fn evictions(
    tabs: &[StripTab],
    incoming: f32,
    gap: f32,
    room: f32,
    held: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let short = tabs.iter().map(|tab| tab.width + gap).sum::<f32>() + incoming - room;
    if short <= 0. {
        return Vec::new();
    }
    let mut candidates: Vec<(usize, &StripTab)> = tabs
        .iter()
        .enumerate()
        .filter(|(_, tab)| !tab.pinned && tab.key.as_deref().is_some_and(|key| !held(key)))
        .collect();
    candidates.sort_by_key(|(index, tab)| (!tab.preview, tab.used, *index));
    let mut freed = 0.;
    let mut out = Vec::new();
    for (_, tab) in candidates {
        if freed >= short {
            break;
        }
        freed += tab.width + gap;
        out.push(tab.view.clone());
    }
    out
}

impl Shell {
    /// Open `path` as a quick look: its panel's preview tab.
    pub(crate) fn quick_look(
        &mut self,
        path: std::path::PathBuf,
        line: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(root) = self.root(cx) {
            let path = path.clone().canonicalize().unwrap_or(path.clone());
            self.tabs.preview_key = Some(super::views::document_key(&root, &path));
        }
        self.open_path(path, line, window, cx);
        self.tabs.preview_key = None;
    }

    /// Open `path` kept: its tab, a preview before, stays.
    pub(crate) fn open_kept(
        &mut self,
        path: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_path(path.clone(), None, window, cx);
        if let Some(root) = self.root(cx) {
            let path = path.canonicalize().unwrap_or(path);
            self.keep_document(&super::views::document_key(&root, &path), cx);
        }
    }

    /// Document `key` is already open: a quick look leaves its tab as it
    /// is; any other open keeps it.
    pub(super) fn reopened(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.tabs.preview_key.take().as_deref() != Some(key) {
            self.keep_document(key, cx);
        }
    }

    /// Open document `key` into `panel`: as its preview, in the place of the
    /// preview it had, when this is a quick look; else at the strip's end,
    /// making room in it.
    pub(super) fn open_document_tab(
        &mut self,
        key: &str,
        panel: String,
        focus: bool,
        cx: &mut Context<Self>,
    ) -> String {
        let preview = self.tabs.preview_key.take().as_deref() == Some(key);
        let doc = self.document(cx);
        let engine = self.workspace.read(cx).engine();
        let replaced = preview
            .then(|| {
                panel_views(&doc, &panel)
                    .iter()
                    .enumerate()
                    .find_map(|(index, view)| {
                        let record = doc.views.get(view)?;
                        (record.kind == "file"
                            && engine.param_flag(view, "preview")
                            && !engine.param_flag(view, "pinned")
                            && file_key(Some(record)) != key)
                            .then(|| (index, view.clone()))
                    })
            })
            .flatten();
        let mut params = trellis::model::Params::new();
        params.insert("key".into(), key.into());
        if preview {
            params.insert("preview".into(), true.into());
        }
        let index = replaced.as_ref().map(|(index, _)| *index);
        let into = panel.clone();
        let id = self.engine_do(cx, |engine| {
            engine.open(
                "file",
                OpenOptions {
                    params: Some(params),
                    placement: Some(Placement::Into { into, index }),
                    focus: Some(focus),
                    ..OpenOptions::default()
                },
            )
        });
        match replaced {
            // The preview it replaces closes as its X closes it.
            Some((_, old)) => self
                .workspace
                .update(cx, |workspace, cx| workspace.close(&[old], cx)),
            None => self.tabs.evict = Some((panel, key.to_string())),
        }
        id
    }

    /// Keep document `key`'s tabs: no longer previews.
    pub(crate) fn keep_document(&mut self, key: &str, cx: &mut Context<Self>) {
        let doc = self.document(cx);
        let views: Vec<String> = doc
            .views
            .iter()
            .filter(|(_, record)| file_key(Some(record)) == key)
            .filter(|(id, _)| self.view_flag(id, "preview", cx))
            .map(|(id, _)| id.clone())
            .collect();
        self.set_view_flags(&views, &[("preview", false)], cx);
    }

    /// Keep the view `view` (a tab's double-click or drag, Keep open).
    pub(crate) fn keep_view(&mut self, view: &str, cx: &mut Context<Self>) {
        if self.view_flag(view, "preview", cx) {
            self.set_view_flags(&[view.to_string()], &[("preview", false)], cx);
        }
    }

    /// Pin tab (kept, too) or Unpin tab.
    pub(crate) fn pin_view(&mut self, view: &str, pinned: bool, cx: &mut Context<Self>) {
        let flags: &[(&str, bool)] = if pinned {
            &[("pinned", true), ("preview", false)]
        } else {
            &[("pinned", false)]
        };
        self.set_view_flags(&[view.to_string()], flags, cx);
    }

    pub(crate) fn view_flag(&self, view: &str, name: &str, cx: &App) -> bool {
        self.workspace.read(cx).engine().param_flag(view, name)
    }

    fn set_view_flags(&mut self, views: &[String], flags: &[(&str, bool)], cx: &mut Context<Self>) {
        if views.is_empty() {
            return;
        }
        self.engine_do(cx, |engine| {
            for view in views {
                let mut patch = trellis::model::Params::new();
                for (name, value) in flags {
                    patch.insert((*name).into(), (*value).into());
                }
                engine.set_params(view, patch);
            }
        });
        cx.notify();
    }

    /// A document edited: its tab is kept, and held from eviction for the
    /// rest of the session (`held`, `activeDirty`).
    pub(super) fn document_edited(
        &mut self,
        editor: &gpui::Entity<crate::editor_panel::EditorPanel>,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if !editor.read(cx).is_dirty(cx) {
            return;
        }
        let key = super::views::document_key(&root, editor.read(cx).path());
        self.keep_document(&key, cx);
        self.tabs.held.insert(key);
    }

    /// After a change to the layout: the document in front is the most
    /// recently used, and a strip a document just joined makes room for it.
    pub(super) fn tabs_settled(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(active) = self.active_document(cx) {
            self.tabs.clock += 1;
            let clock = self.tabs.clock;
            self.tabs.used.insert(active, clock);
        }
        if let Some((panel, key)) = self.tabs.evict.take() {
            self.make_room(&panel, &key, window, cx);
        }
    }

    /// Close the tabs `panel`'s strip can spare for `incoming`'s.
    fn make_room(
        &mut self,
        panel: &str,
        incoming: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let workspace = self.workspace.read(cx);
        let Some(room) = workspace.tab_list_bounds(panel) else {
            return;
        };
        let measured: HashMap<String, f32> = workspace
            .tab_bounds(panel)
            .into_iter()
            .map(|(view, bounds)| (view, f32::from(bounds.size.width)))
            .collect();
        let doc = self.document(cx);
        let views = panel_views(&doc, panel);
        let engine = workspace.engine();
        let mut incoming_width = TAB_MIN;
        let mut tabs = Vec::new();
        for view in &views {
            let record = doc.views.get(view);
            let key = Some(file_key(record)).filter(|key| !key.is_empty());
            let width = match &key {
                // A file tab at rest, its close slot left out unless it is
                // the incoming one, which is measured selected.
                Some(key) => {
                    let label = shaped_width(
                        &engine.title_of(view),
                        TextRole::BodyCompact,
                        None,
                        window,
                        cx,
                    );
                    let selected = key == incoming;
                    let mut width = f32::from(TabFit::natural_width(label, true));
                    if !selected {
                        width -= f32::from(TAB_GAP + lattice_ui::components::TAB_CLOSE);
                    }
                    let width = width.clamp(TAB_MIN, TAB_MAX);
                    if selected {
                        incoming_width = width;
                        continue;
                    }
                    width
                }
                None => measured.get(view).copied().unwrap_or(0.),
            };
            tabs.push(StripTab {
                view: view.clone(),
                preview: engine.param_flag(view, "preview"),
                pinned: engine.param_flag(view, "pinned"),
                used: key
                    .as_ref()
                    .and_then(|key| self.tabs.used.get(key))
                    .copied()
                    .unwrap_or(0),
                key,
                width,
            });
        }
        let active = self.active_document(cx);
        let roots: HashSet<String> = self.root_documents(cx);
        let held = |key: &str| {
            key == incoming
                || active.as_deref() == Some(key)
                || self.tabs.held.contains(key)
                || roots.contains(key)
        };
        let close = evictions(
            &tabs,
            incoming_width,
            f32::from(TAB_GAP),
            f32::from(room.size.width),
            &held,
        );
        if !close.is_empty() {
            self.workspace
                .update(cx, |workspace, cx| workspace.close(&close, cx));
        }
    }

    /// The open documents that are a LaTeX root: their text holds
    /// `\documentclass`.
    fn root_documents(&mut self, cx: &App) -> HashSet<String> {
        let Some(root) = self.root(cx) else {
            return HashSet::new();
        };
        self.open_editors()
            .iter()
            .filter(|editor| editor.read(cx).saved_text().contains("\\documentclass"))
            .map(|editor| super::views::document_key(&root, editor.read(cx).path()))
            .collect()
    }
}

/// What a scenario reads of the tabs.
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Shell {
    /// Document `key`'s tab: its panel, its place in the strip, and whether
    /// it is a preview and pinned.
    pub fn tab_state(&self, key: &str, cx: &App) -> Option<(String, usize, bool, bool)> {
        let view = self.view_of_document(key, cx)?;
        let doc = self.document(cx);
        let panel = trellis::model::panel_of_view(&doc, &view)?;
        let index = panel.views.iter().position(|id| *id == view)?;
        Some((
            panel.id.clone(),
            index,
            self.view_flag(&view, "preview", cx),
            self.view_flag(&view, "pinned", cx),
        ))
    }

    /// The documents in panel `panel`'s strip, in order (a named panel's
    /// tab as "").
    pub fn strip_documents(&self, panel: &str, cx: &App) -> Vec<String> {
        let doc = self.document(cx);
        panel_views(&doc, panel)
            .iter()
            .map(|view| file_key(doc.views.get(view)))
            .collect()
    }

    /// Pin tab or Unpin tab on document `key`'s tab, as its menu does.
    pub fn pin_document(&mut self, key: &str, pinned: bool, cx: &mut Context<Self>) {
        if let Some(view) = self.view_of_document(key, cx) {
            self.pin_view(&view, pinned, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(view: &str, width: f32, used: u64) -> StripTab {
        StripTab {
            view: view.into(),
            key: Some(format!("{view}.tex")),
            width,
            preview: false,
            pinned: false,
            used,
        }
    }

    // `chooseEvictions` (trellis-tab-policy.test.tsx): a strip of 3 × 150
    // with 6px gaps in 500px is short 18 + 150 + 6 − … for a 150px tab.
    #[test]
    fn a_full_strip_closes_previews_first_then_the_least_recently_used() {
        let mut preview = tab("c", 150., 9);
        preview.preview = true;
        let tabs = vec![tab("a", 150., 5), tab("b", 150., 2), preview];
        // 3 × 156 + 150 − 500 = 118 short: one tab frees it.
        assert_eq!(evictions(&tabs, 150., 6., 500., &|_| false), ["c"]);
        // 268 short: the preview, then the least recently used.
        assert_eq!(evictions(&tabs, 300., 6., 500., &|_| false), ["c", "b"]);
        // With room, nothing goes.
        assert!(evictions(&tabs, 150., 6., 700., &|_| false).is_empty());
    }

    #[test]
    fn pinned_held_and_named_tabs_stay() {
        let mut pinned = tab("a", 150., 0);
        pinned.pinned = true;
        let named = StripTab {
            key: None,
            ..tab("pdf", 80., 0)
        };
        let tabs = vec![pinned, tab("b", 150., 1), named, tab("c", 150., 3)];
        // Short by a lot: only b and c can go, and b is held.
        assert_eq!(
            evictions(&tabs, 400., 6., 300., &|key| key == "b.tex"),
            ["c"]
        );
    }
}
