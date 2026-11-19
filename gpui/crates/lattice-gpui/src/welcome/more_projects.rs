//! The welcome screen's "More projects" (`WelcomeMoreProjects` in
//! `src/project/welcome-desk.tsx`): under the desk, the next twenty recent
//! projects as a compact list, at most 240px tall (26% of the window, 96px
//! in a window under 760px) and scrolled past that. A row is 32px: the
//! Cloud glyph for an Overleaf project or the folder's, the name, its
//! parent folder (home as ~), an "Overleaf" or "Missing" badge and how long
//! ago it was opened ("4 days ago"); a missing project's glyph, name and folder are dimmed. The
//! app's gliding hover fill lights the row under the pointer, and a press
//! opens it as a desk card does. With more recent projects than the desk
//! and the list hold, "Show all N projects", after the Search glyph in the
//! style of the screen's quieter ways in, opens the recent project finder.

use std::path::{Path, PathBuf};

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    fluid_hover::FluidHover,
    parity,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR},
};

use super::desk::{DESK_SIZE, age, parent_folder_label};
use crate::{
    recents::RecentProject,
    search::insert_pickers::{MISSING_OPACITY, project_badge},
};

/// How many projects the list holds after the desk's.
pub const LISTED: usize = 20;
const ROW_HEIGHT: f32 = 32.;
/// The control radius (`--radius-control`).
const ROW_RADIUS: f32 = 6.;

/// The list's height at most: 240px, or 26% of a short window, 96px in one
/// under 760px.
pub fn list_height(viewport_height: Pixels) -> Pixels {
    if viewport_height < px(760.) {
        px(96.)
    } else {
        px(240.).min(viewport_height * 0.26)
    }
}

/// The projects the list shows: those after the desk's, at most twenty.
pub fn listed(projects: &[RecentProject]) -> &[RecentProject] {
    let start = DESK_SIZE.min(projects.len());
    &projects[start..(start + LISTED).min(projects.len())]
}

/// Whether "Show all N projects" shows: more projects than the desk and
/// the list hold.
pub fn shows_all(total: usize) -> bool {
    total > DESK_SIZE + LISTED
}

/// The section: its heading, the list and, with more projects than it
/// holds, "Show all N projects". `open` runs with a row's project,
/// `show_all` with the button.
#[allow(
    clippy::too_many_arguments,
    reason = "the list's inputs come from several unrelated owners"
)]
pub fn more_projects(
    projects: &[RecentProject],
    total: usize,
    now: u64,
    disabled: bool,
    open: impl Fn(&Path, &mut Window, &mut App) + Clone + 'static,
    show_all: impl Fn(&mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let height = list_height(window.viewport_size().height);
    let hover = FluidHover::new("welcome-more-projects-hover", window, cx)
        .fill(palette.hover)
        .radius(px(ROW_RADIUS));
    let mut rows: Vec<AnyElement> = vec![hover.highlight()];
    for (ix, project) in projects.iter().enumerate() {
        let dim = if project.missing { MISSING_OPACITY } else { 1. };
        let icon = if project.overleaf {
            Icon::CLOUD
        } else {
            Icon::FOLDER
        };
        let opened = project.opened_at.map(|opened| age(opened, now));
        let path: PathBuf = project.path.clone();
        let open = open.clone();
        let row = div()
            .id(("welcome-more-project", ix))
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .h(px(ROW_HEIGHT))
            .px(px(10.))
            .rounded(px(ROW_RADIUS))
            .min_w_0()
            .cursor_pointer()
            .on_click(move |_, window, cx| {
                if !disabled {
                    open(&path, window, cx)
                }
            })
            .child(
                div()
                    .flex_none()
                    .flex()
                    .opacity(dim)
                    .child(icon.element(px(14.), palette.text_secondary)),
            )
            .child(
                div()
                    .flex_none()
                    .max_w(gpui::relative(0.5))
                    .min_w_0()
                    .truncate()
                    .opacity(dim)
                    .text_role(TextRole::Body, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text)
                    .child(project.name.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .opacity(dim)
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(parent_folder_label(&project.path)),
            )
            .children(project_badge(project).map(|badge| div().flex_none().child(badge)))
            .children(opened.map(|opened| {
                div()
                    .flex_none()
                    .whitespace_nowrap()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(opened)
            }));
        rows.push(hover.item(ix, row));
    }
    div()
        .w_full()
        .mt(px(16.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .relative()
                .children(parity::probe("welcome/more-projects-title"))
                .px(px(2.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text_secondary)
                .child(t!("More projects")),
        )
        .child(
            div()
                .id("welcome-more-projects")
                .relative()
                .children(parity::probe("welcome/more-projects"))
                .max_h(height)
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .children(rows),
        )
        // The welcome screen's quieter ways in (`more_action`): 28px,
        // caption, secondary ink, the hairline wash under the pointer.
        .children(shows_all(total).then(|| {
            let (hover_ink, hover_wash) = (palette.text, palette.line);
            div().flex().child(
                div()
                    .id("welcome-show-all-projects")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .px(px(10.))
                    .rounded(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .line_height(px(15.))
                    .font_weight(FONT_WEIGHT_REGULAR)
                    .text_color(palette.text_secondary)
                    .whitespace_nowrap()
                    .cursor_pointer()
                    .hover(move |style| style.bg(hover_wash).text_color(hover_ink))
                    .on_click(move |_, window, cx| {
                        if !disabled {
                            show_all(window, cx)
                        }
                    })
                    .child(Icon::SEARCH.element(px(15.), palette.text_secondary))
                    .child(t!("Show all {count} projects", count = total)),
            )
        }))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projects(count: usize) -> Vec<RecentProject> {
        (0..count)
            .map(|n| RecentProject {
                name: format!("P{n}"),
                path: format!("/p/{n}").into(),
                ..Default::default()
            })
            .collect()
    }

    #[test]
    fn the_list_takes_the_twenty_after_the_desk() {
        assert!(listed(&projects(3)).is_empty());
        assert!(listed(&projects(2)).is_empty());
        let four = projects(4);
        assert_eq!(listed(&four)[0].name, "P3");
        let many = projects(64);
        let shown = listed(&many);
        assert_eq!(shown.len(), LISTED);
        assert_eq!(shown[0].name, "P3");
        assert_eq!(shown[19].name, "P22");
        assert!(!shows_all(23));
        assert!(shows_all(24));
    }

    #[test]
    fn the_list_is_at_most_240px_and_96px_in_a_short_window() {
        assert_eq!(list_height(px(1200.)), px(240.));
        assert_eq!(list_height(px(800.)), px(208.));
        assert_eq!(list_height(px(700.)), px(96.));
    }
}
