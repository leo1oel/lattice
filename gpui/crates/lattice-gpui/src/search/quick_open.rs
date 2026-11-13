//! Quick open (⌘P), as the Tauri app draws and ranks it
//! (`src/project/quick-open-dialog.tsx` over `search-picker-dialog.tsx`,
//! `.quick-open-*` in `src/styles/app-shell.css`).
//!
//! An empty query lists the files visited this session first, newest first
//! and without the one on screen, so ⌘P ↩ goes back to the previous file;
//! every other file follows. A typed query ranks every file, recent ones a
//! little higher. Two prefixes reach the other pickers' targets: `@` lists
//! the manuscript's sections and the project's labels, and `:42` goes to a
//! line of the file on screen; a path query ending in `:42` opens that file
//! at the line. The footer names both prefixes.
//!
//! The card is 560px wide (the window less 40px), 18% of the window down:
//! the query in a borderless 40px field over a hairline, then 32px rows 6px
//! in under one fill that glides to the current row, and the footer. ↑↓ (and
//! ⌃N ⌃P) move and stop at the ends, ↩ opens, ⎋ or a press outside closes.

use std::{collections::HashMap, ops::Range};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    HighlightStyle, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    ParentElement as _, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledText, Subscription, Task, UnderlineStyle, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_ui::{
    ActiveLattice as _, Elevation, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::{Keycap, rise_in},
    fluid_hover::FluidHover,
    icons::{ICON, ICON_SMALL, file_glyph},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{
    ranking::{RankedRow, match_ranges, rank, score_item, score_path},
    symbols::{Symbol, project_symbols},
};
use crate::shell::Shell;

const WIDTH: f32 = 560.;
const LIST_HEIGHT: f32 = 360.;
/// How many visited files an empty query lists before the rest.
const RECENT_SHOWN: usize = 6;
/// What each step up the recent list adds to a typed match's score.
const RECENCY_BOOST: i64 = 12;
const RESULT_LIMIT: usize = 40;
/// The list's inset, and the rows' corner inside the dialog's 14px one.
const LIST_INSET: f32 = 6.;
const ROW_RADIUS: f32 = 14. - LIST_INSET;

/// One row.
#[derive(Clone, Debug, PartialEq)]
enum Row {
    File {
        path: String,
        group: Option<&'static str>,
        line: Option<u32>,
        current: bool,
    },
    Symbol {
        ix: usize,
    },
    Line(u32),
}

/// What quick open opens with, read from the window when it opens.
pub struct QuickOpenSource {
    /// Every file in the project tree, project-relative.
    pub paths: Vec<String>,
    /// The files visited this session, newest first.
    pub recent: Vec<String>,
    /// The file on screen, tagged in the list.
    pub current: Option<String>,
    /// Where `:42` goes: the document on screen, if it has lines.
    pub line_target: Option<String>,
    pub root: std::path::PathBuf,
    pub main: Option<String>,
}

/// What a pick asks the window to do.
#[derive(Clone, Debug, PartialEq)]
pub enum QuickOpenPick {
    Open { path: String, line: Option<u32> },
    Line(u32),
}

pub enum QuickOpenEvent {
    Dismiss,
}

pub struct QuickOpen {
    shell: WeakEntity<Shell>,
    input: Entity<InputState>,
    focus: FocusHandle,
    source: QuickOpenSource,
    /// The recent files shown for an empty query, and each one's boost.
    recent: Vec<String>,
    recency: HashMap<String, i64>,
    /// Go to symbol's items, read the first time `@` is typed.
    symbols: Option<Vec<Symbol>>,
    symbols_task: Option<Task<()>>,
    rows: Vec<Row>,
    sectioned: bool,
    query: String,
    active: usize,
    scroll: ScrollHandle,
    /// The row the fluid hover lit when this last drew: a row it lights
    /// afterwards (a pointer that really moved) becomes the current one.
    adopted: Option<usize>,
    _subscription: Subscription,
}

impl EventEmitter<QuickOpenEvent> for QuickOpen {}

impl QuickOpen {
    pub fn new(
        shell: WeakEntity<Shell>,
        source: QuickOpenSource,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Open file…"));
        let subscription =
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.search(cx),
                InputEvent::PressEnter { .. } => this.select(this.active, window, cx),
                _ => {}
            });
        let present: std::collections::HashSet<&str> =
            source.paths.iter().map(String::as_str).collect();
        let recent: Vec<String> = source
            .recent
            .iter()
            .filter(|path| Some(path.as_str()) != source.current.as_deref())
            .filter(|path| present.contains(path.as_str()))
            .take(RECENT_SHOWN)
            .cloned()
            .collect();
        let recency = recent
            .iter()
            .enumerate()
            .map(|(ix, path)| (path.clone(), (RECENT_SHOWN - ix) as i64))
            .collect();
        let mut this = Self {
            shell,
            input,
            focus: cx.focus_handle(),
            source,
            recent,
            recency,
            symbols: None,
            symbols_task: None,
            rows: Vec::new(),
            sectioned: false,
            query: String::new(),
            active: 0,
            scroll: ScrollHandle::new(),
            adopted: None,
            _subscription: subscription,
        };
        this.search(cx);
        this
    }

    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    /// The rows' text as the list shows them (`name folder tag`), for a
    /// scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn row_texts(&self) -> Vec<String> {
        self.rows
            .iter()
            .map(|row| match row {
                Row::File { path, line, .. } => match line {
                    Some(line) => format!("{path}:{line}"),
                    None => path.clone(),
                },
                Row::Symbol { ix } => self
                    .symbols
                    .as_ref()
                    .and_then(|symbols| symbols.get(*ix))
                    .map(|symbol| format!("@{}", symbol.label))
                    .unwrap_or_default(),
                Row::Line(line) => format!(":{line}"),
            })
            .collect()
    }

    /// Pick the current row, as ↩ does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.select(self.active, window, cx);
    }

    /// Whether the `@` items are still being read.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn reading_symbols(&self) -> bool {
        self.symbols_task.is_some()
    }

    fn search(&mut self, cx: &mut Context<Self>) {
        self.query = self.input.read(cx).value().trim().to_string();
        if self.query.starts_with('@') && self.symbols.is_none() && self.symbols_task.is_none() {
            let root = self.source.root.clone();
            let main = self.source.main.clone();
            self.symbols_task = Some(cx.spawn(async move |this, cx| {
                let symbols = cx
                    .background_executor()
                    .spawn(async move { project_symbols(&root, main.as_deref()) })
                    .await;
                this.update(cx, |this, cx| {
                    this.symbols = Some(symbols);
                    this.symbols_task = None;
                    this.search(cx);
                })
                .ok();
            }));
        }
        let rows = self.rank();
        let mut order: Vec<Option<&'static str>> = Vec::new();
        for row in &rows {
            let group = self.group_of(row);
            if !order.contains(&group) {
                order.push(group);
            }
        }
        self.sectioned = order.len() > 1;
        // Grouped by first appearance, as the app's sections are.
        self.rows = order
            .iter()
            .flat_map(|group| {
                rows.iter()
                    .filter(|row| self.group_of(row) == *group)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect();
        self.active = 0;
        self.scroll.scroll_to_item(0);
        cx.notify();
    }

    fn group_of(&self, row: &Row) -> Option<&'static str> {
        match row {
            Row::File { group, .. } => *group,
            Row::Symbol { ix } => self
                .symbols
                .as_ref()
                .and_then(|symbols| symbols.get(*ix))
                .map(|symbol| symbol.group.label()),
            Row::Line(_) => None,
        }
    }

    fn rank(&self) -> Vec<Row> {
        let query = self.query.as_str();
        let current = self.source.current.as_deref();
        if let Some(needle) = query.strip_prefix('@') {
            let Some(symbols) = &self.symbols else {
                return Vec::new();
            };
            let needle = needle.trim();
            return rank(
                symbols,
                |symbol| {
                    score_item(
                        &RankedRow {
                            label: &symbol.label,
                            detail: &symbol.detail,
                            group: symbol.group.label(),
                        },
                        needle,
                    )
                },
                |_, _| std::cmp::Ordering::Equal,
                RESULT_LIMIT,
            )
            .into_iter()
            .map(|ix| Row::Symbol { ix })
            .collect();
        }
        if let Some(line) = line_only(query) {
            return if self.source.line_target.is_some() {
                vec![Row::Line(line)]
            } else {
                Vec::new()
            };
        }
        if query.is_empty() {
            let mut rest: Vec<&String> = self
                .source
                .paths
                .iter()
                .filter(|path| !self.recency.contains_key(*path))
                .collect();
            rest.sort();
            return self
                .recent
                .iter()
                .map(|path| Row::File {
                    path: path.clone(),
                    group: Some("Recent"),
                    line: None,
                    current: false,
                })
                .chain(rest.into_iter().take(RESULT_LIMIT).map(|path| Row::File {
                    path: path.clone(),
                    group: Some("All files"),
                    line: None,
                    current: Some(path.as_str()) == current,
                }))
                .collect();
        }
        let (needle, line) = path_with_line(query);
        rank(
            &self.source.paths,
            |path| {
                let score = score_path(path, needle);
                if score > 0 {
                    score + self.recency.get(path).copied().unwrap_or(0) * RECENCY_BOOST
                } else {
                    0
                }
            },
            |a, b| a.cmp(b),
            RESULT_LIMIT,
        )
        .into_iter()
        .map(|ix| {
            let path = &self.source.paths[ix];
            Row::File {
                path: path.clone(),
                group: None,
                line,
                current: Some(path.as_str()) == current,
            }
        })
        .collect()
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        if self.rows.is_empty() {
            return;
        }
        let last = self.rows.len() as isize - 1;
        self.active = (self.active as isize + by).clamp(0, last) as usize;
        self.scroll.scroll_to_item(self.list_child(self.active));
        cx.notify();
    }

    /// The list's child that shows row `ix`: the fill comes first, and a
    /// section heading stands before each section's first row.
    fn list_child(&self, ix: usize) -> usize {
        let headings = if self.sectioned {
            (0..=ix)
                .filter(|&at| {
                    at == 0 || self.group_of(&self.rows[at]) != self.group_of(&self.rows[at - 1])
                })
                .count()
        } else {
            0
        };
        1 + ix + headings
    }

    fn select(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get(ix).cloned() else {
            return;
        };
        let pick = match row {
            Row::File { path, line, .. } => QuickOpenPick::Open { path, line },
            Row::Symbol { ix } => {
                let Some(symbol) = self.symbols.as_ref().and_then(|symbols| symbols.get(ix)) else {
                    return;
                };
                QuickOpenPick::Open {
                    path: symbol.path.clone(),
                    line: Some(symbol.line),
                }
            }
            Row::Line(line) => QuickOpenPick::Line(line),
        };
        cx.emit(QuickOpenEvent::Dismiss);
        let shell = self.shell.clone();
        window.defer(cx, move |window, cx| {
            shell
                .update(cx, |shell, cx| shell.quick_open_pick(pick, window, cx))
                .ok();
        });
    }

    fn render_row(
        &self,
        ix: usize,
        row: &Row,
        hover: &FluidHover,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let active = ix == self.active;
        let ink = if active {
            palette.text
        } else {
            palette.text_secondary
        };
        let query = matched_query(&self.query);
        let (icon, name, folder, tag): (AnyElement, AnyElement, Option<String>, Option<String>) =
            match row {
                Row::File {
                    path,
                    line,
                    current,
                    ..
                } => {
                    let (folder, file) = match path.rsplit_once('/') {
                        Some((folder, file)) => (Some(folder.to_string()), file.to_string()),
                        None => (None, path.clone()),
                    };
                    (
                        file_glyph(GlyphKind::for_name(&file), ICON, &palette),
                        marked(file, query, cx),
                        folder,
                        match line {
                            Some(line) => Some(format!(":{line}")),
                            None => current.then(|| "Current".to_string()),
                        },
                    )
                }
                Row::Symbol { ix } => {
                    let symbol = self
                        .symbols
                        .as_ref()
                        .and_then(|symbols| symbols.get(*ix))
                        .cloned();
                    let (label, detail) = symbol
                        .map(|symbol| (symbol.label, symbol.detail))
                        .unwrap_or_default();
                    (
                        Icon::HASH.element(ICON, ink).into_any_element(),
                        marked(label, query, cx),
                        Some(detail),
                        None,
                    )
                }
                Row::Line(line) => (
                    Icon::TEXT_CURSOR_INPUT
                        .element(ICON, ink)
                        .into_any_element(),
                    div()
                        .text_color(palette.text)
                        .child(format!("Go to line {line}"))
                        .into_any_element(),
                    self.source.line_target.clone(),
                    None,
                ),
            };
        div()
            .id(("quick-open-row", ix))
            .relative()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_h(px(32.))
            .px(px(10.))
            .py(px(6.))
            .min_w_0()
            .overflow_hidden()
            .cursor_pointer()
            .text_role(TextRole::Body, cx)
            // The current row's own wash, shown while the gliding fill is
            // elsewhere or gone, as the palette's.
            .when(active && !hover.is_lit(ix, cx), |row| {
                row.rounded(px(ROW_RADIUS)).bg(palette.accent_soft)
            })
            .on_click(cx.listener(move |this, _, window, cx| this.select(ix, window, cx)))
            .child(div().flex_none().flex().child(icon))
            .child(
                div()
                    .flex_none()
                    .max_w(gpui::relative(0.7))
                    .min_w_0()
                    .truncate()
                    .child(name),
            )
            .children(folder.filter(|folder| !folder.is_empty()).map(|folder| {
                div()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(folder)
            }))
            .children(tag.map(|tag| {
                div()
                    .ml_auto()
                    .flex_none()
                    .pl(px(8.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(tag)
            }))
            .into_any_element()
    }
}

/// `:42`, a line of the file on screen.
fn line_only(query: &str) -> Option<u32> {
    let digits = query.strip_prefix(':')?;
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// `name:42`, a path query that opens at a line: the path part and the
/// line.
fn path_with_line(query: &str) -> (&str, Option<u32>) {
    if let Some((path, line)) = query.rsplit_once(':')
        && !path.is_empty()
        && !line.is_empty()
        && line.chars().all(|c| c.is_ascii_digit())
        && let Ok(line) = line.parse()
    {
        return (path.trim(), Some(line));
    }
    (query, None)
}

/// The part of the query a row's text was matched against, without its
/// prefix or line.
fn matched_query(query: &str) -> &str {
    match query.strip_prefix('@') {
        Some(rest) => rest.trim(),
        None => path_with_line(query).0.trim(),
    }
}

/// `text` with the query's characters marked: semibold on an accent
/// underline, the rest of the text a step quieter, so the match is what
/// reads.
fn marked(text: String, query: &str, cx: &App) -> AnyElement {
    let palette = cx.palette();
    let ranges: Vec<Range<usize>> = match_ranges(&text, query);
    if ranges.is_empty() {
        return div()
            .text_color(palette.text)
            .child(text)
            .into_any_element();
    }
    let mark = HighlightStyle {
        color: Some(palette.text),
        font_weight: Some(FONT_WEIGHT_SEMIBOLD),
        underline: Some(UnderlineStyle {
            thickness: px(1.5),
            color: Some(palette.accent.opacity(0.55)),
            wavy: false,
        }),
        ..Default::default()
    };
    let highlights = ranges
        .into_iter()
        .map(|range| (range, mark))
        .collect::<Vec<_>>();
    div()
        .text_color(palette.text_secondary)
        .child(StyledText::new(SharedString::from(text)).with_highlights(highlights))
        .into_any_element()
}

impl Focusable for QuickOpen {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Render for QuickOpen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = px(WIDTH).min(viewport.width - px(40.));
        // One fill for the pointer and the keys, gliding between rows, as
        // the app's picker (`search-picker-dialog.tsx`) and the command
        // palette: the row the pointer lights becomes the current one, as a
        // pointer that really moves does there; rows scrolled under a
        // resting pointer change nothing.
        let hover = FluidHover::new("quick-open-hover", window, cx)
            .fill(palette.accent_soft)
            .radius(px(ROW_RADIUS));
        let lit = hover.lit(cx);
        if lit != self.adopted {
            if let Some(lit) = lit.filter(|lit| *lit < self.rows.len()) {
                self.active = lit;
            }
        }
        let hover = hover.follow((!self.rows.is_empty()).then_some(self.active), cx);
        self.adopted = hover.lit(cx);
        let mut list: Vec<AnyElement> = vec![hover.highlight()];
        for (ix, row) in self.rows.iter().enumerate() {
            let group = self.group_of(row);
            if self.sectioned && (ix == 0 || group != self.group_of(&self.rows[ix - 1])) {
                list.push(
                    div()
                        .px(px(10.))
                        .pt(px(if ix == 0 { 4. } else { 12. }))
                        .pb(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .children(group)
                        .into_any_element(),
                );
            }
            list.push(hover.item(ix, self.render_row(ix, row, &hover, cx)));
        }
        let has_query = !self.input.read(cx).value().is_empty();
        let header = div()
            .relative()
            .flex()
            .items_center()
            .px(px(8.))
            .py(px(6.))
            .border_b_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h(px(40.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .child(Icon::SEARCH.element(ICON, palette.text_secondary))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_role(TextRole::Body, cx)
                            .child(Input::new(&self.input).appearance(false).bordered(false)),
                    )
                    .when(has_query, |field| {
                        field.child(
                            div()
                                .id("quick-open-clear")
                                .flex_none()
                                .w(px(20.))
                                .h(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(6.))
                                .cursor_pointer()
                                .hover(|this| this.bg(palette.line))
                                .on_mouse_down(MouseButton::Left, |_, window, _| {
                                    window.prevent_default()
                                })
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.input.update(cx, |input, cx| {
                                        input.set_value("", window, cx);
                                        input.focus(window, cx);
                                    });
                                    this.search(cx);
                                }))
                                .child(Icon::X.element(ICON_SMALL, palette.text_secondary)),
                        )
                    }),
            );
        let empty = self.rows.is_empty() && self.symbols_task.is_none();
        let footer = div()
            .relative()
            .flex()
            .items_center()
            .px(px(12.))
            .py(px(8.))
            .border_t_1()
            .border_color(palette.line)
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(
                div()
                    .flex()
                    .gap(px(16.))
                    .min_w_0()
                    .overflow_hidden()
                    .child(scope("@", "Sections and labels"))
                    // A narrow window drops the line prefix first: ⌘G reaches
                    // it too.
                    .when(viewport.width > px(480.), |this| {
                        this.child(scope(":", "Line"))
                    }),
            );
        let card = div()
            .id("quick-open")
            .w(width)
            .flex()
            .flex_col()
            .rounded(px(14.))
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .when(empty, |card| {
                card.child(
                    div()
                        .px(px(16.))
                        .py(px(16.))
                        .flex()
                        .justify_center()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child("No matching files"),
                )
            })
            .when(!self.rows.is_empty(), |card| {
                card.child(
                    div()
                        .id("quick-open-list")
                        .max_h(px(LIST_HEIGHT).min(viewport.height * 0.5))
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .relative()
                        .flex()
                        .flex_col()
                        .p(px(LIST_INSET))
                        .children(list),
                )
            })
            .child(footer);
        div()
            .id("quick-open-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .pt(viewport.height * 0.18)
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                let keystroke = &event.keystroke;
                let control = keystroke.modifiers.control && !keystroke.modifiers.platform;
                match keystroke.key.as_str() {
                    "up" => this.step(-1, cx),
                    "down" => this.step(1, cx),
                    "p" if control => this.step(-1, cx),
                    "n" if control => this.step(1, cx),
                    "escape" => cx.emit(QuickOpenEvent::Dismiss),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(QuickOpenEvent::Dismiss)),
            )
            .child(rise_in("quick-open-in", card))
    }
}

/// A footer hint: the prefix's keycap, then what it reaches.
fn scope(key: &'static str, label: &'static str) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .whitespace_nowrap()
        .child(Keycap::new(key))
        .child(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_query_is_digits_after_a_colon() {
        assert_eq!(line_only(":42"), Some(42));
        assert_eq!(line_only(":"), None);
        assert_eq!(line_only(":4x"), None);
        assert_eq!(line_only("main:4"), None);
    }

    #[test]
    fn a_path_query_may_end_at_a_line() {
        assert_eq!(path_with_line("main.tex:12"), ("main.tex", Some(12)));
        assert_eq!(path_with_line("main.tex"), ("main.tex", None));
        assert_eq!(path_with_line("main.tex:"), ("main.tex:", None));
        assert_eq!(matched_query("@ intro"), "intro");
        assert_eq!(matched_query("intro:3"), "intro");
    }
}
