//! SyncTeX from the shell: from the caret to its place in the PDF, and from a
//! double-click in the PDF to its source line, both lattice-core's lookups.

use editor::{SelectionEffects, scroll::Autoscroll};
use gpui::{App, AppContext as _, Context, Entity, Window};
use language::Point;
use lattice_core::latex;
use lattice_editor::latex::synctex_word::{SyncTexWord, source_target_for_word};
use lattice_i18n::{n, t, tr};

use super::{ForwardSync, Shell, pdf_sync::PdfSync};
use crate::{editor_panel::EditorPanel, notices};

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
        if self.project.is_none() || self.parts.get::<PdfSync>().locating {
            return;
        }
        log::debug!("SyncTeX: from {relative} at {position:?}");
        let save = editor.update(cx, |editor, cx| editor.save(cx));
        let generation = self.set_locating(None, cx);
        cx.spawn_in(window, async move |this, cx| {
            // The jump, whose every way out ends the locating below.
            async {
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
                            crate::get_started::progress::mark(crate::get_started::Step::Jump, cx);
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
            }
            .await;
            this.update(cx, |this, cx| this.set_locating(Some(generation), cx))
                .ok();
        })
        .detach();
    }

    /// The PDF panel comes on screen for a jump into it, wherever the
    /// arrangement holds it.
    fn reveal_pdf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_view("pdf", false, window, cx);
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
        word: Option<SyncTexWord>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let generation = self.next_inverse();
        self.inverse_sync_as(generation, document, page, x, y, word, window, cx);
    }

    /// Only the newest double-click lands: an older answer arriving late
    /// would take the caret from where the newer one put it. Each takes
    /// its number as it happens.
    pub(super) fn next_inverse(&mut self) -> u64 {
        let sync = self.parts.get_mut::<PdfSync>();
        sync.inverse += 1;
        sync.inverse
    }

    /// Whether `generation` is still the newest double-click.
    pub(super) fn newest_inverse(&self, generation: u64) -> bool {
        self.parts.get::<PdfSync>().inverse == generation
    }

    /// The jump of double-click `generation`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn inverse_sync_as(
        &mut self,
        generation: u64,
        document: Option<String>,
        page: u32,
        x: f64,
        y: f64,
        word: Option<SyncTexWord>,
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
                if this.root(cx).as_deref() != Some(root.as_path())
                    || !this.newest_inverse(generation)
                {
                    return;
                }
                match target {
                    Ok(target) => {
                        crate::get_started::progress::mark(crate::get_started::Step::Jump, cx);
                        let editor =
                            this.open_path(root.join(&target.path), Some(target.line), window, cx);
                        // The word clicked lands the caret on it within that
                        // line's paragraph, when the paragraph can tell it
                        // apart.
                        if let (Some(editor), Some(word)) = (editor, word) {
                            land_on_word(&editor, target.line, &word, window, cx);
                        }
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

/// Put the caret on `word` in the paragraph around the 1-based `line` of
/// `editor`, when the paragraph holds it unambiguously, or on the
/// paragraph's line when SyncTeX named the blank line after it
/// (`synctex_word::source_target_for_word`).
fn land_on_word(
    editor: &Entity<EditorPanel>,
    line: u32,
    word: &SyncTexWord,
    window: &mut Window,
    cx: &mut App,
) {
    let zed = editor.read(cx).editor().clone();
    let text = zed.read(cx).text(cx);
    let lines: Vec<&str> = text.split('\n').collect();
    if line == 0 || line as usize > lines.len() {
        return;
    }
    let (found, column) = source_target_for_word(&lines, line as usize, word);
    if found == line as usize && column.is_none() {
        return;
    }
    let row = found - 1;
    let source = lines[row];
    let byte = column.map_or(0, |column| {
        source
            .char_indices()
            .nth(column)
            .map_or(source.len(), |(at, _)| at)
    });
    let point = Point::new(row as u32, byte as u32);
    zed.update(cx, |zed, cx| {
        zed.change_selections(
            SelectionEffects::scroll(Autoscroll::center()),
            window,
            cx,
            |selections| selections.select_ranges([point..point]),
        );
    });
}
