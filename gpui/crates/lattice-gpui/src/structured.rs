//! Boards, spreadsheets and Open Slide decks: the Tauri app's structured
//! documents (`structuredDocumentKind` in `src/canvas/document-canvas.tsx`),
//! each a webview island in its document's panel, built from the Tauri app's
//! own editor (`gpui/islands/`: tldraw's board, Univer's sheet, the Open
//! Slide workspace).
//!
//! The document is the panel's like any other: its buffer holds the file's
//! text, saved by the panel's own autosave through lattice-core's editor
//! transaction (merged against the text it grew from) and kept in step with
//! disk by the panel's disk check. The island is only the editor in front of
//! that text, as the Tauri app's canvas hands `source` and `onChange` to the
//! same components:
//!
//! - the page's serialized text (`doc:change`) becomes the buffer's, which
//!   arms the autosave; a change on disk the panel loads goes to the page
//!   (`doc:source`), which merges it in as the Tauri app's editors do;
//! - the page's `onPersist` (the Agent's spreadsheet commit there) saves now;
//! - per-reader view state (a board's camera, a sheet's scroll and zoom, a
//!   deck's page) stays out of the file, kept for the session by path;
//! - hiding the panel has the page write what is pending at once
//!   (`doc:flush`), so a hibernation never takes an edit with it.
//!
//! What the page's modules ask the Tauri backend for (`invoke`) comes here as
//! `tauri:invoke` and is answered for the commands each kind needs
//! ([`StructuredDocument::invoke`]): a sheet's Excel export and its save
//! panel, a deck's Open Slide lease and refresh (`slides.rs`). Its toasts go
//! to the app's toast stack and its confirmations to the app's confirm
//! dialog, both drawn above every page.
//!
//! The Tauri app shows a structured document alone in its panel: no status
//! bar, no tools in the strip, and until the editor's chunk has loaded, its
//! empty ground (`structuredFallbacks`); this does the same.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use base64::Engine as _;
use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::{Locale, t};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, components::ToastLevel};
use lattice_webview::{
    Bundle, FileScope, Island, IslandConfig, IslandEvent, IslandState, IslandTheme,
};
use serde_json::{Value, json};

use crate::notices::{self, Notice};

mod presentation;
pub mod resources;
mod slides;

/// The kinds of structured document, by path, as the Tauri app tells them
/// apart (`structuredDocumentKind`, `isOpenSlideDeckPath`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StructuredKind {
    Board,
    Sheet,
    Deck,
}

impl StructuredKind {
    /// The kind of the project file at `relative`, if it is a structured one.
    pub fn of(relative: &str) -> Option<Self> {
        let lower = relative.replace('\\', "/").to_lowercase();
        if lower.ends_with(".tldr") {
            Some(Self::Board)
        } else if lower.ends_with(".lattice-sheet") {
            Some(Self::Sheet)
        } else if slides::deck_id(relative).is_some() {
            Some(Self::Deck)
        } else {
            None
        }
    }

    /// The island's page in `gpui/islands/dist`.
    fn island(self) -> &'static str {
        match self {
            Self::Board => "board",
            Self::Sheet => "sheet",
            Self::Deck => "slides",
        }
    }

    fn entry(self) -> &'static str {
        match self {
            Self::Board => "board/index.html",
            Self::Sheet => "sheet/index.html",
            Self::Deck => "slides/index.html",
        }
    }
}

/// What the document tells its panel.
pub enum StructuredEvent {
    /// The page's editor has new text for the file.
    Changed(String),
    /// The page asks for the file to be saved now; answer with
    /// [`StructuredDocument::persisted`].
    Persist(u64),
    /// The page has sent what it held after a [`StructuredDocument::flush`].
    Flushed,
    /// An Open Slide save wrote `path` (not necessarily this deck's own
    /// file): a panel showing it takes the text that landed.
    Wrote { path: String, text: Option<String> },
}

pub struct StructuredDocument {
    kind: StructuredKind,
    island: Option<Entity<Island>>,
    /// Why there is no island: its pages are not built, or the project
    /// folder cannot be read.
    unavailable: Option<String>,
    root: PathBuf,
    relative: String,
    /// The file's text as the panel's buffer has it.
    source: String,
    /// The text the page has, from the host or from its own edits.
    sent: Option<String>,
    shown: bool,
    /// The page has drawn its first frame since it was (re)built.
    drawn: bool,
    /// The interface language the page was last given.
    locale: Locale,
    deck: Option<slides::DeckSession>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<StructuredEvent> for StructuredDocument {}

impl StructuredDocument {
    pub fn new(
        kind: StructuredKind,
        root: &Path,
        relative: String,
        source: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let bundle = resources::islands_dir()
            .ok_or_else(|| {
                "The island pages are not built: run gpui/script/build-islands.".to_string()
            })
            .and_then(|dir| FileScope::new(dir).map_err(|error| format!("{error:#}")));
        let palette = cx.palette().clone();
        let mut subscriptions = Vec::new();
        let (island, unavailable) = match bundle {
            Ok(scope) => {
                let config = IslandConfig {
                    name: kind.island().into(),
                    entry: kind.entry(),
                    bundle: Bundle::Directory(scope),
                    files: None,
                    // The editor's ground, as the canvas lays a structured
                    // editor on it.
                    ground: Some(palette.editor),
                    reveal_on_ready: false,
                    theme: IslandTheme::Document,
                };
                let island = cx.new(|cx| Island::new(config, window, cx));
                subscriptions.push(cx.subscribe_in(&island, window, Self::on_island));
                subscriptions.push(cx.observe(&island, |_, _, cx| cx.notify()));
                (Some(island), None)
            }
            Err(error) => {
                log::error!("{}: {error}", kind.island());
                (None, Some(error))
            }
        };
        let deck = (kind == StructuredKind::Deck).then(|| slides::DeckSession::new(root, cx));
        Self {
            kind,
            island,
            unavailable,
            root: root.to_path_buf(),
            relative,
            source,
            sent: None,
            shown: false,
            drawn: false,
            locale: lattice_i18n::locale(),
            deck,
            _subscriptions: subscriptions,
        }
    }

    pub fn island(&self) -> Option<&Entity<Island>> {
        self.island.as_ref()
    }

    /// The page has drawn the document.
    pub fn is_drawn(&self) -> bool {
        self.drawn
    }

    /// The focus the panel hands out: the page's, or the panel's own ground
    /// when there is no page.
    pub fn focus_handle(&self, cx: &App) -> Option<gpui::FocusHandle> {
        self.island
            .as_ref()
            .map(|island| island.read(cx).focus_handle(cx))
    }

    fn post(&self, kind: &str, payload: Value, cx: &mut Context<Self>) {
        if let Some(island) = &self.island {
            island.update(cx, |island, _| island.post(kind, payload));
        }
    }

    fn respond(&self, id: u64, result: Result<Value, String>, cx: &mut App) {
        if let Some(island) = &self.island {
            island.update(cx, |island, _| island.respond(id, result));
        }
    }

    /// Show or hide the page (its panel became, or stopped being, the one
    /// displayed). Hidden, it writes what it holds at once.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        if !shown {
            self.post("doc:flush", Value::Null, cx);
        }
        self.post("doc:active", json!({ "active": shown }), cx);
        if let Some(island) = &self.island {
            island.update(cx, |island, cx| island.set_active(shown, cx));
        }
        cx.notify();
    }

    /// Have the page write its pending edits now (the panel saves next).
    pub fn flush(&mut self, cx: &mut Context<Self>) {
        self.post("doc:flush", Value::Null, cx);
    }

    /// The buffer's text changed: the page gets it unless it is the page's own.
    pub fn set_source(&mut self, source: String, cx: &mut Context<Self>) {
        if source == self.source {
            return;
        }
        self.source = source;
        if self.sent.as_ref() != Some(&self.source) {
            self.sent = Some(self.source.clone());
            let source = self.source.clone();
            self.post("doc:source", json!({ "source": source }), cx);
        }
    }

    /// The file moved within the project.
    pub fn moved_to(&mut self, relative: String, cx: &mut Context<Self>) {
        self.relative = relative;
        // The page names its document by path (a board routes the Agent's
        // tools by it): open it again under the new one.
        self.open_page(cx);
    }

    /// The panel saved (or failed to) for the page's `doc:persist`.
    pub fn persisted(&self, id: u64, saved: bool, cx: &mut App) {
        self.respond(id, Ok(Value::Bool(saved)), cx);
    }

    /// The project's files changed on disk: a deck's runtime copy follows.
    pub fn files_changed(&mut self, paths: Option<&[String]>, cx: &mut Context<Self>) {
        if self.kind == StructuredKind::Deck {
            let root = self.root.to_string_lossy().into_owned();
            self.post(
                "slides:files-changed",
                json!({ "root": root, "paths": paths }),
                cx,
            );
        }
    }

    /// Send the page everything it needs to show the document.
    fn open_page(&mut self, cx: &mut Context<Self>) {
        self.sent = Some(self.source.clone());
        self.locale = lattice_i18n::locale();
        let view_state = saved_view_state(&self.root.join(&self.relative), cx);
        let mut payload = json!({
            "path": self.relative,
            "source": self.source,
            "viewState": view_state,
            "locale": self.locale.tag(),
            "active": self.shown,
        });
        if self.kind == StructuredKind::Deck {
            payload["projectRoot"] = json!(self.root.to_string_lossy());
            payload["editable"] = json!(true);
        }
        self.post("doc:open", payload, cx);
    }

    fn on_island(
        &mut self,
        _: &Entity<Island>,
        event: &IslandEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            IslandEvent::Ready => {
                self.drawn = false;
                self.open_page(cx);
            }
            IslandEvent::Hibernated => {
                self.drawn = false;
                self.sent = None;
                // The page took its leases with it, without releasing them.
                if let Some(deck) = &mut self.deck {
                    deck.release_all(cx);
                }
                cx.notify();
            }
            IslandEvent::Message { kind, payload } => self.on_message(kind, payload, cx),
            IslandEvent::Request { id, kind, payload } => {
                self.on_request(*id, kind, payload.clone(), window, cx)
            }
            IslandEvent::Focus(_) | IslandEvent::PointerDown => {}
        }
    }

    fn on_message(&mut self, kind: &str, payload: &Value, cx: &mut Context<Self>) {
        log::debug!("{}: {kind}", self.kind.island());
        match kind {
            "doc:change" => {
                let Some(source) = payload.get("source").and_then(Value::as_str) else {
                    return;
                };
                if source == self.source {
                    return;
                }
                self.source = source.to_string();
                self.sent = Some(self.source.clone());
                cx.emit(StructuredEvent::Changed(self.source.clone()));
            }
            "doc:view-state" => {
                if let Some(state) = payload.get("viewState") {
                    save_view_state(&self.root.join(&self.relative), state.clone(), cx);
                }
            }
            "doc:flushed" => cx.emit(StructuredEvent::Flushed),
            "doc:drawn" => {
                self.drawn = true;
                if let Some(island) = &self.island {
                    island.update(cx, |island, cx| island.reveal(cx));
                }
                cx.notify();
            }
            "island:notify" => show_page_notice(payload, cx),
            "slides:agent-request" => notices::info(
                t!("The Agent is not in the GPUI preview yet."),
                t!("Open Slide’s Ask AI, Apply comments and Draft a deck need the Agent."),
                cx,
            ),
            _ => log::debug!("{}: unhandled {kind}", self.kind.island()),
        }
    }

    fn on_request(
        &mut self,
        id: u64,
        kind: &str,
        payload: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            "doc:persist" => cx.emit(StructuredEvent::Persist(id)),
            "island:confirm" => self.confirm(id, &payload, cx),
            "tauri:invoke" => self.invoke(id, payload, window, cx),
            "slides:mutation" if self.kind == StructuredKind::Deck => {
                self.apply_mutation(id, payload, cx)
            }
            _ => self.respond(id, Err(format!("unknown request {kind}")), cx),
        }
    }

    /// The page's `confirmAction`, asked in the app's confirm dialog.
    fn confirm(&mut self, id: u64, payload: &Value, cx: &mut Context<Self>) {
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let message = text("message").unwrap_or_default();
        let (title, body) = match text("title") {
            Some(title) => (title, Some(message)),
            None => (message, None),
        };
        let mut question = crate::confirm::Confirm::new(title);
        if let Some(body) = body.filter(|body| !body.is_empty()) {
            question = question.body(body);
        }
        if let Some(label) = text("confirmLabel") {
            question = question.confirm_label(label);
        }
        if payload.get("destructive").and_then(Value::as_bool) == Some(true) {
            question = question.destructive();
        }
        let this = cx.entity().downgrade();
        let cancelled = this.clone();
        question = question
            .on_confirm(move |_, cx| {
                this.update(cx, |this, cx| this.respond(id, Ok(json!("confirm")), cx))
                    .ok();
            })
            .on_cancel(move |cx| {
                cancelled
                    .update(cx, |this, cx| this.respond(id, Ok(json!("cancel")), cx))
                    .ok();
            });
        crate::confirm::ask(question, cx);
    }

    /// One of the Tauri backend's commands, as the page's modules invoke it.
    fn invoke(&mut self, id: u64, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let args = payload.get("args").cloned().unwrap_or(Value::Null);
        match (self.kind, command.as_str()) {
            (_, "plugin:dialog|save") => self.save_panel(id, &args, window, cx),
            (StructuredKind::Sheet, "save_xlsx") => self.save_xlsx(id, &payload, cx),
            (StructuredKind::Deck, _) if slides::handles(&command) => {
                let result = self
                    .deck
                    .as_mut()
                    .map(|deck| deck.invoke(&command, &args, cx));
                match result {
                    Some(task) => {
                        let this = cx.entity().downgrade();
                        cx.spawn(async move |_, cx| {
                            let result = task.await;
                            this.update(cx, |this, cx| this.respond(id, result, cx))
                                .ok();
                        })
                        .detach();
                    }
                    None => self.respond(id, Err("No deck".into()), cx),
                }
            }
            _ => {
                log::warn!("{}: refused {command}", self.kind.island());
                self.respond(
                    id,
                    Err(format!("{command} is not available in the GPUI preview")),
                    cx,
                );
            }
        }
    }

    /// The native save panel (`@tauri-apps/plugin-dialog`'s `save`): the
    /// path chosen, or `null` when cancelled.
    fn save_panel(&mut self, id: u64, args: &Value, window: &mut Window, cx: &mut Context<Self>) {
        let options = args.get("options").cloned().unwrap_or(Value::Null);
        let suggested = options
            .get("defaultPath")
            .and_then(Value::as_str)
            .map(|path| {
                Path::new(path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .filter(|name| !name.is_empty());
        let directory = dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| self.root.clone());
        let chosen = cx.prompt_for_new_path(&directory, suggested.as_deref());
        cx.spawn_in(window, async move |this, cx| {
            let answer = match chosen.await {
                Ok(Ok(Some(path))) => Ok(json!(path.to_string_lossy())),
                Ok(Ok(None)) | Err(_) => Ok(Value::Null),
                Ok(Err(error)) => Err(format!("{error:#}")),
            };
            this.update(cx, |this, cx| this.respond(id, answer, cx))
                .ok();
        })
        .detach();
    }

    /// `save_xlsx`: the workbook's bytes written where the writer chose,
    /// checked as the Tauri app checks them (lattice-core's `export::save`).
    fn save_xlsx(&mut self, id: u64, payload: &Value, cx: &mut Context<Self>) {
        let request = xlsx_request(payload);
        let this = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = match request {
                Ok((destination, bytes)) => {
                    cx.background_spawn(async move {
                        lattice_core::export::save(
                            &destination,
                            &bytes,
                            &lattice_core::export::XLSX,
                        )
                    })
                    .await
                }
                Err(error) => Err(error),
            };
            this.update(cx, |this, cx| {
                this.respond(id, result.map(Value::String), cx)
            })
            .ok();
        })
        .detach();
    }

    /// An Open Slide save: applied to the project, answered with what landed.
    fn apply_mutation(&mut self, id: u64, payload: Value, cx: &mut Context<Self>) {
        let root = self.root.clone();
        let this = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let applied = cx
                .background_spawn(async move { slides::apply_mutation(&root, &payload) })
                .await;
            this.update(cx, |this, cx| match applied {
                Ok(applied) => {
                    if applied.had_conflicts {
                        notices::warning(
                            t!(
                                "Open Slide and another editor changed the same lines in {path}; Lattice kept both with conflict markers.",
                                path = applied.path
                            ),
                            cx,
                        );
                    }
                    cx.emit(StructuredEvent::Wrote {
                        path: applied.path.clone(),
                        text: applied.text.clone(),
                    });
                    this.respond(id, Ok(applied.operations), cx);
                }
                Err(error) => this.respond(id, Err(error), cx),
            })
            .ok();
        })
        .detach();
    }
}

/// `save_xlsx`'s destination (a base64 UTF-8 header, `x-xlsx-destination`)
/// and the workbook's bytes (the request body, base64 over the bridge).
fn xlsx_request(payload: &Value) -> Result<(PathBuf, Vec<u8>), String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let destination = payload
        .get("headers")
        .and_then(|headers| headers.get("x-xlsx-destination"))
        .and_then(Value::as_str)
        .and_then(|encoded| engine.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "Choose where to export the Excel workbook.".to_string())?;
    let bytes = payload
        .get("base64")
        .and_then(Value::as_str)
        .and_then(|encoded| engine.decode(encoded).ok())
        .ok_or_else(|| "The Excel workbook was not sent as binary data.".to_string())?;
    Ok((PathBuf::from(destination), bytes))
}

/// A toast the page raised (`island:notify`), on the app's stack.
fn show_page_notice(payload: &Value, cx: &mut App) {
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let level = match text("level").as_str() {
        "error" => ToastLevel::Error,
        "warning" => ToastLevel::Warning,
        "success" => ToastLevel::Success,
        _ => ToastLevel::Info,
    };
    let mut notice = Notice::new(level, text("title"));
    let detail = text("detail");
    if !detail.is_empty() {
        notice = notice.detail(detail);
    }
    notices::show(notice, cx);
}

impl Render for StructuredDocument {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The interface language changed (settings redraw every window).
        if lattice_i18n::locale() != self.locale {
            self.locale = lattice_i18n::locale();
            let locale = self.locale.tag();
            self.post("doc:locale", json!({ "locale": locale }), cx);
        }
        let palette = cx.palette().clone();
        let failure = self.unavailable.clone().or_else(|| {
            self.island
                .as_ref()
                .and_then(|island| match island.read(cx).state() {
                    IslandState::Failed(error) => Some(error.clone()),
                    _ => None,
                })
        });
        div()
            .id(("structured", self.kind as usize))
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(palette.editor)
            .children(lattice_ui::parity::probe(match self.kind {
                StructuredKind::Board => "board/surface",
                StructuredKind::Sheet => "sheet/surface",
                StructuredKind::Deck => "slides/surface",
            }))
            .when_some(failure, |this, failure| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(4.))
                        .px(px(24.))
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text)
                                .child(match self.kind {
                                    StructuredKind::Board => t!("Couldn’t open this board"),
                                    StructuredKind::Sheet => t!("Couldn’t open this spreadsheet"),
                                    StructuredKind::Deck => t!("Open Slide could not start"),
                                }),
                        )
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .text_center()
                                .child(failure),
                        ),
                )
            })
            .when_some(self.island.clone(), |this, island| this.child(island))
    }
}

/// The view states of structured documents this session, by path: a board's
/// camera, a sheet's selection, scroll and zoom, a deck's page
/// (`BoardFileViewState`, `SpreadsheetFileViewState`, `OpenSlideFileViewState`).
#[derive(Default)]
struct ViewStates(HashMap<PathBuf, Value>);

impl gpui::Global for ViewStates {}

fn saved_view_state(path: &Path, cx: &App) -> Value {
    cx.try_global::<ViewStates>()
        .and_then(|states| states.0.get(path).cloned())
        .unwrap_or(Value::Null)
}

fn save_view_state(path: &Path, state: Value, cx: &mut App) {
    cx.default_global::<ViewStates>()
        .0
        .insert(path.to_path_buf(), state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_follow_the_tauri_apps_paths() {
        assert_eq!(StructuredKind::of("map.tldr"), Some(StructuredKind::Board));
        assert_eq!(StructuredKind::of("a/B.TLDR"), Some(StructuredKind::Board));
        assert_eq!(
            StructuredKind::of("data/results.lattice-sheet"),
            Some(StructuredKind::Sheet)
        );
        assert_eq!(
            StructuredKind::of("slides/understanding-attention/index.tsx"),
            Some(StructuredKind::Deck)
        );
        assert_eq!(StructuredKind::of("slides/a/b/index.tsx"), None);
        assert_eq!(StructuredKind::of("main.tex"), None);
        assert_eq!(StructuredKind::of("results.csv"), None);
    }

    #[test]
    fn an_xlsx_export_names_its_destination_and_carries_its_bytes() {
        let engine = base64::engine::general_purpose::STANDARD;
        let payload = json!({
            "headers": { "x-xlsx-destination": engine.encode("/tmp/结果.xlsx") },
            "base64": engine.encode(b"PK\x03\x04"),
        });
        let (destination, bytes) = xlsx_request(&payload).unwrap();
        assert_eq!(destination, PathBuf::from("/tmp/结果.xlsx"));
        assert_eq!(bytes, b"PK\x03\x04");
        assert!(xlsx_request(&json!({ "base64": "" })).is_err());
        assert!(
            xlsx_request(&json!({ "headers": { "x-xlsx-destination": engine.encode("/x.xlsx") } }))
                .is_err()
        );
    }
}
