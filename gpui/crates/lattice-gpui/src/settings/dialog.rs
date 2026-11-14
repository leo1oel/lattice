//! Settings, the dialog (`src/settings/settings-dialog.tsx`; dialogs.css
//! `.settings-*`): a dialog of 860 × 640 (the window less 20px a side) on
//! the dialog corner, rising in as every dialog does.
//!
//! The left column (200px, the chrome surface, the hairline at its right)
//! holds the search and the sections, grouped under micro labels; the
//! pointer's fill glides between the sections on the fast tier as the Tauri
//! app's fluid hover does, and leaves the chosen section, which wears the
//! accent wash and the accent ink at semibold, alone. While the search holds
//! a query its results replace the sections: each names the setting and
//! where it lives, the arrows move through them and Enter opens one, which
//! brings its row into view and washes it for a moment. The page scrolls on
//! the panel surface, back to its top whenever the section changes. There is
//! no title bar: each page's title names it, and the X floats in the corner.
//!
//! At 560px of dialog or less the two columns take turns: the sections are
//! a list of cards with chevrons under a "Settings" title, a section opens
//! as a page with a way back, and Escape goes back before it closes.
//!
//! Only the sections the GPUI app has are listed: Appearance, Editor &
//! builds and the TeX doctor. The agent, integration and about pages come
//! with the features they configure.

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, Entity, EventEmitter,
    FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    Pixels, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, WeakEntity, Window, canvas, div, point, prelude::FluentBuilder as _, px,
    svg,
};
use gpui_kit::{
    base::slider::{SliderEvent, SliderState},
    component::input::{InputEvent, InputState},
};
use lattice_i18n::t;
use lattice_settings::SettingsTab;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::{IconButton, LayerPlacement, ModalLayer, rise_in},
};

use super::{
    controls::PageWidth,
    search::{self, Entry},
};
use crate::{project::Project, shell::Shell};

/// The dialog's largest size (`--dialog-large-*`).
const DIALOG_WIDTH: Pixels = px(860.);
const DIALOG_HEIGHT: Pixels = px(640.);
/// At or below this dialog width the sections and the page take turns.
const NARROW_WIDTH: Pixels = px(560.);
pub(super) const NAV_WIDTH: Pixels = px(200.);
/// How long a revealed row stays washed (`settings-row-reveal`).
const REVEAL: Duration = Duration::from_millis(1600);

/// What the dialog asks of the window.
pub enum SettingsEvent {
    Close,
    /// Settings › Editor & builds › Auxiliary files › Clean.
    CleanBuildFiles,
}

/// The pages the GPUI app draws; another remembered page opens Appearance.
fn drawn(tab: SettingsTab) -> SettingsTab {
    match tab {
        SettingsTab::Editor | SettingsTab::Doctor | SettingsTab::Overleaf => tab,
        _ => SettingsTab::Appearance,
    }
}

/// The editable state a page keeps while Settings is open.
pub struct Fields {
    pub search: Entity<InputState>,
    pub author_name: Entity<InputState>,
    pub project_word: Entity<InputState>,
    pub source_font_name: Entity<InputState>,
    pub prose_font_name: Entity<InputState>,
    pub editor_font_size: Entity<SliderState>,
    pub source_line_height: Entity<SliderState>,
    pub prose_font_size: Entity<SliderState>,
    pub prose_line_height: Entity<SliderState>,
    /// Whether a face is being typed by name ("Other font…").
    pub source_other: bool,
    pub prose_other: bool,
    /// The custom accent's popover is open.
    pub custom_accent_open: bool,
    pub custom_accent: Entity<InputState>,
}

pub struct SettingsDialog {
    pub(super) tab: SettingsTab,
    pub(super) fields: Fields,
    shell: WeakEntity<Shell>,
    pub(super) project: Option<Entity<Project>>,
    /// The window's live preview, for its rows in Editor & builds.
    live_preview: Option<Entity<crate::live_preview::LivePreview>>,
    focus: FocusHandle,
    scroll: ScrollHandle,
    pub(super) query: String,
    /// The result the arrows have reached.
    pub(super) result: usize,
    /// The row a result opened, and when, washed for a moment.
    pub(super) reveal: Option<(Entry, Instant)>,
    /// Each row's place in the page, written as it is drawn, for revealing.
    pub(super) rows: Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>,
    viewport: Rc<RefCell<Bounds<Pixels>>>,
    /// In the narrow form, a section's page is open (not the list).
    pub(super) narrow_page: bool,
    /// The search result the pointer's fill was on as last adopted, so only
    /// a new one moves the arrows' place.
    pub(super) results_adopted: Option<usize>,
    /// Settings › Overleaf's view of the account, once the page is drawn.
    pub(super) overleaf: Option<Entity<super::overleaf_pane::OverleafConnection>>,
    _reveal_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SettingsEvent> for SettingsDialog {}

impl Focusable for SettingsDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn slider(min: f32, max: f32, step: f32, value: f32, cx: &mut App) -> Entity<SliderState> {
    cx.new(|_| {
        SliderState::new()
            .min(min)
            .max(max)
            .step(step)
            .default_value(value)
    })
}

impl SettingsDialog {
    pub fn new(
        shell: WeakEntity<Shell>,
        project: Option<Entity<Project>>,
        live_preview: Option<Entity<crate::live_preview::LivePreview>>,
        tab: Option<SettingsTab>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let settings = super::get(cx).clone();
        let appearance = &settings.appearance;
        let input = |value: &str,
                     placeholder: SharedString,
                     window: &mut Window,
                     cx: &mut Context<Self>| {
            let value = value.to_owned();
            cx.new(move |cx| {
                let mut state = InputState::new(window, cx).placeholder(placeholder);
                state.set_value(value, window, cx);
                state
            })
        };
        let search = input("", t!("Search").into(), window, cx);
        let author_name = input(&settings.author_name, t!("Anonymous").into(), window, cx);
        let project_word = input("", t!("e.g. Lattice").into(), window, cx);
        let listed_source = super::appearance_pane::SOURCE_FACES
            .iter()
            .any(|(family, _)| *family == appearance.source_font);
        let listed_prose = super::appearance_pane::PROSE_FACES
            .iter()
            .any(|(family, _)| *family == appearance.prose_font);
        let source_other = !appearance.source_font.is_empty() && !listed_source;
        let prose_other = !appearance.prose_font.is_empty() && !listed_prose;
        let source_font_name = input(
            if source_other {
                &appearance.source_font
            } else {
                ""
            },
            "Fira Code".into(),
            window,
            cx,
        );
        let prose_font_name = input(
            if prose_other {
                &appearance.prose_font
            } else {
                ""
            },
            "Fira Code".into(),
            window,
            cx,
        );
        let custom_accent = input(
            appearance
                .accent
                .custom_rgb()
                .map_or("", |_| appearance.accent.tag()),
            "#3D7AF2".into(),
            window,
            cx,
        );
        let (size_min, size_max) = lattice_settings::FONT_SIZE_RANGE;
        let (line_min, line_max) = lattice_settings::LINE_HEIGHT_RANGE;
        let editor_font_size = slider(size_min, size_max, 1., appearance.editor_font_size, cx);
        let source_line_height =
            slider(line_min, line_max, 0.05, appearance.source_line_height, cx);
        let prose_font_size = slider(size_min, size_max, 1., appearance.prose_font_size, cx);
        let prose_line_height = slider(line_min, line_max, 0.05, appearance.prose_line_height, cx);

        let mut subscriptions = vec![
            cx.subscribe_in(&search, window, |this, _, event: &InputEvent, _, cx| {
                if let InputEvent::Change = event {
                    this.result = 0;
                    cx.notify();
                }
            }),
            cx.subscribe(&author_name, |_, input, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    let name = input.read(cx).value().to_string();
                    super::update(cx, |settings| settings.author_name = name);
                }
            }),
            cx.subscribe_in(
                &project_word,
                window,
                |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.add_project_word(window, cx);
                    }
                    cx.notify();
                },
            ),
            cx.subscribe(&source_font_name, |_, input, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    let name = lattice_settings::normalize_font_name(Some(
                        &serde_json::Value::String(input.read(cx).value().to_string()),
                    ));
                    super::update_appearance(cx, |appearance| appearance.source_font = name);
                }
            }),
            cx.subscribe(&prose_font_name, |_, input, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    let name = lattice_settings::normalize_font_name(Some(
                        &serde_json::Value::String(input.read(cx).value().to_string()),
                    ));
                    super::update_appearance(cx, |appearance| appearance.prose_font = name);
                }
            }),
            cx.subscribe(&custom_accent, |_, input, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    let text = input.read(cx).value().trim().to_string();
                    let text = if text.starts_with('#') {
                        text
                    } else {
                        format!("#{text}")
                    };
                    if let Some(accent @ lattice_settings::Accent::Custom(_)) =
                        lattice_settings::Accent::parse(&text)
                    {
                        super::update_appearance(cx, |appearance| appearance.accent = accent);
                    }
                }
            }),
        ];
        let on_slider = |field: fn(&mut lattice_settings::Appearance, f32)| {
            move |_: &mut Self,
                  _: Entity<SliderState>,
                  event: &SliderEvent,
                  cx: &mut Context<Self>| {
                let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
                let value = value.start();
                super::update_appearance(cx, |appearance| field(appearance, value));
            }
        };
        subscriptions.push(cx.subscribe(
            &editor_font_size,
            on_slider(|appearance, value| appearance.editor_font_size = value.round()),
        ));
        subscriptions.push(cx.subscribe(
            &source_line_height,
            on_slider(|appearance, value| {
                appearance.source_line_height = (value * 20.).round() / 20.
            }),
        ));
        subscriptions.push(cx.subscribe(
            &prose_font_size,
            on_slider(|appearance, value| appearance.prose_font_size = value.round()),
        ));
        subscriptions.push(cx.subscribe(
            &prose_line_height,
            on_slider(|appearance, value| {
                appearance.prose_line_height = (value * 20.).round() / 20.
            }),
        ));
        // An edit from outside (the file, another window) moves the sliders.
        subscriptions.push(cx.observe_global_in::<super::AppSettings>(
            window,
            |this, window, cx| {
                this.sync_sliders(window, cx);
                cx.notify();
            },
        ));
        if let Some(project) = &project {
            subscriptions.push(cx.observe(project, |_, _, cx| cx.notify()));
        }
        // The live preview's rows follow its download, its state and a
        // removal.
        if let Some(live) = &live_preview {
            subscriptions.push(cx.observe(live, |_, _, cx| cx.notify()));
        }

        let tab = drawn(tab.unwrap_or(settings.settings_tab));
        Self {
            tab,
            fields: Fields {
                search,
                author_name,
                project_word,
                source_font_name,
                prose_font_name,
                editor_font_size,
                source_line_height,
                prose_font_size,
                prose_line_height,
                source_other,
                prose_other,
                custom_accent_open: false,
                custom_accent,
            },
            shell,
            project,
            live_preview,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            query: String::new(),
            result: 0,
            reveal: None,
            rows: Rc::default(),
            viewport: Rc::default(),
            narrow_page: false,
            results_adopted: None,
            overleaf: None,
            _reveal_task: None,
            _subscriptions: subscriptions,
        }
    }

    /// Put the keyboard in the search, as Settings opens: typing is how most
    /// people look for a setting. Called once the modal layer, which takes
    /// focus as it first draws, has drawn.
    pub fn focus_search(&self, window: &mut Window, cx: &mut App) {
        self.fields
            .search
            .update(cx, |search, cx| search.focus(window, cx));
    }

    /// The page on screen.
    /// Settings › Overleaf's view of the account, once the page has drawn.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn overleaf_connection(&self) -> Option<Entity<super::overleaf_pane::OverleafConnection>> {
        self.overleaf.clone()
    }

    /// The window Settings is open in.
    pub(super) fn shell(&self) -> WeakEntity<Shell> {
        self.shell.clone()
    }

    pub fn tab(&self) -> SettingsTab {
        self.tab
    }

    /// The row a search result revealed, while it is washed.
    pub fn revealed_row(&self) -> Option<&'static str> {
        self.reveal.as_ref().and_then(|(entry, _)| entry.id)
    }

    /// The search results' labels, for a scenario.
    pub fn result_labels(&self, cx: &App) -> Vec<String> {
        self.results(cx)
            .into_iter()
            .map(|entry| entry.label)
            .collect()
    }

    fn sync_sliders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let appearance = super::get(cx).appearance.clone();
        for (state, value) in [
            (&self.fields.editor_font_size, appearance.editor_font_size),
            (
                &self.fields.source_line_height,
                appearance.source_line_height,
            ),
            (&self.fields.prose_font_size, appearance.prose_font_size),
            (&self.fields.prose_line_height, appearance.prose_line_height),
        ] {
            if state.read(cx).value().start() != value {
                state.update(cx, |state, cx| state.set_value(value, window, cx));
            }
        }
    }

    /// Open a section's page; Settings reopens on it next time.
    pub fn open_tab(&mut self, tab: SettingsTab, cx: &mut Context<Self>) {
        let tab = drawn(tab);
        if tab != self.tab {
            self.tab = tab;
            // Every page shares the viewport, which starts at its top.
            self.scroll.set_offset(point(px(0.), px(0.)));
            self.rows.borrow_mut().clear();
        }
        self.narrow_page = true;
        super::update(cx, |settings| settings.settings_tab = tab);
        cx.notify();
    }

    /// Open a search result: its page, its row brought into view and washed.
    pub fn open_entry(&mut self, entry: Entry, cx: &mut Context<Self>) {
        self.open_tab(entry.tab, cx);
        if entry.id.is_some() {
            self.reveal = Some((entry, Instant::now()));
            // Scrolled once the page has drawn and its rows are measured.
            self._reveal_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                this.update(cx, |this, cx| this.scroll_to_reveal(cx)).ok();
                // Redraw while the wash fades.
                let start = Instant::now();
                while start.elapsed() < REVEAL {
                    cx.background_executor()
                        .timer(Duration::from_millis(16))
                        .await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        return;
                    }
                }
                this.update(cx, |this, cx| {
                    this.reveal = None;
                    cx.notify();
                })
                .ok();
            }));
        }
        cx.notify();
    }

    /// Centre the revealed row in the page.
    fn scroll_to_reveal(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.reveal.as_ref().and_then(|(entry, _)| entry.id) else {
            return;
        };
        let Some(row) = self.rows.borrow().get(id).copied() else {
            return;
        };
        let viewport = *self.viewport.borrow();
        let offset = self.scroll.offset();
        // The row's place in the page, wherever the page is scrolled to.
        let in_page = row.top() - viewport.top() - offset.y;
        let target = in_page - (viewport.size.height - row.size.height) / 2.;
        let max = self.scroll.max_offset().y;
        self.scroll
            .set_offset(point(px(0.), -target.clamp(px(0.), max.max(px(0.)))));
        cx.notify();
    }

    /// How washed a row is now: 1 as it is revealed, fading to 0.
    pub(super) fn revealed(&self, id: &str) -> f32 {
        match &self.reveal {
            Some((entry, at)) if entry.id == Some(id) => {
                let t = at.elapsed().as_secs_f32() / REVEAL.as_secs_f32();
                // `settings-row-reveal`: the wash holds, then eases away.
                if t < 0.25 {
                    1.
                } else {
                    (1. - (t - 0.25) / 0.75).clamp(0., 1.)
                }
            }
            _ => 0.,
        }
    }

    /// A row's place, recorded as it is drawn.
    pub(super) fn measure(&self, id: &'static str) -> AnyElement {
        let rows = self.rows.clone();
        canvas(
            move |bounds, _, _| {
                rows.borrow_mut().insert(id, bounds);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full()
        .into_any_element()
    }

    fn add_project_word(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let word = self.fields.project_word.read(cx).value().trim().to_string();
        let Some(project) = self.project.clone() else {
            return;
        };
        if word.is_empty() {
            return;
        }
        let mut words = project.read(cx).manifest().spelling_words.clone();
        if !words
            .iter()
            .any(|existing| existing.to_lowercase() == word.to_lowercase())
        {
            words.push(word);
            super::editor_pane::set_spelling_words(&project, words, cx);
        }
        self.fields
            .project_word
            .update(cx, |input, cx| input.set_value("", window, cx));
    }

    pub(super) fn add_project_word_clicked(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_project_word(window, cx);
        cx.notify();
    }

    pub(super) fn clean(&mut self, cx: &mut Context<Self>) {
        cx.emit(SettingsEvent::CleanBuildFiles);
    }

    /// The window is cleaning its build files or building.
    pub(super) fn busy(&self, cx: &App) -> (bool, bool) {
        self.shell
            .upgrade()
            .map(|shell| shell.read(cx).settings_busy(cx))
            .unwrap_or((false, false))
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(SettingsEvent::Close);
    }

    pub(super) fn back(&mut self, cx: &mut Context<Self>) {
        self.narrow_page = false;
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let searching = !self.query().trim().is_empty();
        let narrow = self.is_narrow(window);
        match key {
            "escape" if narrow && self.narrow_page => {
                self.back(cx);
                cx.stop_propagation();
            }
            "down" | "up" | "enter" if searching => {
                let results = self.results(cx);
                if results.is_empty() {
                    return;
                }
                match key {
                    "down" => self.result = (self.result + 1).min(results.len() - 1),
                    "up" => self.result = self.result.saturating_sub(1),
                    _ => {
                        let entry = results[self.result.min(results.len() - 1)].clone();
                        self.open_entry(entry, cx);
                    }
                }
                cx.stop_propagation();
                cx.notify();
            }
            _ => {}
        }
    }

    /// The window's live preview, for its rows in Editor & builds.
    pub(super) fn live_preview(&self) -> Option<Entity<crate::live_preview::LivePreview>> {
        self.live_preview.clone()
    }

    fn query(&self) -> String {
        self.query.clone()
    }

    pub(super) fn results(&self, cx: &App) -> Vec<Entry> {
        let known = None;
        let mut entries = search::entries(self.project.is_some(), known);
        if self
            .live_preview()
            .is_some_and(|live| live.read(cx).available())
        {
            entries = search::with_live_preview(entries);
        }
        search::search(&entries, &self.fields.search.read(cx).value())
    }

    fn dialog_size(window: &Window) -> (Pixels, Pixels) {
        let viewport = window.viewport_size();
        (
            DIALOG_WIDTH.min(viewport.width - px(40.)),
            DIALOG_HEIGHT.min(viewport.height - px(40.)),
        )
    }

    fn is_narrow(&self, window: &Window) -> bool {
        Self::dialog_size(window).0 <= NARROW_WIDTH
    }

    /// The page on the right.
    fn content(
        &mut self,
        narrow: bool,
        width: Pixels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let page_width = PageWidth {
            narrow_dialog: narrow,
            width,
        };
        let page = match self.tab {
            SettingsTab::Editor => super::editor_pane::render(self, page_width, window, cx),
            SettingsTab::Doctor => super::editor_pane::doctor(page_width, cx),
            SettingsTab::Overleaf => super::overleaf_pane::render(self, page_width, window, cx),
            _ => super::appearance_pane::render(self, page_width, window, cx),
        };
        let viewport = self.viewport.clone();
        div()
            .relative()
            .children(lattice_ui::parity::probe("settings/content"))
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(palette.panel)
            .child(
                canvas(
                    move |bounds, _, _| *viewport.borrow_mut() = bounds,
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .id("settings-page")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .when(narrow, |this| this.child(self.back_button(cx)))
                    .child(page),
            )
            .into_any_element()
    }

    fn back_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .id("settings-back")
            .flex()
            .items_center()
            .gap(px(2.))
            .w_full()
            .h(px(44.))
            .pl(px(8.))
            .pr(px(10.))
            .bg(palette.panel)
            .cursor_pointer()
            .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
            .line_height(gpui::relative(1.))
            .text_color(palette.accent)
            .child(
                svg()
                    .path(Icon::CHEVRON_LEFT.path())
                    .size(px(15.))
                    .text_color(palette.accent),
            )
            .child(t!("Settings"))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.back(cx)))
            .into_any_element()
    }
}

impl Render for SettingsDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let (width, height) = Self::dialog_size(window);
        let narrow = width <= NARROW_WIDTH;
        let show_nav = !narrow || !self.narrow_page;
        let show_page = !narrow || self.narrow_page;
        let content_width = if narrow { width } else { width - NAV_WIDTH };
        let nav = show_nav.then(|| self.nav(narrow, window, cx));
        let page = show_page.then(|| self.content(narrow, content_width, window, cx));
        let close = IconButton::new("settings-close", Icon::X)
            .tooltip(t!("Close settings"))
            .on_click(cx.listener(|this, _, _, cx| this.close(cx)));
        let card = div()
            .id("settings-modal")
            .children(lattice_ui::parity::probe("settings/modal"))
            .key_context("SettingsDialog")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .relative()
            .flex()
            .w(width)
            .h(height)
            .rounded(px(14.))
            .overflow_hidden()
            .bg(palette.panel)
            .shadow(lattice_ui::Elevation::Dialog.shadows(&palette))
            .children(nav)
            .children(page)
            .child(div().absolute().top(px(10.)).right(px(10.)).child(close));
        let this = cx.entity();
        ModalLayer::new(
            "settings-layer",
            LayerPlacement::Center,
            div()
                .w(width)
                .h(height)
                .child(rise_in("settings-rise", card)),
            move |_, cx| this.update(cx, |this, cx| this.close(cx)),
        )
    }
}
