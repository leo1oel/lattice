//! Copy-on-start workspaces and checked writeback. An agent never writes the original tree.
use crate::{project, project_fs};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
const LIMIT: u64 = 64 * 1024 * 1024;
const COUNT: usize = 4096;
pub struct Workspace {
    pub original: PathBuf,
    pub stage: PathBuf,
    baseline: BTreeMap<String, Vec<u8>>,
    journal: PathBuf,
}
fn control(path: &str) -> bool {
    path.split('/').any(|part| part.starts_with('.'))
}
fn bibliography(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".bib")
}
fn files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    project_fs::ProjectDir::open_nofollow(root)?.read_tree(LIMIT, COUNT)
}

impl Workspace {
    pub fn prepare(original: &Path, stage: &Path, journal: &Path) -> Result<Self, String> {
        let original_files = files(original)?;
        fs::create_dir_all(stage).map_err(|e| e.to_string())?;
        let previous: Option<BTreeMap<String, Vec<u8>>> = fs::read(journal)
            .ok()
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|_| "Agent baseline journal is damaged.".to_string())
            })
            .transpose()?;
        let existing = files(stage)?;
        let mut baseline = previous.clone().unwrap_or_default();
        for (name, bytes) in &original_files {
            if previous.is_some() && existing.get(name) != baseline.get(name) {
                continue;
            }
            project_fs::ProjectDir::open_nofollow(stage)?.atomic_write(name, bytes)?;
            baseline.insert(name.clone(), bytes.clone());
        }
        let workspace = Self {
            original: original.to_path_buf(),
            stage: stage.to_path_buf(),
            baseline,
            journal: journal.to_path_buf(),
        };
        workspace.save()?;
        Ok(workspace)
    }
    fn save(&self) -> Result<(), String> {
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(parent) = self.journal.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary =
            self.journal.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(
            &mut file,
            &serde_json::to_vec(&self.baseline).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, &self.journal).map_err(|e| e.to_string())
    }
    /// Explicitly apply text edits and creations. Deletions, binary edits, hidden state and
    /// bibliography changes are retained in staging and reported for manual review.
    pub fn apply(&mut self) -> Result<Value, String> {
        let mutation = crate::project_locks::mutation(&self.original);
        let _lease =
            mutation.lock().map_err(|_| "Project mutation lock unavailable".to_string())?;
        let current = files(&self.stage)?;
        let mut applied = Vec::new();
        let mut blocked = Vec::new();
        for (name, bytes) in &current {
            if self.baseline.get(name) == Some(bytes) {
                continue;
            }
            if control(name) || bibliography(name) {
                blocked.push(json!({"path":name,"reason":"protected_path"}));
                continue;
            }
            let Ok(text) = std::str::from_utf8(bytes) else {
                blocked.push(json!({"path":name,"reason":"binary_requires_review"}));
                continue;
            };
            let baseline = self.baseline.get(name);
            let disk = match project::safe_path(&self.original, name) {
                Ok(path) => fs::read(path).ok(),
                Err(_) => None,
            };
            if disk.as_ref() != baseline {
                blocked.push(json!({"path":name,"reason":"original_changed"}));
                continue;
            }
            // Use the shared atomic history transaction and exact expected version. A text
            // edit from the UI after our read is refused by the domain's comparison.
            let base =
                baseline.and_then(|value| std::str::from_utf8(value).ok()).map(str::to_string);
            let base = if base.is_none() {
                if project_fs::ProjectDir::open(&self.original)
                    .and_then(|dir| dir.create_empty(name))
                    .is_err()
                {
                    blocked.push(json!({"path":name,"reason":"creation_refused"}));
                    continue;
                }
                Some(String::new())
            } else {
                base
            };
            match project::apply_editor_transaction(
                &self.original,
                name.clone(),
                text.to_string(),
                base.clone(),
                base,
            ) {
                Ok(_) => {
                    self.baseline.insert(name.clone(), bytes.clone());
                    applied.push(name.clone());
                }
                Err(_) => blocked.push(json!({"path":name,"reason":"write_refused"})),
            }
        }
        for name in self.baseline.keys() {
            if !current.contains_key(name) {
                blocked.push(json!({"path":name,"reason":"deletion_requires_review"}));
            }
        }
        self.save()?;
        Ok(json!({"applied":applied,"blocked":blocked,"mode":"explicit_checked_writeback"}))
    }
}
