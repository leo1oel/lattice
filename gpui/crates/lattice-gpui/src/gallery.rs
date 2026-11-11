//! `lattice-gpui --gallery`: every lattice-ui component on one sheet, laid
//! out like Paper's Components boards, for a look review in either
//! appearance (`LATTICE_APPEARANCE=light|dark`).
//!
//! With `LATTICE_SHOT_OUT=PATH.png` it saves the window once it has drawn and
//! quits, as the `shot` scenario does for the main window. The sheet is two
//! pages tall; `LATTICE_GALLERY_PAGE=2` starts on the overlays and surfaces.

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, WindowBounds, WindowOptions, div, px, size,
};
use gpui_kit::component::input::InputState;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{
        Badge, BadgeTone, Button, CheckState, Checkbox, DialogCard, EmptyState, ErrorState, Field,
        IconButton, Keycap, LatticeTooltip, LoadingState, PanelHeader, SearchField, Segmented,
        SelectTrigger, SettingsCard, SettingsRow, Switch, Toast, ToastLevel,
    },
};

pub struct Gallery {
    page: u8,
    fields: [Entity<InputState>; 5],
    tooltip: gpui::AnyView,
    loading_since: Instant,
}

pub fn open(cx: &mut App) -> anyhow::Result<()> {
    let bounds = Bounds::centered(None, size(px(1440.), px(1100.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        ..Default::default()
    };
    let (window, _) = gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| Gallery::new(window, cx))
    })?;
    if let Ok(out) = std::env::var("LATTICE_SHOT_OUT") {
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1500))
                .await;
            let result = window.update(cx, |_, window, cx| capture(window, cx, &out));
            if let Err(error) | Ok(Err(error)) = result.map_err(anyhow::Error::from) {
                log::error!("gallery shot: {error:#}");
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    }
    Ok(())
}

#[cfg(feature = "offscreen-shots")]
fn capture(window: &mut Window, cx: &mut App, out: &str) -> anyhow::Result<()> {
    window.refresh();
    let _ = window.draw(cx);
    window.render_to_image()?.save(out)?;
    Ok(())
}

#[cfg(not(feature = "offscreen-shots"))]
fn capture(_: &mut Window, _: &mut App, _: &str) -> anyhow::Result<()> {
    anyhow::bail!("build with --features offscreen-shots to capture the gallery")
}

impl Gallery {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = |text: &str, placeholder: &str, window: &mut Window, cx: &mut Context<Self>| {
            let (text, placeholder) = (text.to_string(), placeholder.to_string());
            cx.new(move |cx| {
                let mut state = InputState::new(window, cx).placeholder(placeholder);
                state.set_value(text, window, cx);
                state
            })
        };
        Self {
            page: match std::env::var("LATTICE_GALLERY_PAGE").as_deref() {
                Ok("2") => 2,
                _ => 1,
            },
            fields: [
                field("", "Paper title", window, cx),
                field("Attention Is All You Need", "", window, cx),
                field("vaswani2017", "", window, cx),
                field("", "Search or add papers", window, cx),
                field("main.tex", "", window, cx),
            ],
            tooltip: LatticeTooltip::view("Toggle Project panel", Some("⌘⌥1".into()), cx),
            loading_since: Instant::now() - Duration::from_secs(1),
        }
    }
}

fn board(title: &str, note: &str, children: Vec<AnyElement>, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .items_end()
                .gap(px(12.))
                .child(
                    div()
                        .text_role(TextRole::Title, cx)
                        .text_color(palette.text)
                        .child(SharedString::from(title.to_string())),
                )
                .child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(SharedString::from(note.to_string())),
                ),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_start()
                .gap(px(16.))
                .p(px(20.))
                .rounded(px(10.))
                .bg(palette.panel)
                .shadow(lattice_ui::elevation::panel_ring(palette))
                .children(children),
        )
        .into_any_element()
}

fn labelled(label: &str, child: impl IntoElement, cx: &App) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(cx.palette().text_secondary)
                .child(SharedString::from(label.to_string())),
        )
        .child(child)
        .into_any_element()
}

impl Render for Gallery {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let noop = |_: &gpui::ClickEvent, _: &mut Window, _: &mut App| {};
        let buttons = vec![
            Button::new("primary", "Save")
                .primary()
                .on_click(noop)
                .into_any_element(),
            Button::new("tinted", "Undo")
                .tinted()
                .on_click(noop)
                .into_any_element(),
            Button::new("secondary", "Review")
                .on_click(noop)
                .into_any_element(),
            Button::new("ghost", "Cancel")
                .ghost()
                .on_click(noop)
                .into_any_element(),
            Button::new("danger", "Delete")
                .danger()
                .on_click(noop)
                .into_any_element(),
            Button::new("disabled", "Save")
                .primary()
                .disabled(true)
                .into_any_element(),
            Button::new("compact", "Add papers")
                .icon(Icon::PLUS)
                .compact()
                .on_click(noop)
                .into_any_element(),
            Button::new("compact-tinted", "Accept")
                .tinted()
                .compact()
                .on_click(noop)
                .into_any_element(),
            IconButton::new("icon-row", Icon::CLOSE)
                .frame(px(24.), px(24.))
                .tooltip("Close")
                .into_any_element(),
            IconButton::new("icon-compact", Icon::DOTS)
                .tooltip("More")
                .into_any_element(),
            IconButton::new("icon-on", Icon::RECTANGLE_HORIZONTAL)
                .on(true)
                .into_any_element(),
            IconButton::new("icon-disabled", Icon::PLUS)
                .disabled(true)
                .into_any_element(),
        ];
        let [rest, filled, invalid, search, disabled] = self.fields.clone();
        let fields = vec![
            labelled(
                "rest, placeholder",
                div().w(px(220.)).child(Field::new(&rest)),
                cx,
            ),
            labelled(
                "with text",
                div().w(px(220.)).child(Field::new(&filled)),
                cx,
            ),
            labelled(
                "invalid",
                div().w(px(220.)).child(Field::new(&invalid).invalid(true)),
                cx,
            ),
            labelled(
                "search",
                div().w(px(220.)).child(Field::new(&search).search()),
                cx,
            ),
            labelled(
                "disabled",
                div()
                    .w(px(220.))
                    .child(Field::new(&disabled).disabled(true)),
                cx,
            ),
            labelled(
                "select",
                div()
                    .w(px(220.))
                    .child(SelectTrigger::new("select", "Natbib (author–year)")),
                cx,
            ),
            labelled(
                "select, compact",
                div()
                    .w(px(140.))
                    .child(SelectTrigger::new("select-compact", "Title").compact()),
                cx,
            ),
            labelled(
                "search field",
                SearchField::new("find", "Find in project").width(px(220.)),
                cx,
            ),
        ];
        let toggles = vec![
            labelled(
                "off",
                Checkbox::new("cb-off", CheckState::Off).on_toggle(|_, _, _| {}),
                cx,
            ),
            labelled(
                "on",
                Checkbox::new("cb-on", CheckState::On).on_toggle(|_, _, _| {}),
                cx,
            ),
            labelled("mixed", Checkbox::new("cb-mixed", CheckState::Mixed), cx),
            labelled(
                "disabled",
                Checkbox::new("cb-disabled", CheckState::On).disabled(true),
                cx,
            ),
            labelled(
                "switch off",
                Switch::new("sw-off", false).on_toggle(|_, _, _| {}),
                cx,
            ),
            labelled(
                "switch on",
                Switch::new("sw-on", true).on_toggle(|_, _, _| {}),
                cx,
            ),
            labelled(
                "disabled",
                Switch::new("sw-disabled", false).disabled(true),
                cx,
            ),
            labelled(
                "with a label",
                Checkbox::new("cb-label", CheckState::On)
                    .label("Include figures folder")
                    .description("Images under figures/ go into the ZIP"),
                cx,
            ),
        ];
        let small = vec![
            labelled(
                "segmented",
                Segmented::new("seg")
                    .label("Proofread", false, noop)
                    .label("Polish", true, noop)
                    .label("Translate", false, noop),
                cx,
            ),
            labelled(
                "badges",
                div()
                    .flex()
                    .gap(px(6.))
                    .child(Badge::new("Draft"))
                    .child(Badge::new("Synced").tone(BadgeTone::Success))
                    .child(Badge::new("3 conflicts").tone(BadgeTone::Warning))
                    .child(Badge::new("4×").compact()),
                cx,
            ),
            labelled(
                "keycaps",
                div()
                    .flex()
                    .gap(px(4.))
                    .child(Keycap::new("⌘"))
                    .child(Keycap::new("⇧"))
                    .child(Keycap::new("K")),
                cx,
            ),
        ];
        let overlays =
            vec![
            labelled("tooltip", self.tooltip.clone(), cx),
            labelled(
                "toast",
                Toast::new("toast-ok", ToastLevel::Success, "Moved 3 files to Trash")
                    .detail("figures/old-plot.pdf and 2 more")
                    .action(Button::new("undo", "Undo").tinted().compact().on_click(noop))
                    .action(Button::new("details", "Details").compact().on_click(noop))
                    .on_dismiss(noop),
                cx,
            ),
            labelled(
                "toast, error",
                Toast::new("toast-error", ToastLevel::Error, "Build failed")
                    .detail("Undefined control sequence at main.tex:42")
                    .action(Button::new("log", "Open log").tinted().compact().on_click(noop))
                    .on_dismiss(noop),
                cx,
            ),
            labelled(
                "dialog",
                DialogCard::new("New project")
                    .field(Field::new(&filled))
                    .field(SelectTrigger::new("template", "NeurIPS 2026"))
                    .action(Button::new("cancel", "Cancel").on_click(noop))
                    .action(Button::new("create", "Create").primary().on_click(noop)),
                cx,
            ),
            labelled(
                "dialog, risky",
                DialogCard::new("Delete “old-plot.pdf”?")
                    .mark(Icon::CIRCLE_ALERT, palette.danger, palette.danger_soft)
                    .body("It goes to the Trash and leaves the Overleaf project on the next sync.")
                    .action(Button::new("cancel-delete", "Cancel").ghost().on_click(noop))
                    .action(Button::new("delete", "Delete").danger().on_click(noop)),
                cx,
            ),
        ];
        let surfaces = vec![
            labelled(
                "settings card",
                div().w(px(520.)).child(
                    SettingsCard::new()
                        .row(
                            SettingsRow::new("Compile on save")
                                .description("Builds the PDF whenever a source file is saved")
                                .control(
                                    Switch::new("compile-on-save", true).on_toggle(|_, _, _| {}),
                                ),
                        )
                        .row(
                            SettingsRow::new("Citation style").control(
                                div()
                                    .w_full()
                                    .child(SelectTrigger::new("style", "Natbib").compact()),
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
                LoadingState::new("loading", "Loading the library", self.loading_since),
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
        ];
        let sheet = div()
            .id("gallery")
            .size_full()
            .overflow_y_scroll()
            .bg(palette.window)
            .p(px(32.))
            .flex()
            .flex_col()
            .gap(px(28.));
        if self.page == 2 {
            sheet
                .child(board(
                    "Overlays",
                    "on the lift with the ring; popover, floating and dialog levels",
                    overlays,
                    cx,
                ))
                .child(board(
                    "Surfaces and states",
                    "Settings card and rows, panel header, empty, loading, error",
                    surfaces,
                    cx,
                ))
        } else {
            sheet
                .child(board(
                    "Buttons",
                    "primary, tinted, secondary, ghost, danger; disabled; compact; icon buttons",
                    buttons,
                    cx,
                ))
                .child(board(
                    "Fields and selection",
                    "a field answers with its border, never a ring",
                    fields,
                    cx,
                ))
                .child(board(
                    "Checkbox and switch",
                    "14px box, 4px corner; 28 × 16 track, moderate tier",
                    toggles,
                    cx,
                ))
                .child(board(
                    "Small controls",
                    "segmented, badges, keycaps",
                    small,
                    cx,
                ))
        }
    }
}
