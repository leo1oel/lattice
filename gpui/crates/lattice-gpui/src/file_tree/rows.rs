//! The tree's rows from the project's files, as Kit's tree takes them.

use std::collections::HashSet;

use gpui_kit::component::tree::TreeItem;
use lattice_core::models::FileNode;

/// The tree's rows. A folder whose only entry is a folder shows as one row
/// with its descendant, down the chain, as the Tauri app's tree flattens
/// them (`flattenEmptyDirectories`): "slides / understanding-attention",
/// which stands for the deepest folder (its id, its children, opening,
/// renaming and dropping into it).
pub(super) fn tree_items(nodes: &[FileNode], expanded: &HashSet<String>) -> Vec<TreeItem> {
    nodes
        .iter()
        .map(|node| {
            if node.kind != "directory" {
                return TreeItem::new(node.path.clone(), node.name.clone());
            }
            let (deepest, label) = flattened(node);
            TreeItem::new(deepest.path.clone(), label)
                .children(tree_items(&deepest.children, expanded))
                .expanded(expanded.contains(&deepest.path))
        })
        .collect()
}

/// The tree's rows' ids (each folder by the deepest of its chain), shown or
/// inside a closed folder.
pub(super) fn item_ids(items: &[TreeItem], ids: &mut HashSet<String>) {
    for item in items {
        ids.insert(item.id.to_string());
        item_ids(&item.children, ids);
    }
}

/// The row `entry` is drawn as, among the rows' ids `known`: its own, or,
/// for a folder drawn as one row with its chain of single folders, that
/// row (the deepest of the chain, the shortest id inside it). None when the
/// tree leaves it out.
pub(super) fn row_for(entry: &str, known: &HashSet<String>) -> Option<String> {
    if known.contains(entry) {
        return Some(entry.to_string());
    }
    let inside = format!("{entry}/");
    known
        .iter()
        .filter(|id| id.starts_with(&inside))
        .min_by_key(|id| id.len())
        .cloned()
}

/// The files the tree leaves out until Show hidden files: a class's or a
/// bibliography style's support files (`.sty`, `.bst`), which a template
/// brings and the writer rarely opens (`hideTemplateFiles`).
pub(super) fn hide_template_files(nodes: &mut Vec<FileNode>) {
    nodes.retain(|node| {
        node.kind == "directory" || {
            let name = node.name.to_ascii_lowercase();
            !(name.ends_with(".sty") || name.ends_with(".bst"))
        }
    });
    for node in nodes {
        hide_template_files(&mut node.children);
    }
}

/// A folder and the chain of single folders under it: the deepest one and
/// the names on the way, joined by "/".
fn flattened(node: &FileNode) -> (&FileNode, String) {
    let mut deepest = node;
    let mut label = node.name.clone();
    while let [only] = deepest.children.as_slice() {
        if only.kind != "directory" {
            break;
        }
        label.push('/');
        label.push_str(&only.name);
        deepest = only;
    }
    (deepest, label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, kind: &str, children: Vec<FileNode>) -> FileNode {
        FileNode {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            content_kind: String::new(),
            size: 0,
            children,
        }
    }

    #[test]
    fn a_chain_of_single_folders_is_one_row_for_the_deepest() {
        let deck = node(
            "slides/understanding-attention",
            "directory",
            vec![node(
                "slides/understanding-attention/index.tsx",
                "file",
                vec![],
            )],
        );
        let slides = node("slides", "directory", vec![deck]);
        let (deepest, label) = flattened(&slides);
        assert_eq!(deepest.path, "slides/understanding-attention");
        assert_eq!(label, "slides/understanding-attention");
        let items = tree_items(&[slides], &HashSet::new());
        assert_eq!(items[0].id.as_ref(), "slides/understanding-attention");
    }

    #[test]
    fn an_entry_is_found_as_its_own_row_or_its_chains_row() {
        let theme = node(
            "theme",
            "directory",
            vec![node(
                "theme/fonts",
                "directory",
                vec![node("theme/fonts/serif.otf", "file", vec![])],
            )],
        );
        let mut nodes = vec![
            theme,
            node("main.tex", "file", vec![]),
            node("acl.sty", "file", vec![]),
        ];
        hide_template_files(&mut nodes);
        let mut known = HashSet::new();
        item_ids(&tree_items(&nodes, &HashSet::new()), &mut known);
        assert_eq!(row_for("main.tex", &known).as_deref(), Some("main.tex"));
        // The folder imported is drawn as "theme/fonts", under that id.
        assert_eq!(row_for("theme", &known).as_deref(), Some("theme/fonts"));
        // A hidden support file, and a look-alike name, have no row.
        assert_eq!(row_for("acl.sty", &known), None);
        assert_eq!(row_for("them", &known), None);
    }

    #[test]
    fn template_support_files_are_left_out_at_any_depth() {
        let mut nodes = vec![
            node("main.tex", "file", vec![]),
            node("acl.STY", "file", vec![]),
            node(
                "style",
                "directory",
                vec![
                    node("style/natbib.bst", "file", vec![]),
                    node("style/notes.md", "file", vec![]),
                ],
            ),
        ];
        hide_template_files(&mut nodes);
        let mut ids = HashSet::new();
        item_ids(&tree_items(&nodes, &HashSet::new()), &mut ids);
        assert_eq!(
            ids,
            HashSet::from(["main.tex", "style", "style/notes.md"].map(String::from))
        );
    }

    #[test]
    fn a_folder_holding_a_file_stays_its_own_row() {
        let chapters = node(
            "chapters",
            "directory",
            vec![node("chapters/intro.tex", "file", vec![])],
        );
        assert_eq!(flattened(&chapters).1, "chapters");
        let two = node(
            "figures",
            "directory",
            vec![
                node("figures/a", "directory", vec![]),
                node("figures/b", "directory", vec![]),
            ],
        );
        assert_eq!(flattened(&two).1, "figures");
    }
}
