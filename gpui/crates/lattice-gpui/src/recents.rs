//! The projects opened lately, newest first, as the Tauri app keeps them
//! (`RecentProject` in `src/settings/app-settings.ts`): each one's name, its
//! folder and when a window last opened it, at most eight. The welcome
//! screen lays out the first three (one for each of ⌘1 to ⌘3) and a launch
//! without a project reopens the newest.
//!
//! The list lives as `recent-projects.json` in the app's state directory
//! (`shell::workspaces::state_dir`): a scripted run keeps it in memory unless
//! `LATTICE_GPUI_STATE_DIR` names a directory, so a run never reads or
//! changes the writer's own list.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use gpui::{App, Global};
use serde::{Deserialize, Serialize};

use crate::shell::workspaces::{state_dir, write_json};

const KEPT: usize = 8;
const FILE: &str = "recent-projects.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: PathBuf,
    /// When a window last opened it, in ms since the epoch; absent from an
    /// entry written before the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<u64>,
}

pub struct RecentProjects {
    dir: Option<PathBuf>,
    list: Vec<RecentProject>,
}

impl Global for RecentProjects {}

impl RecentProjects {
    pub fn init(scripted: bool, cx: &mut App) {
        cx.set_global(Self::load(state_dir(scripted)));
    }

    fn load(dir: Option<PathBuf>) -> Self {
        let list = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join(FILE)).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<RecentProject>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .take(KEPT)
            .collect();
        Self { dir, list }
    }

    pub fn list(cx: &App) -> &[RecentProject] {
        cx.try_global::<Self>()
            .map(|recents| recents.list.as_slice())
            .unwrap_or_default()
    }

    /// Put `root` first, named `name`, opened now.
    pub fn record(root: &Path, name: &str, cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        let recents = cx.global_mut::<Self>();
        recents.list.retain(|project| project.path != root);
        recents.list.insert(
            0,
            RecentProject {
                name: name.to_string(),
                path: root.to_path_buf(),
                opened_at: Some(now_ms()),
            },
        );
        recents.list.truncate(KEPT);
        recents.persist();
        crate::shell::menus::refresh(cx);
    }

    /// Replace the list, for a scenario that stages one.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn stage(list: Vec<RecentProject>, cx: &mut App) {
        if cx.has_global::<Self>() {
            cx.global_mut::<Self>().list = list;
        }
    }

    fn persist(&self) {
        if let Some(dir) = &self.dir
            && let Err(error) = write_json(&dir.join(FILE), &self.list)
        {
            log::warn!("could not save the recent projects: {error:#}");
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_reads_the_apps_own_shape_and_keeps_eight() {
        let dir = std::env::temp_dir().join(format!("lattice-gpui-recents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entries: Vec<String> = (0..10)
            .map(|n| format!(r#"{{"name":"P{n}","path":"/p/{n}","openedAt":{n}}}"#))
            .collect();
        std::fs::write(dir.join(FILE), format!("[{}]", entries.join(","))).unwrap();
        let recents = RecentProjects::load(Some(dir.clone()));
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(recents.list.len(), KEPT);
        assert_eq!(recents.list[0].opened_at, Some(0));
        assert_eq!(recents.list[0].path, PathBuf::from("/p/0"));
    }
}
