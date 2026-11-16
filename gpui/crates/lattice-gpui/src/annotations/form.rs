//! The note a composer holds (`AnnotationForm` in the Tauri app's
//! `annotation-composer.tsx`): the quote with where it is, a line for what
//! should change, the intent chips, Save (⌘↵) and Save and revise now
//! (⇧⌘↵). The source editor's composer and the PDF's show the same one.

use std::rc::Rc;

use gpui::{
    AnyElement, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::TextareaState;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, ButtonVariant, Textarea},
    tokens::{RADIUS_CONTROL, SPACING_3, SPACING_4},
};

use super::{colors, model::Intent};

/// What the note shows.
pub struct NoteForm<'a> {
    /// The words the note is about.
    pub quote: &'a str,
    /// Where they are (`main.tex:35`, `PDF p.1 → main.tex:35`).
    pub location: SharedString,
    pub field: &'a Entity<TextareaState>,
    pub intent: Option<Intent>,
    pub error: Option<SharedString>,
    /// Whether Save may run yet (the PDF's note waits for SyncTeX).
    pub ready: bool,
    /// An Overleaf comment: no intent chips, no Save and revise now, and
    /// Save reads Comment on Overleaf.
    pub overleaf: bool,
}

/// A chip's choice: the intent now chosen (`None` when it was unpicked).
pub type OnIntent<T> = Rc<dyn Fn(&mut T, Option<Intent>, &mut Context<T>)>;
/// Save; `true` asks the agent about the note at once.
pub type OnSave<T> = Rc<dyn Fn(&mut T, bool, &mut Window, &mut Context<T>)>;

/// The note's body, for a composer of `T` to frame.
pub fn note_form<T: 'static>(
    form: NoteForm,
    on_intent: OnIntent<T>,
    on_save: OnSave<T>,
    cx: &mut Context<T>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let body = form.field.read(cx).value().to_string();
    let overleaf = form.overleaf;
    let saveable =
        form.ready && (!body.trim().is_empty() || (!overleaf && form.intent.is_some()));
    let quote_text = form.quote.trim();
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
                .child(form.location.clone()),
        );
    let chosen = form.intent;
    let chips = div().flex().flex_wrap().gap(px(4.)).min_w_0().children(
        Intent::ALL.iter().enumerate().map(|(index, intent)| {
            let intent = *intent;
            let pressed = chosen == Some(intent);
            let on_intent = on_intent.clone();
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
                    on_intent(this, (!pressed).then_some(intent), cx);
                    cx.notify();
                }))
        }),
    );
    let (save_keys, revise_keys) = if cfg!(target_os = "macos") {
        ("⌘↵", "⇧⌘↵")
    } else {
        ("Ctrl+Enter", "Ctrl+Shift+Enter")
    };
    let save = on_save.clone();
    let actions = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(4.))
        .child(
            Button::new(
                "annotation-save",
                if overleaf {
                    t!("Comment on Overleaf")
                } else {
                    t!("Save")
                },
            )
                .variant(ButtonVariant::Tinted)
                .size(ButtonSize::Compact)
                .keys(save_keys)
                .disabled(!saveable)
                .on_click(cx.listener(move |this, _, window, cx| save(this, false, window, cx))),
        )
        .when(!overleaf, |actions| {
            actions.child(
                Button::new("annotation-save-revise", t!("Save and revise now"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Compact)
                    .keys(revise_keys)
                    .disabled(!saveable)
                    .on_click(
                        cx.listener(move |this, _, window, cx| on_save(this, true, window, cx)),
                    ),
            )
        });
    div()
        .flex()
        .flex_col()
        .gap(SPACING_4)
        .min_w_0()
        .child(quote)
        .child(Textarea::new(form.field).grows())
        .when(!overleaf, |form| form.child(chips))
        .children(form.error.map(|error| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.danger)
                .child(error)
        }))
        .child(actions)
        .into_any_element()
}
