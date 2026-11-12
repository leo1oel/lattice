//! Hover cards for citation keys and `\ref` labels, drawn as the Tauri app
//! draws them (`src/editor/latex/latex-hover-cards.ts`, the
//! `.citation-hover-card` and `.reference-hover-card` rules in
//! `src/styles/editor-workspace.css` and `surfaces.css`):
//!
//! - a citation card: the key as a quiet chip, the entry set as a reference
//!   list sets it (the title in the reading face at the title size, the
//!   authors, the venue and year in italics), its source as a badge, then
//!   its actions on a hairline: Go to entry (the title runs it too) and
//!   Copy key, which says "Copied" for a moment;
//! - a reference card: what the label names and the label, its title, its
//!   source snippet and the file it is in; the title opens it there.
//!
//! Both stand on the popover surface: the panel radius, the lifted surface,
//! the popover elevation. The Tauri app frosts them (97% of the surface over
//! a 14px backdrop blur); GPUI has no backdrop filter, and the 3% of page
//! left unblurred reads as ghost text, so the surface is solid (the port
//! plan's substitute for `backdrop-filter`).
//!
//! Not yet: the paper library's facts (Crossref health, Open paper), the
//! uses in this paper, "Why cited", and figure and equation previews. They
//! read the library, the compiled build and KaTeX, which later slices bring.

use std::time::{Duration, Instant};

use gpui::{
    App, ClipboardItem, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px, relative,
};
use language::BufferSnapshot;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Badge, Button},
    fonts::Fonts,
};

use crate::{
    ProjectIndex,
    hover::{HoverCardContext, HoverProvider, HoverTarget},
    index::{Citation, Reference},
    latex::syntax,
};

/// How long Copy key says "Copied".
const COPIED_FOR: Duration = Duration::from_millis(1600);

/// The popover surface every card stands on.
pub(crate) fn card_surface(cx: &App) -> gpui::Div {
    let palette = cx.palette();
    div()
        .flex()
        .flex_col()
        .rounded(px(10.))
        .bg(palette.raised)
        .shadow(Elevation::Popover.shadows(palette))
        .text_color(palette.text)
}

/// The reading face: Timeless Serif Text when this build embeds Timeless,
/// the interface sans otherwise (`--reading-font`).
fn reading_font(cx: &App) -> (SharedString, gpui::FontFallbacks) {
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
        format!("{names} +{more}")
    } else if others {
        format!("{names} et al.")
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

/// CSS `text-transform: capitalize`: each word's first letter in capitals.
fn capitalize(text: &str) -> String {
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
        let (reading, reading_fallbacks) = reading_font(cx);
        let byline = byline_authors(&citation.authors);
        // No-break spaces keep the year with the venue's last word.
        let publication = [citation.venue.as_str(), citation.year.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(",\u{a0}");
        let source = source_label(&citation);
        let editor_font = cx.lattice().fonts.editor.clone();
        let goto_title = goto.clone();
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
            .on_click(goto_title)
            .child(heading);
        title_style.text_style().font_fallbacks = Some(reading_fallbacks.clone());
        card_surface(cx)
            .w(px(360.).min(self.context.max_width))
            .pt(px(12.))
            .px(px(16.))
            .pb(px(8.))
            .text_role(TextRole::Body, cx)
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
            .when_some(source, |card, source| {
                card.child(
                    div()
                        .max_w_full()
                        .mt(px(8.))
                        .flex()
                        .flex_wrap()
                        .gap(px(4.))
                        .child(Badge::new(source)),
                )
            })
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
                    .child(
                        Button::new("citation-card-goto", "Go to entry")
                            .ghost()
                            .compact()
                            .on_click(goto),
                    )
                    .child(
                        Button::new(
                            "citation-card-copy",
                            if is_copied { "Copied" } else { "Copy key" },
                        )
                        .ghost()
                        .compact()
                        .on_click(copy),
                    ),
            )
    }
}

/// A label's card.
#[derive(IntoElement)]
pub struct ReferenceCard {
    pub reference: Reference,
    pub context: HoverCardContext,
}

impl RenderOnce for ReferenceCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let reference = self.reference;
        let editor_font = cx.lattice().fonts.editor.clone();
        let heading = if reference.title.is_empty() {
            reference.label.clone()
        } else {
            reference.title.clone()
        };
        let open = {
            let context = self.context.clone();
            let (path, line) = (reference.path.clone(), reference.line);
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                context.open_location(path.clone(), line, cx)
            }
        };
        card_surface(cx)
            .w(px(360.).min(self.context.max_width))
            .pt(px(10.))
            .px(px(12.))
            .pb(px(11.))
            .text_role(TextRole::Body, cx)
            .child(
                div()
                    .mb(px(5.))
                    .text_color(palette.accent)
                    .font_family(editor_font.clone())
                    .text_size(lattice_ui::tokens::TEXT_MICRO)
                    .child(capitalize(&format!(
                        "{} {}",
                        reference.kind,
                        reference.label
                    ))),
            )
            .child(
                div()
                    .id("reference-card-title")
                    .text_size(lattice_ui::tokens::TEXT_CAPTION)
                    .font_weight(FontWeight(650.))
                    .line_height(relative(1.35))
                    .cursor_pointer()
                    .hover(|style| style.underline())
                    .on_click(open)
                    .child(heading),
            )
            .when(!reference.snippet.is_empty(), |card| {
                card.child(
                    div()
                        .mt(px(7.))
                        .max_h(px(132.))
                        .overflow_hidden()
                        .text_color(palette.text_secondary)
                        .font_family(editor_font)
                        .text_size(lattice_ui::tokens::TEXT_MICRO)
                        .line_height(relative(1.45))
                        .child(reference.snippet.clone()),
                )
            })
            .child(
                div()
                    .mt(px(6.))
                    .text_color(palette.text_secondary)
                    .text_size(lattice_ui::tokens::TEXT_MICRO)
                    .child(reference.path.clone()),
            )
    }
}

/// The citation card for the key under the pointer.
pub struct CitationCards {
    pub index: WeakEntity<ProjectIndex>,
}

impl HoverProvider for CitationCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget> {
        let (window, start) = around(text, offset);
        let target = syntax::citation_target(&window, offset - start)?;
        let index = self.index.upgrade()?;
        let citation = index.read(cx).citation(&target.key)?.clone();
        let weak = self.index.clone();
        Some(HoverTarget {
            range: target.range.start + start..target.range.end + start,
            id: "citation",
            card: std::rc::Rc::new(move |context, _, _| {
                CitationCard {
                    citation: citation.clone(),
                    context: context.clone(),
                    index: weak.clone(),
                }
                .into_any_element()
            }),
        })
    }
}

/// The reference card for the label under the pointer.
pub struct ReferenceCards {
    pub index: WeakEntity<ProjectIndex>,
}

impl HoverProvider for ReferenceCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget> {
        let (window, start) = around(text, offset);
        let target = syntax::reference_target(&window, offset - start)?;
        let index = self.index.upgrade()?;
        let reference = index.read(cx).reference(&target.key)?.clone();
        Some(HoverTarget {
            range: target.range.start + start..target.range.end + start,
            id: "reference",
            card: std::rc::Rc::new(move |context, _, _| {
                ReferenceCard {
                    reference: reference.clone(),
                    context: context.clone(),
                }
                .into_any_element()
            }),
        })
    }
}

/// The text within 800 bytes of `offset` each way (what `keyAt` scans),
/// and where it starts.
fn around(text: &BufferSnapshot, offset: usize) -> (String, usize) {
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
