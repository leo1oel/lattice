//! Go to definition in a LaTeX source (F12, and ⌘-click from
//! `source_pointer.rs`), as the Tauri app's editor has it (`gotoDefinition`
//! in `latex-editor.ts`): what the caret or the click is on
//! (`lattice_editor::latex::definition`) opens where it is defined, a
//! label's `\label` with the open file's unsaved labels among the project's,
//! a citation key's bibliography entry, an `\input`'s file or a figure.
//! Anywhere else TexLab is asked, when it is installed, and its answer
//! opens.

use std::path::Path;

use gpui::{AppContext as _, Context, actions};
use lattice_core::texlab::DocumentAt;
use lattice_editor::{
    TexlabService,
    latex::definition::{DefinitionTarget, definition_target_at, graphics_roots},
};

use super::{EditorPanel, EditorPanelEvent};
use crate::search::live_labels::{local_labels, merge_references};

actions!(lattice, [GotoDefinition]);

/// The project's files, as project-relative paths.
fn project_paths(nodes: &[lattice_core::models::FileNode], into: &mut Vec<String>) {
    for node in nodes {
        if node.kind == "directory" {
            project_paths(&node.children, into);
        } else {
            into.push(node.path.clone());
        }
    }
}

impl EditorPanel {
    /// F12's handler, on the panel's element: the caret's definition, or the
    /// key goes on outside a LaTeX file.
    pub(super) fn definition_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        use gpui::InteractiveElement as _;
        element.on_action(cx.listener(|this, _: &GotoDefinition, _, cx| {
            let (_, head) = this.latex_selection(cx);
            if !this.go_to_definition(head, cx) {
                cx.propagate();
            }
        }))
    }

    /// Open the definition of what `offset` is on; false when this is no
    /// LaTeX file or nothing there has one (and TexLab is not installed).
    pub(crate) fn go_to_definition(&mut self, offset: usize, cx: &mut Context<Self>) -> bool {
        let relative = self.relative().to_string();
        if !lattice_editor::latex::is_tex_source(Path::new(&relative)) {
            return false;
        }
        let text = self.editor().read(cx).buffer().read(cx).snapshot(cx).text();
        let project = self.project.read(cx);
        let index = project.index().read(cx);
        let references = merge_references(
            index.references(),
            &relative,
            local_labels(&relative, &text),
        );
        let mut paths = Vec::new();
        project_paths(project.files(), &mut paths);
        let root = self.latex_root.clone();
        let folder = self.project_root(cx);
        // A figure is read under the `\graphicspath` roots the project's TeX
        // sources set, the open file's unsaved text standing in for its own.
        let roots = || {
            let sources: Vec<String> = paths
                .iter()
                .filter(|path| path.ends_with(".tex"))
                .filter_map(|path| {
                    if *path == relative {
                        Some(text.clone())
                    } else {
                        lattice_core::project::read_file(&folder, path).ok()
                    }
                })
                .collect();
            graphics_roots(sources.iter().map(String::as_str))
        };
        let target = definition_target_at(&text, offset, &references, &paths, roots, &root);
        let event = match target {
            Some(DefinitionTarget::Reference { path, line, .. }) => {
                Some(EditorPanelEvent::OpenLocation { path, line })
            }
            Some(DefinitionTarget::Citation { key }) => {
                let index = self.project.read(cx).index().read(cx);
                index
                    .citation_entry(&key)
                    .map(|(path, line)| EditorPanelEvent::OpenLocation { path, line })
            }
            Some(DefinitionTarget::Include { path } | DefinitionTarget::Asset { path }) => {
                Some(EditorPanelEvent::OpenFile { path })
            }
            None => return self.texlab_definition(relative, text, offset, cx),
        };
        if let Some(event) = event {
            cx.emit(event);
        }
        true
    }

    /// TexLab's definition of what `offset` is on, opened when it answers;
    /// false when TexLab is not installed.
    fn texlab_definition(
        &mut self,
        relative: String,
        text: String,
        offset: usize,
        cx: &mut Context<Self>,
    ) -> bool {
        if !TexlabService::available() {
            return false;
        }
        let line_start = text[..offset].rfind('\n').map_or(0, |at| at + 1);
        let line = text[..line_start].matches('\n').count() as u32 + 1;
        // TexLab counts UTF-16 units, from 1 as the Tauri app sends them.
        let character = text[line_start..offset].encode_utf16().count() as u32 + 1;
        let (root, pool) = self.project.read(cx).texlab().read(cx).pool();
        let answer = cx.background_spawn(async move {
            let mut pool = pool.lock().ok()?;
            let at = DocumentAt {
                path: &relative,
                text: Some(&text),
                revision: None,
                line,
                character,
            };
            pool.definition(&root, &at).ok().flatten()
        });
        cx.spawn(async move |this, cx| {
            if let Some(location) = answer.await {
                this.update(cx, |_, cx| {
                    cx.emit(EditorPanelEvent::OpenLocation {
                        path: location.path,
                        line: location.line,
                    })
                })
                .ok();
            }
        })
        .detach();
        true
    }
}
