//! ⌘-double-click (Ctrl on Windows and Linux) on a figure in the compiled
//! PDF opens the drawing it was made from, as the Tauri app's
//! `pdf-figure-source-open.tsx` does; a plain double-click stays the jump
//! to the source line, and so does a ⌘-double-click off a figure.
//!
//! SyncTeX lands in Inkscape's own `.pdf_tex`; the entry `.tex` beside it
//! names the drawing on its first line (`% editable-figure source: …`,
//! `figureSourcePath` in `editable-figure.ts`). lattice-core decides how
//! the drawing opens (`figure_source_to_open`): a drawing in its program,
//! an SVG only once the writer agrees, anything else revealed in Finder.

use std::path::Path;

use gpui::{AppContext as _, Context, Window};
use lattice_core::{
    latex,
    project::{self, FigureSourceOpening},
};
use lattice_editor::latex::synctex_word::SyncTexWord;
use lattice_i18n::t;

use super::Shell;
use crate::{
    confirm::{self, Confirm},
    notices,
};

const SOURCE_HEADER: &str = "% editable-figure source: ";
/// A first line longer than this names no drawing.
const MAX_SOURCE_LINE: usize = 1024;

/// The project path of the drawing the figure entry at `entry_path` (with
/// `entry_text`) was made from, relative to the entry's folder; `None` when
/// it names none or a path leaving the project.
pub(super) fn figure_source_path(entry_path: &str, entry_text: &str) -> Option<String> {
    let first = entry_text.split('\n').next()?.trim_end_matches('\r');
    if first.len() > MAX_SOURCE_LINE {
        return None;
    }
    let name = first.strip_prefix(SOURCE_HEADER)?.trim_end();
    let drive = name.as_bytes().get(1) == Some(&b':') && name.as_bytes()[0].is_ascii_alphabetic();
    if name.is_empty() || name.starts_with('/') || drive {
        return None;
    }
    let mut parts: Vec<&str> = entry_path.split('/').collect();
    parts.pop();
    for part in name.split('/') {
        match part {
            ".." => {
                parts.pop()?;
            }
            "." => {}
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

impl Shell {
    /// A ⌘-double-click in the PDF: the figure's drawing when the point is
    /// on one, else the source line, as a plain double-click.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn figure_source_at(
        &mut self,
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
        let generation = self.next_inverse();
        let lookup = cx.background_spawn({
            let root = root.clone();
            let document = document.clone();
            async move {
                let target =
                    latex::inverse_search_in(&root, page, x, y, document.as_deref()).ok()?;
                let entry = match target.path.strip_suffix(".pdf_tex") {
                    Some(stem) => format!("{stem}.tex"),
                    None => target.path.clone(),
                };
                let text = std::fs::read_to_string(root.join(&entry)).ok()?;
                figure_source_path(&entry, &text)
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let source = lookup.await;
            this.update_in(cx, |this, window, cx| {
                if this.root(cx).as_deref() != Some(root.as_path())
                    || !this.newest_inverse(generation)
                {
                    return;
                }
                match source {
                    Some(source) => open_figure_source(&root, source, false, cx),
                    None => {
                        this.inverse_sync_as(generation, document, page, x, y, word, window, cx)
                    }
                }
            })
            .ok();
        })
        .detach();
    }
}

/// Open `source` as lattice-core says it may be opened, asking first for
/// an SVG (`openFigureSource`).
fn open_figure_source(root: &Path, source: String, agreed: bool, cx: &mut gpui::App) {
    match project::figure_source_to_open(root, &source, agreed) {
        Ok(FigureSourceOpening::Open(file)) => cx.open_with_system(&file),
        Ok(FigureSourceOpening::Reveal(file)) => cx.reveal_path(&file),
        Ok(FigureSourceOpening::Ask) => {
            let name = source.rsplit('/').next().unwrap_or(&source).to_string();
            let root = root.to_path_buf();
            confirm::ask(
                Confirm::new(t!(
                    "Open {name} in its default app? An SVG file often opens in a web browser, which runs any script it holds.",
                    name = name
                ))
                .confirm_label(t!("Open"))
                .on_confirm(move |_, cx| open_figure_source(&root, source.clone(), true, cx)),
                cx,
            );
        }
        Err(error) => notices::error(t!("Could not open the drawing"), error, cx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_names_its_drawing_beside_it() {
        let entry = "% editable-figure source: plot.drawio\r\n\\input{plot.pdf_tex}\n";
        assert_eq!(
            figure_source_path("figures/plot.tex", entry).as_deref(),
            Some("figures/plot.drawio")
        );
        assert_eq!(
            figure_source_path(
                "figures/plot.tex",
                "% editable-figure source: ../src/a.svg\n"
            )
            .as_deref(),
            Some("src/a.svg")
        );
        assert_eq!(
            figure_source_path("plot.tex", "% editable-figure source: ../a.svg"),
            None
        );
        assert_eq!(
            figure_source_path("plot.tex", "% editable-figure source: /etc/a.svg"),
            None
        );
        assert_eq!(
            figure_source_path("plot.tex", "% editable-figure source: C:/a.svg"),
            None
        );
        assert_eq!(
            figure_source_path("plot.tex", "\\input{plot.pdf_tex}"),
            None
        );
    }
}
