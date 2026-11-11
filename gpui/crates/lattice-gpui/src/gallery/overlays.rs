//! Page 2: what floats. Paper's Menus, toasts and dialogs board.
//!
//! A menu and a popover are drawn open, as the board shows them; beside each
//! a live trigger opens the same thing on Kit's popover host.

use gpui::{AnyElement, App, Context, IntoElement, ParentElement as _, Styled as _, div, px};
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{
        Button, DialogCard, Field, Menu, MenuAction, MenuPopover, Popover, PopoverCard, Select,
        Toast, ToastLevel,
    },
};

use super::{Gallery, board, labelled, noop};

/// The board's Project menu: a label, icons, shortcuts, a disabled item, a
/// separator to the edge and the destructive item.
fn project_menu(menu: Menu) -> Menu {
    let run = |_: &mut gpui::Window, _: &mut App| {};
    menu.label("Project")
        .item(
            MenuAction::new("New file", run)
                .icon(Icon("icons/file.svg"))
                .shortcut("⌘N"),
        )
        .item(MenuAction::new("New folder", run).icon(Icon("icons/folder.svg")))
        .item(
            MenuAction::new("Copy path", run)
                .icon(Icon("icons/copy.svg"))
                .shortcut("⌥⌘C"),
        )
        .item(MenuAction::new("Rename", run).disabled(true))
        .separator()
        .item(
            MenuAction::new("Move to Trash", run)
                .icon(Icon("icons/trash.svg"))
                .shortcut("⌘⌫")
                .destructive(),
        )
}

fn rename_card(gallery: &Gallery) -> PopoverCard {
    PopoverCard::new()
        .title("Rename workspace")
        .child(Field::new(&gallery.rename))
        .action(Button::new("rename-cancel", "Cancel").ghost().compact().on_click(noop))
        .action(Button::new("rename-done", "Done").tinted().compact().on_click(noop))
}

pub(super) fn boards(gallery: &mut Gallery, cx: &mut Context<Gallery>) -> Vec<AnyElement> {
    let palette = cx.palette().clone();
    let rename = gallery.rename.clone();
    let floating = vec![
        labelled(
            "menu: label, icons, shortcut, disabled 50%, separator to the edge, destructive",
            div()
                .w(px(240.))
                .child(project_menu(Menu::new("menu-open")).highlighted(2)),
            cx,
        ),
        labelled(
            "popover: 288 wide, 16 inset, compact tinted lead",
            rename_card(gallery),
            cx,
        ),
        labelled(
            "live: open on press, arrows, Enter, Escape",
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(MenuPopover::new(
                    "menu-live",
                    Button::new("menu-trigger", "Project").icon(Icon::CHEVRON_DOWN),
                    project_menu,
                ))
                .child(Popover::new(
                    "popover-live",
                    Button::new("popover-trigger", "Rename"),
                    move |_, _| {
                        PopoverCard::new()
                            .title("Rename workspace")
                            .child(Field::new(&rename))
                            .action(Button::new("live-cancel", "Cancel").ghost().compact())
                            .action(Button::new("live-done", "Done").tinted().compact())
                    },
                )),
            cx,
        ),
        labelled(
            "tooltip: shortcut as quiet text",
            gallery.tooltip.clone(),
            cx,
        ),
    ];
    let toasts = vec![
        Toast::new("toast-ok", ToastLevel::Success, "Moved 3 files to Trash")
            .detail("figures/old-plot.pdf and 2 more")
            .action(Button::new("undo", "Undo").tinted().compact().on_click(noop))
            .action(Button::new("details", "Details").compact().on_click(noop))
            .on_dismiss(noop)
            .into_any_element(),
        Toast::new("toast-error", ToastLevel::Error, "Build failed")
            .detail("Undefined control sequence at main.tex:42")
            .action(Button::new("log", "Open log").tinted().compact().on_click(noop))
            .action(Button::new("details-error", "Details").compact().on_click(noop))
            .on_dismiss(noop)
            .into_any_element(),
        Toast::new("toast-warning", ToastLevel::Warning, "Overleaf is offline")
            .detail("Edits are kept and sync when it returns")
            .on_dismiss(noop)
            .into_any_element(),
    ];
    let [_, filled, ..] = gallery.fields.clone();
    let dialogs = vec![
        DialogCard::new("New project")
            .field(Field::new(&filled))
            .field(Select::new("template", ["NeurIPS 2026", "ICML 2026", "Article"], Some(0)))
            .action(Button::new("cancel", "Cancel").on_click(noop))
            .action(Button::new("create", "Create").primary().on_click(noop))
            .into_any_element(),
        DialogCard::new("Delete “old-plot.pdf”?")
            .mark(Icon("icons/trash.svg"), palette.danger, palette.danger_soft)
            .body("It goes to the Trash and leaves the Overleaf project on the next sync.")
            .action(Button::new("cancel-delete", "Cancel").ghost().on_click(noop))
            .action(Button::new("delete", "Delete").danger().on_click(noop))
            .into_any_element(),
    ];
    vec![
        board(
            "Menus, popovers, tooltips",
            "on the lift at the popover level: a 10px surface with a 4px inset, rows on the \
             6px corner",
            floating,
            cx,
        ),
        board(
            "Toasts",
            "320 wide at the floating level; severity colours only the icon",
            toasts,
            cx,
        ),
        board(
            "Dialogs",
            "390 wide, 14px corner, a serif title; a mark only when it asks something risky",
            dialogs,
            cx,
        ),
    ]
}
