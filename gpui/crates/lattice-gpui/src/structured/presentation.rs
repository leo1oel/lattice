//! The Open Slide runtime the decks share: lattice-core's supervisor
//! (`presentation::PresentationRuntime`), the Tauri app's own, made once per
//! process from the resources the GPUI app runs with ([`super::resources`]).
//!
//! The supervisor asks which project each lease owner's window shows, to
//! tell a live lease from one a closed page left behind. In the GPUI app a
//! deck session is its own lease owner (`slides.rs`), so the answer is the
//! project of each deck session still open, kept here.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use gpui::App;
use lattice_core::{host::Resources, presentation::PresentationRuntime};

use super::resources;

/// The runtime and the deck sessions holding leases on it.
#[derive(Clone)]
pub struct Presentation {
    runtime: PresentationRuntime,
    /// Each open deck session's label, and the project it shows.
    shown: Arc<Mutex<HashMap<String, PathBuf>>>,
}

/// Made once: `None` when this build has no Open Slide runtime beside it.
struct Global(Option<Presentation>);

impl gpui::Global for Global {}

impl Presentation {
    /// The process's runtime, made on first use.
    pub fn get(cx: &mut App) -> Option<Self> {
        if let Some(global) = cx.try_global::<Global>() {
            return global.0.clone();
        }
        let presentation = Self::new();
        if let Some(presentation) = &presentation {
            // Stop the Node service with the app, as the Tauri app does on exit.
            let runtime = presentation.runtime.clone();
            cx.on_app_quit(move |_| {
                let runtime = runtime.clone();
                async move { runtime.shutdown() }
            })
            .detach();
        }
        cx.set_global(Global(presentation.clone()));
        presentation
    }

    fn new() -> Option<Self> {
        let bundle_dir = resources::presentation_bundle()?;
        let state = resources::app_dirs();
        let made = PresentationRuntime::new(&Resources {
            bundle_dir,
            app_data_dir: state.data,
            app_cache_dir: state.cache,
        });
        match made {
            Ok(runtime) => Some(Self {
                runtime,
                shown: Arc::default(),
            }),
            Err(error) => {
                log::error!("Open Slide runtime: {error}");
                None
            }
        }
    }

    pub fn runtime(&self) -> &PresentationRuntime {
        &self.runtime
    }

    /// The deck session `label` shows `root`.
    pub fn shows(&self, label: &str, root: &Path) {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if let Ok(mut shown) = self.shown.lock() {
            shown.insert(label.to_string(), root);
        }
    }

    /// The deck session `label` closed.
    pub fn forget(&self, label: &str) {
        if let Ok(mut shown) = self.shown.lock() {
            shown.remove(label);
        }
    }

    /// What each open deck session shows, for the supervisor's stale-lease check.
    pub fn shown_roots(&self) -> HashMap<String, PathBuf> {
        self.shown
            .lock()
            .map(|shown| shown.clone())
            .unwrap_or_default()
    }
}
