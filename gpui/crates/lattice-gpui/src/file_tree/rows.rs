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
