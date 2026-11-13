//! The welcome screen's desk of recent projects (`src/project/welcome-desk.tsx`,
//! `.welcome-desk*` in `src/styles/dialogs.css`): up to three projects, one
//! for each of ⌘1 to ⌘3, each a card on the lift (aspect 1.3, 4px corners)
//! with its name in the title serif under it and when it last changed or
//! opened. The cards keep a third of the width however many there are, so
//! fewer than three shrink the desk around them. A card rises 2px onto the
//! floating shadow under the pointer, on the moderate tier.
//!
//! A project a build has made a PDF of shows that PDF's first page, paper
//! coloured in both appearances with its top (the title, the authors, the
//! abstract) in view, the venue it typeset on a badge, and when it last
//! changed (`crate::first_pages`); one without shows the page glyph on the
//! lift. Until the pages are read the cards' sheets stay clear, and a page
//! fades in when it lands, rather than a blank card flashing first.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, Motion, TextRole, TextRoleStyle as _,
    interaction::{fade, use_interaction},
    parity,
    tokens::FONT_WEIGHT_MEDIUM,
};

use crate::{first_pages::ShownPage, recents::RecentProject};

/// The desk holds three pages, one for each of ⌘1 to ⌘3.
pub const DESK_SIZE: usize = 3;
const GAP: f32 = 16.;

/// "yesterday", "3 days ago", "last month": how long before `now` (ms) a
/// moment was, as `Intl.RelativeTimeFormat` says it in English with
/// `numeric: "auto"`.
pub fn age(then: u64, now: u64) -> String {
    let seconds = now.saturating_sub(then) as f64 / 1000.;
    if seconds < 60. {
        return "just now".into();
    }
    let days = seconds / 86_400.;
    let (value, unit) = if seconds < 3600. {
        ((seconds / 60.).round(), "minute")
    } else if days < 1. {
        ((seconds / 3600.).round(), "hour")
    } else if days < 7. {
        (days.round(), "day")
    } else if days < 30. {
        ((days / 7.).round(), "week")
    } else if days < 365. {
        ((days / 30.).round(), "month")
    } else {
        ((days / 365.).round(), "year")
    };
    let value = value as u64;
    match (value, unit) {
        (0, "day") => "today".into(),
        (1, "day") => "yesterday".into(),
        (0, unit) => format!("this {unit}"),
        (1, "minute" | "hour") => format!("1 {unit} ago"),
        (1, unit) => format!("last {unit}"),
        (value, unit) => format!("{value} {unit}s ago"),
    }
}

/// Where a project lives, as a writer reads it: its parent folder, the home
/// folder written as ~.
pub fn parent_folder_label(path: &Path) -> String {
    let parent = path
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .filter(|parent| !parent.is_empty())
        .unwrap_or_else(|| "/".into());
    let mut parts = parent.splitn(4, '/');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(""), Some("Users" | "home"), Some(_user), rest) => match rest {
            Some(rest) => format!("~/{rest}"),
            None => "~".into(),
        },
        _ => parent,
    }
}

/// What a card says under its name: when the paper last changed, else
/// when it was last opened, else where it lives.
fn when(project: &RecentProject, page: Option<&ShownPage>, now: u64) -> String {
    match (page.and_then(|page| page.edited_at), project.opened_at) {
        (Some(edited), _) => format!("Edited {}", age(edited, now)),
        (None, Some(opened)) => format!("Opened {}", age(opened, now)),
        (None, None) => parent_folder_label(&project.path),
    }
}

/// The desk: its title and up to three cards; `open` runs with the card's
/// project.
pub fn desk(
    projects: &[RecentProject],
    pages: Option<&HashMap<PathBuf, ShownPage>>,
    width: gpui::Pixels,
    now: u64,
    disabled: bool,
    open: impl Fn(&Path, &mut Window, &mut App) + Clone + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let count = projects.len().min(DESK_SIZE).max(1) as f32;
    // A third of the width per card, however many there are.
    let frame = (width + px(GAP)) * (count / DESK_SIZE as f32) - px(GAP);
    let card_width = (frame - px(GAP) * (count - 1.)) / count;
    let cards: Vec<AnyElement> = projects
        .iter()
        .take(DESK_SIZE)
        .enumerate()
        .map(|(ix, project)| {
            let id = ElementId::Name(format!("welcome-desk-{ix}").into());
            let (interaction, _) = use_interaction(id.clone(), window, cx);
            let lift = fade(
                ElementId::Name(format!("welcome-desk-lift-{ix}").into()),
                interaction.pointer.hovered && !disabled,
                Motion::Moderate,
                window,
                cx,
            );
            let name = project.name.clone();
            let page = pages.and_then(|pages| pages.get(&project.path)).cloned();
            let when = if pages.is_some() {
                when(project, page.as_ref(), now)
            } else {
                String::new()
            };
            let landed = fade(
                ElementId::Name(format!("welcome-desk-page-{ix}").into()),
                pages.is_some(),
                Motion::Moderate,
                window,
                cx,
            );
            // A page rests on the PDF's own shadow; the glyph card on the
            // lift's. Either takes the floating shadow under the pointer.
            let mut shadows = if page.is_some() {
                let mut page_shadow = vec![lattice_ui::elevation::ring(palette.ring)];
                page_shadow.extend(lattice_ui::elevation::pdf_page(&palette));
                page_shadow
            } else {
                Elevation::Raised.shadows(&palette)
            };
            if lift > 0.5 {
                shadows = Elevation::Floating.shadows(&palette);
            }
            let path = project.path.clone();
            let open = open.clone();
            let shortcut = format!("{}{}", crate::shell::commands::MOD_LABEL, ix + 1);
            let region = format!("welcome/card/{ix}");
            div()
                .id(id)
                .relative()
                .children(parity::probe(region.clone()))
                .w(card_width)
                .flex()
                .flex_col()
                .cursor_pointer()
                .text_color(palette.text_secondary)
                .tooltip(move |_, cx| {
                    lattice_ui::components::LatticeTooltip::view(
                        format!("{} ({shortcut})", path.display()),
                        None,
                        cx,
                    )
                })
                .on_click({
                    let path = project.path.clone();
                    move |_, window, cx| {
                        if !disabled {
                            open(&path, window, cx)
                        }
                    }
                })
                .child(
                    div()
                        .relative()
                        .top(px(-2. * lift))
                        .w_full()
                        .h(card_width / 1.3)
                        .mb(px(10.))
                        .rounded(px(4.))
                        .overflow_hidden()
                        .opacity(landed)
                        .bg(if page.is_some() {
                            palette.pdf_page
                        } else {
                            palette.raised
                        })
                        .shadow(shadows)
                        .flex()
                        .items_center()
                        .justify_center()
                        .when_some(page.clone(), |sheet, page| {
                            sheet
                                .items_start()
                                .child(
                                    gpui::img(gpui::ImageSource::Render(page.image.clone()))
                                        .w_full(),
                                )
                                .children(page.venue.clone().map(|venue| {
                                    div()
                                        .absolute()
                                        .left(px(8.))
                                        .bottom(px(8.))
                                        .rounded(px(4.))
                                        .shadow(Elevation::Raised.shadows(&palette))
                                        .child(lattice_ui::components::Badge::new(venue).compact())
                                }))
                        })
                        .when(page.is_none() && pages.is_some(), |sheet| {
                            sheet.child(Icon::FILE_TEXT.element(px(20.), palette.text_secondary))
                        }),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_role(TextRole::Title, cx)
                        .text_color(palette.text)
                        .relative()
                        .children(parity::text_probe(region.clone(), 0, name.clone()))
                        .child(name),
                )
                .child(
                    div()
                        .min_w_0()
                        .min_h(px(16.))
                        .truncate()
                        .text_role(TextRole::Caption, cx)
                        .relative()
                        .children(parity::text_probe(region, 1, when.clone()))
                        .child(when),
                )
                .into_any_element()
        })
        .collect();
    div()
        .w(frame)
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .relative()
                .children(parity::probe("welcome/recents-title"))
                .children(parity::text_probe(
                    "welcome/recents-title",
                    0,
                    "Recent projects",
                ))
                .px(px(2.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child("Recent projects"),
        )
        .child(
            div()
                .relative()
                .children(parity::probe("welcome/desk"))
                .flex()
                .gap(px(GAP))
                .children(cards),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400_000;

    #[test]
    fn ages_read_as_the_app_says_them() {
        let now = 100 * 365 * DAY;
        assert_eq!(age(now - 10_000, now), "just now");
        assert_eq!(age(now - 5 * 60_000, now), "5 minutes ago");
        assert_eq!(age(now - DAY / 2, now), "12 hours ago");
        assert_eq!(age(now - DAY, now), "yesterday");
        assert_eq!(age(now - 3 * DAY, now), "3 days ago");
        assert_eq!(age(now - 8 * DAY, now), "last week");
        assert_eq!(age(now - 40 * DAY, now), "last month");
        assert_eq!(age(now - 800 * DAY, now), "2 years ago");
    }

    #[test]
    fn a_folder_under_home_reads_from_the_tilde() {
        assert_eq!(
            parent_folder_label(Path::new("/Users/writer/Documents/reading-notes")),
            "~/Documents"
        );
        assert_eq!(parent_folder_label(Path::new("/Users/writer/notes")), "~");
        assert_eq!(
            parent_folder_label(Path::new("/srv/papers/a")),
            "/srv/papers"
        );
    }
}
