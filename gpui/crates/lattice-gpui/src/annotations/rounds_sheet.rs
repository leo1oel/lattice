//! The Revision rounds sheet (`annotation-rounds-dialog.tsx`,
//! `annotations.css`'s `.annotation-rounds`): every revision round as a
//! version. The rail lists Now, each settled round (newest first, with when
//! it settled, how many annotations it asked about and what became of them)
//! and the text before revisions; choosing one compares it side by side with
//! the version before it, or any older one chosen under the comparison, each
//! changed paragraph tagged with the accepted annotations behind it, the
//! words the newer one dropped struck and the ones it added washed, ↑ ↓
//! stepping between them. A round opens in the project history, and any
//! version but Now can be restored, as one entry of the project's history.
//!
//! Opened from the Annotations panel's Revision rounds and from the round
//! saved notice's Compare (`shell/rounds_flow.rs`, which runs the restore).

pub mod compare;

use std::{ops::Range, path::PathBuf};

use gpui::{
    AnyElement, App, Context, EventEmitter, HighlightStyle, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::project::{AnnotationRound, EditorComment};
use lattice_i18n::{Locale, join_phrases, locale, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, IconButton, LayerPlacement, ModalLayer, Sheet},
    tokens::FONT_WEIGHT_MEDIUM,
};

use compare::{Changed, Snapshots, Version};

use crate::history::{review_mode::diff, time};

/// Below this width the rail goes over the comparison
/// (`@container rounds (max-width: 640px)`).
const NARROW: f32 = 640.;

/// What the sheet asks of the window.
pub enum RoundsSheetEvent {
    Close,
    /// Open this history entry (the round's version) in History.
    OpenInHistory(String),
    /// Write `files` (path, text) as one restore named `label`.
    Restore { label: String, files: Vec<(String, String)> },
}

pub struct RoundsSheet {
    settled: Vec<AnnotationRound>,
    annotations: Vec<EditorComment>,
    snapshots: Option<Snapshots>,
    error: Option<SharedString>,
    restoring: bool,
    /// The version compared, and the older one it is compared with (none:
    /// the one before it).
    selected: Version,
    base: Option<Version>,
    /// The change the arrows are on, for the pair it was chosen in.
    cursor: (String, usize),
    scroll: ScrollHandle,
    width: std::rc::Rc<std::cell::Cell<f32>>,
    /// A restore is an ordinary local edit, so syncing carries it to Overleaf.
    overleaf_linked: bool,
}

impl EventEmitter<RoundsSheetEvent> for RoundsSheet {}

impl RoundsSheet {
    /// The sheet over `root`'s rounds; `read_source` reads a file's live
    /// text (its open buffer, else the disk).
    pub fn new(
        root: PathBuf,
        rounds: &[AnnotationRound],
        annotations: Vec<EditorComment>,
        overleaf_linked: bool,
        read_source: impl Fn(&str, &App) -> Option<String> + 'static,
        cx: &mut Context<Self>,
    ) -> Self {
        let settled: Vec<AnnotationRound> = rounds
            .iter()
            .filter(|round| round.settled_at.is_some())
            .cloned()
            .collect();
        let numbers: Vec<u32> = settled.iter().map(|round| round.number).collect();
        let read = cx.background_executor().spawn(async move {
            numbers
                .into_iter()
                .map(|number| {
                    lattice_core::project::read_annotation_round(&root, number)
                        .map(|files| (number, files))
                })
                .collect::<Result<std::collections::BTreeMap<_, _>, String>>()
        });
        cx.spawn(async move |this, cx| {
            let read = read.await;
            this.update(cx, |this, cx| {
                match read {
                    Ok(rounds) => {
                        let paths: std::collections::BTreeSet<String> = rounds
                            .values()
                            .flatten()
                            .map(|file| file.path.clone())
                            .collect();
                        let now = paths
                            .into_iter()
                            .map(|path| {
                                let text = read_source(&path, cx);
                                (path, text)
                            })
                            .collect();
                        this.snapshots = Some(Snapshots { rounds, now });
                    }
                    Err(error) => this.error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        let selected = compare::versions(&settled)
            .get(1)
            .cloned()
            .unwrap_or(Version::Now);
        Self {
            settled,
            annotations,
            snapshots: None,
            error: None,
            restoring: false,
            selected,
            base: None,
            cursor: (String::new(), 0),
            scroll: ScrollHandle::new(),
            width: Default::default(),
            overleaf_linked,
        }
    }

    /// The paragraphs the comparison shows, once the rounds are read, with
    /// the annotation numbers behind each (for a scenario).
    pub fn shown_changes(&self) -> Option<Vec<(String, Vec<u32>)>> {
        self.snapshots.as_ref()?;
        Some(self.changes().into_iter().map(|change| (change.newer, change.numbers)).collect())
    }

    /// Open in History, for the round compared (for a scenario).
    pub fn open_in_history(&mut self, cx: &mut Context<Self>) {
        if let Version::Round(number) = self.selected
            && let Some(id) = self.round(number).and_then(|round| round.history_id.clone())
        {
            cx.emit(RoundsSheetEvent::OpenInHistory(id));
        }
    }

    /// Select `version` in the rail, as a click on its row does (for a
    /// scenario).
    pub fn select(&mut self, version: Version, cx: &mut Context<Self>) {
        self.selected = version;
        self.base = None;
        cx.notify();
    }

    /// Ask to restore the version selected, as its Restore button does
    /// (for a scenario).
    pub fn ask_to_restore(&mut self, cx: &mut Context<Self>) {
        self.ask_restore(cx);
    }

    /// The error the sheet shows, if any (for a scenario).
    pub fn shown_error(&self) -> Option<SharedString> {
        self.error.clone()
    }

    /// The restore did not go through: why, and the sheet stays.
    pub fn restore_failed(&mut self, error: String, cx: &mut Context<Self>) {
        self.restoring = false;
        self.error = Some(error.into());
        cx.notify();
    }

    fn round(&self, number: u32) -> Option<&AnnotationRound> {
        self.settled.iter().find(|round| round.number == number)
    }

    fn label(version: &Version) -> SharedString {
        match version {
            Version::Now => t!("Now").into(),
            Version::Before => t!("Before revisions").into(),
            Version::Round(number) => t!("Round {0}", number).into(),
        }
    }

    /// The versions the selected one can be compared with: those older.
    fn older_choices(&self) -> Vec<Version> {
        let versions = compare::versions(&self.settled);
        let at = versions
            .iter()
            .position(|version| *version == self.selected)
            .unwrap_or(0);
        versions[at + 1..].to_vec()
    }

    fn older(&self) -> Option<Version> {
        let choices = self.older_choices();
        self.base
            .clone()
            .filter(|base| choices.contains(base))
            .or_else(|| choices.first().cloned())
    }

    fn changes(&self) -> Vec<Changed> {
        match (&self.snapshots, self.older()) {
            (Some(snapshots), Some(older)) => compare::changes(
                snapshots,
                &self.settled,
                &self.annotations,
                &older,
                &self.selected,
            ),
            _ => Vec::new(),
        }
    }

    fn pair(&self) -> String {
        format!(
            "{}>{}",
            self.older().map(|older| older.key()).unwrap_or_default(),
            self.selected.key()
        )
    }

    fn change_index(&self) -> usize {
        if self.cursor.0 == self.pair() { self.cursor.1 } else { 0 }
    }

    fn go_to(&mut self, index: usize, changes: &[Changed], cx: &mut Context<Self>) {
        if index >= changes.len() {
            return;
        }
        self.cursor = (self.pair(), index);
        // The rows are the scroll area's children after its head, each file's
        // name before its first change when there are several files.
        let several = changes
            .iter()
            .any(|change| change.path != changes[0].path);
        let headers = if several {
            1 + (1..=index)
                .filter(|&at| changes[at].path != changes[at - 1].path)
                .count()
        } else {
            0
        };
        self.scroll.scroll_to_item(1 + headers + index);
        cx.notify();
    }

    fn restore(&mut self, cx: &mut Context<Self>) {
        let Some(snapshots) = &self.snapshots else {
            return;
        };
        if self.selected == Version::Now {
            return;
        }
        let name = Self::label(&self.selected);
        let files = compare::restore_files(snapshots, &self.selected);
        if files.is_empty() {
            self.error = Some(t!("The files already read as {name}.", name = name).into());
            cx.notify();
            return;
        }
        self.restoring = true;
        self.error = None;
        cx.emit(RoundsSheetEvent::Restore {
            label: t!("Restore {name}", name = name),
            files,
        });
        cx.notify();
    }

    /// Ask before restoring, saying what syncing then does in a project
    /// linked to Overleaf.
    fn ask_restore(&mut self, cx: &mut Context<Self>) {
        let name = Self::label(&self.selected);
        let question = if self.overleaf_linked {
            t!(
                "Restore the files the rounds touched to {name}? Syncing then replaces them on Overleaf too, including co-authors' changes made there since; Overleaf's history keeps those.",
                name = name
            )
        } else {
            t!("Restore the files the rounds touched to {name}?", name = name)
        };
        let this = cx.entity().downgrade();
        crate::confirm::ask(
            crate::confirm::Confirm::new(question).on_confirm(move |_, cx| {
                this.update(cx, |sheet, cx| sheet.restore(cx)).ok();
            }),
            cx,
        );
    }

    fn close(cx: &mut Context<Self>) {
        cx.emit(RoundsSheetEvent::Close);
    }
}

/// A round's date and time, short (`Intl.DateTimeFormat` with a short
/// month): "Oct 12, 2:20 PM", "10月12日 14:20".
fn when(at: Option<&str>) -> String {
    let Some(ms) = at.and_then(time::parse_ms) else {
        return String::new();
    };
    let Some(local) = chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.with_timezone(&chrono::Local))
    else {
        return String::new();
    };
    use chrono::Datelike as _;
    let clock = time::clock_time(ms, locale());
    match locale() {
        Locale::ZhCn => format!("{}月{}日 {clock}", local.month(), local.day()),
        _ => format!("{} {}, {clock}", local.format("%b"), local.day()),
    }
}

/// `text` with `spans` struck (`del`) or washed (`ins`).
fn marked(text: &str, spans: Vec<Range<usize>>, deleted: bool, cx: &App) -> StyledText {
    let palette = cx.palette();
    let style = if deleted {
        HighlightStyle {
            color: Some(palette.text_secondary),
            background_color: Some(palette.danger.opacity(0.10)),
            strikethrough: Some(gpui::StrikethroughStyle {
                thickness: px(1.),
                color: Some(palette.danger),
            }),
            ..HighlightStyle::default()
        }
    } else {
        HighlightStyle {
            color: Some(palette.text),
            background_color: Some(palette.success_soft),
            ..HighlightStyle::default()
        }
    };
    let highlights: Vec<(Range<usize>, HighlightStyle)> = spans
        .into_iter()
        .filter(|span| span.end > span.start)
        .map(|span| (span, style))
        .collect();
    StyledText::new(SharedString::from(text.to_string())).with_highlights(highlights)
}

impl RoundsSheet {
    fn render_rail(&self, narrow: bool, older: Option<&Version>, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let now_edited = self.snapshots.as_ref().is_some_and(Snapshots::now_edited);
        let versions = compare::versions(&self.settled);
        let mut rail = div()
            .id("annotation-rounds-rail")
            .flex()
            .gap(px(2.))
            .min_h_0()
            .when(narrow, |rail| {
                rail.flex_row()
                    .overflow_x_scroll()
                    .pb(px(8.))
                    .border_b_1()
                    .border_color(palette.line)
            })
            .when(!narrow, |rail| {
                rail.flex_col()
                    .w(px(220.))
                    .flex_none()
                    .overflow_y_scroll()
                    .pr(px(8.))
                    .border_r_1()
                    .border_color(palette.line)
            });
        for (index, version) in versions.into_iter().enumerate() {
            let current = version == self.selected;
            let is_base = older == Some(&version);
            let detail: Option<String> = match &version {
                Version::Now => None,
                Version::Before => Some(when(self.settled.first().map(|round| round.started_at.as_str()))),
                Version::Round(number) => self.round(*number).map(|round| {
                    let count = round.outcomes.len();
                    let annotations = if count == 1 {
                        t!("1 annotation").to_string()
                    } else {
                        t!("{0} annotations", count)
                    };
                    join_phrases(&[when(round.settled_at.as_deref()), annotations])
                }),
            };
            let tag = match &version {
                Version::Round(number) => self.round(*number).map(|round| {
                    let (accepted, rejected, open) = compare::outcome_counts(round);
                    let mut parts = Vec::new();
                    if accepted > 0 {
                        parts.push(t!("{accepted} accepted", accepted = accepted));
                    }
                    if rejected > 0 {
                        parts.push(t!("{rejected} rejected", rejected = rejected));
                    }
                    if open > 0 {
                        parts.push(t!("{open} open", open = open));
                    }
                    join_phrases(&parts)
                }),
                _ => None,
            }
            .filter(|tag| !tag.is_empty());
            let chosen = version.clone();
            rail = rail.child(
                div()
                    .id(("annotation-version", index))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .flex_none()
                    .when(narrow, |row| row.min_w(px(150.)))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(8.))
                    .when(current, |row| {
                        row.bg(palette.raised).border_1().border_color(palette.line)
                    })
                    .when(is_base, |row| row.border_l_2().border_color(palette.accent))
                    .hover(|row| row.bg(palette.hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected = chosen.clone();
                        this.base = None;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_role(TextRole::Body, cx)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(palette.text)
                            .child(Self::label(&version))
                            .when(version == Version::Now && now_edited, |name| {
                                name.child(
                                    div()
                                        .size(px(5.))
                                        .rounded_full()
                                        .flex_none()
                                        .bg(palette.text_secondary),
                                )
                            }),
                    )
                    .children(detail.map(|detail| {
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(detail)
                    }))
                    .children(tag.map(|tag| {
                        div().flex().child(
                            div()
                                .mt(px(2.))
                                .px(px(6.))
                                .rounded(px(4.))
                                .bg(palette.hover)
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text)
                                .whitespace_nowrap()
                                .child(tag),
                        )
                    })),
            );
        }
        rail.into_any_element()
    }

    fn render_compare(&self, narrow: bool, older: Option<Version>, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let changes = self.changes();
        let index = self.change_index();
        let newer_name = Self::label(&self.selected);
        let title: SharedString = match &older {
            Some(older) => t!("{0} → {1}", Self::label(older), newer_name).into(),
            None => newer_name.clone(),
        };
        let history_id = match &self.selected {
            Version::Round(number) => self.round(*number).and_then(|round| round.history_id.clone()),
            _ => None,
        };
        let count = (!changes.is_empty()).then(|| {
            let (up, down) = (changes.clone(), changes.clone());
            div()
                .flex()
                .items_center()
                .gap(px(2.))
                .child(if changes.len() == 1 {
                    t!("1 change").to_string()
                } else {
                    t!("{0} changes", changes.len())
                })
                .child(
                    IconButton::new("annotation-compare-previous", Icon::ARROW_UP)
                        .frame(px(24.), px(24.))
                        .icon_size(px(13.))
                        .tooltip(t!("Previous change"))
                        .disabled(index == 0)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.go_to(index.saturating_sub(1), &up, cx)
                        })),
                )
                .child(
                    IconButton::new("annotation-compare-next", Icon::ARROW_DOWN)
                        .frame(px(24.), px(24.))
                        .icon_size(px(13.))
                        .tooltip(t!("Next change"))
                        .disabled(index + 1 >= changes.len())
                        .on_click(cx.listener(move |this, _, _, cx| this.go_to(index + 1, &down, cx))),
                )
        });
        let bar = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(12.))
            .gap_y(px(6.))
            .min_w_0()
            .text_role(TextRole::Body, cx)
            .text_color(palette.text_secondary)
            .child(
                div()
                    .min_w_0()
                    .text_color(palette.text)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .child(title),
            )
            .children(count)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(4.))
                    .ml_auto()
                    .children(history_id.map(|id| {
                        Button::new("annotation-open-history", t!("Open in History"))
                            .ghost()
                            .compact()
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.emit(RoundsSheetEvent::OpenInHistory(id.clone()))
                            }))
                    }))
                    .when(self.selected != Version::Now, |actions| {
                        actions.child(
                            Button::new("annotation-restore-round", t!("Restore {0}", newer_name))
                                .ghost()
                                .compact()
                                .icon(Icon::ROTATE_CCW)
                                .disabled(self.restoring || self.snapshots.is_none())
                                .on_click(cx.listener(|this, _, _, cx| this.ask_restore(cx))),
                        )
                    }),
            );
        let message = |text: SharedString| {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(text)
                .into_any_element()
        };
        let body: AnyElement = if self.snapshots.is_none() {
            message(t!("Reading the rounds…").into())
        } else if older.is_none() {
            message(t!("This is the earliest version").into())
        } else if changes.is_empty() {
            message(t!("The two versions read the same").into())
        } else {
            let older_name = older.as_ref().map(Self::label).unwrap_or_default();
            let several = changes.iter().any(|change| change.path != changes[0].path);
            let mut columns = div()
                .id("annotation-compare-columns")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(
                    div()
                        .when(narrow, |head| head.hidden())
                        .flex()
                        .gap(px(12.))
                        .pb(px(4.))
                        .bg(palette.raised)
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(div().flex_1().min_w_0().child(older_name))
                        .child(div().flex_1().min_w_0().child(newer_name.clone())),
                );
            for (at, change) in changes.iter().enumerate() {
                if several && (at == 0 || changes[at - 1].path != change.path) {
                    columns = columns.child(
                        div()
                            .mt(px(8.))
                            .text_role(TextRole::Caption, cx)
                            .font_family(cx.lattice().fonts.editor.clone())
                            .text_color(palette.text_secondary)
                            .child(change.path.clone()),
                    );
                }
                let hunks = diff::hunks(&change.older, &change.newer);
                let deleted: Vec<Range<usize>> =
                    hunks.iter().map(|hunk| hunk.base_from..hunk.base_to).collect();
                let inserted: Vec<Range<usize>> = hunks.iter().map(|hunk| hunk.from..hunk.to).collect();
                let current = at == index;
                let card = |content: AnyElement| {
                    div()
                        .flex_1()
                        .min_w_0()
                        .px(px(12.))
                        .py(px(10.))
                        .rounded(px(10.))
                        .bg(palette.panel)
                        .border_1()
                        .border_color(if current { palette.line_strong } else { palette.line })
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text)
                        .whitespace_normal()
                        .child(content)
                };
                let placeholder = |text: &'static str| {
                    div().italic().text_color(palette.text_secondary).child(text).into_any_element()
                };
                let left = if change.older.is_empty() {
                    placeholder(t!("(new paragraph)"))
                } else {
                    marked(&change.older, deleted, true, cx).into_any_element()
                };
                let right = div()
                    .children(change.numbers.iter().map(|number| {
                        div()
                            .mr(px(4.))
                            .px(px(4.))
                            .min_w(px(16.))
                            .h(px(16.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .bg(palette.accent)
                            .text_color(palette.accent_contrast)
                            .text_role(TextRole::Micro, cx)
                            .child(number.to_string())
                    }))
                    .child(if change.newer.is_empty() {
                        placeholder(t!("(removed)"))
                    } else {
                        marked(&change.newer, inserted, false, cx).into_any_element()
                    })
                    .flex()
                    .flex_wrap()
                    .items_start()
                    .into_any_element();
                columns = columns.child(
                    div()
                        .flex()
                        .when(narrow, |row| row.flex_col())
                        .gap(px(if narrow { 6. } else { 12. }))
                        .child(card(left))
                        .child(card(right)),
                );
            }
            columns.into_any_element()
        };
        let choices = self.older_choices();
        let base_row = (choices.len() > 1).then(|| {
            let mut row = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(4.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(t!("Compare with"));
            for (at, version) in choices.into_iter().enumerate() {
                let pressed = older.as_ref() == Some(&version);
                let chosen = version.clone();
                row = row.child(
                    div()
                        .id(("annotation-compare-base", at))
                        .h(px(24.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .rounded_full()
                        .when(pressed, |pill| pill.border_1().border_color(palette.accent).text_color(palette.text))
                        .hover(|pill| pill.bg(palette.hover))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.base = Some(chosen.clone());
                            cx.notify();
                        }))
                        .child(Self::label(&version)),
                );
            }
            row
        });
        div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(bar)
            .children(self.error.clone().map(|error| {
                crate::history::widgets::inline_message(error, true, cx)
            }))
            .child(body)
            .children(base_row)
            .into_any_element()
    }
}

impl Render for RoundsSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let width = self.width.clone();
        let narrow = self.width.get() > 0. && self.width.get() <= NARROW;
        let older = self.older();
        let rail = self.render_rail(narrow, older.as_ref(), cx);
        let compare = self.render_compare(narrow, older, cx);
        let measure = gpui::canvas(
            move |bounds, _, _| width.set(f32::from(bounds.size.width)),
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let body = div()
            .relative()
            .flex_1()
            .min_h_0()
            .h_full()
            .flex()
            .when(narrow, |body| body.flex_col().gap(px(10.)))
            .when(!narrow, |body| body.gap(px(16.)))
            .child(measure)
            .child(rail)
            .child(compare);
        let this = cx.entity().downgrade();
        let sheet = Sheet::new("annotation-rounds", t!("Revision rounds"))
            .on_close({
                let this = this.clone();
                move |window, cx| {
                    let this = this.clone();
                    ModalLayer::leave("annotation-rounds", window, cx, move |_, cx| {
                        this.update(cx, |_, cx| Self::close(cx)).ok();
                    });
                }
            })
            .child(body);
        let _ = window;
        ModalLayer::new("annotation-rounds", LayerPlacement::Center, sheet, move |_, cx| {
            this.update(cx, |_, cx| Self::close(cx)).ok();
        })
    }
}
