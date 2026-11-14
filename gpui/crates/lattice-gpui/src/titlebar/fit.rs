//! How the titlebar fits its room (`useFolds`, `useWindowCentred`): its
//! parts' widths from their labels' shaped widths, how far it folds, and
//! where the search field stands.

use gpui::Window;
use lattice_i18n::t;
use lattice_ui::{TextRole, typography::shaped_width};

use super::workspace_switch::unfolded_switch_width;
#[cfg(test)]
use super::workspace_switch::{self, SwitchTab, tab_width};
use crate::shell::Shell;

/// Between the titlebar's groups (`--space-6`), and its side padding.
pub(super) const GROUP_GAP: f32 = 12.;
/// The search field's width, and the least it gives up to before folding.
pub(super) const SEARCH_WIDTH: f32 = 320.;
pub(super) const SEARCH_MIN: f32 = 200.;

/// The project switcher's chrome around its name (`ToolbarButton::switcher`:
/// 8px in at each side, the 12px chevron 8px after the name), and the
/// widest it grows, alone or as the current project's tab.
pub(super) const SWITCHER_CHROME: f32 = 8. + 8. + 12. + 8.;
pub(super) const SWITCHER_MAX: f32 = 260.;
pub(super) const TAB_SWITCHER_MAX: f32 = 220.;
/// Another project's tab: its name 8px in and 4px before the close button,
/// cut at 180px, then the 20px close button 4px from the tab's end; tabs
/// 2px apart; the group 6px before the Panels menu's own 6px.
pub(super) const PROJECT_TAB_PAD: f32 = 8. + 4.;
pub(super) const PROJECT_TAB_MAX: f32 = 180.;
pub(super) const PROJECT_CLOSE: f32 = 20. + 4.;
pub(super) const PROJECT_TAB_GAP: f32 = 2.;
pub(super) const PROJECT_GROUP_END: f32 = 6.;
pub(super) const PANELS_START: f32 = 6.;
/// The Panels menu's chrome around its label (`ToolbarButton` with an
/// icon: 8px in at each side, the 14px icon 6px before the label).
pub(super) const PANELS_CHROME: f32 = 8. + 14. + 6. + 8.;

/// The project group's width from its names' widths: the switcher alone
/// (`switcher` its name), or a tab per project once there are two (`tabs`,
/// each name and whether it is the current project).
pub(super) fn project_group_width(switcher: f32, tabs: &[(f32, bool)]) -> f32 {
    if tabs.len() < 2 {
        return (switcher + SWITCHER_CHROME).min(SWITCHER_MAX) + PROJECT_GROUP_END;
    }
    let tabs_width: f32 = tabs
        .iter()
        .map(|&(name, current)| {
            let body = if current {
                (name + SWITCHER_CHROME).min(TAB_SWITCHER_MAX)
            } else {
                (name + PROJECT_TAB_PAD).min(PROJECT_TAB_MAX)
            };
            body + PROJECT_CLOSE
        })
        .sum();
    tabs_width + PROJECT_TAB_GAP * (tabs.len() - 1) as f32 + PROJECT_GROUP_END
}

/// How wide the left group draws with its workspaces unfolded, from its
/// labels' shaped widths, so the folds are right on the frame that changes
/// any of them.
pub(super) fn unfolded_left_width(shell: &Shell, window: &Window, cx: &gpui::App) -> f32 {
    let subtitle = |text: &str, weight| {
        f32::from(shaped_width(
            text,
            TextRole::Subtitle,
            Some(weight),
            window,
            cx,
        ))
    };
    let switcher = subtitle(
        &shell.project_name(cx),
        lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD,
    );
    let active = shell.root(cx);
    let tabs: Vec<(f32, bool)> = shell
        .projects
        .iter()
        .map(|open| {
            if Some(&open.root) == active.as_ref() {
                (switcher, true)
            } else {
                (
                    subtitle(&open.name, lattice_ui::tokens::FONT_WEIGHT_REGULAR),
                    false,
                )
            }
        })
        .collect();
    let panels = f32::from(shaped_width(
        t!("Panels"),
        TextRole::Caption,
        None,
        window,
        cx,
    ));
    project_group_width(switcher, &tabs)
        + PANELS_START
        + PANELS_CHROME
        + panels
        + GROUP_GAP
        + unfolded_switch_width(shell, window, cx)
}

/// The room the folds are decided in: where the left group ends with its
/// workspaces unfolded, and where the tools begin.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Room {
    pub(super) left_unfolded: Option<f32>,
    pub(super) tools_start: Option<f32>,
}

/// How far the titlebar folds: 0 none, 1 the search field to its icon, 2 the
/// workspaces into one menu too.
pub(super) fn folds(room: Room, width: f32) -> u8 {
    let tools = room.tools_start.unwrap_or(width);
    let fits = |left: Option<f32>, search: f32| {
        left.is_none_or(|left| left + GROUP_GAP + search + GROUP_GAP <= tools)
    };
    if fits(room.left_unfolded, SEARCH_MIN) {
        0
    } else if fits(room.left_unfolded, 28.) {
        1
    } else {
        2
    }
}

/// Where the unfolded search field stands: centred on the window, moved only
/// as far as the room between its neighbours lets it, and narrowed to that
/// room down to its minimum.
pub(super) fn search_place(room: Room, window_width: f32) -> (f32, f32) {
    let left = room.left_unfolded.unwrap_or(0.);
    let tools = room.tools_start.unwrap_or(window_width);
    let from = left + GROUP_GAP;
    let to = tools - GROUP_GAP;
    let width = SEARCH_WIDTH.min((to - from).max(SEARCH_MIN));
    let wanted = (window_width - width) / 2.;
    let x = wanted.min(to - width).max(from);
    (x, width)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(left: f32, tools: f32) -> Room {
        Room {
            left_unfolded: Some(left),
            tools_start: Some(tools),
        }
    }

    #[test]
    fn a_wide_window_folds_nothing_and_centres_the_search() {
        let room = room(513., 1288.);
        assert_eq!(folds(room, 1440.), 0);
        assert_eq!(search_place(room, 1440.), (560., 320.));
    }

    #[test]
    fn the_search_never_overlaps_the_workspace_switcher() {
        // The 1015px CI window: the left group ends at 513.
        let room = room(513., 863.);
        let fold = folds(room, 1015.);
        assert_eq!(fold, 0);
        let (x, width) = search_place(room, 1015.);
        assert!(x >= 513. + GROUP_GAP, "{x} starts inside the switcher");
        assert!(x + width <= 863. - GROUP_GAP);
    }

    #[test]
    fn short_of_room_the_search_folds_then_the_workspaces() {
        assert_eq!(folds(room(513., 700.), 900.), 1);
        assert_eq!(folds(room(513., 540.), 760.), 2);
    }

    #[test]
    fn the_fold_follows_the_workspaces_without_measuring_them_unfolded() {
        // In a narrow window five workspaces fold; with three deleted the
        // same switch start leaves room for them unfolded, and a longer name
        // or the dot on a workspace that differs takes that room back.
        let switch_start = 300.;
        let tools = 760.;
        let left = |tabs: &[(f32, bool)]| {
            switch_start
                + workspace_switch::track_width(
                    tabs.iter()
                        .map(|&(label, dot)| tab_width(SwitchTab::Named { label, dot })),
                )
        };
        let five = [(60., false); 5];
        assert_eq!(folds(room(left(&five), tools), 1015.), 2);
        let two = [(60., false), (60., false)];
        assert_eq!(folds(room(left(&two), tools), 1015.), 0);
        let renamed = [(60., false), (150., false)];
        assert_eq!(folds(room(left(&renamed), tools), 1015.), 1);
        // Just room for two clean tabs and the least search field: the dot
        // on one of them folds the search field.
        let differs = [(60., true), (60., false)];
        let snug = left(&two) + GROUP_GAP + SEARCH_MIN + GROUP_GAP;
        assert_eq!(folds(room(left(&two), snug), 1015.), 0);
        assert_eq!(folds(room(left(&differs), snug), 1015.), 1);
    }

    #[test]
    fn a_rename_keeps_the_width_its_field_draws() {
        // The rename field is at least 6×7+20px wide and its Input adds no
        // width of its own, so a long name typed in it scrolls instead of
        // widening the track.
        let renaming = [SwitchTab::Renaming];
        assert_eq!(
            workspace_switch::track_width(renaming.map(tab_width)),
            2. + 62. + 2. + 28.
        );
    }

    #[test]
    fn the_fold_follows_the_project_group_without_a_frame_late() {
        // ToolbarButton::switcher: 8px in, the name, 8px, a 12px chevron,
        // 8px; cut at 260px alone, then 6px before the Panels menu.
        assert_eq!(project_group_width(100., &[(100., true)]), 136. + 6.);
        assert_eq!(project_group_width(400., &[]), 260. + 6.);
        // A second project turns the switcher into two tabs, each with its
        // 20px close button 4px from its end, 2px apart.
        let two = project_group_width(100., &[(100., true), (80., false)]);
        assert_eq!(two, (136. + 24.) + 2. + (92. + 24.) + 6.);
        assert_eq!(
            project_group_width(100., &[(100., true), (400., false)]),
            (136. + 24.) + 2. + (180. + 24.) + 6.
        );
        // Snug at 1015px with one project, the second one folds the search
        // field on the frame it opens.
        let rest = 300.;
        let one = 95. + project_group_width(100., &[(100., true)]) + rest;
        let snug = one + GROUP_GAP + SEARCH_MIN + GROUP_GAP;
        assert_eq!(folds(room(one, snug), 1015.), 0);
        assert_eq!(folds(room(95. + two + rest, snug), 1015.), 1);
    }

    #[test]
    fn before_anything_is_measured_nothing_folds() {
        assert_eq!(folds(Room::default(), 1440.), 0);
    }
}
