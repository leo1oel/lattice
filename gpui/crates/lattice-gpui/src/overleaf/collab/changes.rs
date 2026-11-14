//! The Suggestions tab (`src/overleaf/overleaf-changes.tsx`): the open file's
//! suggestions in the order they come in the text, under the section each
//! falls in, each a row saying who added or deleted what and when, with
//! Accept and Reject, and the sentence around it as the paper reads, the
//! change marked in its author's colour (which shows it in the editor).
//! With two or more, Accept all and Reject all.

use std::{ops::Range, sync::LazyLock};

use gpui::{HighlightStyle, StrikethroughStyle, StyledText, UnderlineStyle};
use lattice_core::overleaf_rt::{TrackedChange, tracked};
use lattice_editor::remote_cursors::hue_color;
use lattice_i18n::t;
use lattice_ui::components::{Button, ButtonSize, ButtonVariant, IconButton};
use regex::Regex;

use super::{comments::avatar, *};

/// Context either side of a suggestion, in characters, trimmed to words.
const CONTEXT: usize = 64;

impl OverleafCollabPanel {
    pub(super) fn render_changes(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let bridge = self.bridge.read(cx);
        let Some(path) = self
            .active
            .clone()
            .filter(|path| bridge.live_review(path).is_some())
        else {
            return empty_state(
                Drawing::ProofMarks,
                t!("Open a file to see its suggestions").into(),
                cx,
            );
        };
        let mut changes = bridge
            .live_review(&path)
            .map(|review| review.changes.clone())
            .unwrap_or_default();
        if changes.is_empty() {
            return empty_state(
                Drawing::ProofMarks,
                t!("No suggestions in this file").into(),
                cx,
            );
        }
        changes.sort_by_key(|change| (change.position, change.id.clone()));
        let text = bridge.live_text(&path).unwrap_or_default().to_string();
        let can_act = bridge.can_review();
        let busy = bridge.review_busy().map(str::to_string);
        let mut list = div().flex().flex_col().gap(px(20.));
        if changes.len() > 1 {
            list = list.child(self.bulk(&path, &changes, can_act, busy.is_some(), cx));
        }
        let sections = sections_of(&text);
        let mut current: Option<String> = None;
        let mut group: Vec<TrackedChange> = Vec::new();
        let mut groups: Vec<(String, Vec<TrackedChange>)> = Vec::new();
        for change in changes {
            let section = section_at(&sections, change.position);
            if current.as_ref() != Some(&section) {
                if let Some(title) = current.take() {
                    groups.push((title, std::mem::take(&mut group)));
                }
                current = Some(section);
            }
            group.push(change);
        }
        if let Some(title) = current {
            groups.push((title, group));
        }
        for (title, items) in groups {
            let mut rows = div().flex().flex_col();
            for (index, change) in items.iter().enumerate() {
                rows = rows.child(self.change_row(
                    &path,
                    &text,
                    change,
                    index == 0,
                    can_act,
                    busy.as_deref(),
                    cx,
                ));
            }
            list = list.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(group_heading(
                        Icon::FILE_TEXT,
                        title.into(),
                        items.len(),
                        cx,
                    ))
                    .child(rows),
            );
        }
        list.into_any_element()
    }

    fn bulk(
        &self,
        path: &str,
        changes: &[TrackedChange],
        can_act: bool,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ids: Vec<String> = changes.iter().map(|change| change.id.clone()).collect();
        let disabled = !can_act || busy || changes.iter().any(tracked::is_provisional);
        let (accept_bridge, reject_bridge) = (self.bridge.clone(), self.bridge.clone());
        let (accept_ids, reject_ids) = (ids.clone(), ids);
        let (accept_path, reject_path) = (path.to_string(), path.to_string());
        let _ = cx;
        div()
            .flex()
            .justify_end()
            .gap(px(2.))
            .child(
                Button::new("overleaf-accept-all", t!("Accept all"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Compact)
                    .disabled(disabled)
                    .on_click(move |_, _, cx| {
                        let ids = accept_ids.clone();
                        accept_bridge.update(cx, |bridge, cx| {
                            bridge.accept_changes(&accept_path, ids, cx)
                        });
                    }),
            )
            .child(
                Button::new("overleaf-reject-all", t!("Reject all"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Compact)
                    .disabled(disabled)
                    .on_click(move |_, _, cx| {
                        let ids = reject_ids.clone();
                        reject_bridge.update(cx, |bridge, cx| {
                            bridge.reject_changes(&reject_path, ids, cx)
                        });
                    }),
            )
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn change_row(
        &self,
        path: &str,
        text: &str,
        change: &TrackedChange,
        first: bool,
        can_act: bool,
        busy: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let bridge = self.bridge.read(cx);
        let author = bridge
            .author_name(change.user_id.as_deref())
            .map(str::to_string)
            .unwrap_or_else(|| t!("Unknown").to_string());
        let hue = hue_color(change.hue as f32);
        let kind = if change.deletion {
            t!("deleted")
        } else {
            t!("added")
        };
        let at = change
            .timestamp
            .as_deref()
            .map(crate::overleaf::picker::relative_time)
            .unwrap_or_default();
        let working = busy == Some(change.id.as_str()) || busy == Some("all");
        let disabled = !can_act || working || tracked::is_provisional(change);
        let tip = if can_act {
            None
        } else {
            Some(t!("This account cannot accept or reject suggestions here"))
        };
        let id = change.id.clone();
        let (accept_bridge, reject_bridge) = (self.bridge.clone(), self.bridge.clone());
        let (accept_id, reject_id) = (id.clone(), id.clone());
        let (accept_path, reject_path) = (path.to_string(), path.to_string());
        let accept = IconButton::new(
            SharedString::from(format!("overleaf-change-accept-{id}")),
            Icon::CHECK,
        )
        .tooltip(tip.unwrap_or_else(|| t!("Accept")))
        .disabled(disabled)
        .on_click(move |_, _, cx| {
            let ids = vec![accept_id.clone()];
            accept_bridge.update(cx, |bridge, cx| {
                bridge.accept_changes(&accept_path, ids, cx)
            });
        });
        let reject = IconButton::new(
            SharedString::from(format!("overleaf-change-reject-{id}")),
            Icon::X,
        )
        .tooltip(tip.unwrap_or_else(|| t!("Reject")))
        .disabled(disabled)
        .on_click(move |_, _, cx| {
            let ids = vec![reject_id.clone()];
            reject_bridge.update(cx, |bridge, cx| {
                bridge.reject_changes(&reject_path, ids, cx)
            });
        });
        let (sentence, marked) = quoted(text, change);
        let style = if change.deletion {
            HighlightStyle {
                background_color: Some(hue.opacity(0.10)),
                strikethrough: Some(StrikethroughStyle {
                    thickness: px(1.5),
                    color: Some(hue),
                }),
                ..HighlightStyle::default()
            }
        } else {
            HighlightStyle {
                background_color: Some(hue.opacity(0.14)),
                underline: Some(UnderlineStyle {
                    thickness: px(1.5),
                    color: Some(hue),
                    wavy: false,
                }),
                ..HighlightStyle::default()
            }
        };
        let context = HighlightStyle {
            color: Some(palette.text_secondary),
            ..HighlightStyle::default()
        };
        let mut highlights = Vec::new();
        if marked.start > 0 {
            highlights.push((0..marked.start, context));
        }
        highlights.push((marked.clone(), style));
        if marked.end < sentence.len() {
            highlights.push((marked.end..sentence.len(), context));
        }
        let reveal_path = path.to_string();
        let position = change.position;
        let this = cx.weak_entity();
        let reading = cx.lattice().fonts.display.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .px(px(2.))
            .py(px(10.))
            .when(first, |this| this.pt(px(4.)))
            .when(!first, |this| this.border_t_1().border_color(palette.line))
            .child(
                div()
                    .min_w_0()
                    .min_h(px(28.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(avatar(&author, hue, px(18.)))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_color(palette.text)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .child(author.clone()),
                    )
                    .child(div().flex_none().child(kind))
                    .child(div().flex_none().child(at))
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .gap(px(2.))
                            .child(accept)
                            .child(reject),
                    ),
            )
            .child(
                div()
                    .id(SharedString::from(format!("overleaf-change-text-{id}")))
                    .pl(px(24.))
                    .font_family(reading)
                    .text_size(px(15.))
                    .line_height(px(24.))
                    .text_color(palette.text)
                    .cursor_pointer()
                    .on_click(move |_, _, cx| {
                        let path = reveal_path.clone();
                        this.update(cx, |_, cx| cx.emit(CollabEvent::Reveal { path, position }))
                            .ok();
                    })
                    .child(StyledText::new(sentence).with_highlights(highlights)),
            )
            .into_any_element()
    }
}

/// The text around `change` (64 characters either side, trimmed to whole
/// words, whitespace collapsed, "…" where cut) with the change itself, and
/// the change's byte range in it. A deletion's text is put back at its
/// point; an empty one reads "(no text)".
fn quoted(text: &str, change: &TrackedChange) -> (String, Range<usize>) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let at = (change.position.max(0) as usize).min(units.len());
    let own = if change.deletion {
        0
    } else {
        change.text.encode_utf16().count()
    };
    let end = (at + own).min(units.len());
    let before = String::from_utf16_lossy(&units[..at]);
    let after = String::from_utf16_lossy(&units[end..]);
    let mut lead: String = before
        .chars()
        .rev()
        .take(CONTEXT)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let cut_lead = lead.chars().count() < before.chars().count();
    if cut_lead && let Some(space) = lead.find(char::is_whitespace) {
        lead = lead[space..].to_string();
    }
    let mut tail: String = after.chars().take(CONTEXT).collect();
    let cut_tail = tail.chars().count() < after.chars().count();
    if cut_tail && let Some(space) = tail.rfind(char::is_whitespace) {
        tail.truncate(space);
    }
    let body = if change.text.is_empty() {
        t!("(no text)").to_string()
    } else {
        collapse(&change.text)
    };
    let mut lead = collapse(&lead);
    let tail = collapse(&tail);
    if cut_lead {
        lead.insert(0, '…');
    }
    let mut sentence = lead;
    let start = sentence.len();
    sentence.push_str(&body);
    let marked = start..sentence.len();
    // One space where the text has one, never two.
    if sentence.ends_with(' ') && tail.starts_with(' ') {
        sentence.push_str(&tail[1..]);
    } else {
        sentence.push_str(&tail);
    }
    if cut_tail {
        sentence.push('…');
    }
    (sentence, marked)
}

/// `text` with each run of whitespace (line breaks too) one space, its
/// ends kept: a space at either end still parts it from what follows.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for character in text.chars() {
        if character.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(character);
            space = false;
        }
    }
    out
}

/// The text's headings, by UTF-16 position: each `\chapter`, `\section` …
/// `\subsubsection` and `\paragraph`, and the abstract's span.
fn sections_of(text: &str) -> Vec<(usize, Option<usize>, String)> {
    static HEADING: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}")
            .expect("the heading pattern compiles")
    });
    let mut out: Vec<(usize, Option<usize>, String)> = HEADING
        .captures_iter(text)
        .filter_map(|captures| {
            let whole = captures.get(0)?;
            Some((whole.start(), None, captures[1].trim().to_string()))
        })
        .collect();
    if let (Some(begin), Some(end)) = (text.find("\\begin{abstract}"), text.find("\\end{abstract}"))
    {
        out.push((begin, Some(end), t!("Abstract").to_string()));
    }
    out.sort_by_key(|(at, _, _)| *at);
    // By byte, in order: each start counted on from the one before.
    let (mut byte, mut units) = (0, 0);
    for (start, end, _) in &mut out {
        units += text[byte..*start].encode_utf16().count();
        byte = *start;
        *end = end.map(|end| match text.get(byte..end) {
            Some(span) => units + span.encode_utf16().count(),
            None => text[..end].encode_utf16().count(),
        });
        *start = units;
    }
    out
}

/// The section a UTF-16 `position` falls in.
fn section_at(sections: &[(usize, Option<usize>, String)], position: i64) -> String {
    let position = position.max(0) as usize;
    if let Some((_, _, title)) = sections
        .iter()
        .find(|(start, end, _)| end.is_some_and(|end| *start <= position && position <= end))
    {
        return title.clone();
    }
    sections
        .iter()
        .rfind(|(start, end, _)| end.is_none() && *start <= position)
        .map(|(_, _, title)| title.clone())
        .unwrap_or_else(|| t!("Before the first section").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(position: i64, text: &str, deletion: bool) -> TrackedChange {
        TrackedChange {
            id: "c".into(),
            position,
            text: text.into(),
            deletion,
            user_id: None,
            timestamp: None,
            hue: 30,
        }
    }

    #[test]
    fn a_suggestion_is_quoted_in_its_sentence() {
        let text = "We show that the quick fox jumps.";
        let (sentence, marked) = quoted(text, &change(17, "quick ", false));
        assert_eq!(sentence, "We show that the quick fox jumps.");
        assert_eq!(&sentence[marked], "quick ");
        // The change's trailing space still parts it from what follows.
        let (sentence, _) = quoted("Suggested % away", &change(0, "Suggested ", false));
        assert_eq!(sentence, "Suggested % away");
        // A deletion's text stands at its point, between the words around it.
        let (sentence, marked) = quoted("We show the fox.", &change(8, "that ", true));
        assert_eq!(&sentence[marked.clone()], "that ");
        assert_eq!(sentence, "We show that the fox.");
    }

    #[test]
    fn long_context_is_cut_at_words_with_an_ellipsis() {
        let before = "word ".repeat(30);
        let text = format!("{before}CHANGE and then {}", "more ".repeat(30));
        let at = before.encode_utf16().count() as i64;
        let (sentence, marked) = quoted(&text, &change(at, "CHANGE", false));
        assert!(
            sentence.starts_with('…') && sentence.ends_with('…'),
            "{sentence}"
        );
        assert_eq!(&sentence[marked], "CHANGE");
        assert!(!sentence.contains("  "));
    }

    #[test]
    fn suggestions_fall_under_the_heading_before_them_or_the_abstract() {
        let text = "\\begin{abstract}Short.\\end{abstract}\n\\section{Method}\nWe do it.";
        let sections = sections_of(text);
        assert_eq!(section_at(&sections, 17), "Abstract");
        let method = text.find("We do").unwrap() as i64;
        assert_eq!(section_at(&sections, method), "Method");
        assert_eq!(
            section_at(&sections_of("Plain text."), 3),
            "Before the first section"
        );
    }

    #[test]
    fn headings_are_found_at_their_utf16_positions() {
        // "🔵" is two UTF-16 units and four bytes, "é" one unit and two.
        let text = "🔵\\section{One}é\\begin{abstract}ab\\end{abstract}\\section*{Two}";
        let sections = sections_of(text);
        let starts: Vec<_> = sections
            .iter()
            .map(|(start, end, title)| (*start, *end, title.as_str()))
            .collect();
        // \section{One} is 13 units, so "é" is at 15 and \begin at 16;
        // \begin{abstract}ab is 18 units, so \end is at 34 and is 14 long.
        assert_eq!(
            starts,
            vec![
                (2, None, "One"),
                (16, Some(34), "Abstract"),
                (48, None, "Two")
            ]
        );
    }
}
