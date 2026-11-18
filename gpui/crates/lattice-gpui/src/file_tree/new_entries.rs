//! What the Project panel can add, as the Tauri app lists it
//! (`src/project/project-new-entries.ts`, `useNewEntryRequest` in
//! `project-file-tree.tsx`): New LaTeX file, New Markdown file, New folder
//! and Import files… beside the selection, then New spreadsheet and New
//! board at the project root and New presentation, a deck, under
//! `slides/`. They make the panel's + menu, lead its ⋯ menu, and are the
//! palette's Project commands.
//!
//! A LaTeX or Markdown file's row is named `untitled.tex` or `untitled.md`,
//! its stem selected; a spreadsheet's or board's is a bare `untitled`, and
//! each takes its extension when the name given has none
//! (`project-tree-inline-create.ts`). A presentation's row is named under
//! `slides/`, and the name is the deck's id (`create_open_slide_deck`).

use gpui::{App, Context, WeakEntity, Window};
use lattice_i18n::t;
use lattice_ui::{
    Icon,
    components::{Menu, MenuAction},
};

use super::{FileTreeEvent, FileTreePanel};

/// One thing the panel can add (`NewEntryType`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NewEntry {
    Latex,
    Markdown,
    Folder,
    Import,
    Spreadsheet,
    Board,
    Presentation,
}

/// How a new entry's row is named and made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Making {
    pub(super) folder: bool,
    /// The extension a name without one takes.
    pub(super) extension: Option<&'static str>,
    /// Whether the placeholder shows the extension.
    pub(super) shown: bool,
    /// A deck under `slides/`, its name the deck's id.
    pub(super) deck: bool,
}

impl Making {
    pub(super) const FILE: Making = Making {
        folder: false,
        extension: None,
        shown: false,
        deck: false,
    };
    pub(super) const FOLDER: Making = Making {
        folder: true,
        ..Making::FILE
    };

    /// The name given, with the extension it takes when it has none.
    pub(super) fn named(&self, name: &str) -> String {
        match self.extension {
            Some(extension) if !name.contains('.') => format!("{name}.{extension}"),
            _ => name.to_string(),
        }
    }
}

impl NewEntry {
    /// In the order the Tauri app lists them; a separator goes before New
    /// spreadsheet.
    pub const ALL: [NewEntry; 7] = [
        NewEntry::Latex,
        NewEntry::Markdown,
        NewEntry::Folder,
        NewEntry::Import,
        NewEntry::Spreadsheet,
        NewEntry::Board,
        NewEntry::Presentation,
    ];

    pub fn label(self) -> &'static str {
        match self {
            NewEntry::Latex => t!("New LaTeX file"),
            NewEntry::Markdown => t!("New Markdown file"),
            NewEntry::Folder => t!("New folder"),
            NewEntry::Import => t!("Import files…"),
            NewEntry::Spreadsheet => t!("New spreadsheet"),
            NewEntry::Board => t!("New board"),
            NewEntry::Presentation => t!("New presentation"),
        }
    }

    /// `MENU_ICONS` (`trellis-icons.tsx`).
    pub fn icon(self) -> Icon {
        match self {
            NewEntry::Latex => Icon::FILE_CODE_CORNER,
            NewEntry::Markdown => Icon::FILE_TEXT,
            NewEntry::Folder => Icon::FOLDER_PLUS,
            NewEntry::Import => Icon::FOLDER_INPUT,
            NewEntry::Spreadsheet => Icon::TABLE_2,
            NewEntry::Board => Icon::SHAPES,
            NewEntry::Presentation => Icon::PRESENTATION,
        }
    }

    fn separated(self) -> bool {
        self == NewEntry::Spreadsheet
    }

    fn making(self) -> Option<Making> {
        let file = |extension, shown| Making {
            extension: Some(extension),
            shown,
            ..Making::FILE
        };
        Some(match self {
            NewEntry::Latex => file("tex", true),
            NewEntry::Markdown => file("md", true),
            NewEntry::Folder => Making::FOLDER,
            NewEntry::Spreadsheet => file("lattice-sheet", false),
            NewEntry::Board => file("excalidraw", false),
            NewEntry::Presentation => Making {
                deck: true,
                ..Making::FOLDER
            },
            NewEntry::Import => return None,
        })
    }
}

impl FileTreePanel {
    /// Add `entry`: name its row in place, or choose the files to import.
    pub fn new_entry(&mut self, entry: NewEntry, window: &mut Window, cx: &mut Context<Self>) {
        // Spreadsheets and boards start at the project root, and decks
        // always live under slides/; the rest go beside the selection.
        let directory = match entry {
            NewEntry::Spreadsheet | NewEntry::Board => String::new(),
            NewEntry::Presentation => "slides".to_string(),
            _ => self.selection_folder(cx),
        };
        match entry.making() {
            Some(making) => self.begin_making(&directory, making, window, cx),
            None => cx.emit(FileTreeEvent::Import { target: directory }),
        }
    }

    /// The folder the selection is in: the selected folder, or a selected
    /// file's folder; the project root with nothing selected.
    pub(super) fn selection_folder(&self, cx: &App) -> String {
        match self.state.read(cx).selected_entry() {
            Some(entry) if entry.is_folder() => entry.item().id.to_string(),
            Some(entry) => entry
                .item()
                .id
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_string())
                .unwrap_or_default(),
            None => String::new(),
        }
    }

    /// The seven entries, a separator before New spreadsheet: the strip's +
    /// menu and the head of its ⋯ menu.
    pub(super) fn new_entries_menu(view: &WeakEntity<Self>, mut menu: Menu) -> Menu {
        for entry in NewEntry::ALL {
            if entry.separated() {
                menu = menu.separator();
            }
            let view = view.clone();
            menu = menu.item(
                MenuAction::new(entry.label(), move |window, cx| {
                    view.update(cx, |this, cx| this.new_entry(entry, window, cx))
                        .ok();
                })
                .icon(entry.icon()),
            );
        }
        menu
    }

    /// The panel's ⋯ menu (`use-trellis-bridge.ts`): the entries, then Find
    /// in project and Refresh file tree.
    pub(crate) fn panel_menu(view: &WeakEntity<Self>, menu: Menu) -> Menu {
        let find = view.clone();
        let refresh = view.clone();
        Self::new_entries_menu(view, menu)
            .separator()
            .item(
                MenuAction::new(t!("Find in project"), move |window, cx| {
                    find.update(cx, |this, cx| this.find_in_project(window, cx))
                        .ok();
                })
                .icon(Icon::SEARCH),
            )
            .item(
                MenuAction::new(t!("Refresh file tree"), move |_, cx| {
                    refresh.update(cx, |this, cx| this.refresh(cx)).ok();
                })
                .icon(Icon::ROTATE_CW),
            )
    }

    /// Find in project, from the strip's button or the ⋯ menu: the tree's
    /// own filter closes, and the project's find opens.
    pub(crate) fn find_in_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_search(false, window, cx);
        cx.emit(FileTreeEvent::FindInProject);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // project-tree-inline-create.ts: a name without an extension takes the
    // kind's; one the writer typed is kept.
    #[test]
    fn a_name_without_an_extension_takes_the_kinds() {
        let sheet = NewEntry::Spreadsheet.making().unwrap();
        assert_eq!(sheet.named("budget"), "budget.lattice-sheet");
        assert_eq!(sheet.named("budget.csv"), "budget.csv");
        let latex = NewEntry::Latex.making().unwrap();
        assert_eq!(latex.named("untitled.tex"), "untitled.tex");
        assert_eq!(latex.named("notes"), "notes.tex");
        assert_eq!(
            NewEntry::Board.making().unwrap().named("map"),
            "map.excalidraw"
        );
        assert!(NewEntry::Import.making().is_none());
        assert!(NewEntry::Presentation.making().unwrap().deck);
    }
}
