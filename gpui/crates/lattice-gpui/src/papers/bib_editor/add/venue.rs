//! The Venue box's suggestions (`bib-entry-dialog.tsx` `venueMatches`,
//! `chooseVenue`): the app's one venue vocabulary, `src/papers/venues.ts`,
//! read as the citation audit reads it. Picking a suggestion sets the entry
//! type it names (a journal is an @article, a conference @inproceedings);
//! a venue typed freely changes nothing but the field the type writes to.

use std::sync::LazyLock;

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    ParentElement as _, Styled as _, Window, deferred, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _};

use super::{AddReference, Field};

const VENUES_TS: &str = include_str!("../../../../../../../src/papers/venues.ts");

/// One venue: its proper name and the entry type it files under.
#[derive(Debug, PartialEq, Eq)]
pub struct Venue {
    pub name: String,
    pub entry_type: &'static str,
    search: String,
}

static VENUES: LazyLock<Vec<Venue>> = LazyLock::new(|| {
    let item = regex::Regex::new(
        r#"\{ name: ("(?:[^"\\]|\\.)*"), entryType: "(article|inproceedings)", search: ("(?:[^"\\]|\\.)*") \}"#,
    )
    .unwrap();
    item.captures_iter(VENUES_TS)
        .filter_map(|found| {
            Some(Venue {
                name: serde_json::from_str(&found[1]).ok()?,
                entry_type: if &found[2] == "article" {
                    "article"
                } else {
                    "inproceedings"
                },
                search: serde_json::from_str(&found[3]).ok()?,
            })
        })
        .collect()
});

/// Up to eight venues whose search words hold every word typed.
pub fn venue_matches(typed: &str) -> Vec<&'static Venue> {
    let mut query = String::new();
    for ch in typed.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            query.push(ch);
        } else if !query.ends_with(' ') {
            query.push(' ');
        }
    }
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    VENUES
        .iter()
        .filter(|venue| query.split(' ').all(|token| venue.search.contains(token)))
        .take(8)
        .collect()
}

/// The venue as the form holds it: a journal for an article, a booktitle
/// for any other type, each kept as the type changes (`fields.journal`,
/// `fields.booktitle`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VenueSlots {
    pub journal: String,
    pub booktitle: String,
}

impl VenueSlots {
    /// What the Venue box shows for `entry_type`.
    pub fn get(&self, entry_type: &str) -> &str {
        if entry_type == "article" {
            &self.journal
        } else {
            &self.booktitle
        }
    }

    /// The writer typed `value` into the Venue box.
    pub fn set(&mut self, entry_type: &str, value: String) {
        if entry_type == "article" {
            self.journal = value;
        } else {
            self.booktitle = value;
        }
    }

    /// The writer picked `venue`: the entry becomes its type, and the
    /// venue the field that type writes to. Returns the new type.
    pub fn choose(&mut self, venue: &Venue) -> &'static str {
        let article = venue.entry_type == "article";
        self.journal = if article {
            venue.name.clone()
        } else {
            String::new()
        };
        self.booktitle = if article {
            String::new()
        } else {
            venue.name.clone()
        };
        venue.entry_type
    }
}

impl AddReference {
    pub(super) fn venue_typed(&mut self, cx: &mut Context<Self>) {
        let value = self.value(Field::Venue, cx);
        self.venue.set(&self.entry_type, value);
        self.venue_open = true;
        self.venue_active = None;
        cx.notify();
    }

    pub(super) fn set_venue_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.venue_open = open;
        self.venue_active = None;
        cx.notify();
    }

    /// The type picked from its menu; the Venue box shows that type's field.
    pub(super) fn set_type(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.entry_type = kind.to_string();
        let shown = self.venue.get(kind).to_string();
        self.input(Field::Venue)
            .clone()
            .update(cx, |input, cx| input.set_value(shown, window, cx));
        cx.notify();
    }

    fn choose_venue(&mut self, venue: &'static Venue, window: &mut Window, cx: &mut Context<Self>) {
        self.entry_type = self.venue.choose(venue).to_string();
        self.input(Field::Venue).clone().update(cx, |input, cx| {
            input.set_value(venue.name.clone(), window, cx)
        });
        self.set_venue_open(false, cx);
    }

    fn matches(&self, cx: &gpui::App) -> Vec<&'static Venue> {
        if self.venue_open {
            venue_matches(&self.value(Field::Venue, cx))
        } else {
            Vec::new()
        }
    }

    /// The arrows move through the suggestions, Enter picks one, Escape
    /// closes them before it closes the sheet.
    fn venue_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let count = venue_matches(&self.value(Field::Venue, cx)).len();
        match event.keystroke.key.as_str() {
            "down" | "up" if count > 0 => {
                let down = event.keystroke.key == "down";
                self.venue_open = true;
                self.venue_active = Some(match (self.venue_active, down) {
                    (None, true) => 0,
                    (None, false) => count - 1,
                    (Some(at), true) => (at + 1) % count,
                    (Some(at), false) => (at + count - 1) % count,
                });
                cx.notify();
            }
            "enter" if self.venue_open => {
                let Some(venue) = self
                    .venue_active
                    .and_then(|at| self.matches(cx).get(at).copied())
                else {
                    return;
                };
                self.choose_venue(venue, window, cx);
            }
            "escape" if self.venue_open && count > 0 => self.set_venue_open(false, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    /// The Venue box, with its suggestions under it while it is in use.
    pub(super) fn venue_field(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let matches = self.matches(cx);
        let typed = self.value(Field::Venue, cx);
        let menu = (!matches.is_empty()).then(|| {
            let mut menu = div()
                .absolute()
                .top_full()
                .left_0()
                .right_0()
                .mt(px(4.))
                .p(px(4.))
                .flex()
                .flex_col()
                .rounded(px(8.))
                .bg(palette.input)
                .border_1()
                .border_color(palette.line)
                .shadow(Elevation::Floating.shadows(&palette));
            for (at, venue) in matches.into_iter().enumerate() {
                let kind = if venue.entry_type == "article" {
                    t!("journal")
                } else {
                    t!("conference")
                };
                menu = menu.child(
                    div()
                        .id(("bib-venue", at))
                        .flex()
                        .justify_between()
                        .gap(px(8.))
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text)
                        .when(self.venue_active == Some(at), |row| row.bg(palette.hover))
                        .when(venue.name == typed, |row| {
                            row.font_weight(gpui::FontWeight::MEDIUM)
                        })
                        .on_mouse_move(cx.listener(move |this, _, _, cx| {
                            if this.venue_active != Some(at) {
                                this.venue_active = Some(at);
                                cx.notify();
                            }
                        }))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.choose_venue(venue, window, cx);
                            }),
                        )
                        .child(div().min_w_0().truncate().child(venue.name.clone()))
                        .child(
                            div()
                                .flex_none()
                                .italic()
                                .text_color(palette.text_secondary)
                                .child(kind),
                        ),
                );
            }
            deferred(menu).with_priority(1)
        });
        div()
            .relative()
            .flex()
            .flex_1()
            .min_w(px(140.))
            .capture_key_down(cx.listener(Self::venue_key))
            .child(self.field(Field::Venue, t!("Venue"), cx))
            .children(menu)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::papers::bib_editor::model::Draft;

    fn saved(entry_type: &str, slots: &VenueSlots) -> String {
        Draft {
            entry_type: entry_type.into(),
            key: "k".into(),
            title: "T".into(),
            journal: slots.journal.clone(),
            booktitle: slots.booktitle.clone(),
            ..Default::default()
        }
        .format()
    }

    fn pick(typed: &str, name: &str) -> &'static Venue {
        venue_matches(typed)
            .into_iter()
            .find(|venue| venue.name == name)
            .unwrap()
    }

    #[test]
    fn picking_a_journal_makes_an_article_of_a_preprint() {
        let mut slots = VenueSlots::default();
        let kind = slots.choose(pick("nature", "Nature"));
        assert_eq!(
            saved(kind, &slots),
            "@article{k,\n  title = {T},\n  journal = {Nature}\n}\n"
        );
    }

    #[test]
    fn picking_a_conference_files_it_in_proceedings() {
        let mut slots = VenueSlots::default();
        let name = "Advances in Neural Information Processing Systems (NeurIPS)";
        let kind = slots.choose(pick("NeurIPS", name));
        assert_eq!(
            saved(kind, &slots),
            format!("@inproceedings{{k,\n  title = {{T}},\n  booktitle = {{{name}}}\n}}\n")
        );
    }

    #[test]
    fn a_venue_typed_on_a_misc_entry_keeps_it_misc_and_unsaved() {
        let mut slots = VenueSlots::default();
        slots.set("misc", "Nature".into());
        assert_eq!(slots.get("misc"), "Nature");
        assert_eq!(saved("misc", &slots), "@misc{k,\n  title = {T}\n}\n");
    }

    #[test]
    fn misc_chosen_after_a_journal_shows_and_saves_no_venue() {
        let mut slots = VenueSlots::default();
        slots.choose(pick("nature", "Nature"));
        assert_eq!(slots.get("misc"), "");
        assert_eq!(saved("misc", &slots), "@misc{k,\n  title = {T}\n}\n");
        assert_eq!(slots.get("article"), "Nature");
    }
}
