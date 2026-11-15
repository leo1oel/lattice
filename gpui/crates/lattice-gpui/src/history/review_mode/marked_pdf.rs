//! The PDF with review mode's changes marked (`src/history/use-marked-pdf.ts`),
//! for the PDF panel to show in place of the paper's own while review mode is
//! on, unless the writer asks for the PDF without changes (the review bar's
//! toggle).
//!
//! It is built after each build of the paper (the sources it reads have
//! reached disk) and after each accept (a new base written), a moment later
//! so a run of either is one build. A newer build stops the older one
//! (lattice-core's `ChangesExports`). The marked PDF on screen stays until
//! the next one is ready; when one cannot be made (latexdiff fails on a
//! construct, or is not installed) the paper's own PDF comes back with the
//! reason.
//!
//! lattice-core hands the PDF back as bytes; they are written to a file of
//! their own in the system's temporary folder, which the PDF viewer opens,
//! and which goes when a newer one replaces it or review mode ends.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use gpui::{Context, SharedString, Task};
use lattice_core::latex::ChangesExports;

use super::store;

/// How long after a build or an accept the marked PDF waits, in case
/// another follows (`MARKED_PDF_DELAY_MS`).
pub const DELAY: Duration = Duration::from_millis(600);

/// lattice-core's answer for a build a newer one stopped: that one answers
/// instead.
const STOPPED: &str = "The export with changes marked was cancelled.";

/// What the marked PDF is wanted for: the project, the bases' revision and
/// the builds of the paper seen, so either moving builds it again.
pub type Wanted = (PathBuf, u64, usize);

#[derive(Default)]
pub struct MarkedPdf {
    exports: Arc<ChangesExports>,
    wanted: Option<Wanted>,
    /// The marked PDF on screen, while one has been made.
    shown: Option<PathBuf>,
    building: bool,
    /// Why the latest one could not be made.
    error: Option<SharedString>,
    generation: u64,
    _build: Option<Task<()>>,
}

impl MarkedPdf {
    pub fn shown(&self) -> Option<&Path> {
        self.shown.as_deref()
    }

    pub fn building(&self) -> bool {
        self.building
    }

    pub fn error(&self) -> Option<SharedString> {
        self.error.clone()
    }

    /// Want the marked PDF for `wanted`, or (`None`) not at all: it is built
    /// again a moment later when what it is wanted for moved.
    pub fn want(&mut self, wanted: Option<Wanted>, cx: &mut Context<Self>) {
        if wanted == self.wanted {
            return;
        }
        self.exports.cancel();
        let same_project = matches!((&wanted, &self.wanted), (Some(a), Some(b)) if a.0 == b.0);
        self.wanted = wanted.clone();
        self.generation += 1;
        let Some((root, ..)) = wanted else {
            self.reset(cx);
            return;
        };
        if !same_project {
            self.reset(cx);
        }
        let generation = self.generation;
        self._build = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DELAY).await;
            let flushed =
                cx.update(|cx| store::store(cx).update(cx, |store, cx| store.flush(&root, cx)));
            flushed.await;
            let Ok(Some((exports, export))) = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return None;
                }
                this.building = true;
                cx.notify();
                let exports = this.exports.clone();
                let export = exports.begin();
                Some((exports, export))
            }) else {
                return;
            };
            let build_root = root.clone();
            let built = cx
                .background_executor()
                .spawn(async move {
                    lattice_core::latex::review_changes_pdf(&build_root, &exports, export)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.building = false;
                let written = built.and_then(|bytes| {
                    let file = file_for(&root, export);
                    if let Some(folder) = file.parent() {
                        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
                    }
                    std::fs::write(&file, bytes).map_err(|error| error.to_string())?;
                    Ok(file)
                });
                match written {
                    Ok(file) => {
                        if let Some(old) = this.shown.replace(file) {
                            let _ = std::fs::remove_file(old);
                        }
                        this.error = None;
                    }
                    // A newer build stopped this one; that build answers.
                    Err(message) if message == STOPPED => {}
                    Err(message) => {
                        if let Some(old) = this.shown.take() {
                            let _ = std::fs::remove_file(old);
                        }
                        this.error = Some(crate::host_errors::text(&message).into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn reset(&mut self, cx: &mut Context<Self>) {
        self.exports.cancel();
        self._build = None;
        if let Some(old) = self.shown.take() {
            let _ = std::fs::remove_file(old);
        }
        self.building = false;
        self.error = None;
        cx.notify();
    }
}

impl Drop for MarkedPdf {
    fn drop(&mut self) {
        self.exports.cancel();
        if let Some(old) = self.shown.take() {
            let _ = std::fs::remove_file(old);
        }
    }
}

/// Where build `export` of `root`'s marked PDF is kept: a file per build, so
/// the viewer never reads one being written.
fn file_for(root: &Path, export: u64) -> PathBuf {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    std::env::temp_dir()
        .join("lattice-review-pdf")
        .join(format!("{:016x}-{}-{export}.pdf", hasher.finish(), std::process::id()))
}
