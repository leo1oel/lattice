//! The tree's menus, grouped as the app's (`src/project/project-file-tree.tsx`):
//! a row's make, change, locate and view items with Delete at the foot, and
//! the empty area's (and the panel's ⋯) make and view items.

use gpui::{App, ClipboardItem, Context, WeakEntity, Window};
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};

use super::{FileTreeEvent, FileTreePanel};
use crate::confirm::{self, Confirm};

#[cfg(target_os = "macos")]
const REVEAL_LABEL: &str = "Show in Finder";
#[cfg(target_os = "windows")]
const REVEAL_LABEL: &str = "Show in Explorer";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const REVEAL_LABEL: &str = "Show in file manager";

impl FileTreePanel {
    pub(crate) fn ask_delete(&mut self, path: String, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        confirm::ask(
            Confirm::new(format!("Delete “{path}” from this project?"))
                .body("This action cannot be undone.")
                .confirm_label("Delete")
                .destructive()
                .on_confirm(move |_, cx| {
                    view.update(cx, |_, cx| {
                        cx.emit(FileTreeEvent::Delete(vec![path.clone()]))
                    })
                    .ok();
                }),
            cx,
        );
    }

    /// The row menu, grouped as the app's: make, change, locate, view, and
    /// Delete at the foot.
    pub(super) fn row_menu(
        view: &WeakEntity<Self>,
        path: String,
        folder: bool,
        menu: PopupMenu,
        cx: &mut App,
    ) -> PopupMenu {
        let Some(this) = view.upgrade() else {
            return menu;
        };
        let (main, show_hidden, protected, root) = {
            let tree = this.read(cx);
            let project = tree.project.as_ref().map(|project| project.read(cx));
            (
                project.and_then(|project| project.main_document().map(str::to_string)),
                project.is_some_and(|project| project.show_hidden()),
                tree.protected(&path, cx),
                project.map(|project| project.root().to_path_buf()),
            )
        };
        let directory = if folder {
            path.clone()
        } else {
            path.rsplit_once('/')
                .map(|(parent, _)| parent.to_string())
                .unwrap_or_default()
        };
        let item = |label: &'static str,
                    run: Box<
            dyn Fn(&mut FileTreePanel, &mut Window, &mut Context<FileTreePanel>),
        >| {
            let view = view.clone();
            PopupMenuItem::new(label).on_click(move |_, window, cx| {
                view.update(cx, |this, cx| run(this, window, cx)).ok();
            })
        };
        let mut menu = menu
            .item(item("New file", {
                let directory = directory.clone();
                Box::new(move |this, window, cx| this.begin_create(&directory, false, window, cx))
            }))
            .item(item("New folder", {
                let directory = directory.clone();
                Box::new(move |this, window, cx| this.begin_create(&directory, true, window, cx))
            }));
        // Which file Build compiles is the writer's to choose; the check
        // says which one was chosen.
        if !folder && path.to_ascii_lowercase().ends_with(".tex") {
            let chosen = main.as_deref() == Some(path.as_str());
            let view = view.clone();
            let path = path.clone();
            menu = menu.separator().item(
                PopupMenuItem::new("Set as main document")
                    .checked(chosen)
                    .on_click(move |_, _, cx| {
                        if chosen {
                            return;
                        }
                        view.update(cx, |this, cx| {
                            if let Some(project) = &this.project {
                                project
                                    .update(cx, |project, cx| {
                                        project.choose_main_document(path.clone(), cx)
                                    })
                                    .detach();
                            }
                        })
                        .ok();
                    }),
            );
        }
        let absolute = root.map(|root| root.join(&path));
        menu = menu
            .separator()
            .item(item("Rename", {
                let path = path.clone();
                Box::new(move |this, window, cx| this.begin_rename(path.clone(), window, cx))
            }))
            .item(PopupMenuItem::new("Copy path").on_click({
                let absolute = absolute.clone();
                move |_, _, cx| {
                    if let Some(absolute) = &absolute {
                        cx.write_to_clipboard(ClipboardItem::new_string(
                            absolute.to_string_lossy().into_owned(),
                        ));
                    }
                }
            }))
            .item(PopupMenuItem::new(REVEAL_LABEL).on_click(move |_, _, cx| {
                if let Some(absolute) = &absolute {
                    cx.reveal_path(absolute);
                }
            }))
            .separator()
            .item(
                PopupMenuItem::new("Show hidden files")
                    .checked(show_hidden)
                    .on_click({
                        let view = view.clone();
                        move |_, _, cx| {
                            view.update(cx, |this, cx| this.toggle_hidden(cx)).ok();
                        }
                    }),
            )
            .item(item(
                "Refresh file tree",
                Box::new(|this, _, cx| this.refresh(cx)),
            ));
        if !protected {
            menu = menu.separator().item(item("Delete", {
                let path = path.clone();
                Box::new(move |this, _, cx| this.ask_delete(path.clone(), cx))
            }));
        }
        menu
    }

    /// What can be added at the project's top level: the ⋯ menu's first
    /// items, and the whole of the strip's + menu.
    pub(super) fn new_entries_menu(view: &WeakEntity<Self>, menu: PopupMenu) -> PopupMenu {
        let item =
            |label: &'static str,
             run: fn(&mut FileTreePanel, &mut Window, &mut Context<FileTreePanel>)| {
                let view = view.clone();
                PopupMenuItem::new(label).on_click(move |_, window, cx| {
                    view.update(cx, |this, cx| run(this, window, cx)).ok();
                })
            };
        menu.item(item("New file", |this, window, cx| {
            this.begin_create("", false, window, cx)
        }))
        .item(item("New folder", |this, window, cx| {
            this.begin_create("", true, window, cx)
        }))
    }

    /// The menu for the empty area around the rows, and the panel's ⋯ menu.
    pub(super) fn background_menu(view: &WeakEntity<Self>, menu: PopupMenu, cx: &App) -> PopupMenu {
        let show_hidden = view
            .upgrade()
            .and_then(|this| this.read(cx).project.clone())
            .is_some_and(|project| project.read(cx).show_hidden());
        let item =
            |label: &'static str,
             run: fn(&mut FileTreePanel, &mut Window, &mut Context<FileTreePanel>)| {
                let view = view.clone();
                PopupMenuItem::new(label).on_click(move |_, window, cx| {
                    view.update(cx, |this, cx| run(this, window, cx)).ok();
                })
            };
        Self::new_entries_menu(view, menu)
            .separator()
            .item(
                PopupMenuItem::new("Show hidden files")
                    .checked(show_hidden)
                    .on_click({
                        let view = view.clone();
                        move |_, _, cx| {
                            view.update(cx, |this, cx| this.toggle_hidden(cx)).ok();
                        }
                    }),
            )
            .item(item("Refresh file tree", |this, _, cx| this.refresh(cx)))
    }

    fn toggle_hidden(&mut self, cx: &mut Context<Self>) {
        if let Some(project) = &self.project {
            project.update(cx, |project, cx| {
                let shown = project.show_hidden();
                project.set_show_hidden(!shown, cx);
            });
        }
    }
}
