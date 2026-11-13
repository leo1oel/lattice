//! A Markdown file's visual editor: the Tauri app's own engine in the
//! `markdown` island (`gpui/islands/markdown/main.tsx`, which lists the
//! protocol), owned by a [`StructuredDocument`] of kind
//! [`StructuredKind::Markdown`] that the panel's Split and Preview views
//! show (`editor_panel/markdown_view.rs`).
//!
//! What the canvas gave the visual editor in the Tauri app
//! (`document-canvas.tsx`, `visual-editor-props.ts`) comes from here:
//!
//! - its edits as the whole file and the text they were made against
//!   (`md:change`), which the panel applies as the minimal change, keeping
//!   the source editor's caret and history ([`MarkdownEvent::Edit`]);
//! - undo and redo through the buffer's history, which the source shares;
//! - View in source, a project link followed, the caret, the Split's scroll;
//! - the project's files for its page index, its TeX sources for KaTeX's
//!   macros, its images through the island's asset protocol (granted one by
//!   one, with the file's time so an edit on disk loads again), and an image
//!   pasted or dropped into the text saved in `figures/` by lattice-core's
//!   `import_image_bytes`, as the Tauri app's `import_clipboard_image`;
//! - the Tauri commands its modules invoke: web links and Zotero links to the
//!   browser, the clipboard, and a link's preview card (lattice-core's
//!   `link_preview`, on a thread of its own).

use std::path::Path;

use gpui::{App, AppContext as _, Context, Entity};
use lattice_core::models::FileNode;
use serde_json::{Value, json};

use super::{StructuredDocument, StructuredEvent};
use crate::project::{Project, ProjectEvent};

/// What a Markdown file's visual editor asks of its panel.
#[derive(Clone, Debug, PartialEq)]
pub enum MarkdownEvent {
    /// The file after an edit made against `base`: the panel applies the
    /// change only while its buffer still holds `base`.
    Edit {
        base: String,
        source: String,
    },
    Undo,
    Redo,
    /// Show the source, the caret at this UTF-16 offset of the file.
    ViewInSource(usize),
    /// A link to a project file was followed.
    OpenPath(String),
    /// The caret moved to this 1-based line and column of the file.
    Caret(u32, u32),
    /// Split: the source line the preview's centre maps to, fractional
    /// within a wrapped line, for the source's centre to follow.
    Scrolled(f64),
}

/// The Tauri app saves pasted images here (`importClipboardImageFile`).
const FIGURES: &str = "figures";
/// TeX sources read for KaTeX's macros, at most.
const TEX_SOURCES_MAX: usize = 64;
const TEX_SOURCE_BYTES_MAX: u64 = 512 * 1024;

/// What the page needs of the project beyond the file.
pub(super) struct MarkdownSession {
    /// The view is Split.
    split: bool,
    files: Value,
    tex_sources: Vec<String>,
    /// Bumped by every read of the project, so a slow one is dropped.
    generation: u64,
}

impl MarkdownSession {
    fn new() -> Self {
        Self {
            split: false,
            files: json!([]),
            tex_sources: Vec::new(),
            generation: 0,
        }
    }
}

/// Every `.tex` path in the tree, in its order.
fn tex_paths(nodes: &[FileNode], into: &mut Vec<String>) {
    for node in nodes {
        tex_paths(&node.children, into);
        if node.kind != "directory"
            && node.size <= TEX_SOURCE_BYTES_MAX
            && node.path.to_ascii_lowercase().ends_with(".tex")
        {
            into.push(node.path.clone());
        }
    }
}

/// The name `import_clipboard_image` is given (`clipboardImageFileName`).
fn image_file_name(mime: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    let stamp = now.format("%Y-%m-%dT%H-%M-%S");
    let extension = if mime.contains("jpg") || mime.contains("jpeg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else {
        "png"
    };
    format!("clipboard-{stamp}.{extension}")
}

/// A file's modification time in milliseconds, so WebKit asks again after
/// an edit on disk.
fn revision(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

fn text(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_string)
}

impl StructuredDocument {
    /// A Markdown file's visual editor over `source`, following `project`'s
    /// files.
    pub fn markdown(
        project: &Entity<Project>,
        relative: String,
        source: String,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let root = project.read(cx).root().to_path_buf();
        let mut this = Self::new(
            super::StructuredKind::Markdown,
            &root,
            relative,
            source,
            window,
            cx,
        );
        this.markdown = Some(MarkdownSession::new());
        this._subscriptions
            .push(cx.subscribe(project, |this, project, event, cx| {
                if let ProjectEvent::FilesChanged(_) = event {
                    this.read_project(&project, cx);
                    this.post("md:assets-changed", Value::Null, cx);
                }
            }));
        this.read_project(project, cx);
        this
    }

    /// Read the project's tree and TeX sources off the main thread, then
    /// give them to the page.
    fn read_project(&mut self, project: &Entity<Project>, cx: &mut Context<Self>) {
        let Some(session) = &mut self.markdown else {
            return;
        };
        session.generation += 1;
        let generation = session.generation;
        let files = project.read(cx).files().to_vec();
        let root = self.root.clone();
        cx.spawn(async move |this, cx| {
            let (tree, sources) = cx
                .background_spawn(async move {
                    let mut paths = Vec::new();
                    tex_paths(&files, &mut paths);
                    let sources = paths
                        .iter()
                        .take(TEX_SOURCES_MAX)
                        .filter_map(|path| lattice_core::project::read_file(&root, path).ok())
                        .collect::<Vec<_>>();
                    (serde_json::to_value(&files).unwrap_or(json!([])), sources)
                })
                .await;
            this.update(cx, |this, cx| {
                let Some(session) = &mut this.markdown else {
                    return;
                };
                if session.generation != generation {
                    return;
                }
                session.files = tree.clone();
                session.tex_sources = sources.clone();
                this.post(
                    "md:project",
                    json!({ "files": tree, "texSources": sources }),
                    cx,
                );
            })
            .ok();
        })
        .detach();
    }

    /// The fields of `doc:open` a Markdown page needs beside the document's.
    pub(super) fn markdown_open(&self, payload: &mut Value) {
        let Some(session) = &self.markdown else {
            return;
        };
        payload["projectRoot"] = json!(self.root.to_string_lossy());
        payload["editable"] = json!(true);
        payload["split"] = json!(session.split);
        payload["files"] = session.files.clone();
        payload["texSources"] = json!(session.tex_sources);
    }

    /// The page has loaded and listens (it can hand over what it holds).
    pub fn page_ready(&self, cx: &App) -> bool {
        self.island
            .as_ref()
            .is_some_and(|island| island.read(cx).is_ready())
    }

    /// The view became, or stopped being, Split.
    pub fn set_split(&mut self, split: bool, cx: &mut Context<Self>) {
        if let Some(session) = &mut self.markdown
            && session.split != split
        {
            session.split = split;
            self.post("md:split", json!({ "split": split }), cx);
        }
    }

    /// Land the visual editor on a 1-based line of the file.
    pub fn reveal_line(&mut self, line: u32, cx: &mut Context<Self>) {
        let id = format!("reveal-{line}-{}", self.reveals);
        self.reveals += 1;
        self.post("md:reveal", json!({ "id": id, "line": line }), cx);
    }

    /// Split: the source line at the source's centre, with the range that
    /// centre can take, for the preview to follow.
    pub fn follow_center(&mut self, center: f64, min: f64, max: f64, cx: &mut Context<Self>) {
        self.post(
            "md:scroll-to",
            json!({ "center": center, "min": min, "max": max }),
            cx,
        );
    }

    /// The panel refused the page's edit: the page takes the buffer's text.
    pub fn resend_source(&mut self, source: String, cx: &mut Context<Self>) {
        self.source = source;
        let source = self.source.clone();
        self.post("doc:source", json!({ "source": source }), cx);
    }

    pub(super) fn on_markdown_message(
        &mut self,
        kind: &str,
        payload: &Value,
        cx: &mut Context<Self>,
    ) {
        let event = match kind {
            "md:change" => {
                let (Some(source), Some(base)) = (text(payload, "source"), text(payload, "base"))
                else {
                    return;
                };
                if source == self.source {
                    return;
                }
                // The page has the text it wrote, so the buffer taking it
                // sends nothing back; a buffer no longer holding `base`
                // resends its own (`resend_source`).
                self.source = source.clone();
                MarkdownEvent::Edit { base, source }
            }
            "md:undo" => MarkdownEvent::Undo,
            "md:redo" => MarkdownEvent::Redo,
            "md:view-in-source" => {
                let offset = payload.get("offset").and_then(Value::as_u64).unwrap_or(0);
                MarkdownEvent::ViewInSource(offset as usize)
            }
            "md:open-path" => match text(payload, "path") {
                Some(path) => MarkdownEvent::OpenPath(path),
                None => return,
            },
            "md:caret" => {
                let number =
                    |key: &str| payload.get(key).and_then(Value::as_u64).unwrap_or(1) as u32;
                MarkdownEvent::Caret(number("line"), number("column"))
            }
            "md:scrolled" => match payload.get("center").and_then(Value::as_f64) {
                Some(center) => MarkdownEvent::Scrolled(center),
                None => return,
            },
            _ => {
                log::debug!("markdown: unhandled {kind}");
                return;
            }
        };
        cx.emit(StructuredEvent::Markdown(event));
    }

    /// Answer a Markdown page's own request; false when `kind` is not one.
    pub(super) fn on_markdown_request(
        &mut self,
        id: u64,
        kind: &str,
        payload: &Value,
        cx: &mut Context<Self>,
    ) -> bool {
        match kind {
            "md:read" => {
                let path = text(payload, "path").unwrap_or_default();
                let root = self.root.clone();
                self.answer_off_thread(id, cx, move || {
                    lattice_core::project::read_file(&root, &path).map(Value::String)
                });
            }
            "md:load-asset" => {
                let path = text(payload, "path").unwrap_or_default();
                let url = self.asset_url(&path, cx);
                self.respond(id, Ok(url.map_or(Value::Null, Value::String)), cx);
            }
            "md:import-asset" => {
                let base64 = text(payload, "base64").unwrap_or_default();
                let name = image_file_name(
                    &text(payload, "type").unwrap_or_default(),
                    chrono::Utc::now(),
                );
                let root = self.root.clone();
                self.answer_off_thread(id, cx, move || {
                    lattice_core::project::import_image_bytes(&root, FIGURES, &name, &base64)
                        .map(Value::String)
                });
            }
            _ => return false,
        }
        true
    }

    /// The asset protocol's URL for the project image at `relative`, or
    /// `None` when there is no such file (the page shows it as missing).
    fn asset_url(&self, relative: &str, cx: &App) -> Option<String> {
        let island = self.island.as_ref()?;
        let absolute = self.files.as_ref()?.resolve(relative).ok()?;
        if !absolute.is_file() {
            return None;
        }
        let url = island.read(cx).grant(relative);
        Some(format!("{url}?v={}", revision(&absolute)))
    }

    fn answer_off_thread(
        &mut self,
        id: u64,
        cx: &mut Context<Self>,
        work: impl FnOnce() -> Result<Value, String> + Send + 'static,
    ) {
        cx.spawn(async move |this, cx| {
            let result = cx.background_spawn(async move { work() }).await;
            this.update(cx, |this, cx| this.respond(id, result, cx))
                .ok();
        })
        .detach();
    }

    /// One of the Tauri commands the visual editor's modules invoke; false
    /// when `command` is not one of them.
    pub(super) fn invoke_markdown(
        &mut self,
        id: u64,
        command: &str,
        args: &Value,
        cx: &mut Context<Self>,
    ) -> bool {
        match command {
            // Links to the web and to Zotero's reader go to the system.
            "plugin:opener|open_url" | "open_zotero_link" => {
                let url = text(args, "url").unwrap_or_default();
                if command == "open_zotero_link" && !lattice_core::zotero::is_annotation_link(&url)
                {
                    self.respond(
                        id,
                        Err("This is not a link into Zotero's PDF reader.".into()),
                        cx,
                    );
                } else {
                    cx.open_url(&url);
                    self.respond(id, Ok(Value::Null), cx);
                }
            }
            "plugin:clipboard-manager|write_text" => {
                let text = text(args, "text").unwrap_or_default();
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                self.respond(id, Ok(Value::Null), cx);
            }
            "link_preview" => {
                let url = text(args, "url").unwrap_or_default();
                let (sender, receiver) = futures::channel::oneshot::channel();
                // lattice-core's preview is async on Tokio, which the app does
                // not otherwise run: a thread of its own, for one request.
                std::thread::spawn(move || {
                    let result = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| error.to_string())
                        .and_then(|runtime| {
                            let preview =
                                runtime.block_on(lattice_core::link_preview::link_preview(url));
                            serde_json::to_value(preview).map_err(|error| error.to_string())
                        });
                    sender.send(result).ok();
                });
                cx.spawn(async move |this, cx| {
                    let result = receiver
                        .await
                        .unwrap_or_else(|_| Err("The link preview stopped.".into()));
                    this.update(cx, |this, cx| this.respond(id, result, cx))
                        .ok();
                })
                .detach();
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, kind: &str, size: u64, children: Vec<FileNode>) -> FileNode {
        FileNode {
            name: path.rsplit('/').next().unwrap_or(path).into(),
            path: path.into(),
            kind: kind.into(),
            content_kind: if kind == "directory" {
                "directory"
            } else {
                "text"
            }
            .into(),
            size,
            children,
        }
    }

    #[test]
    fn the_tex_sources_are_every_small_tex_file() {
        let tree = vec![
            node("main.tex", "tex", 10, vec![]),
            node(
                "chapters",
                "directory",
                0,
                vec![
                    node("chapters/intro.TEX", "tex", 10, vec![]),
                    node("chapters/huge.tex", "tex", TEX_SOURCE_BYTES_MAX + 1, vec![]),
                ],
            ),
            node("notes.md", "markdown", 10, vec![]),
        ];
        let mut paths = Vec::new();
        tex_paths(&tree, &mut paths);
        assert_eq!(paths, ["main.tex", "chapters/intro.TEX"]);
    }

    #[test]
    fn a_pasted_image_is_named_as_the_tauri_app_names_it() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-13T08:09:10.123Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            image_file_name("image/png", now),
            "clipboard-2026-11-13T08-09-10.png"
        );
        assert_eq!(
            image_file_name("image/jpeg", now),
            "clipboard-2026-11-13T08-09-10.jpg"
        );
        assert_eq!(
            image_file_name("image/webp", now),
            "clipboard-2026-11-13T08-09-10.webp"
        );
        assert_eq!(
            image_file_name("", now),
            "clipboard-2026-11-13T08-09-10.png"
        );
    }
}
