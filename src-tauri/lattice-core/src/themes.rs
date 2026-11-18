//! Installed themes: the bundled ones and those the writer added, kept as
//! `<app data>/themes/<id>.json` (`docs/themes.md`).
//!
//! A theme is data (`lattice_theme`), so installing one runs nothing and
//! asks for no permission. Every file is validated before it is kept, and the
//! copy is what Lattice reads afterwards: the file the writer picked can move
//! or change without changing the theme. Nothing in a project folder installs
//! or selects a theme.

use std::path::{Path, PathBuf};

/// The format and resolver, for shells that use the store.
pub use lattice_theme as format;

use lattice_theme::{resolve, AccentChoice, Appearance, Resolved, ThemeFile, MAX_THEME_BYTES};
use serde::Serialize;

/// Ids under this prefix belong to the bundled themes.
const BUNDLED_PREFIX: &str = "app.lattice.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemeSource {
    Bundled,
    Installed,
}

/// The colours a Settings tile draws a variant with.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantInfo {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub window: String,
    pub chrome: String,
    pub panel: String,
    pub text: String,
    pub accent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub license: String,
    pub description: String,
    pub source: ThemeSource,
    pub variants: Vec<VariantInfo>,
    /// The registry's kill-switch entry this installed version falls under
    /// (`Registry::list_themes` fills it; the store alone never does).
    pub blocked: Option<crate::registry::BlockedEntry>,
}

impl ThemeInfo {
    fn of(theme: &ThemeFile, source: ThemeSource) -> Self {
        let variants = theme
            .variants
            .iter()
            .map(|variant| {
                let resolved = resolve(Some(theme), variant.appearance, AccentChoice::ThemeDefault);
                let fallback = match variant.appearance {
                    Appearance::Light => ["#f7f7f6", "#efeff0", "#fafafa", "#242426"],
                    Appearance::Dark => ["#171718", "#131315", "#1a1a1c", "#e9e9e7"],
                };
                let color = |key: &str, at: usize| {
                    variant
                        .colors
                        .get(key)
                        .map(|_| resolved.colors[key].hex())
                        .unwrap_or_else(|| fallback[at].to_string())
                };
                VariantInfo {
                    id: variant.id.clone(),
                    name: variant.name.clone(),
                    appearance: variant.appearance,
                    window: color("window", 0),
                    chrome: color("chrome", 1),
                    panel: color("panel", 2),
                    text: color("text", 3),
                    accent: resolved.accent.map(|accent| accent.hex()),
                }
            })
            .collect();
        ThemeInfo {
            id: theme.id.clone(),
            name: theme.name.clone(),
            version: theme.version.clone(),
            author: theme.author.clone(),
            license: theme.license.clone(),
            description: theme.description.clone(),
            source,
            variants,
            blocked: None,
        }
    }
}

pub struct ThemeStore {
    root: PathBuf,
}

impl ThemeStore {
    /// The store under the app's data folder.
    pub fn new(app_data_dir: &Path) -> Self {
        ThemeStore { root: app_data_dir.join("themes") }
    }

    /// The installed themes' folder, created when it does not exist yet.
    pub fn folder(&self) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.root)
            .map_err(|err| format!("Could not create the themes folder: {err}"))?;
        Ok(self.root.clone())
    }

    fn path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    fn installed(&self) -> Vec<ThemeFile> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut themes: Vec<ThemeFile> = entries
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| {
                let text = std::fs::read_to_string(entry.path()).ok()?;
                let theme = ThemeFile::parse(&text).ok()?;
                // A file renamed by hand under another id is not this theme.
                (entry.path() == self.path(&theme.id)).then_some(theme)
            })
            .collect();
        themes.sort_by_key(|theme| theme.name.to_lowercase());
        themes
    }

    /// Every theme the writer can pick: the bundled ones, then installed.
    pub fn list(&self) -> Vec<ThemeInfo> {
        lattice_theme::bundled()
            .iter()
            .map(|theme| ThemeInfo::of(theme, ThemeSource::Bundled))
            .chain(
                self.installed().iter().map(|theme| ThemeInfo::of(theme, ThemeSource::Installed)),
            )
            .collect()
    }

    /// A theme by id, bundled or installed.
    pub fn get(&self, id: &str) -> Option<ThemeFile> {
        if id.starts_with(BUNDLED_PREFIX) {
            return lattice_theme::bundled().into_iter().find(|theme| theme.id == id);
        }
        let text = std::fs::read_to_string(self.path(id)).ok()?;
        ThemeFile::parse(&text).ok().filter(|theme| theme.id == id)
    }

    /// `id` (or no theme) for `appearance` with the writer's accent. An id
    /// that names no theme, or a theme removed since it was chosen, resolves
    /// as no theme.
    pub fn resolve(
        &self, id: Option<&str>, appearance: Appearance, accent: AccentChoice,
    ) -> Resolved {
        let theme = id.and_then(|id| self.get(id));
        resolve(theme.as_ref(), appearance, accent)
    }

    /// Installs a theme from its file's text, replacing an installed theme
    /// with the same id.
    pub fn install_text(&self, text: &str) -> Result<ThemeInfo, String> {
        let theme = ThemeFile::parse(text).map_err(|err| err.to_string())?;
        if theme.id.starts_with(BUNDLED_PREFIX) {
            return Err(format!(
                "\"{}\" is the id of a theme that comes with Lattice. Give your theme its own id.",
                theme.id
            ));
        }
        self.folder()?;
        // Written whole and renamed into place, so a reader never sees half a file.
        let partial = self.root.join(format!(".{}.partial", theme.id));
        std::fs::write(&partial, text).map_err(|err| format!("Could not save the theme: {err}"))?;
        std::fs::rename(&partial, self.path(&theme.id))
            .map_err(|err| format!("Could not save the theme: {err}"))?;
        Ok(ThemeInfo::of(&theme, ThemeSource::Installed))
    }

    /// Installs the theme file at `path`.
    pub fn install_file(&self, path: &Path) -> Result<ThemeInfo, String> {
        let size = std::fs::metadata(path)
            .map_err(|err| format!("Could not read {}: {err}", path.display()))?
            .len();
        if size > MAX_THEME_BYTES as u64 {
            return Err("The theme file is larger than 256 KiB.".to_string());
        }
        let text = std::fs::read_to_string(path)
            .map_err(|err| format!("Could not read {}: {err}", path.display()))?;
        self.install_text(&text)
    }

    /// Removes an installed theme. Bundled themes cannot be removed.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if id.starts_with(BUNDLED_PREFIX) || !lattice_theme::valid_theme_id(id) {
            return Err("This theme comes with Lattice and cannot be removed.".to_string());
        }
        match std::fs::remove_file(self.path(id)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Could not remove the theme: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THEME: &str = r##"{"schema":1,"id":"dev.example.ink","name":"Ink","version":"1.0.0",
        "variants":[{"id":"night","appearance":"dark","colors":{"chrome":"#101018","accent":"#9ccfd8"}}]}"##;

    struct Dir(PathBuf);

    impl Dir {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store() -> (Dir, ThemeStore) {
        let dir =
            Dir(std::env::temp_dir().join(format!("lattice-themes-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(dir.path()).unwrap();
        let store = ThemeStore::new(dir.path());
        (dir, store)
    }

    #[test]
    fn bundled_themes_are_listed_first_and_cannot_be_removed() {
        let (_dir, store) = store();
        let list = store.list();
        assert!(list.len() >= 2);
        assert!(list.iter().all(|theme| theme.source == ThemeSource::Bundled));
        assert!(store.get("app.lattice.nord").is_some());
        assert!(store.remove("app.lattice.nord").is_err());
    }

    #[test]
    fn a_theme_file_installs_resolves_and_removes() {
        let (dir, store) = store();
        let file = dir.path().join("ink.lattice-theme.json");
        std::fs::write(&file, THEME).unwrap();
        let info = store.install_file(&file).unwrap();
        assert_eq!(info.source, ThemeSource::Installed);
        assert_eq!(info.variants[0].chrome, "#101018");
        // The kept copy is what counts, not the picked file.
        std::fs::remove_file(&file).unwrap();
        let resolved =
            store.resolve(Some("dev.example.ink"), Appearance::Dark, AccentChoice::ThemeDefault);
        assert_eq!(resolved.theme.as_deref(), Some("dev.example.ink"));
        assert_eq!(resolved.accent.unwrap().hex(), "#9ccfd8");
        assert!(store.list().iter().any(|theme| theme.id == "dev.example.ink"));
        store.remove("dev.example.ink").unwrap();
        let gone =
            store.resolve(Some("dev.example.ink"), Appearance::Dark, AccentChoice::ThemeDefault);
        assert_eq!(gone.theme, None);
    }

    #[test]
    fn invalid_files_and_bundled_ids_are_refused() {
        let (_dir, store) = store();
        assert!(store.install_text("{}").is_err());
        let squatting = THEME.replace("dev.example.ink", "app.lattice.nord");
        assert!(store.install_text(&squatting).unwrap_err().contains("comes with Lattice"));
        assert!(store.remove("../etc").is_err());
    }
}
