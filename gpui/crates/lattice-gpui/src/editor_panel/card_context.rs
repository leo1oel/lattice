//! What the source editor's cards read beside the project index's entries:
//! the manuscript's root document, which a figure's `\includegraphics` path
//! is read from, and the last build that wrote a PDF, whose `.aux` numbers
//! a reference card's label ("(3), page 4 in the last build"), as the Tauri
//! app's `LatexEditorLiveData` gives its cards `rootDocumentPath` and
//! `compiledBuild`. The index is the project's, so every editor on it reads
//! the same.

use gpui::Context;
use lattice_editor::latex::compiled_labels::CompiledBuild;

use super::EditorPanel;

impl EditorPanel {
    pub(super) fn forward_card_context(&mut self, cx: &mut Context<Self>) {
        // Only a LaTeX source's panel knows the manuscript's root; another
        // file's must not clear it.
        if !lattice_editor::latex::is_tex_source(&self.path) || self.latex_root.is_empty() {
            return;
        }
        let root = self.latex_root.clone();
        let builds = self.builds_seen as u64;
        let build = self
            .build
            .read(cx)
            .last()
            .filter(|last| last.wrote_pdf)
            .map(|last| CompiledBuild {
                id: builds,
                root_document: last.root_document.clone(),
                aux_folder: last.aux_folder.clone(),
            });
        let index = self.project.read(cx).index().clone();
        index.update(cx, |index, cx| {
            index.set_root_document(root);
            index.set_compiled_build(build, cx);
        });
    }
}
