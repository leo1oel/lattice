//! The command palette (⌘K, also ⌘⇧P) and the shortcut sheet (⌘?), as the
//! Tauri app draws them (`src/app/command-palette.tsx`, the quick-open
//! picker's look in `src/styles/app-shell.css`).
//!
//! The palette is one keyboard-first list: an empty query lists every
//! command that applies, by section; a typed one ranks the commands and the
//! project's files together. ↑↓ move, ↩ runs, ⎋ or a press outside closes.
//! The card is 640px wide on the dialog surface, a 32px search row over a
//! hairline, then 28px rows 6px in, each with its section's icon (or the
//! file's glyph), its label, its detail at the end and its keys.

use std::path::{Path, PathBuf};

use gpui::{
    Action, AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _,
    Render, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_ui::{
    ActiveLattice as _, Elevation, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::{Keycap, rise_in},
    icons::{ICON, file_glyph},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    Shell,
    commands::{self, Section},
};

const WIDTH: f32 = 640.;
const LIST_HEIGHT: f32 = 460.;
const FILE_LIMIT: usize = 12;
const COMMAND_LIMIT: usize = 40;
/// A deep project must not stall opening the palette.
const MAX_FILES: usize = 4_000;

/// One row.
#[derive(Clone)]
enum Entry {
    Command {
        label: SharedString,
        section: Section,
        keys: Option<SharedString>,
        action: std::rc::Rc<dyn Action>,
        keywords: &'static str,
    },
    File {
        path: PathBuf,
        name: SharedString,
        folder: SharedString,
    },
}

impl Entry {
    fn group(&self) -> &'static str {
        match self {
            Entry::Command { section, .. } => section.label(),
            Entry::File { .. } => "Files",
        }
    }

    fn haystack(&self) -> String {
        match self {
            Entry::Command {
                label, keywords, ..
            } => format!("{label} {keywords}"),
            Entry::File { name, folder, .. } => Path::new(folder.as_ref())
                .join(name.as_ref())
                .to_string_lossy()
                .into_owned(),
        }
    }
}

pub(crate) enum PaletteEvent {
    Dismiss,
}

pub(crate) struct CommandPaletteView {
    shell: WeakEntity<Shell>,
    input: Entity<InputState>,
    focus: FocusHandle,
    commands: Vec<Entry>,
    files: Vec<Entry>,
    shown: Vec<Entry>,
    highlighted: usize,
    scroll: ScrollHandle,
    _subscription: Subscription,
}

impl EventEmitter<PaletteEvent> for CommandPaletteView {}

impl CommandPaletteView {
    fn new(
        shell: &Shell,
        weak: WeakEntity<Shell>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let in_project = shell.root.is_some();
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(if in_project {
                "Search commands and files…"
            } else {
                "Search commands…"
            })
        });
        let subscription =
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.filter(cx),
                InputEvent::PressEnter { .. } => this.run(this.highlighted, window, cx),
                _ => {}
            });
        let context = shell.command_context(cx);
        let commands = commands::commands(&context)
            .into_iter()
            .filter(|command| command.palette)
            .map(|command| Entry::Command {
                keys: commands::keys_label(command.action.as_ref(), window),
                label: command.label,
                section: command.section,
                action: std::rc::Rc::from(command.action),
                keywords: command.keywords,
            })
            .collect::<Vec<_>>();
        let files = shell.root.as_deref().map(project_files).unwrap_or_default();
        let mut this = Self {
            shell: weak,
            input,
            focus: cx.focus_handle(),
            shown: Vec::new(),
            commands: sorted_by_section(commands),
            files,
            highlighted: 0,
            scroll: ScrollHandle::new(),
            _subscription: subscription,
        };
        this.filter(cx);
        this
    }

    fn filter(&mut self, cx: &mut Context<Self>) {
        let query = self.input.read(cx).value().trim().to_lowercase();
        self.shown = if query.is_empty() {
            self.commands.clone()
        } else {
            let mut commands = ranked(&self.commands, &query, COMMAND_LIMIT);
            commands.extend(ranked(&self.files, &query, FILE_LIMIT));
            commands
        };
        self.highlighted = 0;
        self.scroll.scroll_to_item(0);
        cx.notify();
    }

    fn step(&mut self, step: isize, cx: &mut Context<Self>) {
        if self.shown.is_empty() {
            return;
        }
        let count = self.shown.len() as isize;
        self.highlighted = (self.highlighted as isize + step).rem_euclid(count) as usize;
        self.scroll.scroll_to_item(self.highlighted);
        cx.notify();
    }

    fn run(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.shown.get(ix).cloned() else {
            return;
        };
        cx.emit(PaletteEvent::Dismiss);
        let shell = self.shell.clone();
        match entry {
            Entry::Command { action, .. } => {
                let action = action.boxed_clone();
                window.defer(cx, move |window, cx| {
                    if let Some(shell) = shell.upgrade() {
                        let focus = shell.read(cx).focus_handle.clone();
                        // Run where the shell listens, whatever held focus.
                        window.focus(&focus, cx);
                    }
                    window.dispatch_action(action, cx);
                });
            }
            Entry::File { path, .. } => {
                window.defer(cx, move |window, cx| {
                    shell
                        .update(cx, |shell, cx| shell.open_path(path, None, window, cx))
                        .ok();
                });
            }
        }
    }
}

fn sorted_by_section(mut entries: Vec<Entry>) -> Vec<Entry> {
    entries.sort_by_key(|entry| match entry {
        Entry::Command { section, .. } => *section as usize,
        Entry::File { .. } => usize::MAX,
    });
    entries
}

/// The best `limit` of `entries` for `query`, best first, the table's order
/// breaking ties.
fn ranked(entries: &[Entry], query: &str, limit: usize) -> Vec<Entry> {
    let mut scored: Vec<(i64, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(ix, entry)| score(&entry.haystack().to_lowercase(), query).map(|s| (s, ix)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, ix)| entries[ix].clone())
        .collect()
}

/// How well `query` matches `text`: every query character in order, more
/// for a run of them, for one at a word's start, and for an earlier start;
/// `None` when they are not all there.
pub(crate) fn score(text: &str, query: &str) -> Option<i64> {
    if let Some(at) = text.find(query) {
        let word_start = at == 0 || !text[..at].ends_with(char::is_alphanumeric);
        return Some(1_000 + if word_start { 500 } else { 0 } - at as i64);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut score = 0i64;
    let mut position = 0;
    let mut previous: Option<usize> = None;
    for wanted in query.chars() {
        let found = (position..chars.len()).find(|ix| chars[*ix] == wanted)?;
        let word_start = found == 0 || !chars[found - 1].is_alphanumeric();
        score += 10;
        if word_start {
            score += 30;
        }
        if previous == Some(found.wrapping_sub(1)) {
            score += 20;
        }
        score -= (found - position) as i64;
        previous = Some(found);
        position = found + 1;
    }
    Some(score)
}

/// The project's files, as the tree lists them (no build products, no
/// hidden folders), relative to the root.
fn project_files(root: &Path) -> Vec<Entry> {
    const SKIPPED: [&str; 4] = ["node_modules", "target", "__pycache__", "_minted"];
    const HIDDEN: [&str; 14] = [
        "aux",
        "bbl",
        "bcf",
        "blg",
        "fdb_latexmk",
        "fls",
        "log",
        "out",
        "toc",
        "synctex",
        "gz",
        "xdv",
        "run.xml",
        "lof",
    ];
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                if !SKIPPED.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            if HIDDEN.iter().any(|ext| name.ends_with(&format!(".{ext}"))) {
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let folder = relative
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(Entry::File {
                name: name.into(),
                folder: folder.into(),
                path,
            });
            if out.len() >= MAX_FILES {
                break 'walk;
            }
        }
    }
    out.sort_by(|a, b| a.haystack().cmp(&b.haystack()));
    out
}

impl Focusable for CommandPaletteView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Render for CommandPaletteView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(WIDTH).min(window.viewport_size().width - px(40.));
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut group = None;
        for (ix, entry) in self.shown.iter().enumerate() {
            if group != Some(entry.group()) {
                group = Some(entry.group());
                rows.push(
                    div()
                        .px(px(10.))
                        .pt(px(if ix == 0 { 4. } else { 12. }))
                        .pb(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(entry.group())
                        .into_any_element(),
                );
            }
            let active = ix == self.highlighted;
            let (icon, label, detail, keys): (
                AnyElement,
                SharedString,
                Option<SharedString>,
                Option<SharedString>,
            ) = match entry {
                Entry::Command {
                    label,
                    section,
                    keys,
                    ..
                } => (
                    section
                        .icon()
                        .element(
                            ICON,
                            if active {
                                palette.text
                            } else {
                                palette.text_secondary
                            },
                        )
                        .into_any_element(),
                    label.clone(),
                    None,
                    keys.clone(),
                ),
                Entry::File { name, folder, .. } => (
                    file_glyph(GlyphKind::for_name(name), ICON, &palette),
                    name.clone(),
                    (!folder.is_empty()).then(|| folder.clone()),
                    None,
                ),
            };
            rows.push(
                div()
                    .id(("palette-row", ix))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .min_h(px(28.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(8.))
                    .when(active, |row| row.bg(palette.row_selected))
                    .cursor_pointer()
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered && this.highlighted != ix {
                            this.highlighted = ix;
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| this.run(ix, window, cx)))
                    .child(icon)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .justify_between()
                            .gap(px(16.))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::Body, cx)
                                    .text_color(palette.text)
                                    .child(label),
                            )
                            .children(detail.map(|detail| {
                                div()
                                    .flex_shrink_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .child(detail)
                            })),
                    )
                    .children(keys.map(|keys| div().ml(px(4.)).child(Keycap::new(keys))))
                    .into_any_element(),
            );
        }
        let empty = self.shown.is_empty().then(|| {
            let query = self.input.read(cx).value();
            div()
                .px(px(20.))
                .py(px(20.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_role(TextRole::Subtitle, cx)
                        .text_color(palette.text)
                        .child(format!("No commands or files match “{query}”")),
                )
        });
        let card = div()
            .id("command-palette")
            .w(width)
            .flex()
            .flex_col()
            .rounded(px(14.))
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .h(px(32. + 12.))
                    .px(px(14.))
                    .border_b_1()
                    .border_color(palette.line)
                    .child(Icon::SEARCH.element(ICON, palette.text_secondary))
                    .child(
                        div()
                            .flex_1()
                            .text_role(TextRole::Body, cx)
                            .child(Input::new(&self.input).appearance(false).bordered(false)),
                    ),
            )
            .children(empty)
            .when(!self.shown.is_empty(), |card| {
                card.child(
                    div()
                        .id("command-palette-list")
                        .max_h(px(LIST_HEIGHT).min(window.viewport_size().height * 0.6))
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .p(px(6.))
                        .children(rows),
                )
            });
        div()
            .id("command-palette-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .pt(px(72.))
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                match event.keystroke.key.as_str() {
                    "up" => this.step(-1, cx),
                    "down" => this.step(1, cx),
                    "escape" => cx.emit(PaletteEvent::Dismiss),
                    "enter" => {
                        this.run(this.highlighted, window, cx);
                    }
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaletteEvent::Dismiss)),
            )
            .child(rise_in("command-palette-in", card))
    }
}

/// The shortcut sheet: every command with keys, by section.
pub(crate) struct ShortcutSheet {
    focus: FocusHandle,
    groups: Vec<(&'static str, Vec<(SharedString, SharedString)>)>,
}

impl EventEmitter<PaletteEvent> for ShortcutSheet {}

impl ShortcutSheet {
    fn new(shell: &Shell, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut context = shell.command_context(cx);
        // Every command, as the sheet lists keys whatever applies now.
        context.in_project = true;
        let mut groups: Vec<(&'static str, Vec<(SharedString, SharedString)>)> = Vec::new();
        for command in commands::commands(&context) {
            let Some(keys) = commands::keys_label(command.action.as_ref(), window) else {
                continue;
            };
            let label =
                if command.id.starts_with("workspace-") && command.label.starts_with("Switch") {
                    "Switch to a workspace by its place".into()
                } else {
                    command.label
                };
            match groups
                .iter_mut()
                .find(|(name, _)| *name == command.section.label())
            {
                Some((_, rows)) => {
                    if !rows.iter().any(|(existing, _)| *existing == label) {
                        rows.push((label, keys));
                    } else if let Some(row) =
                        rows.iter_mut().find(|(existing, _)| *existing == label)
                        && !row.1.contains('–')
                    {
                        row.1 = format!("{}–{}", row.1, keys).into();
                    }
                }
                None => groups.push((command.section.label(), vec![(label, keys)])),
            }
        }
        groups.sort_by_key(|(name, _)| {
            [
                Section::Navigate,
                Section::Edit,
                Section::Build,
                Section::View,
                Section::Layout,
                Section::Project,
                Section::Appearance,
            ]
            .iter()
            .position(|section| section.label() == *name)
        });
        Self {
            focus: cx.focus_handle(),
            groups,
        }
    }
}

impl Focusable for ShortcutSheet {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ShortcutSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(560.).min(window.viewport_size().width - px(40.));
        let groups = self.groups.iter().map(|(name, rows)| {
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .pt(px(12.))
                        .pb(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(*name),
                )
                .children(rows.iter().map(|(label, keys)| {
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .min_h(px(28.))
                        .child(
                            div()
                                .text_role(TextRole::Body, cx)
                                .text_color(palette.text)
                                .child(label.clone()),
                        )
                        .child(Keycap::new(keys.clone()))
                }))
        });
        div()
            .id("shortcut-sheet-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .items_center()
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.emit(PaletteEvent::Dismiss);
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaletteEvent::Dismiss)),
            )
            .child(rise_in(
                "shortcut-sheet-in",
                div()
                    .id("shortcut-sheet")
                    .w(width)
                    .max_h(window.viewport_size().height * 0.8)
                    .overflow_y_scroll()
                    .rounded(px(14.))
                    .bg(palette.raised)
                    .shadow(Elevation::Dialog.shadows(&palette))
                    .px(px(24.))
                    .pt(px(20.))
                    .pb(px(24.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .text_role(TextRole::Title, cx)
                            .text_color(palette.text)
                            .child("Keyboard shortcuts"),
                    )
                    .children(groups),
            ))
    }
}

impl Shell {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn palette_rows(&self, cx: &App) -> Option<usize> {
        Some(self.palette.as_ref()?.read(cx).shown.len())
    }

    pub(crate) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            self.close_overlays(window, cx);
            return;
        }
        self.shortcuts = None;
        let weak = cx.entity().downgrade();
        let view = cx.new(|cx| CommandPaletteView::new(self, weak, window, cx));
        cx.subscribe_in(&view, window, |this, _, _: &PaletteEvent, window, cx| {
            this.close_overlays(window, cx)
        })
        .detach();
        view.update(cx, |view, cx| {
            view.input.update(cx, |input, cx| input.focus(window, cx))
        });
        self.palette = Some(view);
        cx.notify();
    }

    pub(crate) fn open_shortcuts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        let view = cx.new(|cx| ShortcutSheet::new(self, window, cx));
        cx.subscribe_in(&view, window, |this, _, _: &PaletteEvent, window, cx| {
            this.close_overlays(window, cx)
        })
        .detach();
        window.focus(&view.focus_handle(cx), cx);
        self.shortcuts = Some(view);
        cx.notify();
    }

    pub(crate) fn close_overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        self.shortcuts = None;
        // Back to the document in front, where the keyboard was.
        if let Some(active) = self.active_document(cx)
            && let Some(root) = self.root.clone()
            && let Some(editor) = self.open_editor(&root.join(active), cx)
        {
            window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
        } else {
            window.focus(&self.focus_handle, cx);
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{Entry, FILE_LIMIT, project_files, ranked, score};

    #[test]
    fn files_rank_by_their_path_inside_the_project() {
        let root = std::env::temp_dir()
            .join(format!("lattice-gpui-palette-{}", std::process::id()))
            .join("thesis");
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        for ix in 0..FILE_LIMIT + 4 {
            std::fs::write(root.join("chapters").join(format!("a{ix:02}.tex")), "").unwrap();
        }
        std::fs::write(root.join("thesis.tex"), "").unwrap();
        let shown = ranked(&project_files(&root), "thesis", FILE_LIMIT);
        let names: Vec<String> = shown
            .iter()
            .map(|entry| match entry {
                Entry::File { name, .. } => name.to_string(),
                Entry::Command { .. } => String::new(),
            })
            .collect();
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
        assert_eq!(names, ["thesis.tex"]);
    }

    #[test]
    fn a_run_at_a_word_start_beats_scattered_letters() {
        let run = score("show or hide the pdf", "pdf").unwrap();
        let scattered = score("pick a document folder", "pdf").unwrap();
        assert!(run > scattered);
    }

    #[test]
    fn letters_out_of_order_do_not_match() {
        assert_eq!(score("build project", "dliub"), None);
    }

    #[test]
    fn an_earlier_match_ranks_higher() {
        assert!(score("build project", "build") > score("clean build", "build"));
    }
}
