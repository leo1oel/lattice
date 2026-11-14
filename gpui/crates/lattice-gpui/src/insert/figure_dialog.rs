//! Insert figure (`figure-insert-dialog.tsx`, `.modal.figure-insert-modal`):
//! the figure (or how many), then Width, Placement, Caption and Label, the
//! first field taking the keyboard and Enter in any of them inserting;
//! Cancel and Insert.

use gpui::{
    AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Button, Field, LayerPlacement, ModalLayer, rise_in},
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_DIALOG},
};

use super::figure::FigureOptions;

/// What the dialog asks of the window.
pub enum FigureDialogEvent {
    Insert(FigureOptions),
    Close,
}

pub struct FigureInsertDialog {
    paths: Vec<String>,
    width: Entity<InputState>,
    placement: Entity<InputState>,
    caption: Entity<InputState>,
    label: Entity<InputState>,
    _enter: Vec<Subscription>,
}

impl EventEmitter<FigureDialogEvent> for FigureInsertDialog {}

impl FigureInsertDialog {
    pub fn new(paths: Vec<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let defaults = FigureOptions::default();
        let mut field = |value: &str, placeholder: &str| {
            let value = value.to_string();
            let placeholder = placeholder.to_string();
            cx.new(|cx| {
                InputState::new(window, cx)
                    .default_value(value)
                    .placeholder(placeholder)
            })
        };
        let width = field(&defaults.width, "0.8\\linewidth");
        let placement = field(&defaults.placement, "t");
        let caption = field(&defaults.caption, "");
        let label = field("", t!("fig:name (optional)"));
        let enter = [&width, &placement, &caption, &label]
            .into_iter()
            .map(|field| {
                cx.subscribe(field, |this, _, event, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.insert(cx);
                    }
                })
            })
            .collect();
        Self {
            paths,
            width,
            placement,
            caption,
            label,
            _enter: enter,
        }
    }

    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    /// The options as typed, an empty label the default's.
    pub fn options(&self, cx: &gpui::App) -> FigureOptions {
        let value = |field: &Entity<InputState>| field.read(cx).value().to_string();
        let label = value(&self.label);
        FigureOptions {
            width: value(&self.width),
            placement: value(&self.placement),
            caption: value(&self.caption),
            label: (!label.trim().is_empty()).then(|| label.trim().to_string()),
        }
    }

    pub fn insert(&mut self, cx: &mut Context<Self>) {
        let options = self.options(cx);
        cx.emit(FigureDialogEvent::Insert(options));
    }
}

impl Render for FigureInsertDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(420.).min(window.viewport_size().width - px(40.));
        let count = self.paths.len();
        let what = if count == 1 {
            self.paths[0].clone()
        } else {
            t!("{count} figures", count = count)
        };
        let labelled = |name: String, field: &Entity<InputState>| {
            div()
                .mt(px(12.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text)
                .child(name)
                .child(Field::new(field))
        };
        let card = div()
            .w(width)
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .child(
                div()
                    .mb(px(4.))
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(t!("Insert figure")),
            )
            .child(
                div()
                    .mb(px(8.))
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(what),
            )
            .child(labelled(t!("Width").into(), &self.width))
            .child(labelled(t!("Placement").into(), &self.placement))
            .child(labelled(t!("Caption").into(), &self.caption))
            .child(labelled(t!("Label").into(), &self.label))
            .child(
                div()
                    .mt(px(24.))
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        Button::new("figure-insert-cancel", t!("Cancel"))
                            .ghost()
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(FigureDialogEvent::Close))),
                    )
                    .child(
                        Button::new("figure-insert-submit", t!("Insert"))
                            .primary()
                            .on_click(cx.listener(|this, _, _, cx| this.insert(cx))),
                    ),
            );
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "figure-insert",
            LayerPlacement::UpperThird,
            rise_in("figure-insert-rise", card),
            move |_, cx| {
                this.update(cx, |_, cx| cx.emit(FigureDialogEvent::Close))
                    .ok();
            },
        )
        .initial_focus(gpui::Focusable::focus_handle(self.width.read(cx), cx))
    }
}
