//! The one-time import of the Tauri app's preferences, which it keeps in
//! WebKit's localStorage: a SQLite database per origin under
//! `~/Library/WebKit/<bundle id>/WebsiteData/`, at
//! `Default/<salt>/<salt>/LocalStorage/localstorage.sqlite3` in current
//! WebKit and `LocalStorage/<origin>.localstorage` in older WebKit, each an
//! `ItemTable(key, value)` whose values are UTF-16 text.
//!
//! The database is never opened where it lies: it and its write-ahead log are
//! copied to a temporary directory and the copy is read, so the Tauri app's
//! storage is left exactly as it was, even while that app runs.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde_json::Value;

use crate::model::{Appearance, AutoBuildMode, Choice, Settings, SettingsTab, ThemePreference};

/// The Tauri app's bundle identifier (`src-tauri/tauri.conf.json`).
pub const TAURI_BUNDLE_ID: &str = "app.leo1oel.researchwriter";

/// The keys the import reads, as `app-settings.ts` and the comments' author
/// setting (`editor-comment-data.ts`) name them.
pub const KEYS: &[&str] = &[
    "lattice.theme-preference.v1",
    "lattice.appearance.v5",
    "lattice.appearance.v4",
    "lattice.appearance.v3",
    "lattice.build-preferences.v2",
    "lattice.author-name.v1",
    "lattice.collab.name",
    "lattice.settings-tab.v1",
];

/// What was imported, and from where.
#[derive(Debug)]
pub struct Imported {
    pub settings: Settings,
    pub source: PathBuf,
    /// The keys that held a value.
    pub keys: Vec<String>,
}

/// The settings a set of stored localStorage values amounts to, read as the
/// Tauri app reads them.
pub fn settings_from_items(items: &BTreeMap<String, String>) -> Settings {
    let defaults = Settings::default();
    let item = |key: &str| items.get(key).map(String::as_str);
    let json = |key: &str| item(key).and_then(|text| serde_json::from_str::<Value>(text).ok());
    let (appearance, legacy) = match json("lattice.appearance.v5") {
        Some(current) => (Some(current), false),
        None => (
            json("lattice.appearance.v4").or_else(|| json("lattice.appearance.v3")),
            true,
        ),
    };
    let auto_build_mode = json("lattice.build-preferences.v2")
        .and_then(|value| {
            value
                .get("autoBuildMode")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        // Only "manual" is kept; everything else is the automatic default.
        .filter(|mode| mode == AutoBuildMode::Manual.tag())
        .map(|_| AutoBuildMode::Manual)
        .unwrap_or(defaults.auto_build_mode);
    Settings {
        theme_preference: item("lattice.theme-preference.v1")
            .and_then(ThemePreference::from_tag)
            .unwrap_or(defaults.theme_preference),
        appearance: appearance
            .map(|value| Appearance::from_value(&value, legacy))
            .unwrap_or_default(),
        auto_build_mode,
        author_name: item("lattice.author-name.v1")
            .or_else(|| item("lattice.collab.name"))
            .unwrap_or_default()
            .to_owned(),
        settings_tab: item("lattice.settings-tab.v1")
            .and_then(SettingsTab::from_tag)
            .unwrap_or(defaults.settings_tab),
    }
}

/// The WebKit storage directory of an app, by its bundle identifier.
pub fn website_data(bundle_id: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join("Library/WebKit")
            .join(bundle_id)
            .join("WebsiteData")
    })
}

/// Every LocalStorage database under a `WebsiteData` directory, in either
/// layout.
pub fn databases(website_data: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let children = |dir: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    };
    for salt in children(&website_data.join("Default")) {
        for origin in children(&salt) {
            let database = origin.join("LocalStorage/localstorage.sqlite3");
            if database.is_file() {
                found.push(database);
            }
        }
    }
    for legacy in children(&website_data.join("LocalStorage")) {
        if legacy.extension().is_some_and(|ext| ext == "localstorage") {
            found.push(legacy);
        }
    }
    found.sort();
    found
}

/// UTF-16LE text, as WebKit stores a value.
fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// The values the import reads from one database, read from a copy.
pub fn read_items(database: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let scratch = std::env::temp_dir().join(format!(
        "lattice-gpui-import-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&scratch)?;
    let result = (|| {
        let name = database
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("{} has no file name", database.display()))?;
        let copy = scratch.join(name);
        std::fs::copy(database, &copy)?;
        for suffix in ["-wal", "-shm"] {
            let mut side = database.as_os_str().to_owned();
            side.push(suffix);
            let side = PathBuf::from(side);
            if side.is_file() {
                let mut target = copy.as_os_str().to_owned();
                target.push(suffix);
                std::fs::copy(&side, PathBuf::from(target))?;
            }
        }
        let connection = rusqlite::Connection::open(&copy)?;
        let mut statement = connection.prepare("SELECT key, value FROM ItemTable")?;
        let rows = statement.query_map([], |row| {
            let key: String = row.get(0)?;
            let value = match row.get_ref(1)? {
                rusqlite::types::ValueRef::Blob(bytes) => utf16(bytes),
                rusqlite::types::ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
                _ => String::new(),
            };
            Ok((key, value))
        })?;
        let mut items = BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            if KEYS.contains(&key.as_str()) {
                items.insert(key, value);
            }
        }
        Ok(items)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// Import from the Tauri app's storage under `website_data`: of its
/// databases (the release origin, and a development one beside it), the one
/// with the most of these keys, the most recently written on a tie.
pub fn import_from(website_data: &Path) -> Option<Imported> {
    let modified = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    };
    databases(website_data)
        .into_iter()
        .filter_map(|database| match read_items(&database) {
            Ok(items) if !items.is_empty() => Some((database, items)),
            Ok(_) => None,
            Err(error) => {
                log::warn!("could not read {}: {error:#}", database.display());
                None
            }
        })
        .max_by_key(|(database, items)| (items.len(), modified(database)))
        .map(|(source, items)| Imported {
            settings: settings_from_items(&items),
            keys: items.keys().cloned().collect(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Accent, AccentPreset, CodeTheme, EditorKeymap, InterfaceLanguage};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lattice-settings-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A LocalStorage database as WebKit writes it: UTF-16LE blobs.
    fn webkit_database(path: &Path, items: &[(&str, &str)]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let connection = rusqlite::Connection::open(path).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);",
            )
            .unwrap();
        for (key, value) in items {
            let blob: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
            connection
                .execute(
                    "INSERT INTO ItemTable VALUES (?1, ?2)",
                    rusqlite::params![key, blob],
                )
                .unwrap();
        }
        // Left open while the import reads: the rows are still in the WAL,
        // as they are while the Tauri app runs.
        std::mem::forget(connection);
    }

    #[test]
    fn imports_the_tauri_apps_preferences_without_touching_its_storage() {
        let website_data = scratch("import");
        let release = website_data.join("Default/salt/salt/LocalStorage/localstorage.sqlite3");
        webkit_database(
            &release,
            &[
                ("lattice.theme-preference.v1", "dark"),
                (
                    "lattice.appearance.v5",
                    r##"{"interfaceLanguage":"zh-CN","editorKeymap":"vim","accent":"teal","codeTheme":"nord","editorFontSize":16}"##,
                ),
                (
                    "lattice.build-preferences.v2",
                    r#"{"autoBuildMode":"manual"}"#,
                ),
                ("lattice.author-name.v1", "Ada Lovelace"),
                ("lattice.settings-tab.v1", "editor"),
                ("lattice.recent-projects.v1", "[]"),
            ],
        );
        // A development origin with fewer of the keys is passed over.
        webkit_database(
            &website_data.join("Default/other/other/LocalStorage/localstorage.sqlite3"),
            &[("lattice.theme-preference.v1", "light")],
        );
        let before = std::fs::read(&release).unwrap();

        let imported = import_from(&website_data).expect("an import");
        assert_eq!(imported.source, release);
        let settings = imported.settings;
        assert_eq!(settings.theme_preference, ThemePreference::Dark);
        assert_eq!(
            settings.appearance.interface_language,
            InterfaceLanguage::ZhCn
        );
        assert_eq!(settings.appearance.editor_keymap, EditorKeymap::Vim);
        assert_eq!(
            settings.appearance.accent,
            Accent::Preset(AccentPreset::Teal)
        );
        assert_eq!(settings.appearance.code_theme, CodeTheme::Nord);
        assert_eq!(settings.appearance.editor_font_size, 16.);
        assert_eq!(settings.auto_build_mode, AutoBuildMode::Manual);
        assert_eq!(settings.author_name, "Ada Lovelace");
        assert_eq!(settings.settings_tab, SettingsTab::Editor);
        assert!(
            !imported
                .keys
                .contains(&"lattice.recent-projects.v1".to_owned())
        );
        assert_eq!(std::fs::read(&release).unwrap(), before);
        let _ = std::fs::remove_dir_all(&website_data);
    }

    #[test]
    fn a_legacy_appearance_and_the_shares_name_are_read_when_nothing_newer_is() {
        let items: BTreeMap<String, String> = [
            (
                "lattice.appearance.v4",
                r#"{"interfaceScale":1.1,"tint":"dusk"}"#,
            ),
            ("lattice.collab.name", "Grace"),
            (
                "lattice.build-preferences.v2",
                r#"{"autoBuildMode":"sometimes"}"#,
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
        let settings = settings_from_items(&items);
        assert_eq!(settings.appearance.interface_scale, 1.);
        assert_eq!(settings.appearance.tint.tag(), "dusk");
        assert_eq!(settings.author_name, "Grace");
        assert_eq!(settings.auto_build_mode, AutoBuildMode::Automatic);
    }

    #[test]
    fn no_storage_imports_nothing() {
        let website_data = scratch("empty");
        assert!(import_from(&website_data).is_none());
        let _ = std::fs::remove_dir_all(&website_data);
    }
}
