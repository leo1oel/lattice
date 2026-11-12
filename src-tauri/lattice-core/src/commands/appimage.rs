//! The programs Lattice starts from its Linux AppImage get the host's
//! environment, not the AppImage's.
//!
//! The AppImage's launcher (linuxdeploy's AppRun and its GTK hook) puts the
//! image's own folders first in `LD_LIBRARY_PATH`, `PATH`, `PERLLIB`,
//! `XDG_DATA_DIRS`, GTK's module and schema paths and others, so that Lattice
//! and the helpers WebKit spawns load what the image bundles. A program Lattice
//! starts would inherit them and load those Ubuntu 22.04 libraries in place of
//! its own: on Ubuntu 26.04 rust-coreutils (`env`, `ls`, `cat`) then fail on
//! the bundled libsystemd, and with `env` every `#!/usr/bin/env` script,
//! `latexmk` from TeX Live or TinyTeX among them. Nothing under `$APPDIR` is
//! meant for another program, and the mount is gone once Lattice quits, so a
//! child gets none of it: each inherited variable without those entries, or
//! unset when nothing else is left, a search path without those folders (on
//! Linux the bundled-tools folder of the macOS layout is one, and does not
//! exist), and, when its caller names no working folder, not AppRun's
//! `$APPDIR/usr` either. A value that names no folder there (the hook's
//! `GDK_BACKEND=x11`) cannot be told from the writer's own, and is kept.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the AppImage Lattice runs from is mounted or extracted.
fn appimage_dir() -> Option<PathBuf> {
    let appdir = PathBuf::from(env::var_os("APPDIR")?);
    // Not `/` or a relative path, which every folder or none would start with.
    if !appdir.is_absolute() || appdir.parent().is_none() {
        return None;
    }
    // Only Lattice's own: started from another AppImage's terminal, Lattice
    // inherits that one's APPDIR, a folder it does not run from.
    env::current_exe().ok()?.starts_with(&appdir).then_some(appdir)
}

/// Give `command` every inherited variable that names a folder in Lattice's
/// AppImage without it, and a working folder outside it. Variables `command`
/// already sets are left as set, and a working folder set later wins.
pub(crate) fn host_environment(command: &mut Command) -> &mut Command {
    if let Some(appdir) = appimage_dir() {
        apply(command, &appdir, env::vars_os());
        if command.get_current_dir().is_none() {
            let current = env::current_dir().unwrap_or_default();
            let opened_from = env::var_os("OWD").map(PathBuf::from);
            let home = env::var_os("HOME").map(PathBuf::from);
            if let Some(folder) = working_folder(&appdir, &current, [opened_from, home]) {
                command.current_dir(folder);
            }
        }
    }
    command
}

/// Where a child starts instead of Lattice's `current` folder, when that is in
/// the AppImage (AppRun starts Lattice in `$APPDIR/usr`): the first of
/// `candidates`, where the AppImage was opened from (the runtime's `OWD`) and
/// then the home folder, that is a folder outside it.
fn working_folder(
    appdir: &Path, current: &Path, candidates: [Option<PathBuf>; 2],
) -> Option<PathBuf> {
    if !current.starts_with(appdir) {
        return None;
    }
    candidates
        .into_iter()
        .flatten()
        .find(|folder| folder.is_absolute() && !folder.starts_with(appdir) && folder.is_dir())
}

/// `directories` without the folders of Lattice's AppImage.
pub(crate) fn outside_appimage(mut directories: Vec<PathBuf>) -> Vec<PathBuf> {
    if let Some(appdir) = appimage_dir() {
        directories.retain(|directory| !directory.starts_with(&appdir));
    }
    directories
}

fn apply(
    command: &mut Command, appdir: &Path, inherited: impl IntoIterator<Item = (OsString, OsString)>,
) {
    let set: Vec<OsString> = command.get_envs().map(|(name, _)| name.to_os_string()).collect();
    for (name, value) in inherited {
        if set.contains(&name) {
            continue;
        }
        match kept_entries(appdir, &value) {
            None => {}
            Some(kept) if kept.is_empty() => {
                command.env_remove(name);
            }
            Some(kept) => match env::join_paths(kept) {
                Ok(value) => {
                    command.env(name, value);
                }
                Err(_) => {
                    command.env_remove(name);
                }
            },
        }
    }
}

/// The entries of the `:`-separated `value` outside `appdir`, or `None` when
/// none is inside it and the variable passes on as it is. Empty entries go
/// too: AppRun leaves one when the variable was unset, and in `PATH` one means
/// the working folder.
fn kept_entries(appdir: &Path, value: &OsStr) -> Option<Vec<PathBuf>> {
    let entries: Vec<PathBuf> = env::split_paths(value).collect();
    entries.iter().any(|entry| entry.starts_with(appdir)).then(|| {
        entries
            .into_iter()
            .filter(|entry| !entry.as_os_str().is_empty() && !entry.starts_with(appdir))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_LatticAbC123";

    /// What `apply` leaves `command` setting: `None` for a variable it unsets.
    fn applied(command: &mut Command, inherited: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        let inherited = inherited.iter().map(|(name, value)| (name.into(), value.into()));
        apply(command, Path::new(APPDIR), inherited);
        command
            .get_envs()
            .map(|(name, value)| {
                (name.to_string_lossy().into(), value.map(|value| value.to_string_lossy().into()))
            })
            .collect()
    }

    #[test]
    fn keeps_the_hosts_entries_in_order_and_drops_the_appimages() {
        // As AppRun and its GTK hook leave them, the original value last.
        let inherited = [
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_LatticAbC123/usr/lib/:/tmp/.mount_LatticAbC123/usr/lib/x86_64-linux-gnu/:/opt/cuda/lib64",
            ),
            ("PATH", "/tmp/.mount_LatticAbC123/usr/bin/:/home/writer/.local/bin:/usr/bin"),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_LatticAbC123/usr/share/:/tmp/.mount_LatticAbC123/usr/share:/usr/share:/usr/local/share",
            ),
        ];
        assert_eq!(
            applied(&mut Command::new("latexmk"), &inherited),
            [
                ("LD_LIBRARY_PATH".into(), Some("/opt/cuda/lib64".into())),
                ("PATH".into(), Some("/home/writer/.local/bin:/usr/bin".into())),
                ("XDG_DATA_DIRS".into(), Some("/usr/share:/usr/local/share".into())),
            ]
        );
    }

    #[test]
    fn unsets_a_variable_that_named_only_the_appimage() {
        let inherited = [
            // AppRun's trailing separator: PERLLIB was unset before it.
            ("PERLLIB", "/tmp/.mount_LatticAbC123/usr/share/perl5/:/tmp/.mount_LatticAbC123/usr/lib/perl5/:"),
            ("GSETTINGS_SCHEMA_DIR", "/tmp/.mount_LatticAbC123//usr/share/glib-2.0/schemas"),
            ("APPDIR", APPDIR),
        ];
        assert_eq!(
            applied(&mut Command::new("latexmk"), &inherited),
            [
                ("APPDIR".into(), None),
                ("GSETTINGS_SCHEMA_DIR".into(), None),
                ("PERLLIB".into(), None)
            ]
        );
    }

    #[test]
    fn leaves_everything_else_as_inherited() {
        let inherited = [
            ("HOME", "/home/writer"),
            ("GDK_BACKEND", "x11"),
            ("GTK_THEME", "Adwaita:dark"),
            // A sibling mount shares the name's start, not the folder.
            ("LD_LIBRARY_PATH", "/tmp/.mount_LatticAbC1234/usr/lib:/opt/lib"),
            ("APPIMAGE", "/home/writer/Lattice.AppImage"),
        ];
        assert_eq!(applied(&mut Command::new("latexmk"), &inherited), []);
    }

    #[test]
    fn keeps_what_the_command_sets_itself() {
        let mut command = Command::new("latexmk");
        command.env("PATH", "/usr/bin").env_remove("PERLLIB");
        let inherited = [
            ("PATH", "/tmp/.mount_LatticAbC123/usr/bin/:/usr/local/bin"),
            ("PERLLIB", "/tmp/.mount_LatticAbC123/usr/share/perl5/:/opt/perl"),
        ];
        assert_eq!(
            applied(&mut command, &inherited),
            [("PATH".into(), Some("/usr/bin".into())), ("PERLLIB".into(), None)]
        );
    }

    #[test]
    fn starts_a_child_where_the_appimage_was_opened_not_in_it() {
        let appdir = Path::new(APPDIR);
        let usr = appdir.join("usr");
        let (opened_from, home) = (env::temp_dir(), env::temp_dir().join("no-such-home"));
        let pick = |candidates| working_folder(appdir, &usr, candidates);
        assert_eq!(
            pick([Some(opened_from.clone()), Some(home.clone())]),
            Some(opened_from.clone())
        );
        // Neither a folder in the AppImage nor one that is gone.
        assert_eq!(
            pick([Some(appdir.join("usr/bin")), Some(opened_from.clone())]),
            Some(opened_from.clone())
        );
        assert_eq!(pick([Some(home), Some(opened_from.clone())]), Some(opened_from.clone()));
        assert_eq!(pick([None, None]), None);
        // Lattice already outside the AppImage: the child keeps Lattice's folder.
        assert_eq!(working_folder(appdir, &opened_from, [Some(env::temp_dir()), None]), None);
    }

    #[test]
    fn changes_nothing_outside_an_appimage() {
        // Tests do not run from an AppImage: no APPDIR names their folder.
        assert_eq!(appimage_dir(), None);
        let mut command = Command::new("latexmk");
        host_environment(&mut command);
        assert_eq!((command.get_envs().count(), command.get_current_dir()), (0, None));
        let path = [PathBuf::from("/tmp/.mount_LatticAbC123/usr/bin"), PathBuf::from("/usr/bin")];
        assert_eq!(outside_appimage(path.to_vec()), path);
    }
}
