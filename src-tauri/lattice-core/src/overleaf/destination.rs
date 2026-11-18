//! Where "Open from Overleaf" downloads a project: the folder the writer last
//! downloaded into, else the app's default (`Documents/Overleaf Projects`).
//! The choice is the app's, not a project's, so it lives in the Overleaf
//! config folder beside the session, as one small JSON file.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const DESTINATION_FILE: &str = "overleaf-download-folder.json";

#[derive(Serialize, Deserialize)]
struct Destination {
    folder: PathBuf,
}

/// The folder a download goes to: the last one used while it is still a
/// folder, else `default`. A remembered folder on a drive that is not
/// mounted, or one deleted since, quietly gives way to the default rather
/// than failing the download.
pub fn download_parent(config_dir: &Path, default: &Path) -> PathBuf {
    (fs::read_to_string(config_dir.join(DESTINATION_FILE)).ok())
        .and_then(|raw| serde_json::from_str::<Destination>(&raw).ok())
        .map(|destination| destination.folder)
        .filter(|folder| folder.is_dir())
        .unwrap_or_else(|| default.to_path_buf())
}

/// Remember `folder` as where the next download goes. Best effort: failing
/// to write it must never fail the download that called this.
pub fn remember_download_parent(config_dir: &Path, folder: &Path) {
    let destination = Destination { folder: folder.to_path_buf() };
    let written = fs::create_dir_all(config_dir).and_then(|()| {
        let body = serde_json::to_string_pretty(&destination).map_err(std::io::Error::other)?;
        fs::write(config_dir.join(DESTINATION_FILE), body + "\n")
    });
    if let Err(error) = written {
        log::warn!("Could not remember the Overleaf download folder: {error}");
    }
}

/// Check that a project can be downloaded into `folder`: it exists, is a
/// folder, and this app may create files in it. Checked by creating a file,
/// because permissions alone do not tell (a read-only volume, a sandboxed
/// folder, an ACL).
pub fn check_download_parent(folder: &Path) -> Result<(), String> {
    if !folder.is_dir() {
        return Err("That folder no longer exists. Choose another one.".to_string());
    }
    let probe = folder.join(format!(".lattice-write-check-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(_) => Err("Lattice can't save files in that folder. Choose another one.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_download_goes_where_the_last_one_went_while_that_folder_is_there() {
        let (config, default, chosen) =
            (TempDir::new("config"), TempDir::new("default"), TempDir::new("chosen"));
        assert_eq!(download_parent(&config, &default), default.to_path_buf());

        remember_download_parent(&config, &chosen);
        assert_eq!(download_parent(&config, &default), chosen.to_path_buf());

        let gone = chosen.join("gone");
        remember_download_parent(&config, &gone);
        assert_eq!(download_parent(&config, &default), default.to_path_buf());
        fs::write(config.join(DESTINATION_FILE), "not json").unwrap();
        assert_eq!(download_parent(&config, &default), default.to_path_buf());
    }

    #[test]
    fn only_a_folder_this_app_can_write_in_takes_a_download() {
        let folder = TempDir::new("writable");
        assert!(check_download_parent(&folder).is_ok());
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 0, "the check leaves nothing behind");

        assert!(check_download_parent(&folder.join("missing"))
            .unwrap_err()
            .contains("no longer exists"));
        let file = folder.join("file.txt");
        fs::write(&file, "x").unwrap();
        assert!(check_download_parent(&file).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = folder.join("locked");
            fs::create_dir(&locked).unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
            let refused = check_download_parent(&locked);
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(refused.unwrap_err().contains("can't save files"));
        }
    }
}
