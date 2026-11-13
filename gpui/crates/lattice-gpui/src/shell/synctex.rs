//! SyncTeX from the shell: from the caret to its place in the PDF, and from a
//! double-click in the PDF to its source line, both lattice-core's lookups.

use gpui::{AppContext as _, Context, Window};
use lattice_core::latex;
use lattice_i18n::{n, t, tr};

use super::{ForwardSync, Shell, layout::View};
use crate::notices;

/// Said when a jump to the PDF cannot be made from the PDF on screen.
const NOT_COMPILED: &str = n!(
    "The PDF is not compiled from this source yet, so Lattice cannot find \
     the line in it. Fix the build, then try again."
);
const NO_MATCH: &str = n!("This source line has no matching position in the PDF.");

impl Shell {
    /// From the caret to its place in the PDF, saving first and building
    /// when the PDF was compiled before the latest change, as the Tauri
    /// app's jump does: SyncTeX answers in the lines the PDF was compiled
    /// from. A jump is dropped when the caret moves before it lands.
    pub fn forward_sync(&mut self, _: &ForwardSync, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        let (relative, position) = {
            let editor = editor.read(cx);
            (editor.relative().to_string(), editor.cursor())
        };
        if self.project.is_none() {
            return;
        }
        log::debug!("SyncTeX: from {relative} at {position:?}");
        let save = editor.update(cx, |editor, cx| editor.save(cx));
        cx.spawn_in(window, async move |this, cx| {
            if !save.await.unwrap_or(false) {
                log::info!("SyncTeX: {relative} did not save, so the jump is dropped");
                return;
            }
            if !Self::ensure_compiled(&this, cx).await {
                cx.update(|_, cx| notices::warning(tr(NOT_COMPILED), cx))
                    .ok();
                return;
            }
            let Ok(Some(root)) = this.update(cx, |this, cx| this.root(cx)) else {
                return;
            };
            let (line, column) = position;
            log::debug!("SyncTeX: the PDF is current; looking up {relative}:{line}");
            let lookup = cx
                .background_spawn({
                    let relative = relative.clone();
                    async move { latex::forward_search(&root, &relative, line, column) }
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                // The writer moved on while the jump was made.
                let unmoved = this.active_editor().is_some_and(|editor| {
                    let editor = editor.read(cx);
                    editor.relative() == relative && editor.cursor() == position
                });
                if !unmoved {
                    log::info!("SyncTeX: the caret moved before the jump landed");
                    return;
                }
                match lookup {
                    Ok(Some(target)) => {
                        this.pdf
                            .update(cx, |pdf, cx| pdf.show_sync_target(&target, cx));
                        if !this.pdf.read(cx).in_window() {
                            this.reveal_pdf(window, cx);
                        }
                    }
                    Ok(None) => notices::warning(tr(NO_MATCH), cx),
                    Err(error)
                        if error
                            == "This bibliography entry is not included in the compiled PDF." =>
                    {
                        notices::warning(
                            t!("This bibliography entry is not included in the compiled PDF."),
                            cx,
                        )
                    }
                    Err(error) => notices::error("SyncTeX", error, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// The PDF panel comes on screen for a jump into it, wherever the
    /// arrangement holds it.
    fn reveal_pdf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_view(View::Pdf, window, cx);
    }

    /// From a double-click in the PDF to its source line: in the live PDF
    /// through the compiled document's SyncTeX map, in a root document's tab
    /// through that document's (`document`).
    pub(super) fn inverse_sync(
        &mut self,
        document: Option<String>,
        page: u32,
        x: f64,
        y: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let lookup = cx.background_spawn({
            let root = root.clone();
            async move { latex::inverse_search_in(&root, page, x, y, document.as_deref()) }
        });
        cx.spawn_in(window, async move |this, cx| {
            let target = lookup.await;
            this.update_in(cx, |this, window, cx| {
                // The answer names a path in the project the click was in.
                if this.root(cx).as_deref() != Some(root.as_path()) {
                    return;
                }
                match target {
                    Ok(target) => {
                        this.open_path(root.join(&target.path), Some(target.line), window, cx);
                        // A jump from the PDF's own window brings the
                        // workspace forward, to the line.
                        window.activate_window();
                    }
                    Err(error) => notices::error("SyncTeX", error, cx),
                }
            })
            .ok();
        })
        .detach();
    }
}
