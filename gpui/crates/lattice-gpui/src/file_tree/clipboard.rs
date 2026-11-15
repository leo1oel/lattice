//! The tree's ⌘C and ⌘V, as the Tauri app's (`project-tree-clipboard.ts`):
//! ⌘C puts the selected rows' absolute paths on the clipboard, one a line,
//! and ⌘V duplicates those rows into the selected folder while the clipboard still
//! holds exactly that text, so a later copy in the editor or another app
//! supersedes it; otherwise ⌘V saves the clipboard's image into that folder
//! (`FileTreeEvent::PasteImage`).

use gpui::{ClipboardItem, Context, KeyDownEvent, Window};
use lattice_i18n::t;

use super::{FileTreeEvent, FileTreePanel, selection::outermost};
use crate::notices;

/// "Path copied", or how many were (`notifyCopied`).
pub(super) fn notify_copied(count: usize, cx: &mut gpui::App) {
    let title = match count {
        1 => t!("Path copied").to_string(),
        count => t!("{count} paths copied", count = count).to_string(),
    };
    notices::copied(title, cx);
}

/// The rows ⌘C copied and the text it wrote for them.
pub(super) struct Copied {
    paths: Vec<String>,
    text: String,
}

impl FileTreePanel {
    pub(super) fn clipboard_key(
        &mut self,
        event: &KeyDownEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        // A row being named keeps ⌘C and ⌘V for its field.
        if self.naming.is_some()
            || !modifiers.platform
            || modifiers.shift
            || modifiers.alt
            || modifiers.control
        {
            return;
        }
        match keystroke.key.as_str() {
            "c" => {
                if self.copy_selected(cx) {
                    cx.stop_propagation();
                }
            }
            "v" => {
                if !self.paste_copied(cx) {
                    let target = self.paste_target(cx);
                    cx.emit(FileTreeEvent::PasteImage { target });
                }
                cx.stop_propagation();
            }
            _ => {}
        }
    }

    /// The row the keyboard or a click last selected, project-relative, and
    /// whether it is a folder.
    fn selected_row(&self, cx: &gpui::App) -> Option<(String, bool)> {
        self.state
            .read(cx)
            .selected_entry()
            .map(|entry| (entry.item().id.to_string(), entry.is_folder()))
    }

    fn copy_selected(&mut self, cx: &mut Context<Self>) -> bool {
        let paths = outermost(&self.selected_paths(cx));
        if paths.is_empty() {
            return false;
        }
        let Some(project) = &self.project else {
            return false;
        };
        let root = project.read(cx).root().to_path_buf();
        let text = paths
            .iter()
            .map(|path| root.join(path).to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        notify_copied(paths.len(), cx);
        self.copied = Some(Copied { paths, text });
        true
    }

    /// Where ⌘V puts things: the selected folder, or a selected file's
    /// folder, else the project root.
    fn paste_target(&self, cx: &gpui::App) -> String {
        match self.selected_row(cx) {
            Some((path, true)) => path,
            Some((path, false)) => path
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_string())
                .unwrap_or_default(),
            None => String::new(),
        }
    }

    fn paste_copied(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(copied) = &self.copied else {
            return false;
        };
        let clipboard = cx.read_from_clipboard().and_then(|item| item.text());
        if clipboard.as_deref() != Some(copied.text.as_str()) {
            return false;
        }
        let target = self.paste_target(cx);
        cx.emit(FileTreeEvent::Paste {
            paths: copied.paths.clone(),
            target,
        });
        true
    }
}
