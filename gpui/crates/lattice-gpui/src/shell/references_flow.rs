//! A label's or citation key's occurrences and its rename, in the window
//! (`crate::submission::references`), as the Tauri app's
//! `use-source-navigation.ts` drives them: ⇧F12 and F2 on a symbol in a
//! `.tex` editor, the bar under the titlebar, and the rename dialog over the
//! window.

use gpui::{AppContext as _, Context, Entity, Subscription, Task, Window, actions};
use lattice_ui::components::ToastLevel;

use super::Shell;
use crate::{
    notices::{self, Notice},
    submission::references::{
        self, ReferencesBar, ReferencesEvent, RenameEvent, RenameSymbolDialog, SymbolKind,
        symbol_at,
    },
};

actions!(lattice, [FindReferences, RenameSymbol]);

/// The window's symbol tools, all of the open project: a project switch
/// drops them together, so nothing listed or renamed in one project acts on
/// the next.
#[derive(Default)]
pub(crate) struct References {
    /// A symbol's occurrences, in the bar under the titlebar, while shown.
    pub(crate) bar: Option<(Entity<ReferencesBar>, Subscription)>,
    /// The rename dialog, while it is open.
    pub(crate) rename: Option<(Entity<RenameSymbolDialog>, Subscription)>,
    /// The find whose occurrences the bar shows next; a newer find, or the
    /// project going, drops it before it lands.
    find: Option<Task<()>>,
}

impl Shell {
    /// The label or citation key under the caret of the editor in front,
    /// in a `.tex` file.
    fn symbol_at_caret(&self, cx: &gpui::App) -> Option<(SymbolKind, String)> {
        use editor::ToOffset as _;
        let editor = self.active_editor()?;
        let panel = editor.read(cx);
        if !panel.relative().to_ascii_lowercase().ends_with(".tex") {
            return None;
        }
        let editor = panel.editor().read(cx);
        let buffer = editor.buffer().read(cx).snapshot(cx);
        let caret = editor.selections.newest_anchor().head().to_offset(&buffer);
        let text: String = buffer.text();
        symbol_at(&text, caret.0)
    }

    /// ⇧F12: every occurrence of the symbol under the caret, in the bar.
    pub(crate) fn find_references(
        &mut self,
        _: &FindReferences,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((kind, symbol)) = self.symbol_at_caret(cx) else {
            cx.propagate();
            return;
        };
        self.show_references(kind, symbol, window, cx);
    }

    /// F2: rename the symbol under the caret.
    pub(crate) fn rename_symbol(
        &mut self,
        _: &RenameSymbol,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((kind, symbol)) = self.symbol_at_caret(cx) else {
            cx.propagate();
            return;
        };
        self.begin_rename(kind, symbol, window, cx);
    }

    /// List `symbol`'s occurrences in the bar under the titlebar.
    pub(crate) fn show_references(
        &mut self,
        kind: SymbolKind,
        symbol: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else { return };
        let found = references::find_occurrences(root, kind, symbol.clone(), cx);
        self.references.find = Some(cx.spawn_in(window, async move |this, cx| {
            let found = found.await;
            this.update_in(cx, |this, window, cx| match found {
                Ok(occurrences) => {
                    let bar = cx.new(|_| ReferencesBar::new(kind, symbol, occurrences));
                    let subscription =
                        cx.subscribe_in(&bar, window, |this, bar, event, window, cx| match event {
                            ReferencesEvent::Open { path, line } => {
                                let Some(root) = this.root(cx) else { return };
                                this.open_path(root.join(path), Some(*line), window, cx);
                            }
                            ReferencesEvent::Rename => {
                                let (kind, symbol) = {
                                    let bar = bar.read(cx);
                                    (bar.kind, bar.symbol.clone())
                                };
                                this.begin_rename(kind, symbol, window, cx);
                            }
                            ReferencesEvent::Dismiss => {
                                this.references.bar = None;
                                cx.notify();
                            }
                        });
                    this.references.bar = Some((bar, subscription));
                    cx.notify();
                }
                Err(error) => notices::show(Notice::new(ToastLevel::Error, error), cx),
            })
            .ok();
        }));
    }

    pub(crate) fn begin_rename(
        &mut self,
        kind: SymbolKind,
        symbol: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let dialog = cx.new(|cx| RenameSymbolDialog::new(kind, symbol, window, cx));
        let subscription =
            cx.subscribe_in(
                &dialog,
                window,
                |this, dialog, event, window, cx| match event {
                    RenameEvent::Close => {
                        this.references.rename = None;
                        this.focus_front(window, cx);
                        cx.notify();
                    }
                    RenameEvent::Submit(name) => {
                        this.submit_rename(dialog.clone(), name.clone(), window, cx)
                    }
                },
            );
        self.references.rename = Some((dialog, subscription));
        cx.notify();
    }

    /// Save the open edits, rename on disk (the editors reload what changed
    /// from the watcher), then list the renamed symbol.
    pub(crate) fn submit_rename(
        &mut self,
        dialog: gpui::Entity<RenameSymbolDialog>,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else { return };
        let (kind, old) = {
            let dialog = dialog.read(cx);
            (dialog.kind, dialog.old.clone())
        };
        let saved = self.save_before_leaving(cx);
        cx.spawn_in(window, async move |this, cx| {
            // A save that failed says why in its own notice.
            if let Some(saved) = saved
                && !saved.await
            {
                dialog.update(cx, |dialog, cx| dialog.failed(None, cx));
                return;
            }
            let renamed = this
                .update(cx, |_, cx| {
                    references::rename(root, kind, old, name.clone(), cx)
                })
                .ok();
            let Some(renamed) = renamed else { return };
            match renamed.await {
                Ok(()) => {
                    this.update_in(cx, |this, window, cx| {
                        let open = this.references.rename.as_ref();
                        if open.is_none_or(|(open, _)| *open != dialog) {
                            return;
                        }
                        this.references.rename = None;
                        this.focus_front(window, cx);
                        this.history.update(cx, |history, cx| history.reload(cx));
                        this.show_references(kind, name, window, cx);
                    })
                    .ok();
                }
                Err(error) => {
                    dialog.update(cx, |dialog, cx| dialog.failed(Some(error), cx));
                }
            }
        })
        .detach();
    }
}
