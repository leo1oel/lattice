use super::*;
use crate::overleaf::link::{adopt_project, clone_project, clone_target, publish_project};
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
    let cloned = clone_project(&config, "proj-1", "Cloned", &parent, None, false).unwrap();

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

/// "Download a new copy" passes over the copy already linked in the download
/// folder and lands beside it, and both stay known.
#[test]
fn a_separate_copy_lands_beside_the_linked_one() {
    let server = Mock::project(&[("main.tex", b"remote body")]).serve();
    let (config, parent) = (signed_in(&server.base), TempDir::new("clone-parent"));
    let first = clone_project(&config, "proj-1", "Paper", &parent, None, false).unwrap();
    assert_eq!(clone_project(&config, "proj-1", "Paper", &parent, None, false).unwrap(), first);

    let second = clone_project(&config, "proj-1", "Paper", &parent, None, true).unwrap();
    assert_eq!(second, parent.join("Paper (2)"));
    assert_eq!(load_state(&second).unwrap().project_id, "proj-1");
    // The most recently linked one answers for the project.
    assert_eq!(local_copies(&config, &[]).get("proj-1").unwrap().path, canonical(&second));
    // A recent project the app passes in comes first.
    let copies = local_copies(&config, std::slice::from_ref(&first));
    assert_eq!(copies["proj-1"].path, canonical(&first));
}

#[test]
fn display_paths_use_the_home_folder_as_a_tilde() {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    assert_eq!(display_path(&home.join("Papers/Native VLM")), "~/Papers/Native VLM");
    assert_eq!(display_path(Path::new("/Volumes/Work/Paper")), "/Volumes/Work/Paper");
}
