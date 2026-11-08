use super::*;
use crate::overleaf::link::{
    adopt_project, clone_project, clone_target, publish_project, reopen_local_copy,
};
use crate::overleaf::test_support::*;

/// A folder linked to `project_id` on `host`, wherever it sits.
fn link_folder(root: &Path, host: &str, project_id: &str) {
    seed_linked_project(root, host, &[("main.tex", b"body")], &[("main.tex", b"body")]);
    edit_state(root, |state| state.project_id = project_id.to_string());
}

fn canonical(path: &Path) -> String {
    path.canonicalize().unwrap().to_string_lossy().into_owned()
}

/// The captain's case: a folder outside the download folder ("Native VLM",
/// published or adopted there) is linked to a project. The picker's own check
/// only looks in the download folder, so it reads as fresh and opening the
/// project from Overleaf downloaded a second copy. The lookup finds the folder
/// by its own link instead.
#[test]
fn a_linked_folder_outside_the_download_folder_is_found_by_its_link() {
    let host = "https://www.overleaf.com";
    let (config, downloads, elsewhere) =
        (signed_in(host), TempDir::new("downloads"), TempDir::new("native-vlm"));
    link_folder(&elsewhere, host, "proj-1");

    assert_eq!(clone_target("proj-1", "Native VLM", &downloads).unwrap().kind, "fresh");
    // Known only as a recent project: found.
    let copies = local_copies(&config, &[elsewhere.to_path_buf()]);
    assert_eq!(copies.get("proj-1").map(|copy| copy.path.clone()), Some(canonical(&elsewhere)));

    // Not passed in at all: found once any open of it was remembered.
    assert!(local_copies(&config, &[]).is_empty());
    remember_local_copy(&config, &elsewhere);
    let copies = local_copies(&config, &[]);
    assert_eq!(copies.get("proj-1").map(|copy| copy.path.clone()), Some(canonical(&elsewhere)));
    assert!(!copies.contains_key("proj-2"));
}

/// Linking any way at all remembers the folder: cloning, adopting a folder
/// left on disk, and publishing a local project.
#[test]
fn cloning_adopting_and_publishing_remember_the_folder() {
    let server = Mock::project(&[("main.tex", b"remote body")]).serve();
    let (config, parent) = (signed_in(&server.base), TempDir::new("clone-parent"));
    let cloned = clone_project(&config, "proj-1", "Cloned", &parent, None, &|_, _| {}).unwrap();

    let left = TempDir::new("left-behind");
    left.write("main.tex", "kept");
    adopt_project(&config, "proj-2", "Adopted", &left, None).unwrap();

    let local = TempDir::new("publish-me");
    local.write("main.tex", "local body");
    let published = publish_project(&config, &local, "Published").unwrap();

    let copies = local_copies(&config, &[]);
    assert_eq!(copies["proj-1"].path, canonical(&cloned));
    assert_eq!(copies["proj-2"].path, canonical(&left));
    assert_eq!(copies[&published.project_id].path, canonical(&local));
}

/// A remembered folder that was deleted or unlinked since no longer answers,
/// and is dropped from the list, so opening the project downloads it again as
/// it always did. A folder linked to another Overleaf host is not this
/// account's copy.
#[test]
fn deleted_unlinked_and_other_host_folders_do_not_answer() {
    let host = "https://www.overleaf.com";
    let config = signed_in(host);
    let (deleted, unlinked, other_host) =
        (TempDir::new("deleted"), TempDir::new("unlinked"), TempDir::new("other-host"));
    link_folder(&deleted, host, "proj-1");
    link_folder(&unlinked, host, "proj-2");
    link_folder(&other_host, "https://latex.example.edu", "proj-3");
    for folder in [&deleted, &unlinked, &other_host] {
        remember_local_copy(&config, folder);
    }
    assert_eq!(local_copies(&config, &[]).len(), 2);

    fs::remove_dir_all(unlinked.join(".research")).unwrap();
    fs::remove_dir_all(&*deleted).unwrap();
    assert!(local_copies(&config, &[]).is_empty());
    // Only the folder linked elsewhere is still remembered.
    assert_eq!(read_index(&config).folders, vec![other_host.canonicalize().unwrap()]);
}

/// Reopening a copy found here records the role the dashboard reports now —
/// a viewer promoted to editor, or an editor demoted — as reopening a download
/// always did, and an unreported role clears the old one. A folder linked to
/// another project since is not reopened as this one.
#[test]
fn reopening_a_local_copy_records_the_current_role() {
    let host = "https://www.overleaf.com";
    let (config, elsewhere) = (signed_in(host), TempDir::new("native-vlm"));
    link_folder(&elsewhere, host, "proj-1");
    edit_state(&elsewhere, |state| state.permission = Some("readOnly".to_string()));

    reopen_local_copy(&config, &elsewhere, "proj-1", Some("readAndWrite")).unwrap();
    assert_eq!(load_state(&elsewhere).unwrap().permission.as_deref(), Some("readAndWrite"));
    assert_eq!(local_copies(&config, &[])["proj-1"].path, canonical(&elsewhere));
    reopen_local_copy(&config, &elsewhere, "proj-1", None).unwrap();
    assert_eq!(load_state(&elsewhere).unwrap().permission, None);

    assert!(reopen_local_copy(&config, &elsewhere, "proj-2", Some("owner")).is_err());
    assert_eq!(load_state(&elsewhere).unwrap().permission, None);
}

/// A remembered folder on a drive that is not mounted is kept, so with the
/// drive back the project opens it again instead of downloading a second copy.
#[test]
fn a_folder_on_an_unmounted_drive_is_remembered_for_when_it_is_back() {
    let host = "https://www.overleaf.com";
    let (config, volumes) = (signed_in(host), TempDir::new("volumes"));
    let (drive, away) = (volumes.join("Work"), volumes.join("Unplugged"));
    let folder = drive.join("Native VLM");
    fs::create_dir_all(&folder).unwrap();
    link_folder(&folder, host, "proj-1");
    remember_local_copy(&config, &folder);
    let path = canonical(&folder);

    fs::rename(&drive, &away).unwrap();
    assert!(local_copies(&config, &[]).is_empty());
    fs::rename(&away, &drive).unwrap();
    assert_eq!(local_copies(&config, &[])["proj-1"].path, path);
}

/// Windows remembering their folders at the same moment each keep theirs.
#[test]
fn folders_remembered_at_once_are_all_kept() {
    let config = signed_in("https://www.overleaf.com");
    let folders: Vec<TempDir> = (0..8).map(|n| TempDir::new(&format!("window-{n}"))).collect();
    std::thread::scope(|scope| {
        for folder in &folders {
            let config = &config;
            scope.spawn(move || remember_local_copy(config, folder));
        }
    });
    let mut remembered = read_index(&config).folders;
    remembered.sort();
    let mut expected: Vec<PathBuf> =
        folders.iter().map(|folder| folder.canonicalize().unwrap()).collect();
    expected.sort();
    assert_eq!(remembered, expected);
}

#[test]
fn display_paths_use_the_home_folder_as_a_tilde() {
    let home = crate::host_paths::home_dir().unwrap();
    assert_eq!(display_path(&home.join("Papers/Native VLM")), "~/Papers/Native VLM");
    assert_eq!(display_path(Path::new("/Volumes/Work/Paper")), "/Volumes/Work/Paper");
}
