//! Lattice's preferences for the GPUI app.
//!
//! [`Settings`] is the Tauri app's set (`src/settings/app-settings.ts`):
//! the theme preference, the appearance settings, the automatic build and
//! the "Your name" signature, typed, with the same defaults and the same
//! reading of a stored value. The GPUI app keeps them as JSON in
//! `settings.json` in its state directory, which it watches, so an edit made
//! there (or by another window) applies as it lands; the first run reads the
//! Tauri app's own choices from its WebKit storage instead ([`import`]).

pub mod import;
mod model;

use std::path::{Path, PathBuf};

pub use model::*;

/// The settings file's name in the app's state directory.
pub const FILE_NAME: &str = "settings.json";

/// How the settings were found at startup.
#[derive(Debug)]
pub enum Loaded {
    /// From the GPUI app's own file.
    File(Settings),
    /// Imported from the Tauri app's storage (and written to the file).
    Imported(import::Imported),
    /// Nothing to read: the defaults.
    Defaults(Settings),
}

impl Loaded {
    pub fn settings(&self) -> &Settings {
        match self {
            Loaded::File(settings) | Loaded::Defaults(settings) => settings,
            Loaded::Imported(imported) => &imported.settings,
        }
    }
}

/// The settings in the file at `path`; `None` when there is none. A file
/// that does not parse, or one from a newer version of the layout, is moved
/// aside to `settings.json.unreadable` so the next save does not overwrite
/// it, and reads as the defaults.
pub fn read(path: &Path) -> Option<Settings> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value)
            if value
                .get("version")
                .and_then(serde_json::Value::as_u64)
                .is_none_or(|version| version <= FILE_VERSION) =>
        {
            return Some(Settings::from_value(&value));
        }
        Ok(_) => log::warn!("{} is from a newer version of Lattice", path.display()),
        Err(error) => log::warn!("{} does not parse: {error}", path.display()),
    }
    let aside = path.with_extension("json.unreadable");
    if let Err(error) = std::fs::rename(path, &aside) {
        log::warn!("could not move {} aside: {error}", path.display());
    }
    Some(Settings::default())
}

/// Write the file whole beside the target, then move it over, so a crash
/// mid-write leaves the old file.
pub fn write(path: &Path, settings: &Settings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    let mut text = serde_json::to_string_pretty(&settings.to_value())?;
    text.push('\n');
    std::fs::write(&partial, text)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

/// The settings at startup: the file at `path` if there is one; else the
/// Tauri app's, imported from `tauri_storage` (its `WebsiteData` directory)
/// and written to `path`; else the defaults.
pub fn load(path: &Path, tauri_storage: Option<&Path>) -> Loaded {
    if let Some(settings) = read(path) {
        return Loaded::File(settings);
    }
    match tauri_storage.and_then(import::import_from) {
        Some(imported) => {
            log::info!(
                "imported the Tauri app's settings from {} ({})",
                imported.source.display(),
                imported.keys.join(", ")
            );
            if let Err(error) = write(path, &imported.settings) {
                log::warn!("could not write {}: {error:#}", path.display());
            }
            Loaded::Imported(imported)
        }
        None => Loaded::Defaults(Settings::default()),
    }
}

/// `dir/settings.json`.
pub fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lattice-settings-file-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_file_without_tauri_storage_is_the_defaults() {
        let dir = scratch("missing");
        let loaded = load(&file_in(&dir), Some(&dir.join("nothing")));
        assert!(matches!(loaded, Loaded::Defaults(_)));
        assert!(!file_in(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn written_settings_read_back() {
        let dir = scratch("roundtrip");
        let mut settings = Settings::default();
        settings.appearance.tint = Tint::Mist;
        write(&file_in(&dir), &settings).unwrap();
        assert!(matches!(load(&file_in(&dir), None), Loaded::File(read) if read == settings));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_file_is_set_aside_and_reads_as_the_defaults() {
        let dir = scratch("unreadable");
        let path = file_in(&dir);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(read(&path), Some(Settings::default()));
        assert!(path.with_extension("json.unreadable").exists());
        std::fs::write(&path, r#"{"version": 99, "themePreference": "dark"}"#).unwrap();
        assert_eq!(read(&path), Some(Settings::default()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
