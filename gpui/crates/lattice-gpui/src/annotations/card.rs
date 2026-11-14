//! The pieces every annotation surface shares: the numbered pin
//! (`annotation-pin.tsx`), the quoted passage as the PDF reads it
//! (`annotation-quote.tsx`), and the comment card the source editor shows
//! over a passage (`comment-card.tsx`, `comment-card.css`): the pin, the
//! author and the time with Resolve as a check at the line's end, the note,
//! the replies, and Reply.

use std::sync::LazyLock;

use gpui::{
    AnyElement, App, FontWeight, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _,
    px,
};
use lattice_core::project::EditorComment;
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::IconButton,
    palette::Palette,
    tokens::{RADIUS_SURFACE, SPACING_2, SPACING_3, SPACING_4, SPACING_5, SPACING_6},
    typography::tabular_nums,
};
use regex::Regex;

use super::{
    colors,
    model::{self, Status},
};

/// The pin's height and least width in a card or the panel (`.annotation-pin`).
pub const PIN: f32 = 18.;
/// The gutter's pin (`.cm-annotation-pin`).
pub const GUTTER_PIN: f32 = 14.;

/// An annotation's number in its status colour.
pub fn pin(number: u32, status: Status, size: f32, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .min_w(px(size))
        .h(px(size))
        .px(px(if size >= PIN { 4. } else { 2. }))
        .rounded_full()
        .bg(colors::ink(status, palette))
        .text_color(colors::pin_text(palette))
        .text_role(TextRole::Micro, cx)
        .font_features(tabular_nums())
        .child(number.to_string())
        .into_any_element()
}

/// The passage a note quotes, as the PDF reads it rather than as LaTeX
/// source: accents composed, groups and markup commands dropped, a
/// reference as its key in brackets, and inline math as text with roots and
/// fractions written out (`AnnotationQuote`; its sub- and superscripts stay
/// as `_` and `^` here, with no smaller face to set them in).
pub fn quote_text(text: &str) -> String {
    static INLINE_MATH: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\$([^$]+)\$|\\\(([\s\S]+?)\\\)").unwrap());
    static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\\(?:cite[pt]?|ref|eqref|autoref|cref|Cref)\*?(?:\[[^\]]*\])*\{([^}]*)\}")
            .unwrap()
    });
    static SQRT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\sqrt\s*\{([^{}]*)\}").unwrap());
    static FRAC: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}").unwrap());
    static SIMPLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\w(?:_\{?\w+\}?)?$").unwrap());
    let plain = |part: &str| -> String {
        let set = lattice_core::bib_document::bib_text_to_plain(part);
        if set.is_empty() {
            return if part.chars().any(char::is_whitespace) {
                " ".into()
            } else {
                String::new()
            };
        }
        let lead = if part.starts_with(char::is_whitespace) { " " } else { "" };
        let trail = if part.ends_with(char::is_whitespace) { " " } else { "" };
        format!("{lead}{set}{trail}")
    };
    let mut out = String::new();
    let mut at = 0;
    for found in INLINE_MATH.captures_iter(text) {
        let whole = found.get(0).unwrap();
        out.push_str(&plain(&REFERENCE.replace_all(&text[at..whole.start()], "[$1]")));
        let mut body = found
            .get(1)
            .or_else(|| found.get(2))
            .map_or(String::new(), |body| body.as_str().to_string());
        loop {
            let before = body.clone();
            body = SQRT
                .replace_all(&body, |inner: &regex::Captures| {
                    let inner = &inner[1];
                    if SIMPLE.is_match(inner) {
                        format!("√{inner}")
                    } else {
                        format!("√({inner})")
                    }
                })
                .into_owned();
            body = FRAC.replace_all(&body, "$1/$2").into_owned();
            if body == before {
                break;
            }
        }
        out.push_str(&plain(&body));
        at = whole.end();
    }
    out.push_str(&plain(&REFERENCE.replace_all(&text[at..], "[$1]")));
    out
}

/// What a card does when the writer acts on it.
pub type CardAction = std::rc::Rc<dyn Fn(CardEvent, &mut gpui::Window, &mut App)>;

#[derive(Clone, Debug)]
pub enum CardEvent {
    Resolve(String),
    /// Reply to the note: its reply box in the Annotations panel.
    Reply(String),
}

/// Who wrote it and when, with the pin in place of a colour dot.
fn meta(
    comment: &EditorComment,
    resolve: Option<AnyElement>,
    palette: &Palette,
    cx: &App,
) -> AnyElement {
    let name = model::author_display(&comment.author_name);
    let when = if comment.updated_at.is_empty() {
        &comment.created_at
    } else {
        &comment.updated_at
    };
    div()
        .flex()
        .items_center()
        .gap(SPACING_3)
        .min_h(px(20.))
        .min_w_0()
        .text_role(TextRole::Caption, cx)
        .child(pin(comment.number, Status::of(comment), PIN, cx))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(palette.text)
                .child(name),
        )
        .child(
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_color(palette.text_secondary)
                .child(model::relative_time(when, true)),
        )
        .children(resolve)
        .into_any_element()
}

/// The comment card over a passage: one thread per note on it.
pub fn comment_card(
    comments: &[EditorComment],
    on: CardAction,
    max_width: gpui::Pixels,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let indent = px(PIN + 6.);
    let mut card = div()
        .id("annotation-card")
        .flex()
        .flex_col()
        .gap(SPACING_5)
        .min_w(px(240.).min(max_width))
        .max_w(px(320.).min(max_width))
        .pt(SPACING_5)
        .pb(SPACING_5)
        .pr(SPACING_5)
        .pl(SPACING_6)
        .rounded(RADIUS_SURFACE)
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(&palette))
        .text_color(palette.text)
        .text_role(TextRole::Body, cx)
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());
    for (index, comment) in comments.iter().enumerate() {
        let id = comment.id.clone();
        let on_resolve = on.clone();
        let resolve = IconButton::new(("annotation-card-resolve", index), Icon::CHECK)
            .tooltip(if comment.resolved {
                t!("Reopen")
            } else {
                tc!("comment thread", "Resolve")
            })
            .on_click(move |_, window, cx| on_resolve(CardEvent::Resolve(id.clone()), window, cx))
            .into_any_element();
        let body = if comment.body.is_empty() {
            model::note_text(comment)
        } else {
            comment.body.clone()
        };
        let body = if body.is_empty() {
            t!("(no comment text)").to_string()
        } else {
            body
        };
        let replies = comment.replies.iter().map(|reply| {
            div()
                .flex()
                .flex_col()
                .gap(SPACING_2)
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(SPACING_3)
                        .min_h(px(20.))
                        .text_role(TextRole::Caption, cx)
                        .child(
                            div().w(px(PIN)).flex().justify_center().child(
                                div()
                                    .size(px(8.))
                                    .rounded_full()
                                    .bg(reply_color(&reply.author_id, &reply.author_name)),
                            ),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(model::author_display(&reply.author_name)),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_color(palette.text_secondary)
                                .child(model::relative_time(&reply.created_at, true)),
                        ),
                )
                .child(div().ml(indent).min_w_0().child(reply.body.clone()))
        });
        let reply_id = comment.id.clone();
        let on_reply = on.clone();
        let reply_field = div()
            .id(("annotation-card-reply", index))
            .ml(indent)
            .mt(SPACING_3)
            .h(px(28.))
            .flex()
            .items_center()
            .px(SPACING_4)
            .rounded(px(6.))
            .border_1()
            .border_color(palette.field_border)
            .bg(palette.input)
            .text_color(palette.text_secondary)
            .cursor_text()
            .hover(|this| this.border_color(palette.field_border_hover))
            .child(t!("Reply…"))
            .on_click(move |_, window, cx| on_reply(CardEvent::Reply(reply_id.clone()), window, cx));
        let thread = div()
            .flex()
            .flex_col()
            .gap(SPACING_2)
            .min_w_0()
            .when(index > 0, |this| {
                this.pt(SPACING_5).border_t_1().border_color(palette.line)
            })
            .child(meta(
                comment,
                Some(div().ml_auto().child(resolve).into_any_element()),
                &palette,
                cx,
            ))
            .child(
                div()
                    .ml(indent)
                    .min_w_0()
                    .whitespace_normal()
                    .child(SharedString::from(body)),
            )
            .when(!comment.replies.is_empty(), |this| {
                this.child(
                    div()
                        .mt(SPACING_3)
                        .flex()
                        .flex_col()
                        .gap(SPACING_4)
                        .children(replies),
                )
            })
            .child(reply_field);
        card = card.child(thread);
    }
    card.into_any_element()
}

/// A reply's colour dot, from its author (`peerColorForKey`).
fn reply_color(id: &str, name: &str) -> Hsla {
    let key = if id.is_empty() { name } else { id };
    let mut hash: u32 = 0;
    for unit in key.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(unit));
    }
    lattice_editor::remote_cursors::hue_color((hash % 360) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quote_reads_as_the_pdf_sets_it() {
        assert_eq!(quote_text(r"as shown in \cite{knuth}"), "as shown in [knuth]");
        assert_eq!(quote_text(r"the \emph{key} step"), "the key step");
        assert_eq!(quote_text(r"where $\frac{a}{b}$ holds"), "where a/b holds");
        assert_eq!(quote_text(r"take $\sqrt{x}$ now"), "take √x now");
    }
}
