//! The page's `invoke`s (`tauri:invoke`): those that need a window or the
//! app here (the save panel, the browser, the clipboard, the dropped files'
//! bytes), the page preview's through its deck, the rest by `commands.rs`.

use std::path::Path;

use gpui::{Context, Window};
use serde_json::{Value, json};

use super::{super::commands, SynaraSurface, documents};

impl SynaraSurface {
    pub(super) fn invoke(
        &mut self,
        id: u64,
        payload: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let args = payload.get("args").cloned().unwrap_or(Value::Null);
        let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
        match command.as_str() {
            "plugin:dialog|save" => {
                let suggested = args
                    .get("options")
                    .and_then(|options| options.get("defaultPath"))
                    .and_then(Value::as_str)
                    .and_then(|path| Path::new(path).file_name())
                    .map(|name| name.to_string_lossy().into_owned());
                let directory = dirs::document_dir()
                    .or_else(dirs::home_dir)
                    .or_else(|| self.root.clone())
                    .unwrap_or_default();
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
            // Web links only: WebKit does not hand an embedded frame's
            // `_blank` navigation to the browser, so the host does.
            "plugin:opener|open_url" => {
                let url = text("url").unwrap_or_default();
                let lower = url.to_ascii_lowercase();
                if lower.starts_with("https://") || lower.starts_with("http://") {
                    cx.open_url(&url);
                    self.respond(id, Ok(Value::Null), cx);
                } else {
                    self.respond(id, Err("Only web links open in the browser.".into()), cx);
                }
            }
            "plugin:clipboard-manager|write_text" => {
                let text = text("text").unwrap_or_default();
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                self.respond(id, Ok(Value::Null), cx);
            }
            // The bytes of the Finder drop that just happened (`drops.rs`).
            "read_agent_composer_files" => self.read_dropped(id, cx),
            _ if documents::is_presentation(&command) => self.invoke_deck(id, &command, &args, cx),
            _ if commands::handles(&command) => {
                let Some(root) = self.root.clone() else {
                    self.respond(id, Err("No project is open.".into()), cx);
                    return;
                };
                let task = commands::invoke(&root, &command, &payload, cx);
                let ensures = command == "synara_ensure_ready";
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    this.update(cx, |this, cx| {
                        // The frame may load the runtime's origin, and nothing
                        // else, before the page learns where it is.
                        if ensures
                            && let Ok(info) = &result
                            && let Some(origin) = info.get("origin").and_then(Value::as_str)
                            && let Some(island) = &this.island
                        {
                            island.update(cx, |island, _| island.allow_frame_origin(origin));
                        }
                        this.respond(id, result, cx);
                    })
                    .ok();
                })
                .detach();
            }
            _ => {
                log::warn!("{}: refused {command}", self.kind.name());
                self.respond(
                    id,
                    Err(format!("{command} is not available in the GPUI preview")),
                    cx,
                );
            }
        }
    }
}
