//! The live file tree.
//!
//! Overleaf's tree events are deltas keyed on entity ids: a rename says only
//! "this id is now called that", a delete says only "this id is gone" — one
//! event for a whole folder, not one per file inside it. Nothing carries a
//! path. So the only way to keep a path→document map current without
//! re-reading the project is to hold the tree itself and resolve paths from it.

use super::events::{DocEntry, EntityEntry, Permission, RealtimeEvent};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

/// Guard against a pathological (or hostile) folder tree.
const MAX_FOLDER_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NodeKind {
    Folder,
    /// A document Overleaf tracks line by line, and the only kind that can be
    /// edited through the channel.
    Doc,
    /// A binary file: a figure, a PDF. Present so paths resolve, and so a
    /// delete prunes it, but never joinable.
    File,
}

#[derive(Debug, Clone)]
struct TreeNode {
    name: String,
    parent: Option<String>,
    kind: NodeKind,
    /// A file's content hash, as Overleaf names it (`fileRefs[].hash`):
    /// the git blob SHA-1 its history stores the file under. Older
    /// instances, and every document, have none.
    hash: Option<String>,
}

/// The project's entities, indexed by id.
#[derive(Debug, Default, Clone)]
pub(super) struct Tree {
    nodes: HashMap<String, TreeNode>,
    pub root: String,
    /// The id of the project's main document, which `joinProject` names as
    /// `rootDoc_id` and `rootDocUpdated` changes.
    root_doc: Option<String>,
}

/// What `joinProject` told us about the project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    pub root_folder_id: String,
    pub docs: Vec<DocEntry>,
    /// Everything in the project, so a file can be acted on by id.
    pub entities: Vec<EntityEntry>,
    /// The project's main document (`rootDoc_id`), the file Overleaf compiles,
    /// as a path; `None` when it names no document in the tree.
    pub root_document: Option<String>,
    /// Our own Overleaf account id, echoed back so the app can name itself in
    /// the per-account settings Overleaf stores.
    pub user_id: Option<String>,
    /// What this account may do to the project. The connect answer carries
    /// it: without it the app read `undefined` and overwrote what the
    /// projectJoined event had established, so a reviewer's first keystroke
    /// went out as a plain edit, the server refused it, and live editing died.
    pub permission: Permission,
    /// Whether edits should be recorded as suggestions rather than applied
    /// outright, for this account.
    pub track_changes: bool,
    /// Each binary file's content hash by its id, where Overleaf gave one
    /// (see `TreeNode::hash`): what lets a sync tell an unchanged figure
    /// without downloading it, and check one it does download.
    #[serde(skip)]
    pub file_hashes: HashMap<String, String>,
}

impl ProjectTree {
    pub(super) fn of(
        tree: &Tree, user_id: Option<String>, permission: Permission, track_changes: bool,
    ) -> Self {
        ProjectTree {
            root_folder_id: tree.root.clone(),
            docs: tree.docs(),
            entities: tree.entities(),
            root_document: tree.root_document(),
            user_id,
            permission,
            track_changes,
            file_hashes: tree.file_hashes(),
        }
    }
}

impl Tree {
    fn from_root(root: &Value) -> Self {
        let mut tree = Tree {
            nodes: HashMap::new(),
            root: root.get("_id").and_then(Value::as_str).unwrap_or_default().to_string(),
            root_doc: None,
        };
        tree.absorb(root, None, 0);
        tree
    }

    fn absorb(&mut self, folder: &Value, parent: Option<&str>, depth: usize) {
        if depth > MAX_FOLDER_DEPTH {
            return;
        }
        let Some(id) = folder.get("_id").and_then(Value::as_str) else {
            return;
        };
        let name = folder.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let parent = parent.map(str::to_string);
        let node = TreeNode { name, parent, kind: NodeKind::Folder, hash: None };
        self.nodes.insert(id.to_string(), node);
        for (key, kind) in [("docs", NodeKind::Doc), ("fileRefs", NodeKind::File)] {
            for entity in folder.get(key).and_then(Value::as_array).into_iter().flatten() {
                self.insert_entity(id, entity, kind);
            }
        }
        for child in folder.get("folders").and_then(Value::as_array).into_iter().flatten() {
            self.absorb(child, Some(id), depth + 1);
        }
    }

    pub fn insert_entity(&mut self, parent: &str, entity: &Value, kind: NodeKind) {
        let (Some(id), Some(name)) =
            (entity.get("_id").and_then(Value::as_str), entity.get("name").and_then(Value::as_str))
        else {
            return;
        };
        let hash = (kind == NodeKind::File)
            .then(|| entity.get("hash").and_then(Value::as_str).map(str::to_string))
            .flatten();
        let (name, parent) = (name.to_string(), Some(parent.to_string()));
        self.nodes.insert(id.to_string(), TreeNode { name, parent, kind, hash });
    }

    /// See [`ProjectTree::file_hashes`].
    pub fn file_hashes(&self) -> HashMap<String, String> {
        (self.nodes.iter())
            .filter_map(|(id, node)| Some((id.clone(), node.hash.clone()?)))
            .collect()
    }

    /// The path of an entity, relative to the project root. The root folder's
    /// own name is not part of any path.
    pub fn path_of(&self, id: &str) -> Option<String> {
        let mut parts: Vec<&str> = Vec::new();
        let mut current = id;
        for _ in 0..=MAX_FOLDER_DEPTH {
            let node = self.nodes.get(current)?;
            let Some(parent) = node.parent.as_deref() else {
                parts.reverse();
                return Some(parts.join("/"));
            };
            parts.push(&node.name);
            current = parent;
        }
        // A cycle, which should not happen; refusing to answer beats looping.
        None
    }

    /// Everything in the project except the root folder (which nobody can act
    /// on and which has no path), sorted by path.
    pub fn entities(&self) -> Vec<EntityEntry> {
        let mut entries: Vec<EntityEntry> = (self.nodes.iter())
            .filter(|(id, _)| **id != self.root)
            .filter_map(|(id, node)| {
                let kind = match node.kind {
                    NodeKind::Folder => "folder",
                    NodeKind::Doc => "doc",
                    NodeKind::File => "file",
                };
                Some(EntityEntry {
                    id: id.clone(),
                    path: self.path_of(id)?,
                    kind: kind.to_string(),
                })
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        entries
    }

    /// Every editable document, sorted by path.
    pub fn docs(&self) -> Vec<DocEntry> {
        let entities = self.entities().into_iter().filter(|entity| entity.kind == "doc");
        entities.map(|entity| DocEntry { id: entity.id, path: entity.path }).collect()
    }

    /// The main document's path, while it is a document in the tree.
    pub fn root_document(&self) -> Option<String> {
        let id = self.root_doc.as_deref()?;
        (self.nodes.get(id)?.kind == NodeKind::Doc).then(|| self.path_of(id)).flatten()
    }

    pub fn set_root_doc(&mut self, id: Option<&str>) -> bool {
        let changed = self.root_doc.as_deref() != id;
        self.root_doc = id.map(str::to_string);
        changed
    }

    /// The tree as the app is told it changed: every document and entity, and
    /// the main document, which a rename or move of it changes too.
    pub fn changed(&self) -> RealtimeEvent {
        let (docs, entities) = (self.docs(), self.entities());
        RealtimeEvent::TreeChanged { docs, entities, root_document: self.root_document() }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        self.nodes.get_mut(id).map(|node| node.name = name.to_string()).is_some()
    }

    /// Refused for a parent we have never heard of, rather than orphaning.
    pub fn move_to(&mut self, id: &str, parent: &str) -> bool {
        self.nodes.contains_key(parent)
            && self.nodes.get_mut(id).map(|node| node.parent = Some(parent.to_string())).is_some()
    }

    /// Remove an entity and everything under it. Overleaf sends one event for
    /// a deleted folder, so pruning the subtree is the client's job.
    pub fn remove(&mut self, id: &str) -> bool {
        if self.nodes.remove(id).is_none() {
            return false;
        }
        let mut doomed = vec![id.to_string()];
        while let Some(parent) = doomed.pop() {
            let children: Vec<String> = (self.nodes.iter())
                .filter(|(_, node)| node.parent.as_deref() == Some(parent.as_str()))
                .map(|(id, _)| id.clone())
                .collect();
            for child in children {
                self.nodes.remove(&child);
                doomed.push(child);
            }
        }
        true
    }
}

/// `joinProject` answers with `[error, project, permissions, protocolVersion]`;
/// `project.rootFolder` is an array holding the single root folder. Also returns
/// the raw `trackChangesState`, which only the caller (who knows whose account
/// this is) can interpret.
pub(super) fn parse_project(body: &[Value]) -> Result<(Tree, Permission, Option<Value>), String> {
    let first = body
        .first()
        .ok_or_else(|| "Overleaf's joinProject answer carried no project.".to_string())?;
    // Two shapes: the plain ack puts the permission level in its own slot,
    // while `joinProjectResponse` wraps the project alongside the public id and
    // the permission level.
    let permission = Permission::parse(
        first
            .get("permissionsLevel")
            .and_then(Value::as_str)
            .or_else(|| body.get(1).and_then(Value::as_str)),
    );
    let project = first.get("project").unwrap_or(first);
    let root_field = project
        .get("rootFolder")
        .ok_or_else(|| "Overleaf's joinProject answer has no rootFolder.".to_string())?;
    let root = match root_field {
        Value::Array(folders) => folders
            .first()
            .ok_or_else(|| "Overleaf's project has an empty rootFolder.".to_string())?,
        object @ Value::Object(_) => object,
        _ => return Err("Overleaf's project has an unexpected rootFolder.".to_string()),
    };
    if root.get("_id").and_then(Value::as_str).is_none() {
        return Err("Overleaf's root folder has no id.".to_string());
    }
    let track_changes = project.get("trackChangesState").cloned();
    let mut tree = Tree::from_root(root);
    tree.set_root_doc(project.get("rootDoc_id").and_then(Value::as_str));
    Ok((tree, permission, track_changes))
}

#[cfg(test)]
mod tests {
    use super::super::tests::project_tree;
    use super::*;
    use serde_json::json;

    fn joined(root_doc: Value) -> Tree {
        let mut project = project_tree();
        project["rootDoc_id"] = root_doc;
        parse_project(&[project, json!("owner")]).unwrap().0
    }

    /// The main document is named by id, so a rename or move in the browser
    /// changes its path without any event that mentions it.
    #[test]
    fn the_main_document_is_followed_by_id_through_renames_and_settings_changes() {
        let mut tree = joined(json!("doc-1"));
        assert_eq!(tree.root_document().as_deref(), Some("main.tex"));

        assert!(tree.rename("doc-1", "main_v2.tex"));
        let RealtimeEvent::TreeChanged { root_document, .. } = tree.changed() else { panic!() };
        assert_eq!(root_document.as_deref(), Some("main_v2.tex"));

        // `rootDocUpdated`: someone chose another main document.
        assert!(tree.set_root_doc(Some("doc-2")));
        assert!(!tree.set_root_doc(Some("doc-2")), "the same choice again changes nothing");
        assert_eq!(tree.root_document().as_deref(), Some("sections/intro.tex"));

        // Deleted, it names nothing rather than a path that is gone.
        assert!(tree.remove("folder-1"));
        assert_eq!(tree.root_document(), None);
    }

    #[test]
    fn a_main_document_that_is_no_document_names_nothing() {
        // A binary file, an id the tree never held, or none at all.
        for root_doc in [json!("file-1"), json!("doc-unknown"), Value::Null] {
            assert_eq!(joined(root_doc.clone()).root_document(), None, "{root_doc}");
        }
    }
}
