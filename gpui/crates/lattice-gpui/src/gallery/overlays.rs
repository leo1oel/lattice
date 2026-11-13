//! Page 2: what floats. Paper's Menus, toasts and dialogs board.
//!
//! A menu and a popover are drawn open, as the board shows them; beside each
//! a live trigger opens the same thing on Kit's popover host.

use gpui::{
    AnyElement, App, Context, IntoElement, ParentElement as _, Styled as _, div, point, px, scaled,
};
use lattice_ui::{
    ActiveLattice as _, Entrance, Icon,
    components::{
        Button, DialogCard, Field, Menu, MenuAction, MenuPopover, PopFrom, Popover, PopoverCard,
        Select, Toast, ToastLevel, toast_in,
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
        .action(
            Button::new("rename-cancel", "Cancel")
                .ghost()
                .compact()
                .on_click(noop),
        )
        .action(
            Button::new("rename-done", "Done")
                .tinted()
                .compact()
                .on_click(noop),
        )
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
                    |menu, _, _| project_menu(menu),
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
    // The pop entrance frozen at three points of its travel, unfaded so the
    // scale shows: from 95% about the edge facing the trigger, to rest.
    let entrance = [0., 0.5, 1.]
        .into_iter()
        .map(|progress| {
            let scale = Entrance::POPUP.scale(progress);
            labelled(
                &format!("pop entrance at {:.0}%: scale {scale:.3}", progress * 100.),
                div().w(px(240.)).child(
                    scaled(project_menu(Menu::new((
                        "menu-frame",
                        (progress * 100.) as usize,
                    ))))
                    .scale(scale)
                    .origin(point(0.5, 0.)),
                ),
                cx,
            )
        })
        .collect::<Vec<_>>();
    // Each drops in as the app's toast stack has it when the page opens.
    let toasts = vec![
        toast_in(
            ("toast-in", 0usize),
            PopFrom::Above,
            Toast::new("toast-ok", ToastLevel::Success, "Moved 3 files to Trash")
                .detail("figures/old-plot.pdf and 2 more")
                .action(
                    Button::new("undo", "Undo")
                        .tinted()
                        .compact()
                        .on_click(noop),
                )
                .action(Button::new("details", "Details").compact().on_click(noop))
                .on_dismiss(noop),
        ),
        toast_in(
            ("toast-in", 1usize),
            PopFrom::Above,
            Toast::new("toast-error", ToastLevel::Error, "Build failed")
                .detail("Undefined control sequence at main.tex:42")
                .action(
                    Button::new("log", "Open log")
                        .tinted()
                        .compact()
                        .on_click(noop),
                )
                .action(
                    Button::new("details-error", "Details")
                        .compact()
                        .on_click(noop),
                )
                .on_dismiss(noop),
        ),
        toast_in(
            ("toast-in", 2usize),
            PopFrom::Above,
            Toast::new("toast-warning", ToastLevel::Warning, "Overleaf is offline")
                .detail("Edits are kept and sync when it returns")
                .on_dismiss(noop),
        ),
    ];
    let [_, filled, ..] = gallery.fields.clone();
    let dialogs = vec![
        DialogCard::new("New project")
            .field(Field::new(&filled))
            .field(Select::new(
                "template",
                ["NeurIPS 2026", "ICML 2026", "Article"],
                Some(0),
            ))
            .action(Button::new("cancel", "Cancel").on_click(noop))
            .action(Button::new("create", "Create").primary().on_click(noop))
            .into_any_element(),
        DialogCard::new("Delete “old-plot.pdf”?")
            .mark(Icon("icons/trash.svg"), palette.danger, palette.danger_soft)
            .body("It goes to the Trash and leaves the Overleaf project on the next sync.")
            .action(
                Button::new("cancel-delete", "Cancel")
                    .ghost()
                    .on_click(noop),
            )
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
            "Entrances",
            "menus, selects and popovers spring from their trigger on the pop tier: 6px, from \
             95% scale; dialogs rise from 98% on the slow tier, toasts drop in from 96%",
            entrance,
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
