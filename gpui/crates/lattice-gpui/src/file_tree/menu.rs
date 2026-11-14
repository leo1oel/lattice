//! The tree's menus, grouped and drawn as the app's
//! (`src/project/project-file-tree.tsx`, `project-tree-context-menu.tsx`):
//! a row's make, change, locate and view items, each with its 14px glyph,
//! and Delete at the foot; the empty area's (and the panel's ⋯) make and
//! view items.

use gpui::{App, ClipboardItem, Context, WeakEntity, Window};
use lattice_i18n::{n, t, tr};
use lattice_ui::{
    Icon,
    components::{Menu, MenuAction},
};

use super::{FileTreeEvent, FileTreePanel};
use crate::confirm::{self, Confirm};

#[cfg(target_os = "macos")]
const REVEAL_LABEL: &str = n!("Show in Finder");
#[cfg(target_os = "windows")]
const REVEAL_LABEL: &str = n!("Show in Explorer");
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const REVEAL_LABEL: &str = n!("Show in file manager");

type Run = Box<dyn Fn(&mut FileTreePanel, &mut Window, &mut Context<FileTreePanel>)>;

/// An item that runs `run` on the tree.
fn item(view: &WeakEntity<FileTreePanel>, icon: Icon, label: &'static str, run: Run) -> MenuAction {
    let view = view.clone();
    MenuAction::new(label, move |window, cx| {
        view.update(cx, |this, cx| run(this, window, cx)).ok();
    })
    .icon(icon)
}

impl FileTreePanel {
    pub(crate) fn ask_delete(&mut self, path: String, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        confirm::ask(
            Confirm::new(t!("Delete “{path}” from this project?", path = path))
                .body(t!("This action cannot be undone."))
                .confirm_label(t!("Delete"))
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

    /// New file, New folder and Import files…, in `directory`.
    fn creation_items(view: &WeakEntity<Self>, directory: &str, menu: Menu) -> Menu {
        let (file, folder, import) = (
            directory.to_string(),
            directory.to_string(),
            directory.to_string(),
        );
        menu.item(item(
            view,
            Icon::FILE_PLUS,
            t!("New file"),
            Box::new(move |this, window, cx| this.begin_create(&file, false, window, cx)),
        ))
        .item(item(
            view,
            Icon::FOLDER_PLUS,
            t!("New folder"),
            Box::new(move |this, window, cx| this.begin_create(&folder, true, window, cx)),
        ))
        .item(item(
            view,
            Icon::FOLDER_INPUT,
            "Import files…",
            Box::new(move |_, _, cx| {
                cx.emit(FileTreeEvent::Import {
                    target: import.clone(),
                })
            }),
        ))
    }

    /// Show hidden files and Refresh file tree, the view items.
    fn view_items(view: &WeakEntity<Self>, show_hidden: bool, menu: Menu) -> Menu {
        let toggle = view.clone();
        menu.item(
            MenuAction::new(t!("Show hidden files"), move |_, cx| {
                toggle.update(cx, |this, cx| this.toggle_hidden(cx)).ok();
            })
            .icon(if show_hidden { Icon::CHECK } else { Icon::EYE }),
        )
        // For a change the watcher could not see.
        .item(item(
            view,
            Icon::ROTATE_CW,
            t!("Refresh file tree"),
            Box::new(|this, _, cx| this.refresh(cx)),
        ))
    }

    /// The row menu, grouped as the app's: make, change, locate, view, and
    /// Delete at the foot.
    pub(super) fn row_menu(
        view: &WeakEntity<Self>,
        path: String,
        folder: bool,
        menu: Menu,
        cx: &mut App,
    ) -> Menu {
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
        let mut menu = Self::creation_items(view, &directory, menu);
        // Which file Build compiles is the writer's to choose; the check in
        // place of its icon says which one was chosen, as the app's menu
        // marks it.
        if !folder && path.to_ascii_lowercase().ends_with(".tex") {
            let chosen = main.as_deref() == Some(path.as_str());
            let view = view.clone();
            let path = path.clone();
            menu = menu.separator().item(
                MenuAction::new(t!("Set as main document"), move |_, cx| {
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
                })
                .icon(if chosen { Icon::CHECK } else { Icon::FILE_PLAY }),
            );
        }
        let absolute = root.map(|root| root.join(&path));
        let rename = path.clone();
        menu = menu
            .separator()
            .item(item(
                view,
                Icon::PENCIL,
                t!("Rename"),
                Box::new(move |this, window, cx| this.begin_rename(rename.clone(), window, cx)),
            ))
            .item(
                MenuAction::new(t!("Copy path"), {
                    let absolute = absolute.clone();
                    move |_, cx| {
                        if let Some(absolute) = &absolute {
                            cx.write_to_clipboard(ClipboardItem::new_string(
                                absolute.to_string_lossy().into_owned(),
                            ));
                        }
                    }
                })
                .icon(Icon::COPY),
            )
            .item(
                MenuAction::new(tr(REVEAL_LABEL), move |_, cx| {
                    if let Some(absolute) = &absolute {
                        cx.reveal_path(absolute);
                    }
                })
                .icon(Icon::FOLDER_OPEN),
            )
            .separator();
        menu = Self::view_items(view, show_hidden, menu);
        if !protected {
            menu = menu.separator().item(
                item(
                    view,
                    Icon::TRASH,
                    t!("Delete"),
                    Box::new(move |this, _, cx| this.ask_delete(path.clone(), cx)),
                )
                .destructive(),
            );
        }
        menu
    }

    /// What can be added at the project's top level: the ⋯ menu's first
    /// items, and the whole of the strip's + menu.
    pub(super) fn new_entries_menu(view: &WeakEntity<Self>, menu: Menu) -> Menu {
        Self::creation_items(view, "", menu)
    }

    /// The menu for the empty area around the rows, and the panel's ⋯ menu.
    pub(crate) fn background_menu(view: &WeakEntity<Self>, menu: Menu, cx: &App) -> Menu {
        let show_hidden = view
            .upgrade()
            .and_then(|this| this.read(cx).project.clone())
            .is_some_and(|project| project.read(cx).show_hidden());
        let menu = Self::new_entries_menu(view, menu).separator();
        Self::view_items(view, show_hidden, menu)
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
