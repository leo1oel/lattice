//! Naming a row in place, as the app's tree does it
//! (`src/project/project-tree-inline-create.ts`): a new entry is an
//! "untitled" row until its name is confirmed, a rename edits the row's name,
//! and Enter, leaving the field or Escape settle it.

use std::collections::HashSet;

use gpui::{AppContext as _, Context, Entity, Subscription, Window};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::models::FileNode;

use super::{FileTreeEvent, FileTreePanel};

pub(super) enum NamingKind {
    /// A new entry in `directory`; the row is a placeholder until then.
    Create {
        folder: bool,
    },
    Rename,
}

/// A row whose name is being typed.
pub(super) struct Naming {
    /// The row: the entry renamed, or the new entry's placeholder.
    pub(super) path: String,
    pub(super) kind: NamingKind,
    pub(super) original: String,
    pub(super) input: Entity<InputState>,
    /// The field has had focus, so leaving it means the name is given.
    pub(super) focused: bool,
    pub(super) _subscription: Subscription,
}

impl FileTreePanel {
    /// Start naming a new entry in `directory` ("" is the top level).
    pub fn begin_create(
        &mut self,
        directory: &str,
        folder: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = &self.project else {
            return;
        };
        self.naming = None;
        let taken: HashSet<String> = all_paths(project.read(cx).files());
        let path = placeholder(directory, &taken);
        if !directory.is_empty() {
            // Its folder opens, so the new row shows.
            let mut open = String::new();
            for part in directory.split('/') {
                if !open.is_empty() {
                    open.push('/');
                }
                open.push_str(part);
                self.expanded.insert(open.clone());
            }
        }
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        self.start_naming(path, name, NamingKind::Create { folder }, window, cx);
        self.rebuild(cx);
    }

    /// Start renaming the entry at `path`.
    pub fn begin_rename(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        self.start_naming(path, name, NamingKind::Rename, window, cx);
        self.redraw_rows(cx);
    }

    fn start_naming(
        &mut self,
        path: String,
        name: String,
        kind: NamingKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(name.clone()));
        // The part before the extension is selected, as Finder does, so
        // typing keeps the ".tex".
        let stem = match name.rfind('.') {
            Some(dot) if dot > 0 => dot,
            _ => name.len(),
        };
        // The field takes focus once its row is drawn: focused before, it
        // is not yet in the frame, and GPUI would take the focus back.
        // The rows are drawn again once it has focus, so the field takes
        // typing (it listens for text only when drawn focused).
        let field = input.downgrade();
        let rows = self.state.downgrade();
        window.on_next_frame(move |window, cx| {
            field
                .update(cx, |input, cx| {
                    input.focus(window, cx);
                    input.set_selected_range(0..stem, cx);
                })
                .ok();
            rows.update(cx, |_, cx| cx.notify()).ok();
        });
        let subscription =
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Focus => {
                    if let Some(naming) = &mut this.naming {
                        naming.focused = true;
                    }
                }
                InputEvent::PressEnter { .. } => this.commit_naming(true, window, cx),
                // Only leaving the field once it had focus confirms it.
                InputEvent::Blur if this.naming.as_ref().is_some_and(|naming| naming.focused) => {
                    this.commit_naming(false, window, cx)
                }
                _ => {}
            });
        self.naming = Some(Naming {
            path,
            kind,
            original: name,
            input,
            focused: false,
            _subscription: subscription,
        });
    }

    /// Escape: drop the naming, and a new entry's row with it.
    pub(super) fn cancel_naming(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let created = matches!(
            self.naming.take(),
            Some(Naming {
                kind: NamingKind::Create { .. },
                ..
            })
        );
        if created {
            self.rebuild(cx);
        }
        window.focus(&self.focus_handle, cx);
        self.redraw_rows(cx);
    }

    /// The name was confirmed: by Enter (`enter`), or by leaving the field.
    /// Leaving a new entry's field with its placeholder name unchanged drops
    /// it; Enter creates it under that name.
    pub(super) fn commit_naming(
        &mut self,
        enter: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(naming) = self.naming.take() else {
            return;
        };
        let name = naming.input.read(cx).value().trim().to_string();
        let unchanged = name == naming.original;
        let parent = match naming.path.rsplit_once('/') {
            Some((parent, _)) => parent.to_string(),
            None => String::new(),
        };
        match naming.kind {
            NamingKind::Create { folder } => {
                if !name.is_empty() && (enter || !unchanged) {
                    let path = if parent.is_empty() {
                        name
                    } else {
                        format!("{parent}/{name}")
                    };
                    cx.emit(FileTreeEvent::Create { path, folder });
                }
                self.rebuild(cx);
            }
            NamingKind::Rename => {
                if !name.is_empty() && !unchanged {
                    cx.emit(FileTreeEvent::Rename {
                        path: naming.path,
                        name,
                    });
                }
            }
        }
        if enter {
            window.focus(&self.focus_handle, cx);
        }
        self.redraw_rows(cx);
    }
}

/// "untitled" in `directory`, or "untitled-2", "untitled-3", … when taken.
fn placeholder(directory: &str, taken: &HashSet<String>) -> String {
    (1..)
        .map(|suffix| {
            let name = if suffix > 1 {
                format!("untitled-{suffix}")
            } else {
                "untitled".to_string()
            };
            if directory.is_empty() {
                name
            } else {
                format!("{directory}/{name}")
            }
        })
        .find(|path| !taken.contains(path))
        .expect("an unused name")
}

fn all_paths(nodes: &[FileNode]) -> HashSet<String> {
    let mut paths = HashSet::new();
    fn walk(nodes: &[FileNode], paths: &mut HashSet<String>) {
        for node in nodes {
            paths.insert(node.path.clone());
            walk(&node.children, paths);
        }
    }
    walk(nodes, &mut paths);
    paths
}

/// Put the placeholder row for a new entry at `path` into its folder, in
/// the tree's order (folders first, then names without regard to case).
pub(super) fn insert_placeholder(nodes: &mut Vec<FileNode>, path: &str, folder: bool) {
    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) => (Some(parent), name),
        None => (None, path),
    };
    let siblings = match parent {
        None => nodes,
        Some(parent) => match find_folder(nodes, parent) {
            Some(folder) => &mut folder.children,
            None => return,
        },
    };
    let node = FileNode {
        name: name.to_string(),
        path: path.to_string(),
        kind: if folder { "directory" } else { "text" }.to_string(),
        content_kind: if folder { "directory" } else { "text" }.to_string(),
        size: 0,
        children: Vec::new(),
    };
    let at = siblings
        .iter()
        .position(|sibling| {
            let sibling_folder = sibling.kind == "directory";
            (folder && !sibling_folder)
                || (folder == sibling_folder && sibling.name.to_lowercase() > name.to_lowercase())
        })
        .unwrap_or(siblings.len());
    siblings.insert(at, node);
}

fn find_folder<'a>(nodes: &'a mut [FileNode], path: &str) -> Option<&'a mut FileNode> {
    for node in nodes {
        if node.kind != "directory" {
            continue;
        }
        if node.path == path {
            return Some(node);
        }
        if path.starts_with(&format!("{}/", node.path)) {
            return find_folder(&mut node.children, path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, folder: bool, children: Vec<FileNode>) -> FileNode {
        FileNode {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.to_string(),
            kind: if folder { "directory" } else { "tex" }.to_string(),
            content_kind: if folder { "directory" } else { "text" }.to_string(),
            size: 0,
            children,
        }
    }

    #[test]
    fn a_new_entry_takes_the_first_free_untitled_name() {
        let taken: HashSet<String> = ["untitled.tex", "untitled", "chapters/untitled"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(placeholder("", &taken), "untitled-2");
        assert_eq!(placeholder("chapters", &taken), "chapters/untitled-2");
        assert_eq!(placeholder("figures", &taken), "figures/untitled");
    }

    #[test]
    fn the_placeholder_lands_in_its_folder_in_tree_order() {
        let mut nodes = vec![
            node(
                "chapters",
                true,
                vec![node("chapters/intro.tex", false, vec![])],
            ),
            node("main.tex", false, vec![]),
            node("zeta.tex", false, vec![]),
        ];
        insert_placeholder(&mut nodes, "untitled", false);
        let names: Vec<_> = nodes.iter().map(|node| node.path.as_str()).collect();
        assert_eq!(names, ["chapters", "main.tex", "untitled", "zeta.tex"]);

        insert_placeholder(&mut nodes, "untitled-2", true);
        assert_eq!(
            nodes[1].path, "untitled-2",
            "a folder goes among the folders"
        );

        insert_placeholder(&mut nodes, "chapters/untitled", false);
        let chapter: Vec<_> = nodes[0]
            .children
            .iter()
            .map(|node| node.path.as_str())
            .collect();
        assert_eq!(chapter, ["chapters/intro.tex", "chapters/untitled"]);
    }
}
