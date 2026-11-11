//! Page 3: surfaces that hold other things. Rows, a sheet and a drawer, the
//! Settings card and the region states.

use gpui::{AnyElement, Context, IntoElement, ParentElement as _, Styled as _, div, px};
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{
        Badge, Button, DetailPlacement, Drawer, EmptyState, ErrorState, Field, Keycap,
        LoadingState, PanelHeader, Row, SettingsCard, SettingsRow, Sheet, Switch, Textarea,
    },
};

use super::{Gallery, board, labelled, noop};

pub(super) fn boards(gallery: &mut Gallery, cx: &mut Context<Gallery>) -> Vec<AnyElement> {
    vec![
        board(
            "Rows",
            "32 compact, 40 data, 44 store; hover 5%, pressed 8%, selected 8% medium, the \
             current row the accent wash",
            rows(cx),
            cx,
        ),
        board(
            "Sheets and drawers",
            "a sheet is a dialog of Settings' size at the dialog level; a drawer stands \
             against the right edge at the floating level, on the input surface",
            vec![sheet_and_drawer(gallery, cx)],
            cx,
        ),
        board(
            "Surfaces and states",
            "Settings card and rows, panel header, empty, loading, error",
            states(gallery, cx),
            cx,
        ),
    ]
}

fn rows(cx: &Context<Gallery>) -> Vec<AnyElement> {
    let column = |rows: Vec<AnyElement>| {
        div()
            .w(px(300.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .children(rows)
            .into_any_element()
    };
    vec![
        labelled(
            "compact: icon, label, detail at the end, keycaps",
            column(vec![
                Row::new("row-cmd", "Toggle Project panel")
                    .compact()
                    .icon(Icon::LAYOUT_PANEL_LEFT)
                    .trailing(Keycap::new("⌘⌥1"))
                    .on_click(noop)
                    .into_any_element(),
                Row::new("row-cmd-current", "Compile")
                    .compact()
                    .icon(Icon::HAMMER)
                    .detail("Build", DetailPlacement::End)
                    .current(true)
                    .on_click(noop)
                    .into_any_element(),
                Row::new("row-cmd-off", "Push to Overleaf")
                    .compact()
                    .icon(Icon::CLOUD)
                    .disabled(true)
                    .on_click(noop)
                    .into_any_element(),
            ]),
            cx,
        ),
        labelled(
            "data: detail below; selected",
            column(vec![
                Row::new("row-file", "introduction.tex")
                    .icon(Icon::FILE_TEXT)
                    .detail("sections/", DetailPlacement::Below)
                    .on_click(noop)
                    .into_any_element(),
                Row::new("row-file-selected", "method.tex")
                    .icon(Icon::FILE_TEXT)
                    .detail("sections/", DetailPlacement::Below)
                    .selected(true)
                    .on_click(noop)
                    .into_any_element(),
            ]),
            cx,
        ),
        labelled(
            "store: a paper, a trailing badge",
            column(vec![
                Row::new("row-paper", "Attention Is All You Need")
                    .comfortable()
                    .detail(
                        "Vaswani, Shazeer, Parmar et al. · 2017",
                        DetailPlacement::Below,
                    )
                    .trailing(Badge::new("Cited 4×").compact())
                    .on_click(noop)
                    .into_any_element(),
                Row::new("row-paper-static", "Deep Residual Learning")
                    .comfortable()
                    .detail("He, Zhang, Ren, Sun · 2016", DetailPlacement::Below)
                    .into_any_element(),
            ]),
            cx,
        ),
    ]
}

/// The two over a stand-in for the window: the scrim, a sheet in the middle
/// (smaller than Settings' 860 × 640, to fit the page) and a drawer against
/// the right edge.
fn sheet_and_drawer(gallery: &Gallery, cx: &Context<Gallery>) -> AnyElement {
    let palette = cx.palette();
    let [_, filled, ..] = gallery.fields.clone();
    let sheet = Sheet::new("sheet", "Add papers")
        .size(px(560.), px(330.))
        .on_close(|_, _| {})
        .child(
            div()
                .text_color(palette.text_secondary)
                .child("Search by title, DOI or arXiv ID, or paste a BibTeX entry."),
        )
        .child(Field::new(&filled))
        .child(Textarea::new(&gallery.note))
        .action(Button::new("sheet-cancel", "Cancel").on_click(noop))
        .action(
            Button::new("sheet-add", "Add paper")
                .primary()
                .on_click(noop),
        );
    let drawer = Drawer::new("drawer", "History")
        .width(px(340.))
        .on_close(|_, _| {})
        .child(
            Row::new("drawer-today", "Edited introduction.tex")
                .detail("Today, 14:02", DetailPlacement::Below)
                .on_click(noop),
        )
        .child(
            Row::new("drawer-yesterday", "Compiled main.tex")
                .detail("Yesterday, 18:40", DetailPlacement::Below)
                .on_click(noop),
        );
    div()
        .relative()
        .w(px(1336.))
        .h(px(400.))
        .rounded(px(8.))
        .overflow_hidden()
        .bg(palette.window)
        .child(div().absolute().inset_0().bg(palette.scrim))
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .right(px(340.))
                .flex()
                .items_center()
                .justify_center()
                .child(sheet),
        )
        .child(div().absolute().top_0().right_0().h_full().child(drawer))
        .into_any_element()
}

fn states(gallery: &Gallery, cx: &Context<Gallery>) -> Vec<AnyElement> {
    let palette = cx.palette();
    vec![
        labelled(
            "settings card",
            div().w(px(520.)).child(
                SettingsCard::new()
                    .row(
                        SettingsRow::new("Compile on save")
                            .description("Builds the PDF whenever a source file is saved")
                            .control(Switch::new("compile-on-save", true).on_toggle(|_, _, _| {})),
                    )
                    .row(
                        SettingsRow::new("Editor font size").control(
                            lattice_ui::components::Slider::new(
                                "settings-font-size",
                                &gallery.sliders[1],
                            )
                            .readout(|value| format!("{value:.0} px").into()),
                        ),
                    ),
            ),
            cx,
        ),
        labelled(
            "panel header",
            div()
                .w(px(320.))
                .rounded(px(10.))
                .bg(palette.editor)
                .child(PanelHeader::new("header-close", "History").on_close(noop)),
            cx,
        ),
        labelled(
            "empty",
            EmptyState::new("No papers yet").action(
                Button::new("add-paper", "Add your first paper")
                    .compact()
                    .on_click(noop),
            ),
            cx,
        ),
        labelled(
            "loading",
            LoadingState::new("loading", "Loading the library", gallery.loading_since),
            cx,
        ),
        labelled(
            "error",
            div().w(px(320.)).child(
                ErrorState::new("The project folder moved")
                    .detail("Choose it again to reopen it")
                    .action(
                        Button::new("choose", "Choose folder")
                            .compact()
                            .on_click(noop),
                    ),
            ),
            cx,
        ),
    ]
}
