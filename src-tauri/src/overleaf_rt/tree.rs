//! The live file tree.
//!
//! Overleaf's tree events are deltas keyed on entity ids: a rename says only
//! "this id is now called that", a delete says only "this id is gone" — one
//! event for a whole folder, not one per file inside it. Nothing carries a
//! path. So the only way to keep a path→document map current without
//! re-reading the project is to hold the tree itself and resolve paths from it.

use super::events::{DocEntry, EntityEntry, Permission};
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
}

/// The project's entities, indexed by id.
#[derive(Debug, Default, Clone)]
pub(super) struct Tree {
    nodes: HashMap<String, TreeNode>,
    pub root: String,
}

impl Tree {
    fn from_root(root: &Value) -> Self {
        let mut tree = Tree {
            nodes: HashMap::new(),
            root: root.get("_id").and_then(Value::as_str).unwrap_or_default().to_string(),
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
        let node = TreeNode { name, parent: parent.map(str::to_string), kind: NodeKind::Folder };
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
        self.nodes.insert(
            id.to_string(),
            TreeNode { name: name.to_string(), parent: Some(parent.to_string()), kind },
        );
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
    Ok((Tree::from_root(root), permission, track_changes))
}
