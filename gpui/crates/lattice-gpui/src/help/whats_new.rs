//! What's new, quietly, as the Tauri app tells it (`src/app/whats-new.ts`,
//! `whats-new-dialog.tsx`, `.whats-new-*` in `dialogs.css`): the notes each
//! release carries (`src/release-notes/*.json`, bundled by `build.rs`), and
//! whether this launch is the first on a newer version. An update never
//! opens anything by itself: the first launch after one raises a notice, and
//! the sheet is a click from it, the palette and Help.
//!
//! The sheet is a dated page, not a slideshow: the release's highlights,
//! each a glyph and a sentence, then its fixes and a link to the full notes.
//! A stepper pages back through the releases bundled with this one.

use std::{cmp::Ordering, path::PathBuf, sync::OnceLock};

use gpui::{
    AnyElement, App, Context, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::{Locale, locale, t};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, LayerPlacement, ModalLayer, rise_in},
    scrollbar::FluidScrollbar,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, RADIUS_DIALOG, RADIUS_PILL},
};
use serde::Deserialize;

use crate::notices::{Notice, NoticeAction};

/// Each release's notes as `build.rs` found them, oldest name first.
const BUNDLED: &[&str] = include!(concat!(env!("OUT_DIR"), "/release_notes.rs"));

/// The version running now, which `bump-version.mjs` keeps in step with the
/// Tauri app's.
pub const RUNNING_VERSION: &str = lattice_core::VERSION;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Bilingual {
    pub en: String,
    #[serde(default)]
    pub zh: String,
}

impl Bilingual {
    /// The text in the interface language; Chinese falls back to English
    /// while untranslated.
    pub fn in_locale(&self, locale: Locale) -> &str {
        if locale.is_chinese() && !self.zh.is_empty() {
            &self.zh
        } else {
            &self.en
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Highlight {
    /// One of the sheet's glyphs ([`glyph`]); without one, the sparkle.
    #[serde(default)]
    pub icon: Option<String>,
    pub title: Bilingual,
    #[serde(default)]
    pub body: Option<Bilingual>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ReleaseNotes {
    pub version: String,
    /// `YYYY-MM-DD`, the day the release was cut.
    pub date: String,
    pub highlights: Vec<Highlight>,
    #[serde(default)]
    pub fixes: Vec<Bilingual>,
}

/// Two `x.y.z` versions compared numerically.
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let parts = |version: &str| -> Vec<u64> {
        version
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(left), parts(right));
    (0..a.len().max(b.len()))
        .map(|index| a.get(index).unwrap_or(&0).cmp(b.get(index).unwrap_or(&0)))
        .find(|order| order.is_ne())
        .unwrap_or(Ordering::Equal)
}

/// Every bundled release's notes up to `running`, newest first; read once,
/// when the sheet or the notice first needs them.
pub fn release_notes(running: &str) -> Vec<ReleaseNotes> {
    static PARSED: OnceLock<Vec<ReleaseNotes>> = OnceLock::new();
    let all = PARSED.get_or_init(|| {
        BUNDLED
            .iter()
            .filter_map(|text| match serde_json::from_str(text) {
                Ok(notes) => Some(notes),
                Err(error) => {
                    log::warn!("a bundled release's notes do not parse: {error}");
                    None
                }
            })
            .collect()
    });
    let mut notes: Vec<ReleaseNotes> = all
        .iter()
        .filter(|notes| compare_versions(&notes.version, running).is_le())
        .cloned()
        .collect();
    notes.sort_by(|a, b| compare_versions(&b.version, &a.version));
    notes
}

/// The version this app last launched on, when it is older than `running`
/// (the first launch after an update); none otherwise, including the very
/// first launch, which has nothing to compare with. Records `running`
/// either way, so the next launch says nothing. Without a state folder (a
/// scripted run) there is nothing to compare.
pub fn take_updated_from(state: Option<PathBuf>, running: &str) -> Option<String> {
    let file = state?.join("last-run-version");
    let previous = std::fs::read_to_string(&file)
        .ok()
        .map(|text| text.trim().to_string());
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&file, running).ok();
    previous.filter(|previous| compare_versions(running, previous).is_gt())
}

/// A conjunction list as `Intl.ListFormat` writes one: "A, B, and C";
/// "A、B和C".
pub fn conjunction(items: &[&str], locale: Locale) -> String {
    match items {
        [] => String::new(),
        [only] => (*only).to_string(),
        [rest @ .., last] if locale.is_chinese() => format!("{}和{last}", rest.join("、")),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

/// A release's day as `toLocaleDateString` writes it with a long month:
/// "October 17, 2026"; "2026年10月17日".
pub fn long_date(date: &str, locale: Locale) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let mut parts = date.split('-').map(|part| part.parse::<u32>().ok());
    let (Some(Some(year)), Some(Some(month)), Some(Some(day))) =
        (parts.next(), parts.next(), parts.next())
    else {
        return date.to_string();
    };
    if !(1..=12).contains(&month) {
        return date.to_string();
    }
    if locale.is_chinese() {
        format!("{year}年{month}月{day}日")
    } else {
        format!("{} {day}, {year}", MONTHS[month as usize - 1])
    }
}

/// On the first launch after an update, one notice: the version now
/// running, its first highlights in a line, and See what's new, which opens
/// the sheet in the window it is pressed in.
pub fn announce_update(state: Option<PathBuf>, cx: &mut App) {
    if take_updated_from(state, RUNNING_VERSION).is_none() {
        return;
    }
    let notes = release_notes(RUNNING_VERSION);
    let locale = locale();
    let titles: Vec<&str> = notes
        .first()
        .filter(|latest| latest.version == RUNNING_VERSION)
        .map(|latest| {
            latest
                .highlights
                .iter()
                .take(3)
                .map(|note| note.title.in_locale(locale))
                .collect()
        })
        .unwrap_or_default();
    let mut notice = Notice::new(
        lattice_ui::components::ToastLevel::Info,
        t!("Updated to Lattice {running}", running = RUNNING_VERSION),
    )
    .source(t!("Lattice"))
    .key("whats-new")
    .persistent()
    .action(NoticeAction::new(t!("See what’s new"), |window, cx| {
        window.dispatch_action(Box::new(crate::shell::WhatsNew), cx)
    }));
    if !titles.is_empty() {
        notice = notice.detail(format!(
            "{}{}",
            conjunction(&titles, locale),
            // Ends the sentence listing a release's highlights.
            t!(".")
        ));
    }
    crate::notices::show(notice, cx);
}

/// Where a release's full notes live: the generated list under its lead.
pub fn release_url(version: &str) -> String {
    format!("https://github.com/leo1oel/lattice/releases/tag/v{version}")
}

/// The glyph a highlight names; anything else draws the sparkle.
fn glyph(name: Option<&str>) -> Icon {
    match name.unwrap_or_default() {
        "bot" => Icon::BOT,
        "feather" => Icon::FEATHER,
        "gauge" => Icon::GAUGE,
        "git" => Icon::GIT_BRANCH,
        "menu" => Icon::MENU,
        "message" => Icon::MESSAGE_SQUARE_TEXT,
        "plug" => Icon::PLUG,
        "shapes" => Icon::SHAPES,
        "undo" => Icon::UNDO,
        _ => Icon::SPARKLES,
    }
}

pub enum WhatsNewEvent {
    Close,
}

/// The sheet, made afresh each time it opens, so it starts at the running
/// version.
pub struct WhatsNewSheet {
    releases: Vec<ReleaseNotes>,
    index: usize,
    scroll: ScrollHandle,
}

impl EventEmitter<WhatsNewEvent> for WhatsNewSheet {}

impl WhatsNewSheet {
    pub fn new() -> Self {
        Self {
            releases: release_notes(RUNNING_VERSION),
            index: 0,
            scroll: ScrollHandle::new(),
        }
    }

    /// The version on the page.
    pub fn shown_version(&self) -> &str {
        self.releases
            .get(self.index)
            .map_or(RUNNING_VERSION, |notes| notes.version.as_str())
    }

    /// Page to a newer (`-1`) or older (`1`) release.
    pub fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let next = self.index as isize + by;
        if next >= 0 && (next as usize) < self.releases.len() {
            self.index = next as usize;
            self.scroll.set_offset(gpui::point(px(0.), px(0.)));
            cx.notify();
        }
    }
}

impl Default for WhatsNewSheet {
    fn default() -> Self {
        Self::new()
    }
}

impl WhatsNewSheet {
    /// The pill holding the release's version between Newer and Older.
    fn stepper(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let arrow = |id: &'static str,
                     icon: Icon,
                     label: SharedString,
                     enabled: bool,
                     by: isize,
                     cx: &mut Context<Self>| {
            div()
                .id(id)
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(RADIUS_PILL)
                .text_color(palette.text_secondary)
                .when(!enabled, |this| this.opacity(0.35))
                .when(enabled, |this| {
                    this.cursor_pointer()
                        .hover(|this| this.bg(palette.hover).text_color(palette.text))
                        .on_click(cx.listener(move |this, _, _, cx| this.step(by, cx)))
                })
                .tooltip(move |_, cx| -> gpui::AnyView {
                    lattice_ui::components::LatticeTooltip::view(label.clone(), None, cx)
                })
                .child(icon.element(px(14.), palette.text_secondary))
        };
        let newer = arrow(
            "whats-new-newer",
            Icon::CHEVRON_LEFT,
            t!("Newer release").into(),
            self.index > 0,
            -1,
            cx,
        );
        let older = arrow(
            "whats-new-older",
            Icon::CHEVRON_RIGHT,
            t!("Older release").into(),
            self.index + 1 < self.releases.len(),
            1,
            cx,
        );
        div()
            .flex_none()
            .h(px(28.))
            .px(px(2.))
            .rounded(RADIUS_PILL)
            .border_1()
            .border_color(palette.line)
            .flex()
            .items_center()
            .gap(px(2.))
            .child(newer)
            .child(
                div()
                    .px(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(gpui::FontWeight::BOLD)
                    .text_color(palette.text)
                    .font_features(lattice_ui::typography::tabular_nums())
                    .whitespace_nowrap()
                    .child(self.shown_version().to_string()),
            )
            .child(older)
            .into_any_element()
    }

    fn body(
        &self,
        release: &ReleaseNotes,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let locale = locale();
        let highlights = release.highlights.iter().map(|note| {
            div()
                .flex()
                .items_start()
                .gap(px(10.))
                .child(
                    div()
                        .flex_none()
                        .size(px(30.))
                        .rounded(px(8.))
                        .bg(lattice_ui::interaction::mix(
                            palette.raised,
                            palette.accent,
                            0.1,
                        ))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(glyph(note.icon.as_deref()).element(px(15.), palette.accent)),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .child(
                            div()
                                .text_role(TextRole::Body, cx)
                                .font_weight(FONT_WEIGHT_SEMIBOLD)
                                .text_color(palette.text)
                                .child(note.title.in_locale(locale).to_string()),
                        )
                        .children(note.body.as_ref().map(|body| {
                            div()
                                .mt(px(2.))
                                .text_role(TextRole::Caption, cx)
                                .line_height(gpui::relative(1.5))
                                .text_color(palette.text_secondary)
                                .child(body.in_locale(locale).to_string())
                        })),
                )
        });
        let fixes = (!release.fixes.is_empty()).then(|| {
            div()
                .pt(px(12.))
                .border_t_1()
                .border_color(palette.line)
                .child(
                    div()
                        .mb(px(6.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(Icon::WRENCH.element(px(12.), palette.text_secondary))
                        .child(t!("Fixed")),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .line_height(gpui::relative(1.5))
                        .text_color(palette.text_secondary)
                        .children(release.fixes.iter().map(|fix| {
                            div()
                                .flex()
                                .child(div().flex_none().w(px(18.)).pl(px(6.)).child("•"))
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .child(fix.in_locale(locale).to_string()),
                                )
                        })),
                )
        });
        let max = px(520.).min(window.viewport_size().height * 0.56);
        div()
            .relative()
            .child(
                div()
                    .id("whats-new-body")
                    .max_h(max)
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(div().flex().flex_col().gap(px(12.)).children(highlights))
                    .children(fixes),
            )
            .child(FluidScrollbar::vertical(
                "whats-new-scrollbar",
                &self.scroll,
            ))
            .into_any_element()
    }
}

impl Render for WhatsNewSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(520.).min(window.viewport_size().width - px(40.));
        let release = self.releases.get(self.index).cloned();
        // The app's `.modal > p` outranks `.whats-new-date`, so the date is
        // set as a dialog's paragraph: body text, 20px under it.
        let date = |text: String, cx: &mut Context<Self>| {
            div()
                .mb(px(20.))
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(text)
        };
        let shown = self.shown_version().to_string();
        let card = div()
            .w(width)
            .flex()
            .flex_col()
            .gap(px(8.))
            .pt(px(20.))
            .px(px(24.))
            .pb(px(16.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .children(lattice_ui::parity::probe("whats-new/modal"))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .min_w_0()
                            .text_role(TextRole::Display, cx)
                            .text_color(palette.text)
                            .child(t!("What’s new")),
                    )
                    .child(self.stepper(cx)),
            )
            .map(|card| match &release {
                Some(release) => card
                    .child(date(long_date(&release.date, locale()), cx))
                    .child(self.body(release, window, cx)),
                None => card.child(date(t!("No notes came with this version").to_string(), cx)),
            })
            .child(
                div()
                    .mt(px(8.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        Button::new("whats-new-notes", t!("Full release notes"))
                            .ghost()
                            .compact()
                            .trailing_icon(Icon::EXTERNAL_LINK)
                            .on_click(move |_, _, cx| cx.open_url(&release_url(&shown))),
                    )
                    .child(
                        Button::new("whats-new-done", t!("Done"))
                            .primary()
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(WhatsNewEvent::Close))),
                    ),
            );
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "whats-new",
            LayerPlacement::UpperThird,
            rise_in("whats-new-rise", card),
            move |_, cx| {
                this.update(cx, |_, cx| cx.emit(WhatsNewEvent::Close)).ok();
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_not_as_text() {
        assert_eq!(compare_versions("0.10.0", "0.9.3"), Ordering::Greater);
        assert_eq!(compare_versions("0.16.17", "0.16.17"), Ordering::Equal);
        assert_eq!(compare_versions("0.16", "0.16.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.3", "1.10.0"), Ordering::Less);
    }

    #[test]
    fn bundled_notes_parse_and_stop_at_the_running_version() {
        let notes = release_notes(RUNNING_VERSION);
        assert_eq!(notes.len(), BUNDLED.len(), "every bundled release parses");
        assert!(
            notes
                .windows(2)
                .all(|pair| compare_versions(&pair[0].version, &pair[1].version).is_gt())
        );
        let older = release_notes("0.10.0");
        assert!(
            older
                .iter()
                .all(|notes| compare_versions(&notes.version, "0.10.0").is_le())
        );
        assert_eq!(
            older.first().map(|notes| notes.version.as_str()),
            Some("0.10.0")
        );
    }

    #[test]
    fn only_a_launch_on_a_newer_version_announces_it() {
        let dir = tempfile::tempdir().unwrap();
        let state = || Some(dir.path().to_path_buf());
        // The very first launch has nothing to compare with.
        assert_eq!(take_updated_from(state(), "0.16.0"), None);
        assert_eq!(take_updated_from(state(), "0.16.0"), None);
        assert_eq!(
            take_updated_from(state(), "0.16.2").as_deref(),
            Some("0.16.0")
        );
        assert_eq!(take_updated_from(state(), "0.16.2"), None);
        // A downgrade says nothing either.
        assert_eq!(take_updated_from(state(), "0.15.9"), None);
        assert_eq!(take_updated_from(None, "9.9.9"), None);
    }

    #[test]
    fn lists_and_dates_read_as_intl_writes_them() {
        assert_eq!(conjunction(&["A"], Locale::En), "A");
        assert_eq!(conjunction(&["A", "B"], Locale::En), "A and B");
        assert_eq!(conjunction(&["A", "B", "C"], Locale::En), "A, B, and C");
        assert_eq!(conjunction(&["甲", "乙", "丙"], Locale::ZhCn), "甲、乙和丙");
        assert_eq!(long_date("2026-10-17", Locale::En), "October 17, 2026");
        assert_eq!(long_date("2026-10-07", Locale::ZhCn), "2026年10月7日");
        assert_eq!(long_date("not a date", Locale::En), "not a date");
    }
}
