//! Find in project (⌘⇧F), as the Tauri app has it
//! (`src/project/project-find-dialog.tsx`, `src/app/use-project-search.ts`,
//! `.project-find*` in `src/styles/app-shell.css`).
//!
//! The query runs 180 ms after the last keystroke, over the project's text
//! files and the papers library (lattice-core's `search_files` and
//! `search_library`, the Tauri app's `search_project`); a search answers only
//! while it is the newest one. All, Files and Papers only filter what was
//! found, each tab carrying its count. A file's hits gather under one header
//! naming it with a count of its run, each hit its line number in a 40px
//! column and the line, the query's terms marked; a paper's hits keep their
//! own rows under a Papers heading. ↑↓ move the one fill that glides between
//! hits, ↩ opens the current hit, F3 and ⇧F3 step through them opening
//! each. The query and the tab are kept across reopening, the query coming
//! back selected.

use std::{collections::HashSet, ops::Range, path::PathBuf, time::Duration};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    HighlightStyle, InteractiveElement as _, IntoElement, KeyDownEvent, MouseMoveEvent,
    ParentElement as _, Point, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledText, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::models::ProjectSearchResult;
use lattice_ui::{
    ActiveLattice as _, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::Button,
    icons::{ICON, file_glyph},
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{field::search_field, glide::Glide, sheet::SheetFrame};

const DEBOUNCE: Duration = Duration::from_millis(180);

/// Which hits show: the search always runs over both, so a switch never
/// searches again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FindScope {
    #[default]
    All,
    Files,
    Papers,
}

/// What Find keeps between openings.
#[derive(Clone, Debug, Default)]
pub struct FindMemory {
    pub query: String,
    pub scope: FindScope,
}

pub enum ProjectFindEvent {
    Dismiss,
    /// Open a hit (project-relative), at its line.
    Open {
        path: String,
        line: Option<u32>,
    },
}

pub struct ProjectFind {
    root: PathBuf,
    input: Entity<InputState>,
    focus: FocusHandle,
    scope: FindScope,
    hits: Vec<ProjectSearchResult>,
    /// The query the hits answer.
    answered: String,
    busy: bool,
    /// Typed, and the search not yet run.
    debouncing: bool,
    error: Option<String>,
    active: usize,
    generation: u64,
    search_task: Option<Task<()>>,
    scroll: ScrollHandle,
    glide: Glide,
    pointer: Option<Point<gpui::Pixels>>,
    _subscription: Subscription,
}

impl EventEmitter<ProjectFindEvent> for ProjectFind {}

impl ProjectFind {
    pub fn new(
        root: PathBuf,
        memory: FindMemory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Search files and papers…");
            state.set_value(memory.query.clone(), window, cx);
            state
        });
        let subscription =
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.query_changed(cx),
                InputEvent::PressEnter { secondary, .. } if !secondary => {
                    if this.showing_results(cx) {
                        this.open(this.active, window, cx);
                    }
                }
                _ => {}
            });
        let mut this = Self {
            root,
            input,
            focus: cx.focus_handle(),
            scope: memory.scope,
            hits: Vec::new(),
            answered: String::new(),
            busy: false,
            debouncing: false,
            error: None,
            active: 0,
            generation: 0,
            search_task: None,
            scroll: ScrollHandle::new(),
            glide: Glide::default(),
            pointer: None,
            _subscription: subscription,
        };
        // Reopening runs the kept query again; until it answers it shows as
        // searching rather than as a query with no results.
        this.query_changed(cx);
        this
    }

    /// Give the field the keyboard, its kept query selected: ↩ repeats it,
    /// typing replaces it.
    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
    }

    pub fn memory(&self, cx: &App) -> FindMemory {
        FindMemory {
            query: self.input.read(cx).value().to_string(),
            scope: self.scope,
        }
    }

    fn query(&self, cx: &App) -> String {
        self.input.read(cx).value().trim().to_string()
    }

    fn query_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.query(cx);
        self.generation += 1;
        let generation = self.generation;
        if query.is_empty() {
            self.debouncing = false;
            self.busy = false;
            self.hits.clear();
            self.answered.clear();
            self.error = None;
            self.search_task = None;
            cx.notify();
            return;
        }
        self.debouncing = true;
        let root = self.root.clone();
        self.search_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DEBOUNCE).await;
            let ready = this
                .update(cx, |this, cx| {
                    this.debouncing = false;
                    this.busy = true;
                    cx.notify();
                })
                .is_ok();
            if !ready {
                return;
            }
            let needle = query.clone();
            let found = cx
                .background_executor()
                .spawn(async move { search_project(&root, &needle) })
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                match found {
                    Ok(hits) => {
                        this.hits = hits;
                        this.error = None;
                    }
                    Err(error) => {
                        this.hits.clear();
                        this.error = Some(error);
                    }
                }
                this.answered = query;
                this.active = 0;
                this.glide.reset();
                this.scroll.scroll_to_item(0);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn searching(&self) -> bool {
        self.debouncing || self.busy
    }

    fn showing_results(&self, cx: &App) -> bool {
        !self.query(cx).is_empty() && !self.searching() && self.error.is_none()
    }

    fn file_hits(&self) -> Vec<&ProjectSearchResult> {
        self.hits.iter().filter(|hit| hit.kind == "file").collect()
    }

    fn paper_hits(&self) -> Vec<&ProjectSearchResult> {
        self.hits.iter().filter(|hit| hit.kind == "paper").collect()
    }

    /// The hits the keys move over, in the order they are shown.
    fn selectable(&self) -> Vec<&ProjectSearchResult> {
        let mut hits = Vec::new();
        if self.scope != FindScope::Papers {
            hits.extend(self.file_hits());
        }
        if self.scope != FindScope::Files {
            hits.extend(self.paper_hits());
        }
        hits
    }

    /// One paper can match several times (title, overview and full-text
    /// lines); the count is of papers, each library key once.
    fn paper_count(&self) -> usize {
        self.paper_hits()
            .iter()
            .map(|hit| paper_key(&hit.path))
            .collect::<HashSet<_>>()
            .len()
    }

    fn set_scope(&mut self, scope: FindScope, cx: &mut Context<Self>) {
        self.scope = scope;
        self.active = 0;
        self.glide.reset();
        cx.notify();
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let count = self.selectable().len();
        if count == 0 {
            return;
        }
        self.active = (self.active as isize + by).clamp(0, count as isize - 1) as usize;
        self.reveal_active();
        cx.notify();
    }

    fn reveal_active(&self) {
        if let Some(child) = self.list_child(self.active) {
            self.scroll.scroll_to_item(child);
        }
    }

    /// The list's child that draws hit `ix`: the fill first, then each
    /// file's header before its run, and the Papers heading before the
    /// papers when files show too.
    fn list_child(&self, ix: usize) -> Option<usize> {
        let hits = self.selectable();
        let mut child = 1;
        for (at, hit) in hits.iter().enumerate() {
            let paper = hit.kind == "paper";
            let starts_group = !paper && (at == 0 || hits[at - 1].path != hit.path);
            let papers_heading =
                paper && self.scope == FindScope::All && (at == 0 || hits[at - 1].kind != "paper");
            if starts_group || papers_heading {
                child += 1;
            }
            if at == ix {
                return Some(child);
            }
            child += 1;
        }
        None
    }

    fn open(&mut self, ix: usize, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(hit) = self.selectable().get(ix).copied().cloned() else {
            return;
        };
        self.active = ix;
        cx.emit(ProjectFindEvent::Open {
            path: hit.path,
            line: hit.line,
        });
        cx.notify();
    }

    /// F3 and ⇧F3: the next or previous hit, opened.
    fn cycle(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.selectable().len();
        if !self.showing_results(cx) || count == 0 {
            return;
        }
        let next = if back {
            (self.active + count - 1) % count
        } else {
            (self.active + 1) % count
        };
        self.open(next, window, cx);
        self.reveal_active();
    }

    fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        self.query_changed(cx);
    }

    /// The hits shown, as `path:line`, once the search answered; `None`
    /// while it runs, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn shown_hits(&self, cx: &App) -> Option<Vec<String>> {
        if !self.showing_results(cx) {
            return None;
        }
        Some(
            self.selectable()
                .iter()
                .map(|hit| match hit.line {
                    Some(line) => format!("{}:{line}", hit.path),
                    None => hit.path.clone(),
                })
                .collect(),
        )
    }

    /// Step to the next hit and open it, as F3 does, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn next_hit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cycle(false, window, cx);
    }

    fn render_hits(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let palette = cx.palette().clone();
        let hits = self.selectable();
        let terms = terms(&self.answered);
        let editor_font = cx.lattice().fonts.editor.clone();
        let mut out: Vec<AnyElement> = vec![
            self.glide
                .fill(
                    (!hits.is_empty()).then_some(self.active),
                    palette.accent_soft,
                    px(6.),
                )
                .into_any_element(),
        ];
        for (ix, hit) in hits.iter().enumerate() {
            let paper = hit.kind == "paper";
            if !paper && (ix == 0 || hits[ix - 1].path != hit.path) {
                let run = hits[ix..]
                    .iter()
                    .take_while(|other| other.path == hit.path)
                    .count();
                let (folder, name) = split_path(&hit.path);
                out.push(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .min_w_0()
                        .px(px(10.))
                        .pt(px(if ix == 0 { 4. } else { 12. }))
                        .pb(px(4.))
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text)
                        .child(file_glyph(GlyphKind::for_name(name), ICON, &palette))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_weight(FONT_WEIGHT_MEDIUM)
                                .child(name.to_string()),
                        )
                        .when(!folder.is_empty(), |row| {
                            row.child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .child(folder.to_string()),
                            )
                        })
                        .child(
                            div()
                                .ml_auto()
                                .flex_none()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(run.to_string()),
                        )
                        .into_any_element(),
                );
            }
            if paper && self.scope == FindScope::All && (ix == 0 || hits[ix - 1].kind != "paper") {
                out.push(
                    div()
                        .pt(px(10.))
                        .pb(px(6.))
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child("Papers")
                        .into_any_element(),
                );
            }
            let preview_text = if !hit.snippet.is_empty() {
                hit.snippet.clone()
            } else if paper {
                hit.path.clone()
            } else {
                hit.title.clone()
            };
            let preview = div()
                .min_w_0()
                .truncate()
                .text_role(TextRole::Caption, cx)
                .font_family(editor_font.clone())
                .text_color(palette.text)
                .child(marked_terms(preview_text, &terms, palette.search_match));
            let row = div()
                .id(("find-hit", ix))
                .relative()
                .min_w_0()
                .rounded(px(6.))
                .cursor_pointer()
                .child(self.glide.probe(ix))
                .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                    if this.pointer == Some(event.position) {
                        return;
                    }
                    this.pointer = Some(event.position);
                    if this.active != ix {
                        this.active = ix;
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(move |this, _, window, cx| this.open(ix, window, cx)));
            let row = if paper {
                row.flex()
                    .flex_col()
                    .gap(px(2.))
                    .px(px(10.))
                    .py(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .min_w_0()
                            .child(file_glyph(GlyphKind::Pdf, ICON, &palette))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::Caption, cx)
                                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                                    .text_color(palette.text)
                                    .child(hit.title.clone()),
                            ),
                    )
                    .child(div().pl(px(22.)).child(preview))
            } else {
                row.flex()
                    .items_center()
                    .min_h(px(28.))
                    .py(px(4.))
                    .pr(px(10.))
                    .child(
                        div()
                            .flex_none()
                            .w(px(40.))
                            .pr(px(8.))
                            .flex()
                            .justify_end()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .children(hit.line.map(|line| line.to_string())),
                    )
                    .child(div().flex_1().min_w_0().child(preview))
            };
            out.push(row.into_any_element());
        }
        out
    }

    fn render_scope(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let show = self.showing_results(cx);
        let files = self.file_hits().len();
        let papers = self.paper_count();
        let tab = |id: &'static str, label: &'static str, scope: FindScope, count: usize| {
            let selected = self.scope == scope;
            div()
                .id(id)
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .gap(px(2.))
                .min_w(px(52.))
                .h(px(24.))
                .px(px(10.))
                .rounded(px(7.4))
                .text_role(TextRole::Caption, cx)
                .line_height(px(14.))
                .text_color(palette.text)
                .cursor_pointer()
                .when(selected, |this| {
                    this.bg(palette.panel)
                        .shadow(lattice_ui::Elevation::Raised.shadows(&palette))
                })
                .when(!selected, |this| {
                    let hover = palette.hover;
                    this.hover(move |style| style.bg(hover))
                })
                .on_click(cx.listener(move |this, _, _, cx| this.set_scope(scope, cx)))
                .child(label)
                .when(show, |this| {
                    this.child(
                        div()
                            .ml(px(2.))
                            .text_color(palette.text_secondary)
                            .child(count.to_string()),
                    )
                })
        };
        let query = self.query(cx);
        let status = if query.is_empty() {
            None
        } else if self.error.is_some() {
            Some("Search failed.".to_string())
        } else if self.searching() {
            Some("Searching…".to_string())
        } else {
            None
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap(px(10.))
            .min_h(px(28.))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .h(px(28.))
                    .p(px(2.))
                    .rounded(px(11.))
                    .border_1()
                    .border_color(palette.line)
                    .child(tab("find-scope-all", "All", FindScope::All, files + papers))
                    .child(tab("find-scope-files", "Files", FindScope::Files, files))
                    .child(tab(
                        "find-scope-papers",
                        "Papers",
                        FindScope::Papers,
                        papers,
                    )),
            )
            .children(status.map(|status| {
                div()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(status)
            }))
    }
}

/// The project's text files' hits, then the papers library's.
fn search_project(root: &std::path::Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let mut hits = lattice_core::project::search_files(root, query)?;
    hits.extend(lattice_core::papers::search_library(root, query)?);
    Ok(hits)
}

/// `.research/papers/<key>/`: the paper a hit belongs to.
fn paper_key(path: &str) -> &str {
    let Some(rest) = path.strip_prefix(".research/papers/") else {
        return path;
    };
    match rest.find('/') {
        Some(end) => &path[..".research/papers/".len() + end + 1],
        None => path,
    }
}

fn split_path(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

/// The query's terms worth marking: longer than one character, each once.
fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for term in query.to_lowercase().split_whitespace() {
        if term.chars().count() > 1 && !out.iter().any(|existing| existing == term) {
            out.push(term.to_string());
        }
    }
    out
}

/// The byte ranges in `text` where any of `terms` stands, case aside.
fn term_ranges(text: &str, terms: &[String]) -> Vec<Range<usize>> {
    if terms.is_empty() {
        return Vec::new();
    }
    let lower: Vec<(usize, char)> = text
        .char_indices()
        .map(|(at, c)| (at, c.to_lowercase().next().unwrap_or(c)))
        .collect();
    let mut ranges = Vec::new();
    let mut ix = 0;
    while ix < lower.len() {
        let matched = terms.iter().find_map(|term| {
            let chars: Vec<char> = term.chars().collect();
            (ix + chars.len() <= lower.len()
                && chars
                    .iter()
                    .enumerate()
                    .all(|(offset, c)| lower[ix + offset].1 == *c))
            .then_some(chars.len())
        });
        match matched {
            Some(len) => {
                let start = lower[ix].0;
                let end = lower.get(ix + len).map_or(text.len(), |(at, _)| *at);
                ranges.push(start..end);
                ix += len;
            }
            None => ix += 1,
        }
    }
    ranges
}

/// `text` with each term on the match wash, as the app marks a snippet.
fn marked_terms(text: String, terms: &[String], wash: gpui::Hsla) -> AnyElement {
    let ranges = term_ranges(&text, terms);
    if ranges.is_empty() {
        return div().child(text).into_any_element();
    }
    let style = HighlightStyle {
        background_color: Some(wash),
        ..Default::default()
    };
    StyledText::new(SharedString::from(text))
        .with_highlights(ranges.into_iter().map(|range| (range, style)))
        .into_any_element()
}

impl Focusable for ProjectFind {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Render for ProjectFind {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let view = cx.entity().downgrade();
        let clear_view = view.clone();
        let query = self.query(cx);
        let show = self.showing_results(cx);
        let selectable = self.selectable().len();
        let found = self.hits.len();
        let field = search_field(
            "project-find-field",
            &self.input,
            window,
            cx,
            move |window, cx| {
                clear_view
                    .update(cx, |this, cx| this.clear(window, cx))
                    .ok();
            },
        );
        let mut body: Vec<AnyElement> =
            vec![div().flex().flex_col().child(field).into_any_element()];
        if let Some(error) = &self.error {
            body.push(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(error.clone())
                    .into_any_element(),
            );
        }
        body.push(self.render_scope(cx).into_any_element());
        let results: AnyElement = if query.is_empty() {
            empty_state(None, None, cx)
        } else if show && selectable == 0 {
            let (title, action, label): (String, FindScope, &str) = if found > 0 {
                (
                    if self.scope == FindScope::Files {
                        format!("No files match “{query}”")
                    } else {
                        format!("No papers match “{query}”")
                    },
                    FindScope::All,
                    "Show all results",
                )
            } else {
                (
                    format!("No results for “{query}”"),
                    FindScope::All,
                    "Clear search",
                )
            };
            let clears = found == 0;
            let button = Button::new("project-find-empty-action", label)
                .compact()
                .on_click(cx.listener(move |this, _, window, cx| {
                    if clears {
                        this.clear(window, cx);
                    } else {
                        this.set_scope(action, cx);
                    }
                }));
            empty_state(Some(title), Some(button.into_any_element()), cx)
        } else if show {
            div()
                .id("project-find-hits")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .relative()
                .flex()
                .flex_col()
                .gap(px(2.))
                .pr(px(10.))
                .children(self.render_hits(cx))
                .into_any_element()
        } else {
            div().flex_1().into_any_element()
        };
        body.push(results);
        let close = view.clone();
        let frame = SheetFrame {
            id: "project-find",
            icon: Icon::SEARCH,
            title: "Find in project",
            body,
            actions: Vec::new(),
            scrim_closes: true,
        }
        .render(window, cx, move |_, cx| {
            close
                .update(cx, |_, cx| cx.emit(ProjectFindEvent::Dismiss))
                .ok();
        });
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                let keystroke = &event.keystroke;
                match keystroke.key.as_str() {
                    "up" => this.step(-1, cx),
                    "down" => this.step(1, cx),
                    "f3" => this.cycle(keystroke.modifiers.shift, window, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(frame)
    }
}

/// The results' empty state: the search glyph, and when a query found
/// nothing, what it was and the way out.
fn empty_state(title: Option<String>, action: Option<AnyElement>, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .child(Icon::SEARCH.element(px(28.), palette.line_strong))
        .children(title.map(|title| {
            div()
                .text_role(TextRole::BodyCompact, cx)
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .text_color(palette.text)
                .child(title)
        }))
        .children(action)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_are_longer_than_a_letter_and_marked_wherever_they_stand() {
        let terms = terms("A attention Attention is");
        assert_eq!(terms, ["attention", "is"]);
        assert_eq!(term_ranges("Attention is all", &terms), vec![0..9, 10..12]);
    }

    #[test]
    fn a_paper_counts_once_however_many_lines_match() {
        assert_eq!(
            paper_key(".research/papers/vaswani2017/overview.md"),
            ".research/papers/vaswani2017/"
        );
        assert_eq!(paper_key("main.tex"), "main.tex");
    }
}
