//! Synara's notifications on the app's stack (`synara-notifications.ts`'s
//! parsed message, as the Tauri host's `useSynaraNotificationBridge` shows
//! them), with their buttons answering the frame.

use gpui::Context;
use lattice_ui::components::ToastLevel;
use serde_json::{Value, json};

use super::SynaraSurface;
use crate::notices::{self, Notice, NoticeAction};

impl SynaraSurface {
    /// One of Synara's notifications (`synara-notifications.ts`'s parsed
    /// message), on the app's stack under its id: a later one with the same
    /// id replaces it, a loading one runs until its outcome does, and its
    /// buttons answer the frame.
    pub(super) fn synara_notice(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let Some(id) = text("id") else { return };
        let key = format!("synara:{}:{id}", self.kind.name());
        if text("operation").as_deref() == Some("dismiss") {
            // Only a running one follows Synara's close; a finished one keeps
            // the app's own display time (as the Tauri host does).
            if notices::is_running(&key, cx) {
                notices::dismiss(&key, cx);
            }
            return;
        }
        let level = text("level").unwrap_or_default();
        let mut notice = Notice::new(
            match level.as_str() {
                "error" => ToastLevel::Error,
                "warning" => ToastLevel::Warning,
                "success" => ToastLevel::Success,
                _ => ToastLevel::Info,
            },
            text("title").unwrap_or_default(),
        )
        .key(key);
        if let Some(detail) = text("detail") {
            notice = notice.detail(detail);
        }
        let timeout = payload.get("timeoutMs").and_then(Value::as_f64);
        if level == "loading" {
            notice = notice.running();
        } else if timeout == Some(0.) {
            notice = notice.persistent();
        } else if text("primaryActionLabel").is_some() || text("secondaryActionLabel").is_some() {
            // `hostNotificationTimeout`: one with a choice stays an error's 9 s.
            notice = notice.timeout(std::time::Duration::from_secs(9));
        }
        if let Some(copy) = text("copyText") {
            notice = notice.copy(copy);
        }
        let dismissed = (cx.entity().downgrade(), id.clone());
        notice = notice.on_dismiss(move |cx| {
            let (this, id) = &dismissed;
            this.update(cx, |this, cx| {
                this.post(
                    "agent:notify-action",
                    json!({ "id": id, "action": "dismiss" }),
                    cx,
                )
            })
            .ok();
        });
        for (label, action) in [
            (text("primaryActionLabel"), "primary"),
            (text("secondaryActionLabel"), "secondary"),
        ] {
            let Some(label) = label else { continue };
            let this = cx.entity().downgrade();
            let id = id.clone();
            notice = notice.action(NoticeAction::new(label, move |_, cx| {
                this.update(cx, |this, cx| {
                    this.post(
                        "agent:notify-action",
                        json!({ "id": id, "action": action }),
                        cx,
                    )
                })
                .ok();
            }));
        }
        notices::show(notice, cx);
    }
}
