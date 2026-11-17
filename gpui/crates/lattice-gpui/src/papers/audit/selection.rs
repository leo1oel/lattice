//! Ticking references to check only those, and the settled report's drawing
//! (`bibliography-audit.tsx`'s `selected` and `cleanNote`;
//! `.bibliography-audit-selection`, `-check` and `-clean` in
//! `bibliography-audit.css`):
//!
//! - each row leads with a checkbox that rests hidden, showing under the
//!   pointer and on every row once one is ticked; it is dimmed, and stays
//!   hidden at rest, while a check runs or fixes are written;
//! - with any ticked, a bar under the filters says how many, with Select all
//!   (mixed until every reference is ticked, clearing them once it is),
//!   Check selected and Clear;
//! - a report with nothing left to act on shows the research desk's reading
//!   glass (`REFERENCE_CHECK`), in the queue's pane, or under the overview
//!   below the queue's width.
//!
//! A fresh scan renumbers the references, so it clears the ticks, as the
//! Tauri sheet's `setSelected(new Set())` does after its scans.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Styled as _, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox},
};

use super::Audit;
use crate::research_art::{Drawing, research_art};

/// The group a row names itself with, so its checkbox shows under the pointer.
pub(super) const ROW_GROUP: &str = "audit-row";

/// The drawing's width (`.bibliography-audit-clean .research-art`).
const CLEAN_ART_WIDTH: f32 = 128.;

/// Select all's box with `ticked` of `total` references ticked: on once all
/// are, mixed while only some are (`indeterminate={selected.size < total}`),
/// so a press ticks the rest, and a press on a full box clears it.
pub(super) fn select_all_state(ticked: usize, total: usize) -> CheckState {
    match ticked {
        0 => CheckState::Off,
        _ if ticked >= total => CheckState::On,
        _ => CheckState::Mixed,
    }
}

impl Audit {
    /// Whether references can be ticked and checked now: nothing is being
    /// checked or written (`selectable`).
    pub(super) fn selectable(&self) -> bool {
        !self.busy && !self.applying
    }

    /// Tick reference `index`, or (`on` false) untick it.
    pub(super) fn select(&mut self, index: usize, on: bool, cx: &mut Context<Self>) {
        if !self.selectable() || index >= self.entries.len() {
            return;
        }
        if on {
            self.selected.insert(index);
        } else {
            self.selected.remove(&index);
        }
        cx.notify();
    }

    /// Select all: every reference, or (`on` false) none.
    pub(super) fn select_all(&mut self, on: bool, cx: &mut Context<Self>) {
        if !self.selectable() {
            return;
        }
        self.selected = if on {
            (0..self.entries.len()).collect()
        } else {
            Default::default()
        };
        cx.notify();
    }

    /// Clear, which a running check leaves enabled, as the Tauri sheet's does.
    pub(super) fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.selected.clear();
        cx.notify();
    }

    /// Check selected: a check of the ticked references only; the others
    /// keep their results.
    pub(super) fn check_selected(&mut self, cx: &mut Context<Self>) {
        if !self.selectable() || self.selected.is_empty() {
            return;
        }
        let mut only: Vec<usize> = self.selected.iter().copied().collect();
        only.sort_unstable();
        self.check(Some(only), cx);
    }

    /// The bar over the list while references are ticked: Select all, how
    /// many, Check selected and Clear.
    pub(super) fn selection_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.selected.is_empty() || self.entries.is_empty() {
            return None;
        }
        let palette = cx.palette().clone();
        let selectable = self.selectable();
        let view = cx.entity().downgrade();
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_x(px(8.))
                .gap_y(px(6.))
                .text_role(TextRole::Caption, cx)
                .child(
                    Checkbox::new(
                        "audit-select-all",
                        select_all_state(self.selected.len(), self.entries.len()),
                    )
                    .label(t!("Select all"))
                    .disabled(!selectable)
                    .on_toggle(move |on, _, cx| {
                        view.update(cx, |this, cx| this.select_all(*on, cx)).ok();
                    }),
                )
                .child(
                    // The count pushes the buttons to the line's end.
                    div()
                        .flex_1()
                        .text_color(palette.text_secondary)
                        .child(t!("{0} selected", self.selected.len())),
                )
                .child(
                    Button::new("audit-check-selected", t!("Check selected"))
                        .compact()
                        .ghost()
                        .disabled(!selectable)
                        .on_click(cx.listener(|this, _, _, cx| this.check_selected(cx))),
                )
                .child(
                    Button::new("audit-clear-selection", t!("Clear"))
                        .compact()
                        .ghost()
                        .on_click(cx.listener(|this, _, _, cx| this.clear_selection(cx))),
                )
                .into_any_element(),
        )
    }

    /// Reference `index`'s checkbox, at the row's start. Hidden at rest, it
    /// still takes a press there, as the Tauri row's transparent box does;
    /// its press stays its own, so the row does not open.
    pub(super) fn row_check(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let selecting = !self.selected.is_empty();
        let view = cx.entity().downgrade();
        div()
            .flex_none()
            // The 14px box sits 2px down the row's first line (`margin-top`).
            .pt(px(1.))
            .when(!selecting, |check| {
                check
                    .opacity(0.)
                    .group_hover(ROW_GROUP, |style| style.opacity(1.))
            })
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                Checkbox::new(
                    ("audit-row-check", index),
                    if self.selected.contains(&index) {
                        CheckState::On
                    } else {
                        CheckState::Off
                    },
                )
                .disabled(!self.selectable())
                .on_toggle(move |on, _, cx| {
                    view.update(cx, |this, cx| this.select(index, *on, cx)).ok();
                }),
            )
            .into_any_element()
    }

    /// The reading glass of a settled report; `pane`: centred in the
    /// queue's pane rather than under the overview.
    pub(super) fn clean_note(&self, pane: bool, cx: &Context<Self>) -> AnyElement {
        let art = research_art(
            Drawing::ReferenceCheck,
            px(CLEAN_ART_WIDTH),
            cx.palette().raised,
            cx,
        );
        div()
            .flex()
            .items_center()
            .when(pane, |note| {
                note.flex_1().flex_col().justify_center().py(px(16.))
            })
            .when(!pane, |note| note.py(px(8.)))
            .child(art)
            .into_any_element()
    }
}

/// The selection as a scenario ticks and reads it, through the handlers the
/// sheet's checkboxes and buttons call.
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Audit {
    /// Tick (or untick) the reference with citation key `key`.
    pub fn tick(&mut self, key: &str, on: bool, cx: &mut Context<Self>) {
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            self.select(index, on, cx);
        }
    }

    /// Press Select all: the box hands on the next value, on unless it was.
    pub fn press_select_all(&mut self, cx: &mut Context<Self>) {
        let state = select_all_state(self.selected.len(), self.entries.len());
        self.select_all(state != CheckState::On, cx);
    }

    /// The keys ticked, in the bibliography's order, and Select all's box.
    pub fn ticked(&self) -> (Vec<String>, CheckState) {
        let keys = (0..self.entries.len())
            .filter(|index| self.selected.contains(index))
            .map(|index| self.entries[index].key.clone())
            .collect();
        (
            keys,
            select_all_state(self.selected.len(), self.entries.len()),
        )
    }

    /// Press Check selected.
    pub fn press_check_selected(&mut self, cx: &mut Context<Self>) {
        self.check_selected(cx);
    }

    /// The run under way: how many it checks and the keys still being
    /// checked; none while no run has counted its references.
    pub fn run_keys(&self) -> Option<(usize, Vec<String>)> {
        (self.busy && self.run_total > 0).then(|| {
            let mut keys: Vec<String> = self
                .checking
                .iter()
                .filter_map(|index| self.entries.get(*index).map(|entry| entry.key.clone()))
                .collect();
            keys.sort();
            (self.run_total, keys)
        })
    }

    /// Press Cancel check.
    pub fn press_cancel(&mut self, cx: &mut Context<Self>) {
        self.stop(cx);
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    /// Nothing left to act on, nothing running: the reading glass shows.
    pub fn is_settled(&self) -> bool {
        self.listing().settled(self.busy)
    }
}

#[cfg(test)]
mod tests;
