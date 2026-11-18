//! Settings' page parts, as the Tauri app lays them out
//! (`components/ui/settings-row.tsx`, `settings-section-header.tsx`,
//! `switch-field.tsx`, `settings/settings-controls.tsx`; chrome.css
//! `.ui-settings-*`, dialogs.css `.settings-section`):
//!
//! - A page: 32px over its title, 40px in (20px when the dialog is narrow),
//!   48px under, at most 720px wide; the title in Settings' title role, 24px
//!   above the first group.
//! - A group: its title in Settings' subtitle, semibold, 8px over a card on
//!   the raised panel surface with the hairline edge and 10px corners; 28px
//!   between groups. Rows are at least 52px, 10px over and under and 16px
//!   in, a hairline drawn inside the row above each one after the first.
//! - A row: the label (Settings' body compact) over an optional caption in
//!   the tertiary ink, 2px apart; the control at the right, 16px off the
//!   copy; a select, a field or a button takes the 170px control column.
//! - A page narrower than 520px wraps a row that cannot hold both: the
//!   control drops under the label, at the right (a pictured choice, a
//!   slider or a segmented control takes the line).

use gpui::{
    AnyElement, App, Edges, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{Select, Switch},
    parity,
    tokens::FONT_WEIGHT_SEMIBOLD,
};

/// `--settings-control-width`.
pub const CONTROL_WIDTH: Pixels = px(170.);
/// `--settings-content-max-width`.
pub const CONTENT_MAX_WIDTH: Pixels = px(720.);
/// `--settings-group-gap`.
const GROUP_GAP: Pixels = px(28.);
/// Below this page width a row's control wraps under its label.
pub const PAGE_WRAP_WIDTH: Pixels = px(520.);

/// The page's room, which decides its insets and how rows wrap.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageWidth {
    /// The dialog is in its narrow, one-column form.
    pub narrow_dialog: bool,
    /// The page's own width.
    pub width: Pixels,
}

impl PageWidth {
    pub fn wraps(self) -> bool {
        self.inner() <= PAGE_WRAP_WIDTH
    }

    /// The page's inline inset.
    pub fn inset(self) -> Pixels {
        if self.narrow_dialog { px(20.) } else { px(40.) }
    }

    /// The width the page's content has, inside its insets.
    pub fn inner(self) -> Pixels {
        (self.width.min(CONTENT_MAX_WIDTH) - self.inset() * 2.).max(px(0.))
    }
}

/// A Settings page: its title, then its groups.
pub fn page(
    title: impl Into<SharedString>,
    width: PageWidth,
    groups: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    described_page(title, None, width, groups, cx)
}

/// `.ui-settings-section-header-description`'s 54ch, in the caption's face.
const DESCRIPTION_MAX_WIDTH: Pixels = px(356.);

/// A page whose title has a description under it (`SettingsSectionHeader`'s
/// `description`: the caption in the secondary ink, 6px under the title, at
/// most 54ch wide), then its groups.
pub fn described_page(
    title: impl Into<SharedString>,
    description: Option<SharedString>,
    width: PageWidth,
    groups: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette();
    let top = if width.narrow_dialog { px(8.) } else { px(32.) };
    div()
        .w_full()
        .max_w(CONTENT_MAX_WIDTH)
        .pt(top)
        .px(width.inset())
        .pb(px(48.))
        .flex()
        .flex_col()
        .child({
            // The heading's box fits its text, as the app's does.
            let title: SharedString = title.into();
            div()
                .flex()
                .flex_col()
                .items_start()
                .mb(px(24.))
                .child(
                    div()
                        .relative()
                        .text_role_in(TextRole::Title, TypeScale::Settings, cx)
                        .text_color(palette.text)
                        .children(parity::probe("settings/title"))
                        .children(parity::text_probe("settings/title", 0, title.clone()))
                        .child(title),
                )
                .children(description.map(|description| {
                    div()
                        .mt(px(6.))
                        .max_w(DESCRIPTION_MAX_WIDTH)
                        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                        .text_color(palette.text_secondary)
                        .child(description)
                }))
        })
        .children(
            groups
                .into_iter()
                .enumerate()
                .map(|(ix, group)| div().when(ix > 0, |this| this.mt(GROUP_GAP)).child(group)),
        )
        .into_any_element()
}

/// A titled group of rows in one card.
pub fn group(title: Option<SharedString>, rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    group_probed(title, rows, false, cx)
}

/// A page's first group, whose card the parity harness measures.
pub fn first_group(title: Option<SharedString>, rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    group_probed(title, rows, true, cx)
}

fn group_probed(
    title: Option<SharedString>,
    rows: Vec<AnyElement>,
    probed: bool,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex()
        .flex_col()
        .children(title.map(|title| {
            div()
                .mb(px(8.))
                .text_role_in(TextRole::Subtitle, TypeScale::Settings, cx)
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .text_color(palette.text)
                .child(title)
        }))
        .child(
            div()
                .relative()
                .flex()
                .flex_col()
                .rounded(px(10.))
                .when(probed, |this| {
                    this.children(parity::bordered_probe("settings/group", Edges::all(px(1.))))
                })
                .border_1()
                .border_color(palette.line)
                .bg(palette.raised)
                .overflow_hidden()
                // The divider is drawn inside the row, over its top edge,
                // so it never adds to the row's height (`inset 0 1px 0`).
                .children(rows.into_iter().enumerate().map(|(ix, row)| {
                    div().relative().child(row).when(ix > 0, |this| {
                        this.child(
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .right_0()
                                .h(px(1.))
                                .bg(palette.line),
                        )
                    })
                })),
        )
        .into_any_element()
}

/// How a row's control takes its line when the page wraps.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Wrap {
    /// Stays at the right, at its own width (a select, a field, a button).
    #[default]
    Right,
    /// Takes the whole line (tiles, a slider, a segmented control).
    Line,
    /// Never wraps (a switch).
    Never,
}

/// One setting: the copy at the left, its control at the right.
pub struct Row {
    pub id: &'static str,
    pub label: SharedString,
    pub description: Option<AnyElement>,
    pub control: Option<AnyElement>,
    pub wrap: Wrap,
    /// Tiles stand 12px off the hairlines rather than 10.
    pub roomy: bool,
    /// The row Settings search revealed, washed for a moment.
    pub revealed: f32,
}

impl Row {
    pub fn new(id: &'static str, label: impl Into<SharedString>) -> Self {
        Self {
            id,
            label: label.into(),
            description: None,
            control: None,
            wrap: Wrap::Right,
            roomy: false,
            revealed: 0.,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>, cx: &App) -> Self {
        let text: SharedString = description.into();
        self.description = Some(
            div()
                .mt(px(2.))
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(cx.palette().text_secondary)
                .child(text)
                .into_any_element(),
        );
        self
    }

    pub fn description_element(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> Self {
        self.control = Some(control.into_any_element());
        self
    }

    pub fn wrap(mut self, wrap: Wrap) -> Self {
        self.wrap = wrap;
        self
    }

    pub fn roomy(mut self) -> Self {
        self.roomy = true;
        self
    }

    pub fn revealed(mut self, amount: f32) -> Self {
        self.revealed = amount;
        self
    }

    pub fn render(self, width: PageWidth, cx: &App) -> AnyElement {
        let palette = cx.palette();
        let wraps = width.wraps() && self.wrap != Wrap::Never && self.control.is_some();
        let copy = div()
            .min_w_0()
            .when(wraps, |this| this.flex_1().min_w(px(160.)))
            .when(!wraps, |this| this.flex_1())
            .child(
                div().flex().child(
                    div()
                        .relative()
                        .min_w_0()
                        .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                        .text_color(palette.text)
                        .children(parity::probe(format!("settings/row/{}/label", self.id)))
                        .children(parity::text_probe(
                            format!("settings/row/{}/label", self.id),
                            0,
                            self.label.clone(),
                        ))
                        .child(self.label),
                ),
            )
            .children(self.description);
        let control = self.control.map(|control| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_end()
                .gap(px(8.))
                .when(wraps && self.wrap == Wrap::Line, |this| {
                    this.w_full().justify_start()
                })
                .when(wraps && self.wrap == Wrap::Right, |this| {
                    this.ml_auto().max_w_full()
                })
                .child(control)
        });
        let wash = palette.accent_soft;
        div()
            .id(ElementId::Name(format!("setting-{}", self.id).into()))
            .relative()
            .children(parity::probe(format!("settings/row/{}", self.id)))
            .flex()
            .items_center()
            .justify_between()
            .when(wraps, |this| this.flex_wrap().gap_y(px(8.)))
            .gap_x(px(16.))
            .min_h(px(52.))
            .px(px(16.))
            .py(if self.roomy { px(12.) } else { px(10.) })
            .when(self.revealed > 0., |this| {
                this.bg(gpui::Hsla {
                    a: wash.a * self.revealed,
                    ..wash
                })
            })
            .child(copy)
            .children(control)
            .into_any_element()
    }
}

/// A select of `options` (labels in display order) in the control column.
pub fn select<T: Copy + PartialEq + 'static>(
    id: &'static str,
    options: Vec<(T, SharedString)>,
    value: T,
    on_change: impl Fn(T, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let selected = options.iter().position(|(option, _)| *option == value);
    let values: Vec<T> = options.iter().map(|(option, _)| *option).collect();
    div()
        .w(CONTROL_WIDTH)
        .min_w(CONTROL_WIDTH)
        .child(
            Select::new(
                ElementId::Name(format!("settings-select-{id}").into()),
                options.into_iter().map(|(_, label)| label),
                selected,
            )
            .on_change(move |ix, window, cx| {
                if let Some(value) = values.get(*ix) {
                    on_change(*value, window, cx);
                }
            }),
        )
        .into_any_element()
}

/// A button (or a few) at the right of the 170px control column, as a
/// settings row's button sits (`--settings-control-width`), so the copy
/// beside it wraps where the Tauri app's does.
pub fn in_column(control: impl IntoElement) -> AnyElement {
    div()
        .w(CONTROL_WIDTH)
        .max_w_full()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(8.))
        .child(control)
        .into_any_element()
}

/// A switch, as a row's control.
pub fn switch(
    id: &'static str,
    on: bool,
    disabled: bool,
    on_toggle: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> AnyElement {
    Switch::new(ElementId::Name(format!("settings-switch-{id}").into()), on)
        .disabled(disabled)
        .on_toggle(move |on, window, cx| on_toggle(*on, window, cx))
        .into_any_element()
}

/// What an inline message says of itself (`InlineMessageLevel`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Success,
    Warning,
    Error,
}

/// A message that stays where it is (`components/ui/inline-message.tsx`,
/// chrome.css `.ui-inline-message`): the level's 13px mark, in its status
/// colour, centred on the first line of the caption beside it, 6px apart;
/// the caption in the secondary ink, or the primary for an error.
pub fn inline_message(level: Level, text: impl Into<SharedString>, cx: &App) -> AnyElement {
    let palette = cx.palette();
    let (icon, color) = match level {
        Level::Info => (Icon::INFO, palette.info),
        Level::Success => (Icon::CIRCLE_CHECK, palette.success),
        Level::Warning => (Icon::CIRCLE_ALERT, palette.warning),
        Level::Error => (Icon::CIRCLE_ALERT, palette.danger),
    };
    let leading = TextRole::Caption.leading(TypeScale::Settings);
    div()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(6.))
        .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
        .text_color(if level == Level::Error {
            palette.text
        } else {
            palette.text_secondary
        })
        .child(
            // The first line's height, so the mark sits centred on it.
            div()
                .flex_none()
                .h(leading)
                .flex()
                .items_center()
                .child(icon.element(px(13.), color)),
        )
        .child(div().min_w_0().flex_1().child(text.into()))
        .into_any_element()
}

/// What sits among a group's rows without being one (a key's field, a
/// notice): the card's 12px and 16px inset, under the hairline (chrome.css
/// `.ui-settings-group-body > *`). `joined` drops the space over it, for a
/// field that belongs to the row naming it.
pub fn block(child: impl IntoElement, joined: bool) -> AnyElement {
    div()
        .px(px(16.))
        .pt(if joined { px(0.) } else { px(12.) })
        .pb(px(12.))
        .child(child)
        .into_any_element()
}

/// A `'static` row id for a row made from data (a credited
/// work): rows and their controls are keyed by it, and each name is interned
/// once for the run, so the ids stay few and distinct.
pub fn row_id(prefix: &str, name: &str) -> &'static str {
    use std::{
        collections::HashSet,
        sync::{Mutex, PoisonError},
    };
    static IDS: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);
    let id = format!("{prefix}-{name}");
    let mut ids = IDS.lock().unwrap_or_else(PoisonError::into_inner);
    let ids = ids.get_or_insert_with(HashSet::new);
    if let Some(known) = ids.get(id.as_str()) {
        return known;
    }
    let leaked: &'static str = Box::leak(id.into_boxed_str());
    ids.insert(leaked);
    leaked
}

/// What a page drawn in an entity of its own needs to make its rows
/// revealable by Settings search: the dialog's record of each row's place,
/// and the row being washed, with how much.
#[derive(Clone, Default)]
pub struct Marks {
    pub rows: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<&'static str, gpui::Bounds<Pixels>>>,
    >,
    pub revealed: Option<(&'static str, f32)>,
}

impl Marks {
    /// `row`, measured as it is drawn and washed while revealed.
    pub fn row(&self, row: Row, width: PageWidth, cx: &App) -> AnyElement {
        let id = row.id;
        let rows = self.rows.clone();
        let amount = match self.revealed {
            Some((revealed, amount)) if revealed == id => amount,
            _ => 0.,
        };
        div()
            .relative()
            .child(
                gpui::canvas(
                    move |bounds, _, _| {
                        rows.borrow_mut().insert(id, bounds);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(row.revealed(amount).render(width, cx))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_row_id_is_interned_once() {
        let first = super::row_id("grammar-rule", "OxfordComma");
        assert_eq!(first, "grammar-rule-OxfordComma");
        assert!(std::ptr::eq(
            first,
            super::row_id("grammar-rule", "OxfordComma")
        ));
    }
}
