//! The composer for a new note on the selection (`annotation-composer.tsx`):
//! the quote with where it is, a line for what should change, the intent
//! chips, and Save (⌘↵), pinned beside the passage as the editor scrolls and
//! kept on the side it opened on. Esc or a click outside closes it.

use std::rc::Rc;

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, px,
};
use language::ToOffset as _;
use lattice_ui::{
    ActiveLattice as _, Elevation,
    components::{PopFrom, pop_in},
    tokens::{RADIUS_SURFACE, SPACING_5},
};

use super::Draft;
use crate::{
    annotations::form,
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
        let name = std::path::Path::new(&self.relative)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        form::note_form(
            form::NoteForm {
                quote: &draft.quote,
                location: format!("{name}:{}", draft.line).into(),
                field: &draft.field,
                intent: draft.intent,
                error: draft.error.clone(),
                ready: true,
            },
            Rc::new(|this: &mut Self, intent, _| {
                if let Some(draft) = &mut this.annotations.draft {
                    draft.intent = intent;
                }
            }),
            Rc::new(|this: &mut Self, revise, window, cx| this.save_note(revise, window, cx)),
            cx,
        )
    }
}
