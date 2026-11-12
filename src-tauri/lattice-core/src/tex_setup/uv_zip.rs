//! Unpacking the Windows uv release: a flat zip of `uv.exe`, `uvx.exe` and
//! `uvw.exe`, read as strictly as the macOS tarball is.

use super::installer::create_private_file;
use super::safe_zip::zip_entry_path;
use std::io::Write;
use std::path::Path;

/// The programs Lattice runs from the archive. `uvw.exe` (the windowless
/// launcher) is in the release too, and is known but left behind.
const EXTRACTED: [&str; 2] = ["uv.exe", "uvx.exe"];
const IGNORED: &str = "uvw.exe";

/// Extract exactly `uv.exe` and `uvx.exe` into `staging`, refusing anything
/// else the archive holds: another name, a folder, a link, a second copy, a
/// path that could leave `staging`.
pub(super) fn extract_uv_zip(archive_path: &Path, staging: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Could not read the uv archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Could not inspect the uv archive: {error}"))?;
    let mut found = [false; 2];
    let mut ignored_seen = false;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not inspect the uv archive: {error}"))?;
        let name = entry.name().map_or_else(
            |_| String::from_utf8_lossy(entry.name_raw()).into_owned(),
            |name| name.into_owned(),
        );
        // A name that is not one plain file name is not one of ours.
        let plain = zip_entry_path(&name).filter(|path| path.components().count() == 1);
        let Some(plain) = plain.as_deref().and_then(Path::to_str) else {
            return Err(format!("The uv archive contained an unexpected entry: {name}"));
        };
        if plain == IGNORED {
            if ignored_seen || !entry.is_file() || entry.is_symlink() {
                return Err(format!("The uv archive contained an invalid {plain} entry."));
            }
            ignored_seen = true;
            continue;
        }
        let Some(position) = EXTRACTED.iter().position(|wanted| *wanted == plain) else {
            return Err(format!("The uv archive contained an unexpected entry: {name}"));
        };
        if found[position] || !entry.is_file() || entry.is_symlink() || name.ends_with('/') {
            return Err(format!("The uv archive contained an invalid {plain} entry."));
        }
        found[position] = true;
        let mut output = create_private_file(&staging.join(plain))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Could not extract {plain} from the uv archive: {error}"))?;
        output.flush().map_err(|error| format!("Could not finish extracting {plain}: {error}"))?;
    }
    if found.contains(&false) {
        return Err("The uv archive did not contain the expected executables.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use zip::write::SimpleFileOptions;

    /// A zip of `entries` (`None` contents make a symlink to `/elsewhere`) in
    /// `dir`, and an empty staging folder beside it.
    fn archive(
        dir: &TempDir, name: &str, entries: &[(&str, Option<&[u8]>)],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let path = dir.join(name);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        for (entry, contents) in entries {
            match contents {
                Some(bytes) => {
                    writer.start_file(*entry, options).unwrap();
                    writer.write_all(bytes).unwrap();
                }
                None if entry.ends_with('/') => writer.add_directory(*entry, options).unwrap(),
                None => writer.add_symlink(*entry, "/elsewhere", options).unwrap(),
            }
        }
        writer.finish().unwrap();
        let staging = dir.join(format!("{name}-staging"));
        std::fs::create_dir(&staging).unwrap();
        (path, staging)
    }

    #[test]
    fn uv_archive_extracts_exe_zip() {
        let dir = TempDir::new("uv-zip");
        // The real release's three entries, in its order, no folder around them.
        let (zip, staging) = archive(
            &dir,
            "uv.zip",
            &[("uv.exe", Some(b"UV")), ("uvw.exe", Some(b"UVW")), ("uvx.exe", Some(b"UVX"))],
        );
        extract_uv_zip(&zip, &staging).unwrap();
        assert_eq!(std::fs::read(staging.join("uv.exe")).unwrap(), b"UV");
        assert_eq!(std::fs::read(staging.join("uvx.exe")).unwrap(), b"UVX");
        // The windowless launcher is not something Lattice runs.
        assert!(!staging.join("uvw.exe").exists());
    }

    #[test]
    fn a_folder_named_staging_with_spaces_and_unicode_is_fine() {
        let dir = TempDir::new("uv-zip-unicode");
        let (zip, _) = archive(&dir, "uv.zip", &[("uv.exe", Some(b"1")), ("uvx.exe", Some(b"2"))]);
        let staging = dir.join("Zoë Å").join("My Tools");
        std::fs::create_dir_all(&staging).unwrap();
        extract_uv_zip(&zip, &staging).unwrap();
        assert!(staging.join("uv.exe").is_file() && staging.join("uvx.exe").is_file());
    }

    #[test]
    #[allow(clippy::type_complexity)]
    fn extraction_refuses_everything_but_the_expected_files() {
        let dir = TempDir::new("uv-zip-refuse");
        let good: [(&str, Option<&[u8]>); 2] = [("uv.exe", Some(b"1")), ("uvx.exe", Some(b"2"))];
        let refused: [(&str, Vec<(&str, Option<&[u8]>)>, &str); 10] = [
            ("zip-slip", vec![("../uv.exe", Some(b"x")), good[1]], "unexpected entry"),
            ("slip-deep", vec![("a/../../uv.exe", Some(b"x")), good[1]], "unexpected entry"),
            ("backslash", vec![(r"..\uv.exe", Some(b"x")), good[1]], "unexpected entry"),
            ("absolute", vec![("/uv.exe", Some(b"x")), good[1]], "unexpected entry"),
            ("drive", vec![("C:/uv.exe", Some(b"x")), good[1]], "unexpected entry"),
            ("stream", vec![("uv.exe:evil", Some(b"x")), good[1]], "unexpected entry"),
            ("folder", vec![("uv-x/", None), good[0], good[1]], "unexpected entry"),
            ("nested", vec![("uv/uv.exe", Some(b"x")), good[1]], "unexpected entry"),
            ("link", vec![("uv.exe", None), good[1]], "invalid uv.exe entry"),
            ("stranger", vec![good[0], good[1], ("evil.exe", Some(b"x"))], "unexpected entry"),
        ];
        for (name, entries, expected) in &refused {
            let (zip, staging) = archive(&dir, &format!("{name}.zip"), entries);
            let error = extract_uv_zip(&zip, &staging).unwrap_err();
            assert!(error.contains(expected), "{name}: {error}");
            assert!(
                !dir.join("uv.exe").exists() && !dir.join("evil.exe").exists(),
                "{name} wrote outside staging"
            );
        }
        let (zip, staging) = archive(&dir, "missing.zip", &[("uv.exe", Some(b"1"))]);
        let error = extract_uv_zip(&zip, &staging).unwrap_err();
        assert_eq!(error, "The uv archive did not contain the expected executables.");
        let (zip, staging) =
            archive(&dir, "linked-ignored.zip", &[("uvw.exe", None), good[0], good[1]]);
        assert!(extract_uv_zip(&zip, &staging).unwrap_err().contains("invalid uvw.exe entry"));
        assert!(extract_uv_zip(&dir.join("nothing.zip"), &staging)
            .unwrap_err()
            .starts_with("Could not read the uv archive"));
    }
}
