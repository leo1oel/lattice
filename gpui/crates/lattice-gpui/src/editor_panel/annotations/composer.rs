//! The composer for a new note on the selection (`annotation-composer.tsx`):
//! the quote with where it is, a line for what should change, the intent
//! chips, and Save (⌘↵), pinned beside the passage as the editor scrolls and
//! kept on the side it opened on. Esc or a click outside closes it.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};
use language::ToOffset as _;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, ButtonVariant, PopFrom, Textarea, pop_in},
    tokens::{RADIUS_CONTROL, RADIUS_SURFACE, SPACING_3, SPACING_4, SPACING_5},
};

use super::Draft;
use crate::{
    annotations::{colors, model::Intent},
    editor_panel::EditorPanel,
};

/// The composer's width at most, and its margin inside the editor.
const COMPOSER_WIDTH: f32 = 360.;
const COMPOSER_MARGIN: f32 = 8.;
const COMPOSER_MAX_HEIGHT: f32 = 400.;

impl EditorPanel {
    /// The composer, over the source view beside the passage it quotes;
    /// none while no note is being written or its passage is off screen.
    pub(in crate::editor_panel) fn annotation_composer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let view_cell = self.annotations.view.clone();
        let tracker = canvas(
            move |bounds, _, _| view_cell.set(Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element();
        let Some(draft) = &self.annotations.draft else {
            return Some(tracker);
        };
        let (Some(view), Some(editor)) = (
            self.annotations.view.get(),
            self.lattice.read(cx).painted().bounds,
        ) else {
            // The view is measured by the tracker's first frame.
            cx.on_next_frame(window, |_, _, cx| cx.notify());
            return Some(tracker);
        };
        let snapshot = self.buffer.read(cx).snapshot();
        let (start, end) = (
            draft.range.start.to_offset(&snapshot),
            draft.range.end.to_offset(&snapshot),
        );
        let (anchor, end_rect) = self.lattice.update(cx, |lattice, cx| {
            (
                lattice.offset_bounds(start, window, cx),
                lattice.offset_bounds(end, window, cx),
            )
        });
        let top_edge = view.top().max(editor.top());
        let bottom_edge = view.bottom().min(editor.bottom());
        let visible =
            anchor.filter(|anchor| anchor.bottom() > top_edge && anchor.top() < bottom_edge);
        let Some(anchor) = visible else {
            // The field and its words stay; the note is never pinned to an edge.
            return Some(tracker);
        };
        let width = px(COMPOSER_WIDTH).min((view.size.width - px(16.)).max(px(0.)));
        let below = anchor
            .bottom()
            .max(end_rect.map_or(anchor.bottom(), |end| end.bottom()));
        let height = self.annotations.height.get().max(px(120.));
        let above = *self
            .annotations
            .draft
            .as_mut()?
            .above
            .get_or_insert_with(|| {
                bottom_edge - below - px(COMPOSER_MARGIN) < height
                    && anchor.top() - top_edge > bottom_edge - below
            });
        let left = (anchor.left() - view.left())
            .max(px(COMPOSER_MARGIN))
            .min((view.size.width - width - px(COMPOSER_MARGIN)).max(px(COMPOSER_MARGIN)));
        let max_height = if above {
            anchor.top() - top_edge - px(COMPOSER_MARGIN)
        } else {
            bottom_edge - below - px(COMPOSER_MARGIN)
        }
        .min(px(COMPOSER_MAX_HEIGHT))
        .max(px(0.));
        let top = if above {
            anchor.top() - px(COMPOSER_MARGIN) - height.min(max_height) - view.top()
        } else {
            below + px(COMPOSER_MARGIN) - view.top()
        };
        let draft = self.annotations.draft.as_ref()?;
        let body = self.composer_body(draft, cx);
        let height_cell = self.annotations.height.clone();
        let palette = cx.palette().clone();
        let id = draft.id;
        let popup = div()
            .id(("annotation-composer", id as usize))
            .w(width)
            .max_h(max_height)
            .overflow_y_scroll()
            .p(SPACING_5)
            .rounded(RADIUS_SURFACE)
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(
                cx.listener(|this, _, window, cx| this.dismiss_draft(true, window, cx)),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                let keys = &event.keystroke;
                if keys.key == "escape" {
                    cx.stop_propagation();
                    this.dismiss_draft(false, window, cx);
                } else if keys.key == "enter" && keys.modifiers.secondary(cx) {
                    cx.stop_propagation();
                    this.save_draft(window, cx);
                }
            }))
            .child(body)
            .child(
                canvas(
                    move |bounds, _, _| height_cell.set(bounds.size.height),
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        let from = if above {
            PopFrom::Above
        } else {
            PopFrom::Below
        };
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(tracker)
                .child(div().absolute().left(left).top(top).child(pop_in(
                    ("annotation-composer-in", id as usize),
                    from,
                    popup,
                )))
                .into_any_element(),
        )
    }

    /// The note itself (`AnnotationForm`).
    fn composer_body(&self, draft: &Draft, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let body = draft.field.read(cx).value().to_string();
        let saveable = !body.trim().is_empty() || draft.intent.is_some();
        let name = std::path::Path::new(&self.relative)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let quote_text = draft.quote.trim();
        let quote = div()
            .flex()
            .items_start()
            .gap(SPACING_4)
            .min_w_0()
            .py(SPACING_3)
            .px(SPACING_4)
            .rounded(RADIUS_CONTROL)
            .bg(palette.annotation_highlight)
            .border_l_2()
            .border_color(palette.annotation)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .line_clamp(2)
                    .italic()
                    .font_family(cx.lattice().fonts.ui.clone())
                    .text_size(px(13.))
                    .line_height(px(16.))
                    .text_color(palette.text)
                    .child(if quote_text.is_empty() {
                        t!("(empty span)").to_string()
                    } else {
                        quote_text.to_string()
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .max_w(gpui::relative(0.55))
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .font_features(lattice_ui::typography::tabular_nums())
                    .child(format!("{name}:{}", draft.line)),
            );
        let chips = div().flex().flex_wrap().gap(px(4.)).min_w_0().children(
            Intent::ALL.iter().enumerate().map(|(index, intent)| {
                let intent = *intent;
                let pressed = draft.intent == Some(intent);
                div()
                    .id(("annotation-intent", index))
                    .h(px(24.))
                    .px(SPACING_4)
                    .flex()
                    .items_center()
                    .rounded_full()
                    .border_1()
                    .text_role(TextRole::Caption, cx)
                    .whitespace_nowrap()
                    .cursor_pointer()
                    .when(pressed, |this| {
                        this.bg(palette.annotation_highlight)
                            .border_color(colors::highlight_edge(&palette))
                            .text_color(palette.text)
                    })
                    .when(!pressed, |this| {
                        this.border_color(palette.line)
                            .text_color(palette.text_secondary)
                            .hover(|this| this.bg(palette.hover).text_color(palette.text))
                    })
                    .child(intent.label())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(draft) = &mut this.annotations.draft {
                            draft.intent = (draft.intent != Some(intent)).then_some(intent);
                        }
                        cx.notify();
                    }))
            }),
        );
        let save_keys = if cfg!(target_os = "macos") {
            "⌘↵"
        } else {
            "Ctrl+Enter"
        };
        let actions = div().flex().flex_wrap().items_center().gap(px(4.)).child(
            Button::new("annotation-save", t!("Save"))
                .variant(ButtonVariant::Tinted)
                .size(ButtonSize::Compact)
                .keys(save_keys)
                .disabled(!saveable)
                .on_click(cx.listener(|this, _, window, cx| this.save_draft(window, cx))),
        )
        .child(
            Button::new("annotation-save-revise", t!("Save and revise now"))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Compact)
                .keys(if cfg!(target_os = "macos") { "⇧⌘↵" } else { "Ctrl+Shift+Enter" })
                .disabled(!saveable)
                .on_click(cx.listener(|this, _, window, cx| this.save_note(true, window, cx))),
        );
        div()
            .flex()
            .flex_col()
            .gap(SPACING_4)
            .min_w_0()
            .child(quote)
            .child(Textarea::new(&draft.field).grows())
            .child(chips)
            .children(draft.error.clone().map(|error| {
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(error)
            }))
            .child(actions)
            .into_any_element()
    }
}
