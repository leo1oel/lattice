//! The records a lookup could not tell apart, as one list, and how a record
//! was found and matched (`citation-candidates.tsx`, `.bib-candidate*` and
//! `.bib-citation-evidence` in `app-shell.css`): each reads as it would be
//! cited (the serif title, people's names, the italic venue), with whether
//! it is the published version or the preprint and how it was matched. Add
//! reference and Add papers' title rows both show it; the host's own button
//! takes the chosen one.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::{bib_document::bib_text_to_plain, models::ResolvedCitation};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Palette, TextRole, TextRoleStyle as _,
    interaction::{fade, mix, track_pointer, use_interaction},
    motion::Motion,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR},
};
use serde_json::Value;

/// A record with no venue, or an arXiv one, is the preprint; anything else
/// was published.
fn is_preprint(venue: &str) -> bool {
    let venue = venue.to_ascii_lowercase();
    venue.is_empty() || venue.contains("arxiv") || venue.contains("preprint")
}

/// The venue a record names first (`recordVenue`).
fn record_venue(record: &ResolvedCitation) -> String {
    bib_text_to_plain(
        [&record.journal, &record.booktitle, &record.publisher]
            .into_iter()
            .find(|venue| !venue.is_empty())
            .map_or("", |venue| venue.as_str()),
    )
}

/// The people a record names, joined as the interface language joins a
/// list (`readableAuthors`).
pub fn readable_authors(field: &str) -> String {
    let names: Vec<String> = lattice_core::bib_document::author_names(field.trim())
        .iter()
        .map(|name| bib_text_to_plain(name))
        .filter(|name| !name.is_empty())
        .collect();
    lattice_i18n::join_conjunction(&names)
}

/// What a lookup's evidence says, in the order the line reads it: where the
/// record came from (with its link, when it is a web address), how its
/// title matched, and how its authors did.
struct Evidence {
    source: Option<(String, Option<String>)>,
    title: Option<&'static str>,
    authors: &'static str,
}

fn evidence_of(evidence: Option<&Value>, authors_present: bool) -> Evidence {
    let field = |name: &str| {
        evidence
            .and_then(|evidence| evidence.get(name))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let link = field("url")
        .filter(|url| {
            let url = url.to_ascii_lowercase();
            url.starts_with("http://") || url.starts_with("https://")
        })
        .map(str::to_string);
    Evidence {
        source: field("source").map(|source| (source.to_string(), link)),
        title: field("title_match").map(|matched| {
            if matched == "exact" {
                t!("Exact title match")
            } else {
                t!("Similar title match")
            }
        }),
        authors: match field("author_match") {
            Some("matched") => t!("Compatible author names"),
            Some("partial") => t!("Partial author information"),
            _ if authors_present => t!("Authors unchecked"),
            _ => t!("Authors unavailable and unchecked"),
        },
    }
}

/// How a record was found and matched, in one quiet line, its parts set
/// apart by spacing (`CitationEvidence`); `ink` is its type's colour.
pub fn evidence_line(
    id: SharedString,
    evidence: Option<&Value>,
    authors_present: bool,
    ink: Hsla,
    window: &mut Window,
    cx: &mut gpui::App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let said = evidence_of(evidence, authors_present);
    let mut parts: Vec<AnyElement> = Vec::new();
    if let Some((source, link)) = said.source {
        parts.push(match link {
            Some(link) => {
                let (interaction, pointer) = use_interaction(id.clone(), window, cx);
                let hover = fade(
                    SharedString::from(format!("{id}-fade")),
                    interaction.pointer.hovered,
                    Motion::Fast,
                    window,
                    cx,
                );
                track_pointer(div().id(id), pointer)
                    .cursor_pointer()
                    .text_color(mix(ink, palette.text, hover))
                    .text_decoration_1()
                    .text_decoration_color(mix(palette.line_strong, palette.text, hover))
                    .on_click(move |_, _, cx| cx.open_url(&link))
                    .child(source)
                    .into_any_element()
            }
            None => div().child(source).into_any_element(),
        });
    }
    if let Some(title) = said.title {
        parts.push(div().child(title).into_any_element());
    }
    parts.push(div().child(said.authors).into_any_element());
    let mut line = div().flex().flex_wrap().items_center().text_color(ink);
    for (at, part) in parts.into_iter().enumerate() {
        line = line
            .when(at > 0, |line| line.child(div().px(px(6.)).child("\u{a0}")))
            .child(part);
    }
    line.into_any_element()
}

/// Whether the published version or the preprint, as a small chip.
fn kind_chip(preprint: bool, palette: &Palette, cx: &gpui::App) -> AnyElement {
    div()
        .flex_none()
        .h(px(18.))
        .px(px(6.))
        .flex()
        .items_center()
        .rounded(px(4.))
        .font_weight(FONT_WEIGHT_MEDIUM)
        .whitespace_nowrap()
        .map(|chip| {
            if preprint {
                chip.text_color(palette.text_secondary)
                    .border_1()
                    .border_color(palette.line)
            } else {
                chip.text_color(mix(palette.success, palette.text, 0.2))
                    .bg(palette.success_soft)
            }
        })
        .text_role(TextRole::Micro, cx)
        .child(if preprint {
            t!("Preprint")
        } else {
            t!("Published")
        })
        .into_any_element()
}

/// The list of `candidates`, `chosen_at` the chosen one; `pick` hears a
/// click (`false`) or a double click (`true`, to use it at once).
pub fn candidate_list(
    id: &'static str,
    candidates: &[ResolvedCitation],
    chosen_at: usize,
    focused: bool,
    pick: impl Fn(usize, bool, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let pick = Rc::new(pick);
    let palette = cx.palette().clone();
    let mut list = div()
        .id(id)
        .flex()
        .flex_col()
        .rounded(px(10.))
        .border_1()
        .border_color(palette.line)
        .overflow_hidden()
        .bg(palette.raised);
    for (at, candidate) in candidates.iter().enumerate() {
        let chosen = at == chosen_at;
        let venue = record_venue(candidate);
        let authors = readable_authors(&candidate.author);
        let byline = lattice_i18n::join_phrases(&[
            if authors.is_empty() {
                t!("Authors unavailable").to_string()
            } else {
                authors
            },
            if candidate.year.trim().is_empty() {
                t!("Year unavailable").to_string()
            } else {
                candidate.year.trim().to_string()
            },
        ]);
        let row_id = SharedString::from(format!("{id}-{at}"));
        let (interaction, pointer) = use_interaction(row_id.clone(), window, cx);
        let radio = div()
            .flex_none()
            .mt(px(4.))
            .size(px(14.))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .border_1()
            .border_color(if chosen {
                palette.accent
            } else {
                palette.line_strong
            })
            .when(chosen && focused, |radio| {
                radio.shadow(lattice_ui::components::focus_ring(&palette, palette.raised))
            })
            .when(chosen, |radio| {
                radio.child(div().size(px(6.)).rounded_full().bg(palette.accent))
            });
        let evidence = evidence_line(
            SharedString::from(format!("{id}-source-{at}")),
            candidate.evidence.as_ref(),
            !candidate.author.is_empty(),
            palette.text_secondary,
            window,
            cx,
        );
        list = list.child(
            track_pointer(div().id(row_id), pointer)
                .relative()
                .flex()
                .items_start()
                .gap(px(10.))
                .pt(px(12.))
                .pb(px(12.))
                .pl(px(12.))
                .pr(px(16.))
                .when(at > 0, |row| row.border_t_1().border_color(palette.line))
                .cursor_pointer()
                .map(|row| {
                    if chosen {
                        row.bg(palette.accent.opacity(0.06)).child(
                            div()
                                .absolute()
                                .top_0()
                                .bottom_0()
                                .left_0()
                                .w(px(2.))
                                .bg(palette.accent),
                        )
                    } else {
                        row.bg(mix(
                            Hsla::transparent_black(),
                            palette.hover,
                            interaction.hover,
                        ))
                    }
                })
                .on_click({
                    let pick = pick.clone();
                    move |event: &ClickEvent, window, cx| {
                        pick(at, event.click_count() == 2, window, cx)
                    }
                })
                .child(radio)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_role(TextRole::Typeset, cx)
                                .font_weight(FONT_WEIGHT_REGULAR)
                                .text_color(palette.text)
                                .child(bib_text_to_plain(&candidate.title)),
                        )
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(byline),
                        )
                        .child(
                            div()
                                .font_family(cx.lattice().fonts.display.clone())
                                .italic()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(if venue.is_empty() {
                                    t!("Venue unavailable").to_string()
                                } else {
                                    venue.clone()
                                }),
                        )
                        .child(
                            div()
                                .mt(px(4.))
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap_x(px(8.))
                                .gap_y(px(4.))
                                .text_role(TextRole::Micro, cx)
                                .text_color(palette.text_secondary)
                                .child(kind_chip(is_preprint(&venue), &palette, cx))
                                .child(evidence),
                        ),
                ),
        );
    }
    list.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_arxiv_or_unnamed_venue_is_the_preprint() {
        assert!(is_preprint(""));
        assert!(is_preprint("arXiv preprint arXiv:1706.03762"));
        assert!(is_preprint("bioRxiv Preprint"));
        assert!(!is_preprint(
            "Advances in Neural Information Processing Systems"
        ));
    }

    #[test]
    fn the_evidence_names_its_source_link_and_matches() {
        let said = evidence_of(
            Some(&json!({
                "source": "Crossref",
                "url": "https://doi.org/10.1/x",
                "title_match": "exact",
                "author_match": "matched"
            })),
            true,
        );
        assert_eq!(
            said.source,
            Some(("Crossref".into(), Some("https://doi.org/10.1/x".into())))
        );
        assert_eq!(said.title, Some("Exact title match"));
        assert_eq!(said.authors, "Compatible author names");
        // A link that is no web address is named, not followed.
        let said = evidence_of(Some(&json!({"source": "DBLP", "url": "file:///x"})), false);
        assert_eq!(said.source, Some(("DBLP".into(), None)));
        assert_eq!(said.title, None);
        assert_eq!(said.authors, "Authors unavailable and unchecked");
    }
}
