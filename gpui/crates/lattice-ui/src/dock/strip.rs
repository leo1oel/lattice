//! How a panel's 40px strip gives way when it is short of room, as the Trellis
//! patch's `planHeader` lays out the Tauri app's headers.
//!
//! Documents' tabs share what the strip leaves after its tools and ⋯ menu,
//! shrinking with an ellipsis to 100px each. A named panel's tab (Project,
//! PDF, Build) never ellipsizes: every one shows its name, or only the
//! selected one does and the others their icons. Past that the documents'
//! tabs shrink further toward their icon and close square, then the panel's
//! own tools (the editor's Build chip) leave the strip, which the ⋯ menu
//! repeats, and then even the selected panel's name goes. Only after all of
//! that does the strip clip its tabs.
//!
//! A panel's spare tools (a .tex file's Source / Visual switch) show only in
//! room to spare: while every tab keeps its natural width beside them and the
//! panel's tools (the Trellis patch's `data-tools="named"` header). They go
//! before anything else gives way, and the ⋯ menu repeats them.
//!
//! The planner is plain arithmetic over measured widths, so it is tested
//! without a window; the renderer measures the strip and its tools on screen
//! and the labels by shaping them.

use gpui::{Pixels, px};

use crate::components::TabFit;

/// The strip's side padding.
pub const STRIP_PADDING: Pixels = px(6.);
/// Between the tabs, the tools and the menu.
pub const STRIP_GAP: Pixels = px(4.);
/// Between two tabs.
pub const TAB_SPACING: Pixels = px(2.);
/// The ⋯ menu button.
pub const MENU_WIDTH: Pixels = px(24.);
/// The drop target past the last tab, at its narrowest.
pub const END_DROP_MIN: Pixels = px(8.);
/// The most a document's tab shrinks to while anything else can give way:
/// the selected tab keeps room for two letters and an ellipsis beside its
/// close square.
pub const DOCUMENT_TAB_MIN: Pixels = px(100.);
/// A document's tab at its smallest: icon and close square, no label.
pub const DOCUMENT_TAB_FLOOR: Pixels = px(66.);

/// One tab, as the planner sees it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabSpec {
    /// The label's shaped width.
    pub label: Pixels,
    /// A named panel's tab, which shows its name whole or not at all; a
    /// document's tab ellipsizes instead.
    pub named: bool,
    pub selected: bool,
    pub closable: bool,
}

impl TabSpec {
    fn natural(&self) -> Pixels {
        TabFit::natural_width(self.label, self.closable)
    }
}

/// What the strip shows.
#[derive(Clone, Debug, PartialEq)]
pub struct StripPlan {
    pub tabs: Vec<TabFit>,
    /// Whether the panel's tools stay in the strip.
    pub tools: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Names {
    All,
    Selected,
    None,
}

/// The roomiest arrangement of `tabs` that fits a strip `width` wide whose
/// panel's tools are `tools` wide (zero for none).
pub fn plan(width: Pixels, tabs: &[TabSpec], tools: Pixels) -> StripPlan {
    let steps = [
        (Names::All, DOCUMENT_TAB_MIN, true),
        (Names::Selected, DOCUMENT_TAB_MIN, true),
        (Names::Selected, DOCUMENT_TAB_FLOOR, true),
        (Names::Selected, DOCUMENT_TAB_FLOOR, false),
        (Names::None, DOCUMENT_TAB_FLOOR, false),
    ];
    let room = width - STRIP_PADDING * 2. - MENU_WIDTH - STRIP_GAP - TAB_SPACING - END_DROP_MIN;
    let mut last = None;
    for (names, document_min, with_tools) in steps {
        let fits: Vec<TabFit> = tabs
            .iter()
            .map(|tab| fit(tab, names, document_min))
            .collect();
        let demand = tabs
            .iter()
            .zip(&fits)
            .map(|(tab, fit)| match fit {
                TabFit::Full => tab.natural(),
                TabFit::Shrinks { min } => tab.natural().min(*min),
                TabFit::IconOnly => TabFit::icon_only_width(),
            })
            .fold(px(0.), |sum, w| sum + w)
            + TAB_SPACING * tabs.len().saturating_sub(1) as f32
            + if with_tools && tools > px(0.) {
                tools + STRIP_GAP
            } else {
                px(0.)
            };
        let plan = StripPlan {
            tabs: fits,
            tools: with_tools,
        };
        if demand <= room {
            return plan;
        }
        last = Some(plan);
    }
    last.unwrap_or(StripPlan {
        tabs: Vec::new(),
        tools: true,
    })
}

/// Whether a panel's spare tools, `spare` wide, fit beside `tabs` at their
/// natural widths and its tools, `tools` wide, in a strip `width` wide.
pub fn room_to_spare(width: Pixels, tabs: &[TabSpec], tools: Pixels, spare: Pixels) -> bool {
    if spare <= px(0.) {
        return false;
    }
    let room = width - STRIP_PADDING * 2. - MENU_WIDTH - STRIP_GAP - TAB_SPACING - END_DROP_MIN;
    let tabs_width = tabs
        .iter()
        .map(TabSpec::natural)
        .fold(px(0.), |sum, w| sum + w)
        + TAB_SPACING * tabs.len().saturating_sub(1) as f32;
    let tools = if tools > px(0.) {
        tools + STRIP_GAP
    } else {
        px(0.)
    };
    tabs_width + tools + spare + SPARE_GAP <= room
}

/// Between the spare tools and the panel's tools (`.trellis-latex-tools`).
pub const SPARE_GAP: Pixels = px(4.);

fn fit(tab: &TabSpec, names: Names, document_min: Pixels) -> TabFit {
    if !tab.named {
        return TabFit::Shrinks {
            min: tab.natural().min(document_min),
        };
    }
    let named = match names {
        Names::All => true,
        Names::Selected => tab.selected,
        Names::None => false,
    };
    if named {
        TabFit::Full
    } else {
        TabFit::IconOnly
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(label: f32, selected: bool) -> TabSpec {
        TabSpec {
            label: px(label),
            named: true,
            selected,
            closable: true,
        }
    }

    fn document(label: f32, selected: bool) -> TabSpec {
        TabSpec {
            label: px(label),
            named: false,
            selected,
            closable: true,
        }
    }

    #[test]
    fn a_roomy_strip_names_every_tab_and_keeps_its_tools() {
        let plan = plan(px(590.), &[document(48., true)], px(83.));
        assert!(plan.tools);
        assert_eq!(
            plan.tabs,
            vec![TabFit::Shrinks {
                min: DOCUMENT_TAB_MIN
            }]
        );
    }

    #[test]
    fn a_short_document_tab_never_grows_to_the_minimum() {
        // A 20px label makes an 86px tab: its floor is its own width.
        let plan = plan(px(590.), &[document(20., true)], px(0.));
        assert_eq!(plan.tabs, vec![TabFit::Shrinks { min: px(86.) }]);
    }

    #[test]
    fn named_tabs_drop_to_icons_except_the_selected_one() {
        // Project (42px label) and Agent (36px): 108 + 102 + 2 = 212px of
        // tabs, in a strip that leaves 200 beside its end drop.
        let tabs = [named(42., true), named(36., false)];
        let plan = plan(px(200. + 12. + 28. + 10.), &tabs, px(0.));
        assert_eq!(plan.tabs, vec![TabFit::Full, TabFit::IconOnly]);
        assert!(plan.tools);
    }

    #[test]
    fn named_tabs_leave_room_for_the_end_drop() {
        // The same 212px of tabs in a strip whose row holds exactly 212px:
        // the end drop's 2px gap and 8px don't fit beside them, so they give
        // way rather than be clipped.
        let tabs = [named(42., true), named(36., false)];
        let plan = plan(px(212. + 12. + 28.), &tabs, px(0.));
        assert_eq!(plan.tabs, vec![TabFit::Full, TabFit::IconOnly]);
    }

    #[test]
    fn the_tools_leave_before_the_selected_name_does() {
        // The 1015px CI window's center: a 160px card holding main.tex
        // (48px label) and the 83px Build chip.
        let plan = plan(px(160.), &[document(48., true)], px(83.));
        assert!(!plan.tools, "the Build chip gives way first");
        assert_eq!(
            plan.tabs,
            vec![TabFit::Shrinks {
                min: DOCUMENT_TAB_FLOOR
            }]
        );
    }

    #[test]
    fn spare_tools_show_only_beside_tabs_at_their_natural_width() {
        // The 590px main.tex card: a 48px label (a 120px tab), the 82px
        // Build chip and the 156px Source / Visual switch fit.
        let tabs = [document(48., true)];
        assert!(room_to_spare(px(590.), &tabs, px(82.), px(156.)));
        // 320px: the tab and the chip fit at their widths, the switch not.
        assert!(plan(px(320.), &tabs, px(82.)).tools);
        assert!(!room_to_spare(px(320.), &tabs, px(82.), px(156.)));
        // Nothing to spare: nothing shows.
        assert!(!room_to_spare(px(590.), &tabs, px(82.), px(0.)));
    }

    #[test]
    fn a_strip_too_narrow_for_anything_shows_icons() {
        let plan = plan(px(60.), &[named(42., true), named(36., false)], px(0.));
        assert_eq!(plan.tabs, vec![TabFit::IconOnly, TabFit::IconOnly]);
        assert!(!plan.tools);
    }
}
