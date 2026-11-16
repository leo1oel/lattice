//! Hover cards for citation keys and `\ref` labels, drawn as the Tauri app
//! draws them (`src/editor/latex/latex-hover-cards.ts`, the
//! `.citation-hover-card` and `.reference-hover-card` rules in
//! `src/styles/editor-workspace.css` and `surfaces.css`):
//!
//! - a citation card: the key as a quiet chip, the entry set as a reference
//!   list sets it (the title in the reading face at the title size, the
//!   authors, the venue and year in italics), its source as a badge, then
//!   what is known about it as badges (Crossref's word on the paper, its
//!   arXiv id or DOI), its uses in the manuscript ("Cited N× here",
//!   `card_uses.rs`), then its actions on a hairline: Open paper (the lead,
//!   when the library can open it; the title runs it, else Go to entry),
//!   "Why cited", Go to entry and Copy key, which says "Copied" for a
//!   moment;
//! - a reference card ([`super::reference_card`]).
//!
//! Both stand on the popover surface: the panel radius, the popover
//! elevation, and the Tauri app's frosted surface (`surfaces.css`): 97% of
//! the lifted surface over the page blurred by 14px (`backdrop_blur`, CSS's
//! `backdrop-filter: blur(14px)`). Where the renderer cannot read the page
//! under a card, the blur's fallback fills the card with the surface,
//! opaque, since 3% of page left unblurred reads as ghost text. That is
//! every card while the window holds a native surface anywhere (a webview
//! island such as the Agent panel or a board, sheet or deck), even one not
//! under the card: the cards are drawn deferred, and GPUI then draws all
//! deferred content on its own surface above the native views, which cannot
//! read the window's page.
//!
//! The library's facts, the uses and the actions that leave the card come
//! from the host through the editor's [`CitationSlot`]; without one the
//! card shows the bibliography's facts, Go to entry and Copy key.

use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    App, ClipboardItem, ElementId, FocusHandle, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use language::BufferSnapshot;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Badge, BadgeTone, Button},
    fonts::Fonts,
};

use super::{
    card_uses,
    citation_library::{CitationLibrary, CitationSlot, Health},
};
use crate::{
    ProjectIndex,
    hover::{HoverCardContext, HoverProvider, HoverTarget, NextCardAction, PreviousCardAction},
    index::Citation,
    latex::syntax,
};

/// How long Copy key says "Copied".
const COPIED_FOR: Duration = Duration::from_millis(1600);

/// The popover surface every card stands on: the Tauri app's frosted
/// popover, `color-mix(in srgb, var(--surface-elevated) 97%, transparent)`
/// over `backdrop-filter: blur(14px)`.
pub fn card_surface(cx: &App) -> gpui::Div {
    let palette = cx.palette();
    div()
        .flex()
        .flex_col()
        .rounded(px(10.))
        .backdrop_blur(px(14.), palette.raised.alpha(1.))
        .bg(palette.raised.opacity(0.97))
        .shadow(Elevation::Popover.shadows(palette))
        .text_color(palette.text)
}

/// The reading face: Timeless Serif Text when this build embeds Timeless,
/// the interface sans otherwise (`--reading-font`).
pub fn reading_font(cx: &App) -> (SharedString, gpui::FontFallbacks) {
    let fonts = &cx.lattice().fonts;
    if fonts.private {
        (fonts.display.clone(), Fonts::display_fallbacks())
    } else {
        (fonts.ui.clone(), Fonts::ui_fallbacks())
    }
}

/// A BibTeX author list as people, braces kept: "Vaswani, Ashish and
/// Shazeer, Noam" reads "Ashish Vaswani", "Noam Shazeer"; "{Google Brain}"
/// is one name; a trailing "and others" is a flag.
fn parse_authors(authors: &str) -> (Vec<String>, bool) {
    let unbrace = |value: &str| {
        value
            .replace(['{', '}'], "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    // Only an "and" outside braces separates two names.
    static TOKENS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)[{}]|\s+and\s+").expect("the author separator pattern compiles")
    });
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0usize, 0usize);
    for token in TOKENS.find_iter(authors) {
        match token.as_str() {
            "{" => depth += 1,
            "}" => depth = depth.saturating_sub(1),
            _ if depth == 0 => {
                parts.push(authors[start..token.start()].to_string());
                start = token.end();
            }
            _ => {}
        }
    }
    parts.push(authors[start..].to_string());
    let mut parts: Vec<String> = parts
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !unbrace(part).is_empty())
        .collect();
    let others = parts
        .last()
        .is_some_and(|last| unbrace(last).eq_ignore_ascii_case("others"));
    if others {
        parts.pop();
    }
    let people = parts
        .iter()
        .map(|raw| {
            let part = unbrace(raw);
            let one_group = raw.starts_with('{') && raw.ends_with('}') && {
                let mut depth = 0;
                raw.char_indices().all(|(at, c)| {
                    match c {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        _ => {}
                    }
                    depth > 0 || at == raw.len() - 1
                })
            };
            if one_group {
                return part;
            }
            let pieces: Vec<&str> = part
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .collect();
            match pieces.as_slice() {
                [last, .., first] => format!("{first} {last}"),
                _ => part,
            }
        })
        .collect();
    (people, others)
}

/// The first three names in full, then how many more: "Ashish Vaswani, Noam
/// Shazeer, Niki Parmar +5" (`paperBylineAuthors`). `None` without authors.
pub fn byline_authors(authors: &str) -> Option<String> {
    let (people, others) = parse_authors(authors);
    if people.is_empty() {
        return None;
    }
    let names = people
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = people.len().saturating_sub(3);
    Some(if more > 0 {
        t!("{names} +{more}", names = names, more = more)
    } else if others {
        t!("{names} et al.", names = names)
    } else {
        names
    })
}

/// Where the entry came from: its arXiv id, else its DOI, else its URL's
/// site (`paperSourceLabel`).
pub fn source_label(citation: &Citation) -> Option<String> {
    if let Some(id) = citation
        .arxiv_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("arXiv {id}"));
    }
    if let Some(doi) = citation.doi.as_deref().filter(|doi| !doi.is_empty()) {
        return Some(format!("DOI {doi}"));
    }
    let url = citation.url.as_deref()?;
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .trim_start_matches("www.");
    (!host.is_empty()).then(|| host.to_string())
}

/// The reference kind as cards and completions show it (`referenceKindLabel`);
/// the kind itself stays an identifier, and one this list lacks reads as is.
pub(crate) fn reference_kind_label(kind: &str) -> &str {
    match kind {
        "figure" => t!("figure"),
        "table" => t!("table"),
        "equation" => t!("equation"),
        "section" => t!("section"),
        "reference" => t!("reference"),
        other => other,
    }
}

/// CSS `text-transform: capitalize`: each word's first letter in capitals.
pub(super) fn capitalize(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A citation key's card.
#[derive(IntoElement)]
pub struct CitationCard {
    pub citation: Citation,
    pub context: HoverCardContext,
    pub index: WeakEntity<ProjectIndex>,
    /// The key's bytes in the buffer: the use the card is for.
    pub range: std::ops::Range<usize>,
    pub library: Option<Rc<dyn CitationLibrary>>,
}

impl RenderOnce for CitationCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let citation = self.citation;
        let key = citation.key.clone();
        let copied = window.use_keyed_state(
            ElementId::Name(format!("citation-card-copied-{key}").into()),
            cx,
            |_, _| None::<Instant>,
        );
        let is_copied = copied.read(cx).is_some_and(|at| at.elapsed() < COPIED_FOR);
        // Opened from the keyboard (⌥⌘K), the actions take focus: Open
        // paper, Why cited, Go to entry, Copy key, each its own handle.
        let keyboard = self.context.keyboard.clone();
        let action_focus = keyboard.as_ref().map(|_| {
            window
                .use_keyed_state(
                    ElementId::Name(format!("citation-card-focus-{key}").into()),
                    cx,
                    |_, cx| [(); 4].map(|_| cx.focus_handle()),
                )
                .read(cx)
                .clone()
        });
        let goto = {
            let context = self.context.clone();
            let index = self.index.clone();
            let key = key.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                let entry = index
                    .upgrade()
                    .and_then(|index| index.read(cx).citation_entry(&key));
                if let Some((path, line)) = entry {
                    context.open_location(path, line, cx);
                }
            }
        };
        let heading = if citation.title.is_empty() {
            citation.key.clone()
        } else {
            citation.title.clone()
        };
        let library = self.library.clone();
        let facts = library
            .as_ref()
            .map(|library| library.facts(&key, cx))
            .unwrap_or_default();
        let uses = library
            .as_ref()
            .map(|library| library.uses(&key, &self.context.text, cx))
            .unwrap_or_default();
        let page = library
            .as_ref()
            .and_then(|library| card_uses::hovered_page(&uses, &library.path(), &self.range));
        let open = library.clone().filter(|_| facts.can_open).map(|library| {
            let (context, key) = (self.context.clone(), key.clone());
            Rc::new(
                move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
                    context.close(cx);
                    library.open_paper(&key, page, window, cx);
                },
            )
        });
        let why = library
            .clone()
            .filter(|library| library.files_reasons(cx))
            .map(|library| {
                let (context, key, range) = (self.context.clone(), key.clone(), self.range.clone());
                move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
                    context.close(cx);
                    library.why_cited(&key, range.clone(), window, cx);
                }
            });
        let uses = library.as_ref().and_then(|library| {
            card_uses::uses_section(
                &key,
                uses,
                self.range.clone(),
                library,
                facts.can_open,
                &self.context,
                window,
                cx,
            )
        });
        let health = facts.health.clone().map(|(health, title)| {
            let badge = match health {
                Health::Verified => Badge::new(t!("Verified by Crossref"))
                    .tone(BadgeTone::Success)
                    .icon(Icon::CHECK),
                Health::Warning(kind) => Badge::new(kind)
                    .tone(BadgeTone::Warning)
                    .icon(Icon::TRIANGLE_ALERT),
            };
            let tip = title.unwrap_or_default();
            div()
                .id("citation-card-health")
                .min_w_0()
                .max_w_full()
                .when(!tip.is_empty(), |fact| fact.tooltip(card_uses::tip(tip)))
                .child(badge.shrinks())
        });
        let (reading, reading_fallbacks) = reading_font(cx);
        let byline = byline_authors(facts.authors.as_deref().unwrap_or(&citation.authors));
        // No-break spaces keep the year with the venue's last word.
        let publication = [citation.venue.as_str(), citation.year.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(",\u{a0}");
        let source = source_label(&citation);
        let editor_font = cx.lattice().fonts.editor.clone();
        // The handles of the actions this card shows, in their order.
        let shown_focus: Vec<FocusHandle> = action_focus
            .iter()
            .flat_map(|[open_focus, why_focus, goto_focus, copy_focus]| {
                [
                    open.is_some().then(|| open_focus.clone()),
                    why.is_some().then(|| why_focus.clone()),
                    Some(goto_focus.clone()),
                    Some(copy_focus.clone()),
                ]
            })
            .flatten()
            .collect();
        // The first action takes focus, not the title, so Return runs the
        // lead action its hint names.
        if let Some(keyboard) = &keyboard
            && let Some(first) = shown_focus.first()
            && keyboard.take_first_focus()
        {
            window.focus(first, cx);
        }
        let walk = shown_focus.clone();
        let focus_of = |slot: usize| action_focus.as_ref().map(|handles| handles[slot].clone());
        let lead_keys = keyboard.is_some().then_some("↩");
        let goto_title = goto.clone();
        let open_title = open.clone();
        let copy = {
            let copied = copied.clone();
            let key = key.clone();
            move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
                cx.write_to_clipboard(ClipboardItem::new_string(key.clone()));
                copied.update(cx, |at, cx| {
                    *at = Some(Instant::now());
                    cx.notify();
                });
                let copied = copied.clone();
                window
                    .spawn(cx, async move |cx| {
                        cx.background_executor().timer(COPIED_FOR).await;
                        copied.update(cx, |_, cx| cx.notify());
                    })
                    .detach();
            }
        };
        let mut title_style = div()
            .id("citation-card-title")
            .self_start()
            .max_w_full()
            .font_family(reading)
            .text_size(lattice_ui::tokens::TEXT_TITLE)
            .line_height(lattice_ui::tokens::LEADING_TITLE)
            .font_weight(FontWeight::NORMAL)
            .text_color(palette.text)
            .line_clamp(4)
            .cursor_pointer()
            .hover(|style| style.underline())
            .on_click(move |event, window, cx| match &open_title {
                Some(open) => open(event, window, cx),
                None => goto_title(event, window, cx),
            })
            .child(heading);
        title_style.text_style().font_fallbacks = Some(reading_fallbacks.clone());
        card_surface(cx)
            .w(px(360.).min(self.context.max_width))
            .pt(px(12.))
            .px(px(16.))
            .pb(px(8.))
            .text_role(TextRole::Body, cx)
            // Tab and ⇧Tab walk the actions, round from the last to the
            // first ([`KEYBOARD_CARD_CONTEXT`]); Return presses the focused
            // one (the element's own activation).
            .when(!walk.is_empty(), |card| {
                let back = walk.clone();
                card.on_action(move |_: &NextCardAction, window, cx| {
                    step_focus(&walk, 1, window, cx);
                })
                .on_action(move |_: &PreviousCardAction, window, cx| {
                    step_focus(&back, -1, window, cx);
                })
            })
            .when(!citation.title.is_empty(), |card| {
                card.child(
                    div()
                        .self_start()
                        .max_w_full()
                        .mb(px(4.))
                        .px(px(6.))
                        .py(px(1.))
                        .rounded(px(4.))
                        .bg(palette.hover)
                        .text_color(palette.text)
                        .font_family(editor_font)
                        .text_size(lattice_ui::tokens::TEXT_MICRO)
                        .line_height(lattice_ui::tokens::LEADING_MICRO)
                        .truncate()
                        .child(citation.key.clone()),
                )
            })
            .child(title_style)
            .when_some(byline, |card, byline| {
                card.child(
                    div()
                        .mt(px(2.))
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .line_clamp(2)
                        .child(byline),
                )
            })
            .when(!publication.is_empty(), |card| {
                let (reading, fallbacks) = reading_font(cx);
                let mut venue = div()
                    .font_family(reading)
                    .text_size(lattice_ui::tokens::TEXT_BODY)
                    .line_height(lattice_ui::tokens::LEADING_SUBTITLE)
                    .italic()
                    .text_color(palette.text_secondary)
                    .line_clamp(2)
                    .child(publication.clone());
                venue.text_style().font_fallbacks = Some(fallbacks);
                card.child(venue)
            })
            .when(source.is_some() || health.is_some(), |card| {
                card.child(
                    div()
                        .max_w_full()
                        .mt(px(8.))
                        .flex()
                        .flex_wrap()
                        .gap(px(4.))
                        .children(health)
                        .children(source.map(|source| {
                            div()
                                .id("citation-card-source")
                                .min_w_0()
                                .max_w_full()
                                .tooltip(card_uses::tip(source.clone()))
                                .child(Badge::new(source).shrinks())
                        })),
                )
            })
            .children(uses)
            .child(
                // Stretched past the card's padding to its 8px inset.
                div()
                    .mt(px(10.))
                    .mx(px(-8.))
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(palette.line)
                    .flex()
                    .flex_wrap()
                    .gap(px(4.))
                    .when_some(open, |bar, open| {
                        bar.child(
                            Button::new("citation-card-open", t!("Open paper"))
                                .tinted()
                                .compact()
                                .when_some(lead_keys, Button::keys)
                                .when_some(focus_of(0), |button, focus| button.track_focus(&focus))
                                .on_click(move |event, window, cx| open(event, window, cx)),
                        )
                    })
                    .when_some(why, |bar, why| {
                        bar.child(
                            Button::new("citation-card-why", t!("Why cited"))
                                .ghost()
                                .compact()
                                .when_some(focus_of(1), |button, focus| button.track_focus(&focus))
                                .on_click(why),
                        )
                    })
                    .child(
                        Button::new("citation-card-goto", t!("Go to entry"))
                            .ghost()
                            .compact()
                            .when_some(focus_of(2), |button, focus| button.track_focus(&focus))
                            .on_click(goto),
                    )
                    .child(
                        Button::new(
                            "citation-card-copy",
                            if is_copied {
                                t!("Copied")
                            } else {
                                t!("Copy key")
                            },
                        )
                        .ghost()
                        .compact()
                        .when_some(focus_of(3), |button, focus| button.track_focus(&focus))
                        .on_click(copy),
                    ),
            )
    }
}

/// Move focus `by` one among `handles`, round from either end; from none
/// of them, to the first.
fn step_focus(handles: &[FocusHandle], by: isize, window: &mut Window, cx: &mut App) {
    let count = handles.len() as isize;
    let next = handles
        .iter()
        .position(|handle| handle.is_focused(window))
        .map_or(0, |at| (at as isize + by).rem_euclid(count));
    window.focus(&handles[next as usize], cx);
}

/// The citation card for the key under the pointer.
pub struct CitationCards {
    pub index: WeakEntity<ProjectIndex>,
    pub library: CitationSlot,
}

impl HoverProvider for CitationCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget> {
        let (window, start) = around(text, offset);
        let target = syntax::citation_target(&window, offset - start)?;
        let index = self.index.upgrade()?;
        let citation = index.read(cx).citation(&target.key)?.clone();
        let library = self.library.borrow().clone();
        // "Why cited" is open on a key: the card stays away meanwhile.
        if library
            .as_ref()
            .is_some_and(|library| library.editing_reason(cx))
        {
            return None;
        }
        let weak = self.index.clone();
        let range = target.range.start + start..target.range.end + start;
        Some(HoverTarget {
            range: range.clone(),
            id: "citation",
            card: std::rc::Rc::new(move |context, _, _| {
                CitationCard {
                    citation: citation.clone(),
                    context: context.clone(),
                    index: weak.clone(),
                    range: range.clone(),
                    library: library.clone(),
                }
                .into_any_element()
            }),
        })
    }
}

/// The text within 800 bytes of `offset` each way (what `keyAt` scans),
/// and where it starts.
pub(super) fn around(text: &BufferSnapshot, offset: usize) -> (String, usize) {
    let start = text.clip_offset(offset.saturating_sub(800), language::Bias::Right);
    let end = text.clip_offset((offset + 800).min(text.len()), language::Bias::Left);
    (text.text_for_range(start..end).collect(), start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bylines_read_as_people_write_their_names() {
        assert_eq!(
            byline_authors("Vaswani, Ashish and Shazeer, Noam").as_deref(),
            Some("Ashish Vaswani, Noam Shazeer")
        );
        assert_eq!(
            byline_authors("A One and B Two and C Three and D Four and E Five").as_deref(),
            Some("A One, B Two, C Three +2")
        );
        assert_eq!(
            byline_authors("{Google Brain} and Doe, Jane and others").as_deref(),
            Some("Google Brain, Jane Doe et al.")
        );
        assert_eq!(
            byline_authors("{Research and Development Institute}").as_deref(),
            Some("Research and Development Institute")
        );
        assert_eq!(byline_authors("").as_deref(), None);
    }

    #[test]
    fn sources_prefer_arxiv_then_doi_then_the_site() {
        let mut citation = Citation {
            url: Some("https://www.example.org/paper".into()),
            ..Citation::default()
        };
        assert_eq!(source_label(&citation).as_deref(), Some("example.org"));
        citation.doi = Some("10.1/x".into());
        assert_eq!(source_label(&citation).as_deref(), Some("DOI 10.1/x"));
        citation.arxiv_id = Some("1706.03762".into());
        assert_eq!(source_label(&citation).as_deref(), Some("arXiv 1706.03762"));
    }

    #[test]
    fn capitalize_matches_css() {
        assert_eq!(capitalize("figure fig:model"), "Figure Fig:model");
    }
}
