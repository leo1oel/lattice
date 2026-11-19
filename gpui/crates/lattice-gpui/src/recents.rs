//! The projects opened lately, newest first, as the Tauri app keeps them
//! (`RecentProject` in `src/settings/app-settings.ts`): each one's name, its
//! folder, when a window last opened it, whether the folder is linked to
//! Overleaf and whether it is gone, at most a hundred, one per folder. The
//! welcome screen lays out the first three (one for each of ⌘1 to ⌘3) and
//! lists the next twenty under them; the titlebar switcher and File ▸ Open
//! Recent list a few more, and the recent project finder
//! (`search::insert_pickers::PickerKind::RecentProject`) searches them all. A
//! launch without a project reopens the newest.
//!
//! A folder that is gone is marked, never dropped: `check` reads every
//! folder again off the main thread at launch, when a surface listing them
//! is built and after an open fails, and a project opened again is no
//! longer missing. A folder is linked to Overleaf when it holds the sync
//! state (`.research/overleaf.json`), the Tauri app's same cheap test.
//!
//! The list lives as `recent-projects.json` in the app's state directory
//! (`shell::workspaces::state_dir`): a scripted run keeps it in memory unless
//! `LATTICE_GPUI_STATE_DIR` names a directory, so a run never reads or
//! changes the writer's own list.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use gpui::{App, Global};
use serde::{Deserialize, Serialize};

use crate::shell::workspaces::{state_dir, write_json};

const KEPT: usize = 100;
const FILE: &str = "recent-projects.json";
/// How long a surface's own check of the folders stands before another
/// surface reads them again: a menu built twice in a row reads them once.
const CHECK_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: PathBuf,
    /// When a window last opened it, in ms since the epoch; absent from an
    /// entry written before the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<u64>,
    /// The folder holds an Overleaf link. Left out when false, so a reader
    /// that predates it reads the entry as before.
    #[serde(default, skip_serializing_if = "is_false")]
    pub overleaf: bool,
    /// The folder was not there when last looked for.
    #[serde(default, skip_serializing_if = "is_false")]
    pub missing: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One folder, as two paths name it: trailing separators aside.
pub fn same_path(a: &Path, b: &Path) -> bool {
    fn trimmed(path: &Path) -> &str {
        let text = path.to_str().unwrap_or_default();
        let trimmed = text.trim_end_matches(['/', '\\']);
        if trimmed.is_empty() { text } else { trimmed }
    }
    a == b || (a.to_str().is_some() && trimmed(a) == trimmed(b))
}

/// What a look at a folder finds: whether it is gone, and whether it holds
/// an Overleaf link (`.research/overleaf.json`, as the Tauri app tests it).
fn look(path: &Path) -> (bool, bool) {
    let missing = !path.is_dir();
    let overleaf = !missing && path.join(".research").join("overleaf.json").is_file();
    (missing, overleaf)
}

pub struct RecentProjects {
    dir: Option<PathBuf>,
    list: Vec<RecentProject>,
    checked_at: Option<Instant>,
}

impl Global for RecentProjects {}

impl RecentProjects {
    pub fn init(scripted: bool, cx: &mut App) {
        cx.set_global(Self::load(state_dir(scripted)));
        Self::check(cx);
    }

    fn load(dir: Option<PathBuf>) -> Self {
        let read = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join(FILE)).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<RecentProject>>(&bytes).ok())
            .unwrap_or_default();
        let mut list: Vec<RecentProject> = Vec::new();
        for project in read {
            if !list.iter().any(|kept| same_path(&kept.path, &project.path)) {
                list.push(project);
            }
        }
        list.truncate(KEPT);
        Self {
            dir,
            list,
            checked_at: None,
        }
    }

    pub fn list(cx: &App) -> &[RecentProject] {
        cx.try_global::<Self>()
            .map(|recents| recents.list.as_slice())
            .unwrap_or_default()
    }

    /// The recent projects other than `current`, newest first.
    pub fn others(current: Option<&Path>, cx: &App) -> Vec<RecentProject> {
        Self::list(cx)
            .iter()
            .filter(|recent| current.is_none_or(|current| !same_path(&recent.path, current)))
            .cloned()
            .collect()
    }

    /// Put `root` first, named `name`, opened now, and no longer missing.
    pub fn record(root: &Path, name: &str, cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        let recents = cx.global_mut::<Self>();
        recents.put_first(root, name, now_ms());
        recents.persist();
        crate::shell::menus::refresh(cx);
        Self::check(cx);
    }

    fn put_first(&mut self, root: &Path, name: &str, now: u64) {
        let overleaf = self
            .list
            .iter()
            .find(|project| same_path(&project.path, root))
            .is_some_and(|project| project.overleaf);
        self.list.retain(|project| !same_path(&project.path, root));
        self.list.insert(
            0,
            RecentProject {
                name: name.to_string(),
                path: root.to_path_buf(),
                opened_at: Some(now),
                overleaf,
                missing: false,
            },
        );
        self.list.truncate(KEPT);
    }

    /// Look at every folder again, off the main thread, unless a look just
    /// did: for a surface about to list them.
    pub fn refresh(cx: &mut App) {
        let fresh = cx
            .try_global::<Self>()
            .and_then(|recents| recents.checked_at)
            .is_some_and(|at| at.elapsed() < CHECK_INTERVAL);
        if !fresh {
            Self::check(cx);
        }
    }

    /// Look at every folder again, off the main thread: a gone one is marked
    /// missing (one back is unmarked), and each one's Overleaf link is read.
    pub fn check(cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        let recents = cx.global_mut::<Self>();
        recents.checked_at = Some(Instant::now());
        let paths: Vec<PathBuf> = recents
            .list
            .iter()
            .map(|project| project.path.clone())
            .collect();
        if paths.is_empty() {
            return;
        }
        cx.spawn(async move |cx| {
            let looks = cx
                .background_executor()
                .spawn(async move {
                    paths
                        .into_iter()
                        .map(|path| {
                            let found = look(&path);
                            (path, found)
                        })
                        .collect::<Vec<_>>()
                })
                .await;
            cx.update(|cx| {
                if !cx.has_global::<Self>() {
                    return;
                }
                if cx.global_mut::<Self>().apply(&looks) {
                    let recents = cx.global::<Self>();
                    recents.persist();
                    crate::shell::menus::refresh(cx);
                    cx.refresh_windows();
                }
            });
        })
        .detach();
    }

    /// Take what a look found; whether anything changed. A gone folder keeps
    /// the link it last had, so it still reads as the Overleaf project it was.
    fn apply(&mut self, looks: &[(PathBuf, (bool, bool))]) -> bool {
        let mut changed = false;
        for (path, (missing, overleaf)) in looks {
            let Some(project) = self.list.iter_mut().find(|project| project.path == *path) else {
                continue;
            };
            let overleaf = if *missing {
                project.overleaf
            } else {
                *overleaf
            };
            if project.missing != *missing || project.overleaf != overleaf {
                project.missing = *missing;
                project.overleaf = overleaf;
                changed = true;
            }
        }
        changed
    }

    /// Replace the list, for a scenario that stages one.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn stage(list: Vec<RecentProject>, cx: &mut App) {
        if cx.has_global::<Self>() {
            let recents = cx.global_mut::<Self>();
            recents.list = list;
            // A staged list's folders are made up: a look would mark them all
            // missing.
            recents.checked_at = Some(Instant::now() + Duration::from_secs(3600));
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

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lattice-gpui-recents-{name}-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project(path: &str) -> RecentProject {
        RecentProject {
            name: path.rsplit('/').next().unwrap_or_default().into(),
            path: path.into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_list_reads_the_apps_own_shape_and_keeps_a_hundred() {
        let dir = scratch("shape");
        let entries: Vec<String> = (0..120)
            .map(|n| format!(r#"{{"name":"P{n}","path":"/p/{n}","openedAt":{n}}}"#))
            .collect();
        std::fs::write(dir.join(FILE), format!("[{}]", entries.join(","))).unwrap();
        let recents = RecentProjects::load(Some(dir.clone()));
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(recents.list.len(), KEPT);
        assert_eq!(KEPT, 100);
        assert_eq!(recents.list[0].opened_at, Some(0));
        assert_eq!(recents.list[0].path, PathBuf::from("/p/0"));
        assert_eq!(recents.list[99].path, PathBuf::from("/p/99"));
        assert!(!recents.list[0].overleaf && !recents.list[0].missing);
    }

    #[test]
    fn recording_keeps_one_entry_per_folder_newest_first_and_at_most_a_hundred() {
        let mut recents = RecentProjects {
            dir: None,
            list: (0..KEPT).map(|n| project(&format!("/p/{n}"))).collect(),
            checked_at: None,
        };
        recents.list[5].overleaf = true;
        recents.list[5].missing = true;
        recents.put_first(Path::new("/p/5/"), "Five", 42);
        assert_eq!(recents.list.len(), KEPT);
        assert_eq!(recents.list[0].name, "Five");
        assert_eq!(recents.list[0].opened_at, Some(42));
        // Opened again: still linked, no longer missing.
        assert!(recents.list[0].overleaf);
        assert!(!recents.list[0].missing);
        assert_eq!(
            recents
                .list
                .iter()
                .filter(|p| same_path(&p.path, Path::new("/p/5")))
                .count(),
            1
        );
        recents.put_first(Path::new("/p/new"), "New", 43);
        assert_eq!(recents.list.len(), KEPT);
        assert_eq!(recents.list[0].path, PathBuf::from("/p/new"));
        assert!(!recents.list.iter().any(|p| p.path == Path::new("/p/99")));
    }

    #[test]
    fn a_loaded_list_drops_a_second_entry_for_one_folder() {
        let dir = scratch("dedup");
        std::fs::write(
            dir.join(FILE),
            r#"[{"name":"A","path":"/p/a"},{"name":"B","path":"/p/b"},{"name":"A again","path":"/p/a/"}]"#,
        )
        .unwrap();
        let recents = RecentProjects::load(Some(dir.clone()));
        std::fs::remove_dir_all(&dir).ok();
        let names: Vec<&str> = recents.list.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["A", "B"]);
        assert!(same_path(Path::new("/p/a/"), Path::new("/p/a")));
        assert!(!same_path(Path::new("/p/a"), Path::new("/p/ab")));
        assert!(same_path(Path::new("/"), Path::new("/")));
    }

    #[test]
    fn a_gone_folder_is_marked_missing_and_keeps_its_link() {
        let dir = scratch("missing");
        let linked = dir.join("linked");
        std::fs::create_dir_all(linked.join(".research")).unwrap();
        std::fs::write(linked.join(".research/overleaf.json"), "{}").unwrap();
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let gone = dir.join("gone");
        let mut recents = RecentProjects {
            dir: None,
            list: vec![
                RecentProject {
                    path: linked.clone(),
                    ..Default::default()
                },
                RecentProject {
                    path: plain.clone(),
                    missing: true,
                    ..Default::default()
                },
                RecentProject {
                    path: gone.clone(),
                    overleaf: true,
                    ..Default::default()
                },
            ],
            checked_at: None,
        };
        let looks: Vec<_> = [&linked, &plain, &gone]
            .into_iter()
            .map(|path| (path.clone(), look(path)))
            .collect();
        assert!(recents.apply(&looks));
        std::fs::remove_dir_all(&dir).ok();
        assert!(recents.list[0].overleaf && !recents.list[0].missing);
        assert!(!recents.list[1].overleaf && !recents.list[1].missing);
        assert!(recents.list[2].overleaf && recents.list[2].missing);
        assert_eq!(recents.list.len(), 3);
        assert!(!recents.apply(&looks));
    }

    #[test]
    fn the_overleaf_and_missing_fields_round_trip_and_stay_out_when_false() {
        let entries = vec![
            RecentProject {
                name: "Linked".into(),
                path: "/p/linked".into(),
                opened_at: Some(7),
                overleaf: true,
                missing: true,
            },
            project("/p/plain"),
        ];
        let json = serde_json::to_string(&entries).unwrap();
        assert_eq!(
            json,
            r#"[{"name":"Linked","path":"/p/linked","openedAt":7,"overleaf":true,"missing":true},{"name":"plain","path":"/p/plain"}]"#
        );
        let read: Vec<RecentProject> = serde_json::from_str(&json).unwrap();
        assert_eq!(read, entries);
    }
}
