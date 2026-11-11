//! One open file: Zed's editor over a local buffer, with Zed's buffer search
//! bar and Lattice's status bar, as a dock panel. Its tab strip carries the
//! build chip.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use editor::{Editor, EditorEvent, SelectionEffects, ToPoint as _, scroll::Autoscroll};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Task, Window, div, prelude::*,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    menu::PopupMenu,
};
use language::{Buffer, Point};
use lattice_ui::ActiveLattice as _;
use search::{BufferSearchBar, buffer_search::DivRegistrar};
use workspace::ToolbarItemView as _;
use zed_actions::buffer_search::Deploy;

use crate::{
    build_panel::BuildPanel,
    editor_status,
    shell::{Build, ToggleVimMode},
};

pub struct EditorPanel {
    path: PathBuf,
    buffer: Entity<Buffer>,
    editor: Entity<Editor>,
    search_bar: Entity<BufferSearchBar>,
    search_visible: bool,
    build: Entity<BuildPanel>,
    /// The caret's line and column, 1-based, for the status bar.
    cursor: (u32, u32),
    /// The file's word count as of opening or the last save; counted off the
    /// main thread.
    words: Option<usize>,
    _count: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EditorPanel {
    /// Read `path` and open it in a new editor.
    pub fn open(
        path: PathBuf,
        build: Entity<BuildPanel>,
        window: &mut Window,
        cx: &mut App,
    ) -> Result<Entity<Self>> {
        let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let text = String::from_utf8(bytes)
            .with_context(|| format!("{} is not UTF-8 text", path.display()))?;
        Ok(cx.new(|cx| Self::new(path, text, build, window, cx)))
    }

    fn new(
        path: PathBuf,
        text: String,
        build: Entity<BuildPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let started = std::time::Instant::now();
        let language = crate::latex::language_for_path(&path, cx);
        let buffer = cx.new(|cx| Buffer::local(text, cx));
        let buffered = started.elapsed();
        buffer.update(cx, |buffer, cx| buffer.set_language(language, cx));
        let languaged = started.elapsed();
        let editor = cx.new(|cx| Editor::for_buffer(buffer.clone(), None, window, cx));
        log::debug!(
            "opened {}: buffer {buffered:?}, language {languaged:?}, editor {:?}",
            path.display(),
            started.elapsed()
        );
        let search_bar = cx.new(|cx| {
            let mut bar = BufferSearchBar::new(None, window, cx);
            bar.set_active_pane_item(Some(&editor), window, cx);
            bar
        });
        let subscriptions = vec![
            // The tab shows whether the file has unsaved edits.
            cx.observe(&buffer, |_, _, cx| cx.notify()),
            // The build chip in this panel's strip follows the build.
            cx.observe(&build, |_, _, cx| cx.notify()),
            cx.subscribe(&editor, |this, editor, event: &EditorEvent, cx| {
                if matches!(event, EditorEvent::SelectionsChanged { .. }) {
                    let editor = editor.read(cx);
                    let snapshot = editor.buffer().read(cx).snapshot(cx);
                    let head = editor.selections.newest_anchor().head().to_point(&snapshot);
                    let line_start = Point::new(head.row, 0);
                    let column =
                        editor_status::caret_column(snapshot.text_for_range(line_start..head));
                    this.cursor = (head.row + 1, column);
                    cx.notify();
                }
            }),
            cx.subscribe(&search_bar, |this, _, event, cx| {
                if matches!(event, search::buffer_search::Event::Dismissed) {
                    this.search_visible = false;
                    cx.notify();
                }
            }),
        ];
        let mut this = Self {
            path,
            buffer,
            editor,
            search_bar,
            search_visible: false,
            build,
            cursor: (1, 1),
            words: None,
            _count: None,
            _subscriptions: subscriptions,
        };
        this.count_words(cx);
        this
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn editor(&self) -> &Entity<Editor> {
        &self.editor
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn search_bar(&self) -> &Entity<BufferSearchBar> {
        &self.search_bar
    }

    pub fn is_dirty(&self, cx: &App) -> bool {
        self.buffer.read(cx).is_dirty()
    }

    pub(crate) fn cursor(&self) -> (u32, u32) {
        self.cursor
    }

    pub(crate) fn words(&self) -> Option<usize> {
        self.words
    }

    /// Recount the words from the buffer's text, off the main thread.
    fn count_words(&mut self, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).as_rope().clone();
        let counted = cx.background_spawn(async move { editor_status::count_words(&text) });
        self._count = Some(cx.spawn(async move |this, cx| {
            let words = counted.await;
            this.update(cx, |this, cx| {
                this.words = Some(words);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Write the buffer to disk. The text is copied on the main thread and
    /// written on a background thread.
    pub fn save(&mut self, cx: &mut Context<Self>) -> Task<Result<()>> {
        let (text, version) = {
            let buffer = self.buffer.read(cx);
            (buffer.line_ending().apply(buffer.text()), buffer.version())
        };
        let path = self.path.clone();
        let buffer = self.buffer.clone();
        cx.spawn(async move |this, cx| {
            cx.background_spawn({
                let path = path.clone();
                async move { std::fs::write(&path, text) }
            })
            .await
            .with_context(|| format!("writing {}", path.display()))?;
            buffer.update(cx, |buffer, cx| buffer.did_save(version, None, cx));
            this.update(cx, |this, cx| this.count_words(cx)).ok();
            Ok(())
        })
    }

    /// Put the cursor at the start of the 1-based `line` and scroll it to the
    /// middle of the editor.
    pub fn go_to_line(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        let point = Point::new(line.saturating_sub(1), 0);
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([point..point]),
            );
        });
        window.focus(&self.editor.focus_handle(cx), cx);
    }

    fn deploy_search(&mut self, action: &Deploy, window: &mut Window, cx: &mut Context<Self>) {
        self.search_visible = true;
        self.search_bar.update(cx, |bar, cx| {
            bar.deploy(action, None, window, cx);
        });
        cx.notify();
    }
}

impl EventEmitter<PanelEvent> for EditorPanel {}

impl Focusable for EditorPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl BasePanel for EditorPanel {
    fn panel_name(&self) -> &'static str {
        "EditorPanel"
    }
}

impl Panel for EditorPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(file_name(&self.path).into())
    }

    fn title(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name = file_name(&self.path);
        if self.is_dirty(cx) {
            format!("{name} •")
        } else {
            name
        }
    }

    /// The build chip, at the strip's trailing end as the app puts it.
    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        Some(editor_status::build_chip(&self.build, cx))
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        menu.menu("Build", Box::new(Build))
            .menu("Find", Box::new(Deploy::find()))
            .separator()
            .menu_with_check(
                "Vim mode",
                crate::app::vim_mode_enabled(cx),
                Box::new(ToggleVimMode),
            )
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for EditorPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Zed's search bar registers its key handlers on whatever element
        // hosts it; in Zed that is a pane, here it is this panel.
        let palette = cx.palette().clone();
        let status: AnyElement = editor_status::status_bar(self, cx).into_any_element();
        let mut registrar =
            DivRegistrar::new(|this: &Self, _, _| Some(this.search_bar.clone()), cx);
        BufferSearchBar::register(&mut registrar);
        registrar
            .into_div()
            .key_context("LatticeEditor")
            .on_action(cx.listener(Self::deploy_search))
            .size_full()
            .flex()
            .flex_col()
            .when(self.search_visible, |panel| {
                panel.child(
                    div()
                        .px_2()
                        .py_1()
                        .border_b_1()
                        .border_color(palette.line)
                        .child(self.search_bar.clone()),
                )
            })
            .child(div().flex_1().min_h_0().child(self.editor.clone()))
            .child(status)
            .child(crate::paint_probe::probe())
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}
