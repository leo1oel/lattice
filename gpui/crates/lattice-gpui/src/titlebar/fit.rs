//! How the titlebar fits its room (`useFolds`, `useWindowCentred` and
//! `trellis.css`'s container queries): its parts' widths from their
//! labels' shaped widths, what gives way in a window this wide, and where
//! the search field stands.

use gpui::Window;
use lattice_i18n::t;
use lattice_ui::{TextRole, typography::shaped_width};

#[cfg(test)]
use super::workspace_switch::{self, SwitchTab, tab_width};
use super::{
    Measured, hidden_chips,
    workspace_switch::{folded_switch_width, unfolded_switch_width},
};
use crate::shell::Shell;

/// Between the titlebar's groups (`--space-6`), and its side padding.
pub(super) const GROUP_GAP: f32 = 12.;
/// The search field's width, the least it gives up to before folding, and
/// its icon once folded.
pub(super) const SEARCH_WIDTH: f32 = 320.;
pub(super) const SEARCH_MIN: f32 = 200.;
pub(super) const SEARCH_ICON: f32 = 28.;
/// From the end of the Panels menu's group to the tools: the group's own
/// 6px padding and the tools' (`.trellis-titlebar` and `.canvas-toolbar`,
/// each `--space-3` in).
pub(super) const TOOLS_LEAD: f32 = 6. + 6.;
/// A bar this wide or narrower cuts the project's name at 200px
/// (`@container titlebar (max-width: 800px)`).
pub(super) const COMPACT_BAR: f32 = 800.;
/// The room between the project and the tools, past their paddings, at or
/// under which the workspaces go, then the Panels menu's label
/// (`@container trellis-titlebar (max-width: 264px)`, `(max-width: 159px)`).
pub(super) const SWITCH_HIDES_AT: f32 = 264.;
pub(super) const PANELS_LABEL_HIDES_AT: f32 = 159.;

/// The project switcher's chrome around its name (`ToolbarButton::switcher`:
/// 8px in at each side, the 12px chevron 8px after the name), and the
/// widest it grows, alone (260px, 200px in a bar of 800px or less) or as
/// the current project's tab.
pub(super) const SWITCHER_CHROME: f32 = 8. + 8. + 12. + 8.;
pub(super) const SWITCHER_MAX: f32 = 260.;
pub(super) const SWITCHER_MAX_COMPACT: f32 = 200.;
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
/// icon: 8px in at each side, the 14px icon 6px before the label), and the
/// menu with its icon alone.
pub(super) const PANELS_CHROME: f32 = 8. + 14. + 6. + 8.;
pub(super) const PANELS_ICON: f32 = 8. + 14. + 8.;

/// The widest the project switcher grows in a window this wide.
pub(super) fn switcher_max(window_width: f32) -> f32 {
    if window_width <= COMPACT_BAR {
        SWITCHER_MAX_COMPACT
    } else {
        SWITCHER_MAX
    }
}

/// The project group's width from its names' widths: the switcher alone
/// (`switcher` its name, cut at `switcher_max`), or a tab per project once
/// there are two (`tabs`, each name and whether it is the current project).
pub(super) fn project_group_width(switcher: f32, tabs: &[(f32, bool)], switcher_max: f32) -> f32 {
    if tabs.len() < 2 {
        return (switcher + SWITCHER_CHROME).min(switcher_max) + PROJECT_GROUP_END;
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

/// What the titlebar's parts measure, from their labels' shaped widths, so
/// the folds are right on the frame that changes any of them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Widths {
    /// The project group, its 6px end included, with the switcher cut at
    /// this window's `switcher_max`.
    pub(super) project: f32,
    /// The Panels menu with its label, and with its icon alone.
    pub(super) panels: f32,
    pub(super) panels_icon: f32,
    /// The workspace switch unfolded, and folded into its menu.
    pub(super) switch: f32,
    pub(super) switch_folded: f32,
    /// The hidden panels' chips, each at its natural width (0 with none).
    pub(super) chips: f32,
}

pub(super) fn widths(shell: &Shell, window: &Window, cx: &gpui::App) -> Widths {
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
    let window_width = f32::from(window.viewport_size().width);
    Widths {
        project: project_group_width(switcher, &tabs, switcher_max(window_width)),
        panels: PANELS_CHROME + panels,
        panels_icon: PANELS_ICON,
        switch: unfolded_switch_width(shell, window, cx),
        switch_folded: folded_switch_width(shell, window, cx),
        chips: hidden_chips::natural_width(shell, window, cx),
    }
}

/// The workspace switch as the titlebar draws it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Switch {
    Unfolded,
    Folded,
    Hidden,
}

/// The search field as the titlebar draws it: in full at `x`, `width`
/// wide, or folded to its icon at the bar's end.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Search {
    Field { x: f32, width: f32 },
    Icon,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Plan {
    pub(super) search: Search,
    pub(super) switch: Switch,
    pub(super) panels_label: bool,
}

/// How the titlebar gives way in a window `window_width` wide, from what it
/// measured last frame and what its parts measure now. Before anything is
/// measured nothing folds.
pub(super) fn plan(room: Measured, widths: Widths, window_width: f32) -> Plan {
    let left_start = room.left_start.unwrap_or(0.);
    let tools_start = room.tools_start.unwrap_or(window_width);
    // The Panels menu's group: from its 6px padding to the tools' lead.
    let from = left_start + widths.project + PANELS_START;
    let to = tools_start - TOOLS_LEAD;
    let content = to - from;
    let chips = if widths.chips > 0. {
        GROUP_GAP + widths.chips
    } else {
        0.
    };
    // What the group asks for with the search field and the switch this
    // wide (`useFolds`' demand, the chips at their natural width).
    let need =
        |search: f32, switch: f32| widths.panels + GROUP_GAP + switch + GROUP_GAP + search + chips;
    let measured = room.tools_start.is_some();
    let (search_folded, mut switch) = if !measured || need(SEARCH_MIN, widths.switch) <= content {
        (false, Switch::Unfolded)
    } else if need(SEARCH_ICON, widths.switch) <= content {
        (true, Switch::Unfolded)
    } else {
        (true, Switch::Folded)
    };
    // Then the container queries' steps, each taken at its width or, with
    // names longer than they were tuned for (a long workspace's, or
    // Simplified Chinese), as soon as the search field's icon would be cut:
    // no step sheds it, the palette has no other place in the bar. The
    // chips shrink instead, so they count for neither.
    let icon_cut = |panels: f32, switch: f32| panels + switch + GROUP_GAP + SEARCH_ICON > content;
    let mut panels_label = true;
    if measured
        && (content <= SWITCH_HIDES_AT
            || (switch == Switch::Folded
                && icon_cut(widths.panels, GROUP_GAP + widths.switch_folded)))
    {
        switch = Switch::Hidden;
    }
    if measured
        && (content <= PANELS_LABEL_HIDES_AT
            || (switch == Switch::Hidden && icon_cut(widths.panels, 0.)))
    {
        panels_label = false;
    }
    let search = if search_folded {
        Search::Icon
    } else {
        // Centred on the window, moved only as far as the room between its
        // neighbours lets it, and narrowed to that room down to its least.
        let field_from = from + widths.panels + GROUP_GAP + widths.switch + GROUP_GAP;
        let field_to = to - chips;
        let width = SEARCH_WIDTH.min((field_to - field_from).max(SEARCH_MIN));
        let wanted = (window_width - width) / 2.;
        let x = wanted.min(field_to - width).max(field_from);
        Search::Field { x, width }
    };
    Plan {
        search,
        switch,
        panels_label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(left: f32, tools: f32) -> Measured {
        Measured {
            left_start: Some(left),
            tools_start: Some(tools),
        }
    }

    /// The e2e fixture's parts: "e2e" as the project, "Panels", two
    /// workspaces and their folded menu.
    fn parts() -> Widths {
        Widths {
            project: 60.,
            panels: 76.,
            panels_icon: PANELS_ICON,
            switch: 150.,
            switch_folded: 100.,
            chips: 0.,
        }
    }

    /// The x ranges every planned part draws at, laid out as the group's
    /// flex row lays them: Panels and the switch from its start, the folded
    /// search field and the chips at its end, the chips shrinking into what
    /// is left them; and whether anything but the chips was cut at the
    /// group's end.
    fn spans(
        plan: Plan,
        w: Widths,
        left: f32,
        tools: f32,
    ) -> (Vec<(&'static str, f32, f32)>, bool) {
        let mut at = left + w.project + PANELS_START;
        let mut spans = vec![("project", left, left + w.project - PROJECT_GROUP_END)];
        let panels = if plan.panels_label {
            w.panels
        } else {
            w.panels_icon
        };
        spans.push(("panels", at, at + panels));
        at += panels;
        let switch = match plan.switch {
            Switch::Unfolded => Some(w.switch),
            Switch::Folded => Some(w.switch_folded),
            Switch::Hidden => None,
        };
        if let Some(switch) = switch {
            spans.push(("switch", at + GROUP_GAP, at + GROUP_GAP + switch));
            at += GROUP_GAP + switch;
        }
        let end = tools - TOOLS_LEAD;
        let mut trailing = 0.;
        if plan.search == Search::Icon {
            trailing += GROUP_GAP + SEARCH_ICON;
        }
        let chips = if w.chips > 0. {
            (end - at - trailing - GROUP_GAP).clamp(0., w.chips)
        } else {
            0.
        };
        if w.chips > 0. {
            trailing += GROUP_GAP + chips;
        }
        let mut tail = (end - trailing).max(at);
        match plan.search {
            Search::Field { x, width } => spans.push(("search", x, x + width)),
            Search::Icon => {
                spans.push(("search", tail + GROUP_GAP, tail + GROUP_GAP + SEARCH_ICON));
                tail += GROUP_GAP + SEARCH_ICON;
            }
        }
        if w.chips > 0. && chips > 0. {
            spans.push(("chips", tail + GROUP_GAP, tail + GROUP_GAP + chips));
        }
        let cut = spans
            .iter()
            .any(|s| s.0 != "project" && s.0 != "chips" && s.2 > end + 0.5);
        spans.push(("tools", tools, tools + 150.));
        (spans, cut)
    }

    fn apart(spans: &[(&str, f32, f32)]) -> bool {
        let mut sorted = spans.to_vec();
        sorted.sort_by(|a, b| a.1.total_cmp(&b.1));
        sorted.windows(2).all(|pair| pair[0].2 <= pair[1].1 + 0.5)
    }

    #[test]
    fn a_wide_window_folds_nothing_and_centres_the_search() {
        let plan = plan(room(95., 1288.), parts(), 1440.);
        assert_eq!(
            plan.search,
            Search::Field {
                x: 560.,
                width: 320.
            }
        );
        assert_eq!(plan.switch, Switch::Unfolded);
        assert!(plan.panels_label);
    }

    #[test]
    fn the_search_never_overlaps_the_workspace_switcher() {
        // The 1015px CI window: the switch ends at 95+60+6+76+12+150 = 399.
        let plan = plan(room(95., 863.), parts(), 1015.);
        let Search::Field { x, width } = plan.search else {
            panic!("folded at 1015px: {plan:?}");
        };
        assert!(x >= 399. + GROUP_GAP, "{x} starts inside the switcher");
        assert!(x + width <= 863. - TOOLS_LEAD);
    }

    #[test]
    fn short_of_room_the_search_folds_then_the_workspaces_then_both_go() {
        let w = parts();
        // The group from 161: Panels, the switch and the least field need
        // 76+12+150+12+200 = 450.
        let fits = |tools: f32| plan(room(95., tools), w, 1015.);
        assert!(matches!(
            fits(161. + 450. + TOOLS_LEAD).search,
            Search::Field { .. }
        ));
        let folded = fits(161. + 449. + TOOLS_LEAD);
        assert_eq!(
            (folded.search, folded.switch),
            (Search::Icon, Switch::Unfolded)
        );
        let menu = fits(161. + 76. + 12. + 150. + 12. + 27. + TOOLS_LEAD);
        assert_eq!((menu.search, menu.switch), (Search::Icon, Switch::Folded));
        let gone = fits(161. + 264. + TOOLS_LEAD);
        assert_eq!(gone.switch, Switch::Hidden);
        assert!(gone.panels_label);
        let icon = fits(161. + 159. + TOOLS_LEAD);
        assert!(!icon.panels_label);
    }

    #[test]
    fn the_hidden_panels_chips_count_as_content_to_fit() {
        let mut w = parts();
        let tools = 161. + 450. + TOOLS_LEAD;
        assert!(matches!(
            plan(room(95., tools), w, 1015.).search,
            Search::Field { .. }
        ));
        w.chips = 80.;
        let plan = plan(room(95., tools), w, 1015.);
        assert_eq!(plan.search, Search::Icon);
        let (spans, cut) = spans(plan, w, 95., tools);
        assert!(apart(&spans) && !cut, "{spans:?}");
    }

    #[test]
    fn a_full_field_stops_short_of_the_chips() {
        let mut w = parts();
        w.chips = 120.;
        let tools = 1288.;
        let plan = plan(room(95., tools), w, 1440.);
        let Search::Field { x, width } = plan.search else {
            panic!("folded at 1440px: {plan:?}");
        };
        assert!(x + width <= tools - TOOLS_LEAD - 120. - GROUP_GAP);
    }

    #[test]
    fn nothing_overlaps_at_any_width_down_to_the_least() {
        // The window's tools stand 150px wide 6px from its edge; a long
        // name, long workspaces and two chips, as zh-CN or a long project
        // name gives them.
        let long = Widths {
            project: SWITCHER_MAX + PROJECT_GROUP_END,
            panels: 76.,
            panels_icon: PANELS_ICON,
            switch: 360.,
            switch_folded: 150.,
            chips: 2. * 140. + 4.,
        };
        for w in [parts(), long] {
            for width in (720..=1600).step_by(5) {
                let width = width as f32;
                let mut w = w;
                w.project = w.project.min(switcher_max(width) + PROJECT_GROUP_END);
                let tools = width - 6. - 150.;
                let plan = plan(room(95., tools), w, width);
                let (spans, cut) = spans(plan, w, 95., tools);
                assert!(apart(&spans) && !cut, "{width}px: {plan:?} {spans:?}");
            }
        }
    }

    #[test]
    fn a_bar_of_800px_or_less_cuts_the_project_name_at_200px() {
        assert_eq!(switcher_max(1015.), 260.);
        assert_eq!(switcher_max(800.), 200.);
        assert_eq!(
            project_group_width(400., &[], switcher_max(720.)),
            200. + 6.
        );
    }

    #[test]
    fn the_fold_follows_the_workspaces_without_measuring_them_unfolded() {
        // In a narrow window five workspaces fold; with three deleted the
        // same group leaves room for them unfolded, and a longer name or
        // the dot on a workspace that differs takes that room back.
        let tools = 720.;
        let with = |tabs: &[(f32, bool)]| Widths {
            switch: workspace_switch::track_width(
                tabs.iter()
                    .map(|&(label, dot)| tab_width(SwitchTab::Named { label, dot })),
            ),
            ..parts()
        };
        let at = |tabs: &[(f32, bool)]| plan(room(95., tools), with(tabs), 1015.);
        let five = [(60., false); 5];
        assert_eq!(at(&five).switch, Switch::Folded);
        let two = [(60., false), (60., false)];
        assert!(matches!(at(&two).search, Search::Field { .. }));
        let renamed = [(60., false), (150., false)];
        assert_eq!(at(&renamed).search, Search::Icon);
        assert_eq!(at(&renamed).switch, Switch::Unfolded);
        // Just room for two clean tabs and the least search field: the dot
        // on one of them folds the search field.
        let differs = [(60., true), (60., false)];
        let w = with(&two);
        let snug = 95.
            + w.project
            + PANELS_START
            + w.panels
            + GROUP_GAP
            + w.switch
            + GROUP_GAP
            + SEARCH_MIN
            + TOOLS_LEAD;
        assert!(matches!(
            plan(room(95., snug), w, 1015.).search,
            Search::Field { .. }
        ));
        assert_eq!(
            plan(room(95., snug), with(&differs), 1015.).search,
            Search::Icon
        );
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
    fn a_folded_switch_cuts_its_name_and_adds_the_dot() {
        assert_eq!(
            workspace_switch::folded_width(40., false),
            4. + 8. + 14. + 6. + 40. + 6. + 12. + 8.
        );
        assert_eq!(
            workspace_switch::folded_width(400., true),
            4. + 8. + 14. + 6. + 112. + 11. + 6. + 12. + 8.
        );
    }

    #[test]
    fn the_fold_follows_the_project_group_without_a_frame_late() {
        // ToolbarButton::switcher: 8px in, the name, 8px, a 12px chevron,
        // 8px; cut at 260px alone, then 6px before the Panels menu.
        assert_eq!(project_group_width(100., &[(100., true)], 260.), 136. + 6.);
        assert_eq!(project_group_width(400., &[], 260.), 260. + 6.);
        // A second project turns the switcher into two tabs, each with its
        // 20px close button 4px from its end, 2px apart.
        let two = project_group_width(100., &[(100., true), (80., false)], 260.);
        assert_eq!(two, (136. + 24.) + 2. + (92. + 24.) + 6.);
        assert_eq!(
            project_group_width(100., &[(100., true), (400., false)], 260.),
            (136. + 24.) + 2. + (180. + 24.) + 6.
        );
        // Snug at 1015px with one project, the second one folds the search
        // field on the frame it opens.
        let one = Widths {
            project: project_group_width(100., &[(100., true)], 260.),
            ..parts()
        };
        let snug = 95.
            + one.project
            + PANELS_START
            + one.panels
            + GROUP_GAP
            + one.switch
            + GROUP_GAP
            + SEARCH_MIN
            + TOOLS_LEAD;
        assert!(matches!(
            plan(room(95., snug), one, 1015.).search,
            Search::Field { .. }
        ));
        let both = Widths {
            project: two,
            ..one
        };
        assert_eq!(plan(room(95., snug), both, 1015.).search, Search::Icon);
    }

    #[test]
    fn before_anything_is_measured_nothing_folds() {
        let plan = plan(Measured::default(), parts(), 1440.);
        assert!(matches!(plan.search, Search::Field { .. }));
        assert_eq!(plan.switch, Switch::Unfolded);
        assert!(plan.panels_label);
    }
}
