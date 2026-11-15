//! The command palette (⌘K, also ⌘⇧P), and the shell's opening of it, the
//! shortcut sheet (⌘?, `super::shortcut_sheet`) and Settings, as the Tauri
//! app draws them (`src/app/command-palette.tsx`, the quick-open
//! picker's look in `src/styles/app-shell.css`).
//!
//! The palette is one keyboard-first list. An empty query leads with the
//! recent commands and the document's own (`super::palette_groups`), then
//! the files opened recently, then every command that applies, by section.
//! A typed one ranks the commands, the project's files, its Papers and every
//! Settings row together, best first; one that finds nothing offers Find in
//! project on it. ↑↓ move, ↩ runs, ⎋ or a press outside closes. The card is
//! 640px wide on the dialog surface, a 32px search row over a hairline, then
//! 28px rows 6px in, each with its section's icon (or the file's glyph), its
//! label, its detail at the end and its keys.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Render,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::{Keycap, rise_in},
    fluid_hover::FluidHover,
    icons::{ICON, file_glyph},
    scrollbar::FluidScrollbar,
    shape,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    Shell, commands,
    palette_entries::{
        COMMAND_LIMIT, Entry, FILE_LIMIT, PAPER_LIMIT, SETTING_LIMIT, entry_text, leading_entries,
        paper_detail, project_files, row_of, scored, sorted_by_section,
    },
    palette_groups::{RecentCommands, Surface},
};

const WIDTH: f32 = 640.;
const LIST_HEIGHT: f32 = 460.;

pub(crate) enum PaletteEvent {
    Dismiss,
}

pub(crate) struct CommandPaletteView {
    shell: WeakEntity<Shell>,
    input: Entity<InputState>,
    focus: FocusHandle,
    in_project: bool,
    commands: Vec<Entry>,
    /// What an empty query leads with.
    leading: Vec<Entry>,
    files: Vec<Entry>,
    papers: Vec<Entry>,
    settings: Vec<Entry>,
    /// Find in project's keys, when the palette offers it.
    find_keys: Option<Option<SharedString>>,
    shown: Vec<Entry>,
    highlighted: usize,
    adopted: Option<usize>,
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
        let in_project = shell.project.is_some();
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(if in_project {
                t!("Search commands, files, papers and settings…")
            } else {
                t!("Search commands and settings…")
            })
        });
        let subscription =
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.filter(cx),
                InputEvent::PressEnter { .. } => this.run(this.highlighted, window, cx),
                _ => {}
            });
        let context = shell.command_context(cx);
        let listed: Vec<commands::Command> = commands::commands(&context)
            .into_iter()
            .filter(|command| command.palette)
            .collect();
        let find_keys = listed
            .iter()
            .find(|command| command.id == "find")
            .map(|command| commands::keys_label(command.action.as_ref(), window));
        let commands = listed
            .into_iter()
            .map(|command| Entry::Command {
                keys: commands::keys_label(command.keys_action(), window),
                id: command.id,
                label: command.label,
                section: command.section,
                action: std::rc::Rc::from(command.action),
                keywords: command.keywords,
                detail: command.detail,
                recent: command.recent,
                lead: None,
            })
            .collect::<Vec<_>>();
        let commands = sorted_by_section(commands);
        let root = shell.root(cx);
        let files = root.as_deref().map(project_files).unwrap_or_default();
        // The document in front decides the suggestions, and is left out of
        // the recent files.
        let front = shell.active_document(cx);
        let surface = front
            .as_deref()
            .and_then(|key| Surface::of(key, super::papers::is_reader_key(key)));
        let leading = leading_entries(
            &commands,
            &RecentCommands::list(cx),
            surface,
            root.as_deref()
                .map(|root| {
                    shell
                        .recent_paths()
                        .into_iter()
                        .filter(|path| Some(path) != front.as_ref())
                        .filter(|path| root.join(path).is_file())
                        .collect()
                })
                .unwrap_or_default(),
            root.as_deref(),
        );
        let papers = if in_project {
            shell
                .papers
                .read(cx)
                .papers
                .iter()
                // A paper that is only cited has nothing to open or fetch.
                .filter(|paper| {
                    paper.has_full_text
                        || paper.has_blog
                        || !paper.arxiv_id.is_empty()
                        || paper.url.is_some()
                })
                .map(|paper| Entry::Paper {
                    detail: paper_detail(paper),
                    paper: Box::new(paper.clone()),
                })
                .collect()
        } else {
            Vec::new()
        };
        let settings = crate::settings::search::entries(in_project, None)
            .into_iter()
            .map(|entry| Entry::Setting(Box::new(entry)))
            .collect();
        let mut this = Self {
            shell: weak,
            input,
            focus: cx.focus_handle(),
            in_project,
            shown: Vec::new(),
            commands,
            leading,
            files,
            papers,
            settings,
            find_keys,
            highlighted: 0,
            adopted: None,
            scroll: ScrollHandle::new(),
            _subscription: subscription,
        };
        this.filter(cx);
        this
    }

    fn filter(&mut self, cx: &mut Context<Self>) {
        let raw = self.input.read(cx).value().trim().to_string();
        let query = raw.to_lowercase();
        self.shown =
            if query.is_empty() {
                let led: Vec<SharedString> = self
                    .leading
                    .iter()
                    .filter_map(|entry| match entry {
                        Entry::Command { id, .. } => Some(id.clone()),
                        _ => None,
                    })
                    .collect();
                self.leading
                .iter()
                .cloned()
                .chain(self.commands.iter().filter(|entry| {
                    !matches!(entry, Entry::Command { id, .. } if led.contains(id))
                }).cloned())
                .collect()
            } else {
                let mut found = scored(&self.commands, &query, COMMAND_LIMIT, false);
                found.extend(scored(&self.files, &query, FILE_LIMIT, false));
                found.extend(scored(&self.papers, &query, PAPER_LIMIT, true));
                found.extend(scored(&self.settings, &query, SETTING_LIMIT, true));
                found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.order().cmp(&b.1.order())));
                let found: Vec<Entry> = found.into_iter().map(|(_, entry)| entry).collect();
                match (&self.find_keys, found.is_empty()) {
                    // A query that found nothing hands itself to Find in
                    // project, which reads every source file's text too.
                    (Some(keys), true) => vec![Entry::Find {
                        query: raw,
                        keys: keys.clone(),
                    }],
                    _ => found,
                }
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
        let groups: Vec<SharedString> = self.shown.iter().map(Entry::group).collect();
        self.scroll
            .scroll_to_item(row_of(&groups, self.highlighted));
        cx.notify();
    }

    fn run(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.shown.get(ix).cloned() else {
            return;
        };
        cx.emit(PaletteEvent::Dismiss);
        let shell = self.shell.clone();
        match entry {
            Entry::Command {
                id, action, recent, ..
            } => {
                if recent {
                    RecentCommands::remember(&id, cx);
                }
                let action = action.boxed_clone();
                window.defer(cx, move |window, cx| {
                    if window.focused(cx).is_none()
                        && let Some(shell) = shell.upgrade()
                    {
                        let focus = shell.read(cx).focus_handle.clone();
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
            Entry::Paper { paper, .. } => {
                window.defer(cx, move |window, cx| {
                    shell
                        .update(cx, |shell, cx| {
                            shell
                                .papers
                                .clone()
                                .update(cx, |papers, cx| papers.activate(&paper, None, window, cx))
                        })
                        .ok();
                });
            }
            Entry::Setting(entry) => {
                window.defer(cx, move |window, cx| {
                    shell
                        .update(cx, |shell, cx| {
                            shell.open_settings(Some(entry.tab), window, cx);
                            if let Some(settings) = shell.settings.clone() {
                                settings.update(cx, |settings, cx| {
                                    settings.open_entry((*entry).clone(), cx)
                                });
                            }
                        })
                        .ok();
                });
            }
            Entry::Find { query, .. } => {
                window.defer(cx, move |window, cx| {
                    shell
                        .update(cx, |shell, cx| shell.find_in_project_for(query, window, cx))
                        .ok();
                });
            }
        }
    }

    /// The rows shown, as (group, label) pairs, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn rows(&self) -> Vec<(String, String, Option<String>)> {
        self.shown
            .iter()
            .map(|entry| {
                let (label, detail) = entry_text(entry);
                (
                    entry.group().to_string(),
                    label.to_string(),
                    detail.map(|detail| detail.to_string()),
                )
            })
            .collect()
    }

    /// Type `text` in the search field, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn type_query(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value(text.to_string(), window, cx)
        });
        self.filter(cx);
    }

    /// Run the row labelled `label`, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn run_labelled(
        &mut self,
        label: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(ix) = self
            .shown
            .iter()
            .position(|entry| entry_text(entry).0 == label)
        else {
            return false;
        };
        self.run(ix, window, cx);
        true
    }
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
        // The app's picker runs the fluid hover over its results
        // (`search-picker-dialog.tsx`): one fill for the pointer and the
        // keys, gliding between rows. The row the pointer lights becomes
        // the current one, as a pointer that really moves does there; a
        // list scrolled under a resting pointer changes nothing.
        let hover = FluidHover::new("command-palette-hover", window, cx)
            .fill(palette.accent_soft)
            .radius(shape::PALETTE_LIST.inner());
        let lit = hover.lit(cx);
        if lit != self.adopted
            && let Some(lit) = lit.filter(|lit| *lit < self.shown.len())
        {
            self.highlighted = lit;
        }
        let hover = hover.follow(Some(self.highlighted), cx);
        self.adopted = hover.lit(cx);
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut group: Option<SharedString> = None;
        for (ix, entry) in self.shown.iter().enumerate() {
            let heading = match entry {
                // A query that found nothing says so over its one row.
                Entry::Find { query, .. } => Some(SharedString::from(t!(
                    "No commands, files or papers match “{query}”",
                    query = query
                ))),
                _ if group.as_ref() != Some(&entry.group()) => Some(entry.group()),
                _ => None,
            };
            if let Some(heading) = heading {
                group = Some(entry.group());
                rows.push(
                    div()
                        .px(px(10.))
                        .pt(px(if ix == 0 { 4. } else { 12. }))
                        .pb(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(heading)
                        .into_any_element(),
                );
            }
            let active = ix == self.highlighted;
            let tint = if active {
                palette.text
            } else {
                palette.text_secondary
            };
            let (label, detail) = entry_text(entry);
            let (icon, keys): (AnyElement, Option<SharedString>) = match entry {
                Entry::Command { section, keys, .. } => (
                    section.icon().element(ICON, tint).into_any_element(),
                    keys.clone(),
                ),
                Entry::File { name, .. } => {
                    (file_glyph(GlyphKind::for_name(name), ICON, &palette), None)
                }
                Entry::Paper { .. } => {
                    (Icon::BOOK_OPEN.element(ICON, tint).into_any_element(), None)
                }
                Entry::Setting(_) => (Icon::SETTINGS.element(ICON, tint).into_any_element(), None),
                Entry::Find { keys, .. } => (
                    Icon::SEARCH.element(ICON, tint).into_any_element(),
                    keys.clone(),
                ),
            };
            rows.push(
                hover.item(
                    ix,
                    div()
                        .id(("palette-row", ix))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .min_h(px(28.))
                        .px(px(10.))
                        .py(px(6.))
                        .rounded(shape::PALETTE_LIST.inner())
                        // The current row's own wash (`button.active`), shown
                        // while the gliding fill is elsewhere or gone.
                        .when(active && !hover.is_lit(ix, cx), |row| {
                            row.bg(palette.accent_soft)
                        })
                        .cursor_pointer()
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
                        .children(keys.map(|keys| div().ml(px(4.)).child(Keycap::new(keys)))),
                ),
            );
        }
        let in_project = self.in_project;
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
                        .child(if in_project {
                            t!(
                                "No commands, files or papers match “{query}”",
                                query = query
                            )
                        } else {
                            t!("No commands or settings match “{query}”", query = query)
                        }),
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
                    // The fill and Lattice's scrollbar are laid over the
                    // list's viewport.
                    div()
                        .relative()
                        .child(hover.highlight())
                        .child(
                            div()
                                .id("command-palette-list")
                                .max_h(px(LIST_HEIGHT).min(window.viewport_size().height * 0.6))
                                .overflow_y_scroll()
                                .track_scroll(&self.scroll)
                                .p(shape::PALETTE_LIST.inset)
                                .children(rows),
                        )
                        .child(FluidScrollbar::vertical(
                            "command-palette-scrollbar",
                            &self.scroll,
                        )),
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
            // 18% of the window down, where every app dialog stands
            // (`.modal-dialog-content`), quick open's too.
            .pt(window.viewport_size().height * 0.18)
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                match event.keystroke.key.as_str() {
                    "up" => this.step(-1, cx),
                    "down" => this.step(1, cx),
                    "escape" => cx.emit(PaletteEvent::Dismiss),
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

impl Shell {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn palette_rows(&self, cx: &App) -> Option<usize> {
        Some(self.palette.as_ref()?.read(cx).shown.len())
    }

    /// The palette, while it is open, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn palette_view(&self) -> Option<Entity<CommandPaletteView>> {
        self.palette.clone()
    }

    pub(crate) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            self.close_overlays(window, cx);
            return;
        }
        if self.overlay_writing(cx) {
            return;
        }
        self.shortcuts = None;
        self.documents.overlays_opened += 1;
        if self.document_overlay_open() {
            self.close_document_overlays(window, cx);
        }
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

    pub(crate) fn shortcuts_view(&self) -> Option<Entity<super::shortcut_sheet::ShortcutSheet>> {
        self.shortcuts.clone()
    }

    pub(crate) fn open_shortcuts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay_writing(cx) {
            return;
        }
        self.palette = None;
        if self.document_overlay_open() {
            self.close_document_overlays(window, cx);
        }
        let view = cx.new(|cx| super::shortcut_sheet::ShortcutSheet::new(self, window, cx));
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
        self.focus_front(window, cx);
        cx.notify();
    }
}
