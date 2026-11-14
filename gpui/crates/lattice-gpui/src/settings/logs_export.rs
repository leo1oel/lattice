//! Settings › Logs › Export…, as the Tauri app's `ExportDialog`
//! (`src/telemetry/app-log.tsx`, `.app-log-export-*` in
//! `adaptive-feedback.css`): the export of the entries shown, as JSON to read
//! before it goes anywhere, with two choices that widen it (the raw
//! diagnostic text; the app's runtime logs, collected when asked), then
//! Copy JSON or Download JSON.
//!
//! The export is made once, when the dialog opens, so what is read is what
//! leaves; the runtime logs are read off the main thread, and an answer for
//! an earlier ask is dropped.

use std::path::PathBuf;

use gpui::{
    App, AppContext as _, ClipboardItem, Context, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, StatefulInteractiveElement as _,
    Styled as _, Task, Window, div, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox, LayerPlacement, ModalLayer, rise_in},
    scrollbar::FluidScrollbar,
    tokens::RADIUS_DIALOG,
};
use serde_json::Value;

use crate::app_log::{Entry, export};

pub enum ExportEvent {
    Close,
}

enum Runtime {
    Off,
    Collecting,
    Ready(Value),
    Failed(String),
}

pub struct ExportDialog {
    safe: Value,
    raw: Value,
    include_raw: bool,
    runtime: Runtime,
    log_folder: Option<PathBuf>,
    data_folder: Option<PathBuf>,
    generation: u64,
    scroll: ScrollHandle,
    _collect: Option<Task<()>>,
}

impl EventEmitter<ExportEvent> for ExportDialog {}

impl ExportDialog {
    pub fn new(
        entries: &[Entry],
        log_folder: Option<PathBuf>,
        data_folder: Option<PathBuf>,
    ) -> Self {
        Self {
            safe: export::create_now(entries, false),
            raw: export::create_now(entries, true),
            include_raw: false,
            runtime: Runtime::Off,
            log_folder,
            data_folder,
            generation: 0,
            scroll: ScrollHandle::new(),
            _collect: None,
        }
    }

    /// The JSON as it would leave: the export, with the runtime logs when
    /// asked for and collected.
    pub fn text(&self) -> String {
        let mut value = if self.include_raw {
            self.raw.clone()
        } else {
            self.safe.clone()
        };
        if let (Runtime::Ready(logs), Value::Object(map)) = (&self.runtime, &mut value) {
            map.insert("runtime_logs".into(), logs.clone());
        }
        serde_json::to_string_pretty(&value).unwrap_or_default()
    }

    /// Whether the text is all there: the runtime logs, when asked for, read.
    pub fn ready(&self) -> bool {
        !matches!(self.runtime, Runtime::Collecting | Runtime::Failed(_))
    }

    pub fn set_include_raw(&mut self, on: bool, cx: &mut Context<Self>) {
        self.include_raw = on;
        cx.notify();
    }

    pub fn set_include_runtime(&mut self, on: bool, cx: &mut Context<Self>) {
        self.generation += 1;
        if on {
            self.collect(cx);
        } else {
            self.runtime = Runtime::Off;
            self._collect = None;
        }
        cx.notify();
    }

    fn collect(&mut self, cx: &mut Context<Self>) {
        let generation = self.generation;
        self.runtime = Runtime::Collecting;
        let log_root = self.log_folder.clone();
        let data_root = self.data_folder.clone();
        self._collect = Some(cx.spawn(async move |this, cx| {
            let collected = cx
                .background_spawn(async move {
                    let (Some(log_root), Some(data_root)) = (log_root, data_root) else {
                        return Err(t!("This run keeps no log folder.").to_string());
                    };
                    let home = dirs::home_dir();
                    let bundle = lattice_core::diagnostic_logs::collect(
                        &log_root,
                        &data_root,
                        home.as_deref(),
                    );
                    serde_json::to_value(bundle).map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.runtime = match collected {
                        Ok(logs) => Runtime::Ready(logs),
                        Err(error) => Runtime::Failed(error),
                    };
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn copy(&self, cx: &mut App) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.text()));
    }

    /// Save the JSON where the writer chooses, the Downloads folder offered.
    fn download(&self, cx: &mut Context<Self>) {
        let text = self.text();
        let directory = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir);
        let chosen = cx.prompt_for_new_path(&directory, Some("lattice-diagnostics.json"));
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(path))) = chosen.await else {
                return;
            };
            let written = cx
                .background_spawn(async move { std::fs::write(&path, text) })
                .await;
            if let Err(error) = written {
                cx.update(|cx| {
                    crate::notices::error(
                        t!("Couldn’t save the diagnostic log"),
                        error.to_string(),
                        cx,
                    )
                });
            }
        })
        .detach();
    }
}

impl Render for ExportDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = px(720.).min(viewport.width - px(40.));
        let height = px(720.).min(viewport.height - px(40.));
        let mono = cx.lattice().fonts.editor.clone();
        let ready = self.ready();
        let include_runtime = !matches!(self.runtime, Runtime::Off);
        let status = match &self.runtime {
            Runtime::Collecting => Some(
                div()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("Collecting runtime logs…"))
                    .into_any_element(),
            ),
            Runtime::Failed(error) => Some(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(6.))
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text_secondary)
                    .child(format!("{} {error}", t!("Could not collect runtime logs.")))
                    .child(
                        Button::new("app-log-export-retry", t!("Retry"))
                            .compact()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.generation += 1;
                                this.collect(cx);
                                cx.notify();
                            })),
                    )
                    .into_any_element(),
            ),
            _ => None,
        };
        let card = div()
            .w(width)
            .max_h(height)
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(16.))
            .rounded(RADIUS_DIALOG)
            .border_1()
            .border_color(palette.line)
            .bg(palette.panel)
            .shadow(Elevation::Dialog.shadows(&palette))
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(t!("Export diagnostic log")),
            )
            .child(
                div()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text_secondary)
                    .child(t!(
                        "Only operation metadata and counts. Nothing leaves this Mac until you copy or download it"
                    )),
            )
            .child(
                Checkbox::new(
                    "app-log-export-raw",
                    if self.include_raw { CheckState::On } else { CheckState::Off },
                )
                .label(t!("Include raw diagnostic text"))
                .description(t!("May include document text and file paths"))
                .on_toggle(cx.listener(|this, on: &bool, _, cx| this.set_include_raw(*on, cx))),
            )
            .child(
                Checkbox::new(
                    "app-log-export-runtime",
                    if include_runtime { CheckState::On } else { CheckState::Off },
                )
                .label(t!("Include app and Agent runtime logs"))
                .description(t!("Credentials are masked, but paths and document text may remain"))
                .on_toggle(cx.listener(|this, on: &bool, _, cx| this.set_include_runtime(*on, cx))),
            )
            .children(status)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h(px(160.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(palette.line)
                    .bg(palette.window)
                    .child(
                        div()
                            .id("app-log-export-preview")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .p(px(10.))
                            .font_family(mono)
                            .text_size(px(11.))
                            .line_height(gpui::relative(1.5))
                            .text_color(palette.text)
                            .child(self.text()),
                    )
                    .child(FluidScrollbar::vertical("app-log-export-scrollbar", &self.scroll)),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        Button::new("app-log-export-cancel", t!("Cancel"))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(ExportEvent::Close))),
                    )
                    .child(
                        Button::new("app-log-export-copy", t!("Copy JSON"))
                            .disabled(!ready)
                            .on_click(cx.listener(|this, _, _, cx| this.copy(cx))),
                    )
                    .child(
                        Button::new("app-log-export-download", t!("Download JSON"))
                            .primary()
                            .icon(Icon::DOWNLOAD)
                            .disabled(!ready)
                            .on_click(cx.listener(|this, _, _, cx| this.download(cx))),
                    ),
            );
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "app-log-export",
            LayerPlacement::Center,
            rise_in("app-log-export-rise", card),
            move |_, cx| {
                this.update(cx, |_, cx| cx.emit(ExportEvent::Close)).ok();
            },
        )
    }
}
