//! The shortcut sheet (⌘?, or Keyboard shortcuts in the palette): every
//! keyboard shortcut, grouped by where it works (`src/app/shortcut-sheet.tsx`).
//! It is built from the keymap when it opens (`shortcut_groups.rs`), so it
//! lists what the keys do in this build; the field filters it by name or by
//! key, and a row's keys are alternatives side by side ("⌘K / ⇧⌘P") or the
//! ends of a range ("⌘1 – ⌘9").

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{EmptyState, Keycap, TrapFocus as _, rise_in},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    Shell, commands,
    palette::PaletteEvent,
    shortcut_groups::{Group, Row, filter_groups, shortcut_groups},
};

/// The shortcut sheet: every shortcut, by where it works.
pub(crate) struct ShortcutSheet {
    focus: FocusHandle,
    input: Entity<InputState>,
    groups: Vec<Group>,
    shown: Vec<Group>,
    _subscription: Subscription,
}

impl EventEmitter<PaletteEvent> for ShortcutSheet {}

impl ShortcutSheet {
    pub(super) fn new(shell: &Shell, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut context = shell.command_context(cx);
        // Every command, as the sheet lists keys whatever applies now.
        context.in_project = true;
        context.latex_source = true;
        let groups = shortcut_groups(&commands::commands(&context), cx);
        let input =
            cx.new(|cx| InputState::new(window, cx).placeholder(t!("Filter by name or key")));
        let subscription = cx.subscribe(&input, |this, input, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                this.shown = filter_groups(&this.groups, &input.read(cx).value());
                cx.notify();
            }
        });
        Self {
            focus: cx.focus_handle(),
            input,
            shown: groups.clone(),
            groups,
            _subscription: subscription,
        }
    }

    /// The query typed in the filter field.
    fn query(&self, cx: &App) -> String {
        self.input.read(cx).value().trim().to_string()
    }

    /// The groups the sheet shows now, for scenarios.
    pub(crate) fn shown(&self) -> &[Group] {
        &self.shown
    }

    /// Type `query` into the filter field, for scenarios.
    pub(crate) fn type_query(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(query.to_string(), window, cx)
        });
        self.shown = filter_groups(&self.groups, query);
        cx.notify();
    }
}

impl Focusable for ShortcutSheet {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        // The field takes the keys as the sheet opens (`autoFocus`).
        self.input.focus_handle(cx)
    }
}

/// A row's keys: alternatives side by side, or a range's two ends.
fn combos(row: &Row, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let keys: Vec<&SharedString> = if row.range {
        row.combos
            .first()
            .into_iter()
            .chain(row.combos.last())
            .collect()
    } else {
        row.combos.iter().collect()
    };
    let mut out = div().flex().flex_none().items_center().gap(px(4.));
    for (ix, keys) in keys.into_iter().enumerate() {
        if ix > 0 {
            out = out.child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(if row.range { "–" } else { "/" }),
            );
        }
        out = out.child(Keycap::new(keys.clone()));
    }
    out.into_any_element()
}

impl Render for ShortcutSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(560.).min(window.viewport_size().width - px(40.));
        let groups: Vec<AnyElement> = self
            .shown
            .iter()
            .map(|group| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .pt(px(12.))
                            .pb(px(4.))
                            .text_role(TextRole::Caption, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(group.title.clone()),
                    )
                    .children(group.rows.iter().map(|row| {
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .min_h(px(28.))
                            .child(
                                div()
                                    .min_w_0()
                                    .text_role(TextRole::Body, cx)
                                    .text_color(palette.text)
                                    .child(row.label.clone()),
                            )
                            .child(combos(row, cx))
                    }))
                    .into_any_element()
            })
            .collect();
        let empty = groups.is_empty().then(|| {
            EmptyState::new(t!("No shortcut matches “{0}”", self.query(cx))).into_any_element()
        });
        let input = self.input.clone();
        let field = crate::search::search_field(
            "shortcut-sheet-filter",
            &self.input,
            window,
            cx,
            move |window, cx| {
                input.update(cx, |input, cx| input.set_value("", window, cx));
            },
        );
        div()
            .id("shortcut-sheet-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .items_center()
            .bg(palette.scrim)
            .occlude()
            .trap_focus("shortcut-sheet-trap", &self.focus)
            .on_key_down(cx.listener(|_, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.emit(PaletteEvent::Dismiss);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaletteEvent::Dismiss)),
            )
            .child(rise_in(
                "shortcut-sheet-in",
                div()
                    .id("shortcut-sheet")
                    .w(width)
                    .max_h(window.viewport_size().height * 0.8)
                    .flex()
                    .flex_col()
                    .rounded(px(14.))
                    .bg(palette.raised)
                    .shadow(Elevation::Dialog.shadows(&palette))
                    .pt(px(20.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .px(px(24.))
                            .text_role(TextRole::Title, cx)
                            .text_color(palette.text)
                            .child(t!("Keyboard shortcuts")),
                    )
                    .child(div().px(px(24.)).pt(px(12.)).child(field))
                    .child(
                        div()
                            .id("shortcut-sheet-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .px(px(24.))
                            .pb(px(24.))
                            .children(empty)
                            .children(groups),
                    ),
            ))
    }
}
