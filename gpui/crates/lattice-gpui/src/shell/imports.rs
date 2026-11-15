//! Bringing files into the project from the tree, as the Tauri app's
//! (`src/app/use-project-tree.ts`): Import files… opens the Mac's panel on
//! files and folders together, and the tree's ⌘V duplicates the rows its ⌘C
//! copied. Both go through lattice-core's `import_files`, which routes each
//! file on content (UTF-8 text through the transaction log, the rest
//! copied). Nothing opens; what landed is summarized.
//!
//! Names the target already has are asked about once for the whole batch,
//! Keep both, Replace or Skip (`import_conflict.rs`).

use gpui::{AppContext as _, Context, PathPromptOptions, Window};
use lattice_core::project::{self as core_project, ImportRequest, NameConflict, ProjectImport};
use lattice_ui::components::{ToastLevel, ToastProgress};

use lattice_i18n::t;

use super::Shell;
use crate::notices::{self, Notice};

/// The clipboard image's bytes as the project keeps them: PNG, JPEG and
/// WebP as they are, anything else the clipboard holds (a TIFF from
/// Preview, a GIF) as PNG, as the Tauri app's canvas re-encodes it.
pub(crate) fn clipboard_image_bytes(
    image: &gpui::Image,
) -> Result<(Vec<u8>, &'static str), String> {
    use gpui::ImageFormat;
    match image.format {
        ImageFormat::Png => Ok((image.bytes.clone(), "png")),
        ImageFormat::Jpeg => Ok((image.bytes.clone(), "jpg")),
        ImageFormat::Webp => Ok((image.bytes.clone(), "webp")),
        _ => {
            let decoded = image::load_from_memory(&image.bytes)
                .map_err(|error| format!("Could not read the clipboard image: {error}"))?;
            let mut png = std::io::Cursor::new(Vec::new());
            decoded
                .write_to(&mut png, image::ImageFormat::Png)
                .map_err(|error| format!("Could not encode PNG: {error}"))?;
            Ok((png.into_inner(), "png"))
        }
    }
}

/// `clipboardImageFileName`: the moment to the second, in UTC, with the
/// colons a file name cannot hold made dashes.
pub(crate) fn clipboard_image_name(extension: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    format!("clipboard-{}.{extension}", now.format("%Y-%m-%dT%H-%M-%S"))
}

impl Shell {
    /// Import files…: the Mac's open panel, files and folders together, into
    /// `target` ("" is the project root).
    pub(super) fn choose_imports(
        &mut self,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some("Import".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let sources: Vec<String> = paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            this.update_in(cx, |this, window, cx| {
                this.import_sources(sources, target, false, None, window, cx)
            })
            .ok();
        })
        .detach();
    }

    /// The tree's ⌘V: duplicate `paths` (project-relative) into `target`; a
    /// taken name keeps both.
    pub(super) fn paste_entries(
        &mut self,
        paths: Vec<String>,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let sources = paths
            .iter()
            .map(|path| root.join(path).to_string_lossy().into_owned())
            .collect();
        self.import_sources(
            sources,
            target,
            true,
            Some(NameConflict::KeepBoth),
            window,
            cx,
        );
    }

    /// ⌘V in the tree without its own copied rows, or a folder's "Paste
    /// clipboard image as figure" (`importSystemClipboardImage`): the image
    /// on the clipboard, saved into `target` (`figures` for the project
    /// root) as `clipboard-<time>.<ext>`
    /// (lattice-core's `import_image_bytes`), and shown in the tree.
    pub(super) fn paste_clipboard_image(
        &mut self,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save_clipboard_image(target, window, cx, |this, path, _, cx| {
            let Some(root) = this.root(cx) else { return };
            this.file_tree
                .update(cx, |tree, cx| tree.set_current(Some(root.join(path)), cx));
        });
    }

    /// Save the clipboard's image into `target` (`figures` for the project
    /// root), then hand `saved` its project-relative path; no image, or a
    /// save that fails, says so instead.
    pub(super) fn save_clipboard_image(
        &mut self,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
        saved: impl FnOnce(&mut Self, String, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let image = cx.read_from_clipboard().and_then(|item| {
            item.into_entries().find_map(|entry| match entry {
                gpui::ClipboardEntry::Image(image) => Some(image),
                _ => None,
            })
        });
        let Some(image) = image else {
            notices::error(t!("No image found on the clipboard."), "", cx);
            return;
        };
        // The project root is no place lattice-core saves an image (nor the
        // Tauri app's, which failed there): a figure pasted with a top-level
        // row selected goes where the editor's pasted figures go.
        let target = if target.is_empty() {
            "figures".to_string()
        } else {
            target
        };
        let root = project.read(cx).root().to_path_buf();
        let save = cx.background_spawn(async move {
            let (bytes, extension) = clipboard_image_bytes(&image)?;
            let name = clipboard_image_name(extension, chrono::Utc::now());
            let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
            core_project::import_image_bytes(&root, &target, &name, &data)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = save.await;
            this.update_in(cx, |this, window, cx| {
                project.update(cx, |project, cx| project.entries_changed(cx));
                match result {
                    Ok(path) => saved(this, path, window, cx),
                    Err(error) => notices::error("Could not import", error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// Import `sources` (absolute) into `target`. Without a `conflict`
    /// policy, a name the target already has asks first.
    pub(super) fn import_sources(
        &mut self,
        sources: Vec<String>,
        target: String,
        copy_existing: bool,
        conflict: Option<NameConflict>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        // How far the copy is, as lattice-core counts it.
        let progress = std::sync::Arc::new(std::sync::Mutex::new(0f32));
        let imported = cx.background_spawn({
            let (sources, target) = (sources.clone(), target.clone());
            let progress = progress.clone();
            async move {
                core_project::import_files(
                    &root,
                    ImportRequest {
                        sources: &sources,
                        target_directory: &target,
                        copy_existing,
                        conflict,
                    },
                    &mut |written, total| {
                        let share = if total == 0 {
                            1.
                        } else {
                            written as f32 / total as f32
                        };
                        if let Ok(mut progress) = progress.lock() {
                            *progress = share;
                        }
                    },
                )
            }
        });
        // An import that outlasts a glance shows its progress
        // (`withImportProgress`), which its outcome then replaces.
        let watch = cx.spawn(async move |_, cx| {
            cx.background_executor().timer(IMPORT_PROGRESS_DELAY).await;
            let share = || progress.lock().map_or(0., |share| *share);
            cx.update(|cx| {
                notices::show(
                    Notice::new(ToastLevel::Info, t!("Importing files…"))
                        .source(t!("Project"))
                        .progress(ToastProgress::Fraction(share()))
                        .key(IMPORT_TOAST),
                    cx,
                )
            });
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(100))
                    .await;
                cx.update(|cx| {
                    notices::update_progress(IMPORT_TOAST, ToastProgress::Fraction(share()), cx)
                });
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let imported = imported.await;
            drop(watch);
            this.update_in(cx, |this, _, cx| match imported {
                Ok(result) if !result.conflicts.is_empty() => {
                    // Asking is the import's pause: its progress goes.
                    notices::dismiss(IMPORT_TOAST, cx);
                    this.ask_import_conflict(sources, target, copy_existing, result.conflicts, cx)
                }
                Ok(result) => {
                    project.update(cx, |project, cx| project.entries_changed(cx));
                    let mut notice =
                        Notice::new(ToastLevel::Success, imported_title(&result, &target))
                            .source(t!("Project"))
                            .key(IMPORT_TOAST);
                    if let Some(detail) = skipped_detail(&result) {
                        notice = notice.detail(detail);
                    }
                    notices::show(notice, cx);
                }
                Err(error) => notices::show(
                    Notice::new(
                        ToastLevel::Error,
                        t!("{action} failed", action = t!("Import files")),
                    )
                    .source(t!("Project"))
                    .detail(error)
                    .key(IMPORT_TOAST),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    /// Import `sources` into `target` as Import files… does, asking about
    /// taken names, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn import_for_scenario(
        &mut self,
        sources: Vec<String>,
        target: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.import_sources(sources, target, false, None, window, cx);
    }

    fn ask_import_conflict(
        &mut self,
        sources: Vec<String>,
        target: String,
        copy_existing: bool,
        names: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let view = cx.entity().downgrade();
        super::import_conflict::ask(
            names,
            target.clone(),
            move |choice, window, cx| {
                // Cancel imports nothing.
                let Some(choice) = choice else { return };
                view.update(cx, |this, cx| {
                    this.import_sources(sources, target, copy_existing, Some(choice), window, cx)
                })
                .ok();
            },
            cx,
        );
    }
}

/// The notice a long import reports its progress in, which its outcome
/// then replaces (`IMPORT_TOAST`).
const IMPORT_TOAST: &str = "project-import";
/// An import that outlasts a glance shows its progress
/// (`IMPORT_PROGRESS_DELAY_MS`).
const IMPORT_PROGRESS_DELAY: std::time::Duration = std::time::Duration::from_millis(400);

/// What landed, as the app's toast titles it.
fn imported_title(result: &ProjectImport, target: &str) -> String {
    let count = result.entries.len();
    let name = result
        .entries
        .first()
        .and_then(|entry| entry.rsplit('/').next())
        .unwrap_or_default();
    match (count, target.is_empty()) {
        (0, _) => t!("Nothing imported").to_string(),
        (1, true) => t!("Imported “{name}” into the project root", name = name).to_string(),
        (1, false) => t!(
            "Imported “{name}” into {targetDirectory}",
            name = name,
            targetDirectory = target
        )
        .to_string(),
        (_, true) => t!(
            "Imported {count} items into the project root",
            count = count
        )
        .to_string(),
        (_, false) => t!(
            "Imported {count} items into {targetDirectory}",
            count = count,
            targetDirectory = target
        )
        .to_string(),
    }
}

/// What Skip left out, under the summary.
fn skipped_detail(result: &ProjectImport) -> Option<String> {
    match result.skipped.as_slice() {
        [] => None,
        [one] => Some(t!("Skipped “{0}”, which is already there.", one).to_string()),
        many => Some(
            t!(
                "Skipped {skippedCount} items that are already there.",
                skippedCount = many.len()
            )
            .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_names_one_item_and_counts_several() {
        let one = ProjectImport {
            entries: vec!["figures/plot.pdf".into()],
            ..Default::default()
        };
        assert_eq!(
            imported_title(&one, "figures"),
            "Imported “plot.pdf” into figures"
        );
        let two = ProjectImport {
            entries: vec!["a.tex".into(), "b.tex".into()],
            ..Default::default()
        };
        assert_eq!(
            imported_title(&two, ""),
            "Imported 2 items into the project root"
        );
        assert_eq!(
            imported_title(&ProjectImport::default(), ""),
            "Nothing imported"
        );
    }

    #[test]
    fn a_pasted_image_is_named_by_its_moment_as_the_tauri_app_names_it() {
        let moment = chrono::DateTime::parse_from_rfc3339("2026-11-14T09:05:07.250Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        // `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)`.
        assert_eq!(
            clipboard_image_name("png", moment),
            "clipboard-2026-11-14T09-05-07.png"
        );
    }

    #[test]
    fn png_stays_as_it_is_and_another_format_becomes_png() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        let kept = gpui::Image::from_bytes(gpui::ImageFormat::Png, png.clone());
        assert_eq!(clipboard_image_bytes(&kept).unwrap(), (png, "png"));
        let mut tiff = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(2, 2)
            .write_to(&mut tiff, image::ImageFormat::Tiff)
            .unwrap();
        let tiff = gpui::Image::from_bytes(gpui::ImageFormat::Tiff, tiff.into_inner());
        let (bytes, extension) = clipboard_image_bytes(&tiff).unwrap();
        assert_eq!(extension, "png");
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
