// Ported from Lattice's patch to DanFessler/trellis 0.2.0 (patches/@danfessler__trellis@0.2.0.patch:
// planHeader), on Trellis, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial.

//! How a panel's header fits its width, so its tabs never run under its
//! actions.
//!
//! `chrome` is the bar's width without its tabs in each [`HEADER_TOOLS`]
//! state. Named tabs (atomic) show their whole label or only their icon; the
//! other tabs have a minimum (`min`) and, under it, a floor (`floor`: icon and
//! close button, no title). When a header is short of room, in order:
//!   1. every unselected named tab's label gives way at once ([`LabelMode`]);
//!   2. the other tabs shrink below their minimum toward their floor
//!      (`tab_min`);
//!   3. the action row loses its text labels, then goes entirely;
//!   4. the selected tab's label gives way too, the last resort of a header
//!      at about the panel's minimum;
//!   5. only then do the tabs scroll, in a strip that now reaches the menu.
//!
//! A header comes back up a label mode only [`LABEL_HYSTERESIS`] px past that
//! mode's need (`previous` is the mode it shows now); selecting another tab
//! moves the name at once. The modes are named only in room to spare: with
//! every named tab's label shown and every other tab at its natural width
//! (`natural`), so no tab is ever narrower for a name, and the panel's
//! minimum never counts them. A divider's rubber band (`squeeze`) shrinks the
//! other tabs for the moment, so that room is theirs. The panel's minimum
//! header is its whole action row, every named tab as an icon and the other
//! tabs at their minimum, capped at 480px.

/// The states of a header's action row, roomiest first: the whole row with
/// its document modes named beside their icons, the whole row, its buttons
/// without their text labels, then none (every header tool is also in the
/// panel menu).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HeaderTools {
    Named,
    Full,
    Icon,
    Hidden,
}

pub const HEADER_TOOLS: [HeaderTools; 4] = [
    HeaderTools::Named,
    HeaderTools::Full,
    HeaderTools::Icon,
    HeaderTools::Hidden,
];

/// Which named tabs show their label, roomiest first: every one; only the
/// selected tab's; none. A strip never names some unselected tabs and not
/// others.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LabelMode {
    All,
    Selected,
    None,
}

pub const LABEL_MODES: [LabelMode; 3] = [LabelMode::All, LabelMode::Selected, LabelMode::None];

/// The room past its need a roomier label mode waits for before a header
/// takes it again, so a width resting at the edge never flickers.
pub const LABEL_HYSTERESIS: f64 = 12.;

#[derive(Clone, Debug, PartialEq)]
pub enum HeaderItem {
    Atomic {
        view_id: String,
        full: f64,
        compact: f64,
    },
    Loose {
        view_id: String,
        min: f64,
        floor: f64,
        natural: f64,
    },
}

impl HeaderItem {
    pub fn view_id(&self) -> &str {
        match self {
            HeaderItem::Atomic { view_id, .. } | HeaderItem::Loose { view_id, .. } => view_id,
        }
    }
}

/// A panel header's measured parts.
#[derive(Clone, Debug, PartialEq)]
pub struct HeaderMeasure {
    /// The bar without its tabs, in each [`HEADER_TOOLS`] state.
    pub chrome: [f64; 4],
    pub gap: f64,
    pub items: Vec<HeaderItem>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeaderPlan {
    pub label_mode: LabelMode,
    pub labelled: usize,
    /// The named tabs that show their label.
    pub labels: Vec<String>,
    pub tools: HeaderTools,
    pub tab_min: Option<f64>,
    pub min: f64,
}

pub fn plan_header(
    header: &HeaderMeasure,
    width: f64,
    squeeze: f64,
    selected: Option<&str>,
    previous: Option<LabelMode>,
) -> HeaderPlan {
    let HeaderMeasure { chrome, gap, items } = header;
    let loose: Vec<(f64, f64, f64)> = items
        .iter()
        .filter_map(|item| match item {
            HeaderItem::Loose {
                min,
                floor,
                natural,
                ..
            } => Some((*min, *floor, *natural)),
            HeaderItem::Atomic { .. } => None,
        })
        .collect();
    let atomic: Vec<&HeaderItem> = items
        .iter()
        .filter(|item| matches!(item, HeaderItem::Atomic { .. }))
        .collect();
    let shown = |mode: LabelMode| -> Vec<&HeaderItem> {
        match mode {
            LabelMode::All => atomic.clone(),
            LabelMode::Selected => atomic
                .iter()
                .copied()
                .filter(|item| Some(item.view_id()) == selected)
                .collect(),
            LabelMode::None => Vec::new(),
        }
    };
    let gaps = gap * items.len().saturating_sub(1) as f64;
    let named = |labels: &[&HeaderItem]| -> f64 {
        atomic
            .iter()
            .map(|item| match item {
                HeaderItem::Atomic { full, compact, .. } => {
                    if labels.iter().any(|l| std::ptr::eq(*l, *item)) {
                        *full
                    } else {
                        *compact
                    }
                }
                HeaderItem::Loose { .. } => 0.,
            })
            .sum()
    };
    let loose_min: f64 = loose.iter().map(|l| l.0).sum();
    let loose_floor: f64 = loose.iter().map(|l| l.1.min(l.0)).sum();
    let loose_natural: f64 = loose.iter().map(|l| l.2.max(l.0)).sum();
    // Room left for the other tabs with `labels` named and the row in state
    // `s`.
    let room = |labels: &[&HeaderItem], s: usize, give: f64| {
        width + give - chrome[s] - gaps - named(labels)
    };
    let slack = |mode: LabelMode| match mode {
        LabelMode::All => room(&shown(LabelMode::All), 1, 0.) - loose_min,
        LabelMode::Selected => {
            room(&shown(LabelMode::Selected), HEADER_TOOLS.len() - 1, 0.) - loose_floor
        }
        LabelMode::None => f64::INFINITY,
    };
    let was = previous.and_then(|p| LABEL_MODES.iter().position(|m| *m == p));
    let label_mode = LABEL_MODES
        .iter()
        .enumerate()
        .find(|(i, mode)| {
            **mode == LabelMode::None
                || slack(**mode)
                    >= (if was.is_some_and(|was| *i < was) {
                        LABEL_HYSTERESIS
                    } else {
                        0.
                    }) - 0.5
        })
        .map(|(_, mode)| *mode)
        .unwrap_or(LabelMode::None);
    let labels = shown(label_mode);
    let mut state = if label_mode == LabelMode::All && room(&labels, 0, 0.) >= loose_natural - 0.5 {
        0
    } else {
        1
    };
    while state < HEADER_TOOLS.len() - 1 && room(&labels, state, squeeze) < loose_floor - 0.5 {
        state += 1;
    }
    let share = if loose.is_empty() {
        0.
    } else {
        room(&labels, state, squeeze) / loose.len() as f64
    };
    let widest = loose.iter().map(|l| l.0).fold(0f64, f64::max);
    let floor = loose.iter().map(|l| l.1.min(l.0)).fold(0f64, f64::max);
    let tab_min = (!loose.is_empty() && share < widest).then(|| floor.max(share.floor()));
    HeaderPlan {
        label_mode,
        labelled: labels.len(),
        labels: labels.iter().map(|item| item.view_id().to_string()).collect(),
        tools: HEADER_TOOLS[state],
        tab_min,
        min: 480f64.min(chrome[1] + gaps + named(&shown(LabelMode::None)) + loose_min),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> HeaderMeasure {
        HeaderMeasure {
            chrome: [200., 160., 120., 41.],
            gap: 2.,
            items: vec![
                HeaderItem::Atomic {
                    view_id: "project".into(),
                    full: 90.,
                    compact: 32.,
                },
                HeaderItem::Atomic {
                    view_id: "agent".into(),
                    full: 80.,
                    compact: 32.,
                },
            ],
        }
    }

    #[test]
    fn labels_give_way_unselected_first() {
        let h = header();
        let roomy = plan_header(&h, 400., 0., Some("project"), None);
        assert_eq!(roomy.label_mode, LabelMode::All);
        let tight = plan_header(&h, 160. + 2. + 90. + 32. + 1., 0., Some("project"), None);
        assert_eq!(tight.label_mode, LabelMode::Selected);
        assert_eq!(tight.labels, ["project"]);
        let none = plan_header(&h, 100., 0., Some("project"), None);
        assert_eq!(none.label_mode, LabelMode::None);
        assert_eq!(none.tools, HeaderTools::Hidden);
    }

    #[test]
    fn a_roomier_mode_waits_for_the_hysteresis() {
        let h = header();
        // Exactly the need of "all" with the full row: 160 + 2 + 170.
        let edge = 332.;
        assert_eq!(
            plan_header(&h, edge, 0., Some("project"), None).label_mode,
            LabelMode::All
        );
        assert_eq!(
            plan_header(&h, edge, 0., Some("project"), Some(LabelMode::Selected)).label_mode,
            LabelMode::Selected
        );
        assert_eq!(
            plan_header(&h, edge + 12., 0., Some("project"), Some(LabelMode::Selected))
                .label_mode,
            LabelMode::All
        );
    }

    #[test]
    fn the_minimum_counts_named_tabs_as_icons() {
        let plan = plan_header(&header(), 400., 0., Some("project"), None);
        assert_eq!(plan.min, 160. + 2. + 64.);
    }
}
