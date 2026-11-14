//! The find bar as `.cm-panel.cm-search` draws it
//! (`src/styles/editor-workspace.css`): on the raised panel ground with a
//! hairline under it, 7px above and below, 10px in on the left and 42px on
//! the right, where × sits 9px down and 8px in. Two rows, 6px apart: the
//! query (one bordered 28px field, the row's lead) with the counter, ↓, ↑,
//! Select all and the Aa / .* / W chips; then the replacement with Replace
//! and Replace all. At 520px or more the rows share one grid, so both fields
//! end at one edge and Replace spans the counter and arrows, Replace all the
//! rest; narrower, each row wraps within itself, the field kept at least
//! 120px.
//!
//! Buttons are quiet 5% ink fills, the accent's soft wash and ink under the
//! pointer; the chips are bare until hovered or on; every fill and ink fades
//! on the fast tier, as the app's buttons do (`app-shell.css`).

use gpui::{
    AnyElement, AnyView, App, Context, ElementId, Focusable as _, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px, relative,
};
use gpui_kit::component::input::{Input, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, focus_ring},
    interaction::{fade, mix, tab_stop, track_pointer, use_interaction},
    motion::Motion,
    typography::tabular_nums,
};

use super::{FindBar, FindOptions};

/// The panel's container query: at this width the rows share one grid.
const GRID_WIDTH: f32 = 520.;
const CONTROL: f32 = 28.;
const GAP: f32 = 6.;
const RADIUS: f32 = 6.;

#[derive(Clone, Copy)]
enum Toggle {
    MatchCase,
    Regexp,
    WholeWord,
}

impl Toggle {
    fn label(self) -> &'static str {
        match self {
            Toggle::MatchCase => "Aa",
            Toggle::Regexp => ".*",
            Toggle::WholeWord => "W",
        }
    }

    fn title(self) -> SharedString {
        match self {
            Toggle::MatchCase => t!("Match case"),
            Toggle::Regexp => t!("Regular expression"),
            Toggle::WholeWord => t!("Whole word"),
        }
        .into()
    }

    fn on(self, options: FindOptions) -> bool {
        match self {
            Toggle::MatchCase => options.match_case,
            Toggle::Regexp => options.regexp,
            Toggle::WholeWord => options.whole_word,
        }
    }

    fn flip(self, mut options: FindOptions) -> FindOptions {
        match self {
            Toggle::MatchCase => options.match_case ^= true,
            Toggle::Regexp => options.regexp ^= true,
            Toggle::WholeWord => options.whole_word ^= true,
        }
        options
    }

    fn id(self) -> &'static str {
        match self {
            Toggle::MatchCase => "find-case",
            Toggle::Regexp => "find-regexp",
            Toggle::WholeWord => "find-word",
        }
    }
}

impl Render for FindBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let wide = is_wide(self.size.get());
        let query = field("find-query", &self.query, window, cx);
        let replacement = field("find-replace", &self.replacement, window, cx);
        let count = div()
            .flex_none()
            .min_w(px(36.))
            .text_center()
            .whitespace_nowrap()
            .text_role(TextRole::Micro, cx)
            .font_weight(FontWeight(500.))
            .line_height(relative(1.))
            .font_features(tabular_nums())
            .text_color(palette.text_secondary)
            .children(lattice_ui::parity::probe("find/count"))
            .children(lattice_ui::parity::text_probe(
                "find/count",
                0,
                self.count_label(cx),
            ))
            .child(self.count_label(cx))
            .into_any_element();
        let next = button("find-next", "↓".into(), t!("Next match").into(), window, cx)
            .on_click(cx.listener(|this, _, window, cx| this.step(false, window, cx)));
        let previous = button(
            "find-previous",
            "↑".into(),
            t!("Previous match").into(),
            window,
            cx,
        )
        .on_click(cx.listener(|this, _, window, cx| this.step(true, window, cx)));
        let select_all = button(
            "find-select-all",
            t!("Select all").into(),
            t!("Select all matches").into(),
            window,
            cx,
        )
        .on_click(cx.listener(|this, _, window, cx| this.select_all(window, cx)));
        let replace = button(
            "find-replace-one",
            t!("Replace").into(),
            t!("Replace this match").into(),
            window,
            cx,
        )
        .on_click(cx.listener(|this, _, window, cx| this.replace_next(window, cx)));
        let replace_all = button(
            "find-replace-all",
            t!("Replace all").into(),
            t!("Replace all matches").into(),
            window,
            cx,
        )
        .on_click(cx.listener(|this, _, window, cx| this.replace_all(window, cx)));
        let toggles: Vec<AnyElement> = [Toggle::MatchCase, Toggle::Regexp, Toggle::WholeWord]
            .into_iter()
            .map(|toggle| {
                let options = self.options;
                chip(toggle, toggle.on(options), window, cx)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.set_options(toggle.flip(options), window, cx)
                    }))
                    .into_any_element()
            })
            .collect();

        let rows: AnyElement = if wide {
            // One grid: the fields' column, then the counter and arrows over
            // Replace, then Select all and the chips over Replace all.
            // The fields' rows are taller by their margin (`field`); the
            // grid centres every other control in them.
            let inset = px(0.2
                * f32::from(
                    TextRole::Caption
                        .font_size(Default::default(), cx)
                        .to_pixels(window.rem_size()),
                ));
            let column = || div().flex().flex_col().gap(px(GAP));
            let line = || div().flex().items_center().gap(px(GAP)).py(inset);
            div()
                .flex()
                .items_start()
                .gap(px(GAP))
                .child(column().flex_1().min_w_0().child(query).child(replacement))
                .child(
                    column()
                        .flex_none()
                        .child(line().child(count).child(next).child(previous))
                        .child(div().py(inset).child(replace.w_full())),
                )
                .child(
                    column()
                        .flex_none()
                        .child(line().child(select_all).children(toggles))
                        .child(div().py(inset).child(replace_all.w_full())),
                )
                .into_any_element()
        } else {
            let row = || div().flex().flex_wrap().items_center().gap(px(GAP));
            let lead = |field: AnyElement| {
                div()
                    .flex_grow(1.)
                    .flex_basis(px(150.))
                    .min_w(px(120.))
                    .child(field)
            };
            div()
                .flex()
                .flex_col()
                .gap(px(GAP))
                .child(
                    row()
                        .child(lead(query))
                        .child(count)
                        .child(next)
                        .child(previous)
                        .child(select_all)
                        .children(toggles),
                )
                .child(
                    row()
                        .child(lead(replacement))
                        .child(replace)
                        .child(replace_all),
                )
                .into_any_element()
        };

        let close = close_button(window, cx)
            .on_click(cx.listener(|this, _, window, cx| this.close(window, cx)));
        let size = self.size.clone();
        let entity = cx.entity().downgrade();
        let bar = div()
            .id("find-bar")
            .key_context("LatticeFindBar")
            .relative()
            .w_full()
            .flex_none()
            .pt(px(7.))
            .pb(px(7.))
            .pl(px(10.))
            .pr(px(42.))
            .bg(palette.raised)
            .border_b_1()
            .border_color(palette.line)
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.close(window, cx);
                }
            }))
            .children(lattice_ui::parity::bordered_probe(
                "find",
                gpui::Edges {
                    bottom: px(1.),
                    ..Default::default()
                },
            ))
            .child(rows)
            .child(close);
        lattice_ui::measure::measured(bar, move |bounds, cx| {
            let measured = (f32::from(bounds.size.width), f32::from(bounds.size.height));
            let crossed = is_wide(size.get()) != is_wide(Some(measured));
            size.set(Some(measured));
            if crossed {
                entity.update(cx, |_, cx| cx.notify()).ok();
            }
        })
    }
}

/// The bar's one bordered control: 28px, the field's hairline deepening
/// under the pointer and while typing, 10px in, one line of the caption
/// role.
fn field(
    id: &'static str,
    input: &gpui::Entity<InputState>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let focused = input.read(cx).focus_handle(cx).is_focused(window);
    let (interaction, pointer) = use_interaction(id, window, cx);
    let deep = fade(
        ElementId::NamedChild(std::sync::Arc::new(id.into()), "deep".into()),
        focused || interaction.pointer.hovered,
        Motion::Fast,
        window,
        cx,
    );
    // CodeMirror's search theme sets `.2em .6em .2em 0` around the panel's
    // inputs, which the app's CSS resets for its buttons and chips only, so
    // the fields keep it: each row is that much taller, and the field ends
    // that far before the counter.
    let em = f32::from(
        TextRole::Caption
            .font_size(Default::default(), cx)
            .to_pixels(window.rem_size()),
    );
    let box_ = track_pointer(div().id(id), pointer)
        .flex()
        .items_center()
        .w_full()
        .min_w_0()
        .h(px(CONTROL))
        .px(px(10.))
        .rounded(px(RADIUS))
        .border_1()
        .border_color(mix(palette.field_border, palette.field_border_hover, deep))
        .bg(palette.input)
        .text_color(palette.text)
        .children(lattice_ui::parity::bordered_probe(
            region(id),
            gpui::Edges::all(px(1.)),
        ))
        .child(
            Input::new(input)
                .appearance(false)
                .px_0()
                .py_0()
                .h(TextRole::Caption.leading(Default::default()))
                .text_size(TextRole::Caption.font_size(Default::default(), cx)),
        );
    div()
        .w_full()
        .min_w_0()
        .py(px(0.2 * em))
        .pr(px(0.6 * em))
        .child(box_)
        .into_any_element()
}

/// Whether a bar of `size` lays its rows out as one grid; before its first
/// layout, as the wide bar.
pub(super) fn is_wide(size: Option<(f32, f32)>) -> bool {
    size.is_none_or(|(width, _)| width >= GRID_WIDTH)
}

/// A control's parity region: `find-next` is `find/next`.
fn region(id: &str) -> String {
    id.replacen("find-", "find/", 1)
}

fn tooltip(title: SharedString) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    move |_, cx| LatticeTooltip::view(title.clone(), None, cx)
}

/// A quiet fill: 5% ink at rest, the accent's soft wash and ink under the
/// pointer, 28px tall and at least as wide, 10px in, the caption role at
/// medium weight.
fn button(
    id: &'static str,
    label: SharedString,
    title: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let palette = cx.palette().clone();
    let (interaction, pointer) = use_interaction(id, window, cx);
    let rest = palette.text.opacity(0.05);
    let focus = focus_ring(&palette, palette.raised);
    tab_stop(track_pointer(div().id(id), pointer))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .min_w(px(CONTROL))
        .h(px(CONTROL))
        .px(px(10.))
        .rounded(px(RADIUS))
        .whitespace_nowrap()
        .cursor_pointer()
        // The app's buttons set no line height of their own: 1.6, the
        // document's.
        .line_height(relative(1.6))
        .bg(mix(rest, palette.accent_soft, interaction.hover))
        .text_color(mix(
            palette.text_secondary,
            palette.accent,
            interaction.hover,
        ))
        .font_weight(FontWeight(500.))
        .focus_visible(move |style| style.shadow(focus))
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
        .tooltip(tooltip(title))
        .children(lattice_ui::parity::probe(region(id)))
        .children(lattice_ui::parity::text_probe(region(id), 0, label.clone()))
        .child(label)
}

/// Match case, Regular expression or Whole word: bare until hovered, the
/// accent's soft wash while on, set in the code face.
fn chip(toggle: Toggle, on: bool, window: &mut Window, cx: &mut App) -> gpui::Stateful<gpui::Div> {
    let palette = cx.palette().clone();
    let id = toggle.id();
    let (interaction, pointer) = use_interaction(id, window, cx);
    let lit = fade(
        ElementId::NamedChild(std::sync::Arc::new(id.into()), "on".into()),
        on,
        Motion::Fast,
        window,
        cx,
    );
    let hover = interaction.hover * (1. - lit);
    let ground: Hsla = mix(
        mix(gpui::transparent_black(), palette.chrome_hover, hover),
        palette.accent_soft,
        lit,
    );
    let ink = mix(
        mix(palette.text_secondary, palette.text, hover),
        palette.accent,
        lit,
    );
    let focus = focus_ring(&palette, palette.raised);
    tab_stop(track_pointer(div().id(id), pointer))
        .flex()
        .flex_none()
        .items_center()
        .h(px(CONTROL))
        .px(px(6.))
        .rounded(px(RADIUS))
        .whitespace_nowrap()
        .cursor_pointer()
        .bg(ground)
        .text_color(ink)
        .font_family(cx.lattice().fonts.editor.clone())
        .font_weight(FontWeight(500.))
        .line_height(relative(1.))
        .focus_visible(move |style| style.shadow(focus))
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
        .tooltip(tooltip(toggle.title()))
        .children(lattice_ui::parity::probe(region(id)))
        .children(lattice_ui::parity::text_probe(
            region(id),
            0,
            toggle.label(),
        ))
        .child(toggle.label())
}

/// ×: 28px square, 9px from the top and 8px from the right, in the title
/// size, the chrome's hover wash under the pointer.
fn close_button(window: &mut Window, cx: &mut App) -> gpui::Stateful<gpui::Div> {
    let palette = cx.palette().clone();
    let (interaction, pointer) = use_interaction("find-close", window, cx);
    let focus = focus_ring(&palette, palette.raised);
    tab_stop(track_pointer(div().id("find-close"), pointer))
        .absolute()
        .top(px(9.))
        .right(px(8.))
        .size(px(CONTROL))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(RADIUS))
        .cursor_pointer()
        .bg(mix(
            gpui::transparent_black(),
            palette.chrome_hover,
            interaction.hover,
        ))
        .text_color(mix(palette.text_secondary, palette.text, interaction.hover))
        .text_size(TextRole::Title.size(Default::default()))
        .font_family(cx.lattice().fonts.ui.clone())
        .font_weight(FontWeight(400.))
        .line_height(relative(1.))
        .focus_visible(move |style| style.shadow(focus))
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
        .tooltip(tooltip(t!("Close search").into()))
        .children(lattice_ui::parity::probe("find/close"))
        .children(lattice_ui::parity::text_probe("find/close", 0, "×"))
        .child("×")
}
