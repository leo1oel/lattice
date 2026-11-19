//! A tab following its file when it is renamed or moved within the project,
//! by the tree or outside Lattice: the path, the LaTeX and spelling
//! features that read it, its language, folds and outline rail.

use std::time::Duration;

use super::*;

impl EditorPanel {
    /// The file was renamed or moved within the project (by the tree, or
    /// outside Lattice): the tab, its buffer and its history follow it.
    pub fn moved_to(&mut self, relative: String, cx: &mut Context<Self>) {
        let root = self.project.read(cx).root().to_path_buf();
        self.path = root.join(&relative);
        if let Some(diagnostics) = &self.diagnostics {
            let relative = relative.clone();
            diagnostics.update(cx, |diagnostics, cx| diagnostics.set_path(relative, cx));
        }
        if let Some(document) = self
            .structured
            .clone()
            .or_else(|| self.markdown_document().cloned())
        {
            let relative = relative.clone();
            document.update(cx, |document, cx| document.moved_to(relative, cx));
        }
        if let Some(document) = self.latex_visual_document().cloned() {
            let relative = relative.clone();
            document.update(cx, |document, cx| document.moved_to(relative, cx));
        }
        let left = std::mem::replace(&mut self.relative, relative);
        self.place_moved(&left, cx);
        match &self.index_lint {
            Some(lint) => {
                let relative = self.relative.clone();
                lint.update(cx, |lint, cx| lint.set_path(relative, cx));
            }
            None => {
                if let Some(facts) = self.attach_tex(cx) {
                    self.attach_index_lint(facts, cx);
                }
            }
        }
        crate::status_counters::set_buffer(root.clone(), left, None, cx);
        self.scan_todos(Duration::ZERO, cx);
        self.bib_moved(cx);
        // The citation cards' library knows the file by its new path.
        if let Some(papers) = self.bib.papers.clone() {
            self.attach_citations(&papers, cx);
        }
        self.spelling_moved(cx);
        self.disk = DiskVersion::Unread;
        let language = latex::language_for_path(&self.path, cx);
        self.buffer
            .update(cx, |buffer, cx| buffer.set_language(language, cx));
        let tex = latex::is_tex_source(&self.path);
        self.lattice.update(cx, |lattice, cx| {
            lattice.set_fold_source(tex.then(latex::folding::source), cx)
        });
        match (&self.rail, tex) {
            (Some(rail), true) => {
                let path = self.relative.clone();
                let source = self.buffer.read(cx).text();
                rail.update(cx, |rail, cx| rail.set_source(path, source, cx));
            }
            (Some(_), false) => self.rail = None,
            (None, true) => {
                let source = self.buffer.read(cx).text();
                self.rail = Some(Self::new_rail(
                    &self.lattice,
                    &self.project,
                    self.relative.clone(),
                    source,
                    cx,
                ));
            }
            (None, false) => {}
        }
        self.offer_view_switch(cx);
        crate::crash::note_editor(self, cx);
        cx.notify();
    }
}
