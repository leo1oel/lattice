//! The shell's side of the asset previews (`crate::asset_preview`): which
//! files open in one, a tab for each, and what follows a refusal, a delete or
//! a move.
//!
//! The Tauri tree sends a row to the asset preview when it is a figure or its
//! content is binary or a link (`project-file-tree.tsx`: `node.kind ===
//! "figure" || node.contentKind === "binary" || node.contentKind ===
//! "symlink"`), and quick open does by the figure extensions
//! (`isProjectAssetFilePath`); here the tree's own scan answers for a path it
//! lists, and the extensions for one it does not (a hidden file). A PDF keeps
//! its viewer (`pdfs.rs`).

use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, Entity, Window};
use lattice_core::models::FileNode;
use lattice_i18n::t;

use super::Shell;
use crate::{
    asset_preview::{AssetPanel, AssetPanelEvent},
    moved_paths, notices,
};

impl Shell {
    /// Whether `relative` opens in an asset preview rather than an editor.
    pub(crate) fn opens_as_asset(&self, relative: &str, cx: &gpui::App) -> bool {
        if super::views::trellis_layout_is_pdf(relative) {
            return false;
        }
        let node = self
            .project
            .as_ref()
            .and_then(|project| find_node(project.read(cx).files(), relative).cloned());
        match node {
            Some(node) => moved_paths::is_asset(&node.path, &node.kind, &node.content_kind),
            None => moved_paths::is_asset(relative, "", ""),
        }
    }

    /// Open `path` in its asset preview when it opens in one (`open_path`).
    pub(super) fn open_if_asset(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let asset = self.root(cx).is_some_and(|root| {
            crate::project::relative_path(&root, path)
                .is_some_and(|relative| self.opens_as_asset(&relative, cx))
        });
        if asset {
            self.open_file_asset(path.to_path_buf(), window, cx);
        }
        asset
    }

    /// A project image or binary file, opened from the tree: a tab of its
    /// own among the documents, or its tab brought forward.
    pub(super) fn open_file_asset(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        if self.asset_for(&path, window, cx).is_none() {
            return;
        }
        self.place_document(&super::views::document_key(&root, &path), true, cx);
        self.sync_views(window, cx);
        self.file_tree
            .update(cx, |tree, cx| tree.set_current(Some(path), cx));
    }

    /// The preview of `path`, opened if it is not yet; it is not placed in
    /// the dock.
    pub(super) fn asset_for(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<AssetPanel>> {
        if let Some(panel) = self
            .asset_panels
            .iter()
            .find(|panel| panel.read(cx).path() == path)
        {
            return Some(panel.clone());
        }
        let root = self.root(cx)?;
        let relative = crate::project::relative_path(&root, path)?;
        let panel = cx.new(|cx| AssetPanel::new(root, relative, window, cx));
        cx.subscribe_in(&panel, window, Self::on_asset_event)
            .detach();
        self.asset_panels.push(panel.clone());
        Some(panel)
    }

    /// lattice-core refused the file: say why, as the Tauri app's
    /// `showFileOpenFailure` does, and take its tab away.
    fn on_asset_event(
        &mut self,
        panel: &Entity<AssetPanel>,
        event: &AssetPanelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            AssetPanelEvent::Failed(error) => {
                notices::error(t!("Could not open the file"), error.clone(), cx);
                self.close_asset(panel, window, cx);
            }
        }
    }

    fn close_asset(
        &mut self,
        panel: &Entity<AssetPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(view) = self.view_of_panel(panel.entity_id()) {
            self.engine_do(cx, |engine| engine.close(&view));
        }
        self.asset_panels.retain(|open| open != panel);
        self.sync_views(window, cx);
    }

    /// A preview the reader closed is let go of, and opens anew when asked
    /// for again.
    pub(super) fn forget_closed_assets(&mut self) {
        let views = self.views.clone();
        self.asset_panels.retain(|panel| {
            views
                .borrow()
                .values()
                .any(|view| view.view().entity_id() == panel.entity_id())
        });
    }

    /// The previews of files deleted from disk close with them.
    pub(super) fn close_deleted_assets(
        &mut self,
        paths: &[String],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let gone: Vec<_> = self
            .asset_panels
            .iter()
            .filter(|panel| {
                let panel = panel.read(cx);
                !panel.path().exists() && paths.iter().any(|path| covers(path, panel.relative()))
            })
            .cloned()
            .collect();
        for panel in gone {
            self.close_asset(&panel, window, cx);
        }
    }

    /// The previews follow a rename or a move of their files.
    pub(super) fn move_assets(&mut self, changes: &[(String, String)], cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        for panel in self.asset_panels.clone() {
            let relative = panel.read(cx).relative().to_string();
            if let Some(moved) = super::entries::remap(&relative, changes) {
                panel.update(cx, |panel, cx| panel.moved_to(&root, moved, cx));
            }
        }
    }

    /// The asset previews open now, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn asset_previews(&self) -> Vec<Entity<AssetPanel>> {
        self.asset_panels.clone()
    }

    /// Close every asset preview's tab, as its X does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn close_asset_previews(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for panel in self.asset_panels.clone() {
            self.close_asset(&panel, window, cx);
        }
    }
}

/// Whether deleting `deleted` removes `relative`: the file itself, or the
/// folder holding it.
fn covers(deleted: &str, relative: &str) -> bool {
    relative == deleted || relative.starts_with(&format!("{deleted}/"))
}

/// The tree's node at `relative`, if its scan lists it.
fn find_node<'a>(nodes: &'a [FileNode], relative: &str) -> Option<&'a FileNode> {
    nodes.iter().find_map(|node| {
        if node.path == relative {
            Some(node)
        } else if node.kind == "directory" && covers(&node.path, relative) {
            find_node(&node.children, relative)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, kind: &str, content: &str, children: Vec<FileNode>) -> FileNode {
        FileNode {
            name: path.rsplit('/').next().unwrap_or(path).into(),
            path: path.into(),
            kind: kind.into(),
            content_kind: content.into(),
            size: 0,
            children,
        }
    }

    #[test]
    fn the_tree_finds_a_nested_file() {
        let tree = vec![
            node("main.tex", "tex", "text", vec![]),
            node(
                "figures",
                "directory",
                "",
                vec![node("figures/plot.png", "figure", "binary", vec![])],
            ),
        ];
        assert_eq!(
            find_node(&tree, "figures/plot.png").map(|node| node.kind.as_str()),
            Some("figure")
        );
        assert!(find_node(&tree, "figures/other.png").is_none());
        assert!(find_node(&tree, "figures-old/plot.png").is_none());
    }

    #[test]
    fn a_folder_deleted_covers_what_is_in_it() {
        assert!(covers("figures", "figures/plot.png"));
        assert!(covers("figures/plot.png", "figures/plot.png"));
        assert!(!covers("fig", "figures/plot.png"));
    }
}
