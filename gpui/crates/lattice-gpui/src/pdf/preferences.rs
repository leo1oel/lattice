//! What the PDF viewers remember between runs, as the Tauri app keeps it in
//! its storage: whether pages are dark (`lattice.pdf-dark-pages.v1`), the fit
//! and zoom a viewer opens with when its file has none of its own
//! (`lattice.pdf-view-preference.v1`), and, per project, whether its PDF is
//! in a window of its own and where that window was left
//! (`lattice.pdf-window.v1:<root>`).
//!
//! One JSON file in the app's state directory, written whole beside itself
//! and moved over it. `LATTICE_GPUI_STATE_DIR` names another directory (empty
//! for none); a scripted run keeps everything in memory, so a scenario starts
//! from the defaults and leaves the reader's choices alone.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

use super::layout::{DEFAULT_SCALE, FitMode, clamp_scale};

/// A window's outer corner and content size, in logical points.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWindow {
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub frame: Option<WindowFrame>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    #[serde(default)]
    pub dark_pages: bool,
    /// `None` is a zoom the reader set; a missing key is Fit width.
    #[serde(default = "default_fit")]
    pub fit_mode: Option<FitMode>,
    #[serde(default = "default_scale")]
    pub scale: f32,
    #[serde(default)]
    pub windows: BTreeMap<PathBuf, ProjectWindow>,
}

fn default_fit() -> Option<FitMode> {
    Some(FitMode::Width)
}

fn default_scale() -> f32 {
    DEFAULT_SCALE
}

impl Preferences {
    /// What is remembered of `root`'s separate window.
    pub fn window(&self, root: &Path) -> ProjectWindow {
        self.windows.get(root).cloned().unwrap_or_default()
    }

    pub fn window_mut(&mut self, root: &Path) -> &mut ProjectWindow {
        self.windows.entry(root.to_path_buf()).or_default()
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            dark_pages: false,
            fit_mode: default_fit(),
            scale: DEFAULT_SCALE,
            windows: BTreeMap::new(),
        }
    }
}

struct Store {
    file: Option<PathBuf>,
    preferences: Preferences,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let file = state_dir().map(|dir| dir.join("pdf.json"));
        let preferences = file.as_deref().and_then(read).unwrap_or_default();
        super::dark::set_enabled(preferences.dark_pages);
        Mutex::new(Store { file, preferences })
    })
}

fn read(file: &Path) -> Option<Preferences> {
    let bytes = std::fs::read(file).ok()?;
    let mut preferences = serde_json::from_slice::<Preferences>(&bytes).ok()?;
    preferences.scale = clamp_scale(preferences.scale);
    Some(preferences)
}

fn state_dir() -> Option<PathBuf> {
    match std::env::var_os("LATTICE_GPUI_STATE_DIR") {
        Some(dir) if dir.is_empty() => None,
        Some(dir) => Some(PathBuf::from(dir)),
        None if std::env::args().any(|arg| arg == "--scenario") => None,
        None => dirs::data_dir().map(|dir| dir.join("lattice-gpui")),
    }
}

/// The preferences as they stand.
pub fn get() -> Preferences {
    store()
        .lock()
        .map(|store| store.preferences.clone())
        .unwrap_or_default()
}

/// Change the preferences and write them, when they changed.
pub fn update(change: impl FnOnce(&mut Preferences)) {
    let Ok(mut store) = store().lock() else {
        return;
    };
    let before = store.preferences.clone();
    change(&mut store.preferences);
    super::dark::set_enabled(store.preferences.dark_pages);
    if store.preferences == before {
        return;
    }
    if let Some(file) = store.file.clone()
        && let Err(error) = write_json(&file, &store.preferences)
    {
        log::warn!("could not save the PDF preferences: {error:#}");
    }
}

/// Read once, early, so dark pages are known before the first page draws.
pub fn load() {
    let _ = store();
}

fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_partial_file_reads_as_the_defaults() {
        let empty: Preferences = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Preferences::default());
        assert_eq!(empty.fit_mode, Some(FitMode::Width));
        let zoomed: Preferences =
            serde_json::from_str(r#"{ "fitMode": null, "scale": 1.5, "darkPages": true }"#)
                .unwrap();
        assert_eq!(zoomed.fit_mode, None);
        assert_eq!(zoomed.scale, 1.5);
        assert!(zoomed.dark_pages);
    }

    #[test]
    fn each_project_keeps_whether_its_pdf_window_is_open_and_where() {
        let dir = std::env::temp_dir().join(format!("lattice-pdf-prefs-{}", std::process::id()));
        let file = dir.join("pdf.json");
        let (a, b) = (Path::new("/papers/a"), Path::new("/papers/b"));
        let frame = WindowFrame {
            x: 40.,
            y: 60.,
            width: 760.,
            height: 880.,
        };
        let mut preferences = Preferences::default();
        preferences.window_mut(a).open = true;
        preferences.window_mut(a).frame = Some(frame);
        write_json(&file, &preferences).unwrap();

        let read_back = read(&file).unwrap();
        assert!(read_back.window(a).open);
        assert_eq!(read_back.window(a).frame, Some(frame));
        assert_eq!(read_back.window(b), ProjectWindow::default());

        // Docking clears the choice and keeps where the window was left.
        let mut docked = read_back;
        docked.window_mut(a).open = false;
        write_json(&file, &docked).unwrap();
        let read_back = read(&file).unwrap();
        assert!(!read_back.window(a).open);
        assert_eq!(read_back.window(a).frame, Some(frame));

        // Each root is recorded under its path, as the Tauri app keys
        // `lattice.pdf-window.v1:<root>`.
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(json["windows"]["/papers/a"]["open"], false);
        assert_eq!(json["windows"]["/papers/a"]["frame"]["width"], 760.0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
