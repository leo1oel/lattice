//! A toast an island page raised (`island:notify`, `islands/shared/boot.tsx`)
//! on the app's stack, as the Tauri app's toast stack shows the page's own
//! (`notifySuccess`, `notifyCopied` in `app-notify.ts`): its area, title and
//! detail, how long it stays, and its primary action, whose label shows on
//! the card and whose choosing the page runs (`island:notify-action`), so a
//! page's "Open note" still opens the note.

use gpui::{App, WeakEntity};
use lattice_ui::components::ToastLevel;
use lattice_webview::Island;
use serde_json::{Value, json};

use crate::notices::{self, Notice, NoticeAction};

/// Show the toast `payload` describes; its action, if any, is answered by
/// `island`'s page.
pub(crate) fn show(payload: &Value, island: Option<WeakEntity<Island>>, cx: &mut App) {
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let level = match text(payload, "level").as_str() {
        "error" => ToastLevel::Error,
        "warning" => ToastLevel::Warning,
        "success" => ToastLevel::Success,
        _ => ToastLevel::Info,
    };
    let mut notice = Notice::new(level, text(payload, "title"));
    let detail = text(payload, "detail");
    if !detail.is_empty() {
        notice = notice.detail(detail);
    }
    let source = text(payload, "source");
    if !source.is_empty() {
        notice = notice.source(source);
    }
    if let Some(timeout) = payload.get("timeoutMs").and_then(Value::as_u64) {
        notice = notice.timeout(std::time::Duration::from_millis(timeout));
    }
    let action = payload.get("action").filter(|action| action.is_object());
    if let (Some(action), Some(island)) = (action, island) {
        let id = text(action, "id");
        notice = notice.action(NoticeAction::new(text(action, "label"), move |_, cx| {
            island
                .update(cx, |island, _| {
                    island.post("island:notify-action", json!({ "id": &id }))
                })
                .ok();
        }));
    }
    notices::show(notice, cx);
}
