//! Files dragged in from the Finder, for an owner that takes them
//! ([`Island::accept_file_drops`]): the Agent's, whose page frames Synara,
//! as the Tauri app's window takes every native drop (`onDragDropEvent`)
//! and relays the Agent's into its composer. WebKit no longer handles
//! them, so the page neither opens a file nor hands it to its frame.

use futures::{StreamExt as _, channel::mpsc};
use gpui::{Context, Window};
use serde_json::{Value, json};

use super::{Island, IslandEvent};

impl Island {
    /// Take the Finder's drags for the owner, from the next build on: it
    /// hears each phase as the message `island:file-drop`, `{ phase:
    /// "enter" | "over" | "leave" | "drop", paths, x, y }`, the paths
    /// absolute (none while over), the point in the page's pixels from its
    /// top left.
    pub fn accept_file_drops(&mut self) {
        self.file_drops = true;
    }

    /// The builder, its drags handed to the owner when it takes them.
    pub(super) fn take_file_drops<'a>(
        &mut self,
        builder: wry::WebViewBuilder<'a>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> wry::WebViewBuilder<'a> {
        if !self.file_drops {
            return builder;
        }
        let (sender, mut drops) = mpsc::unbounded::<Value>();
        self._drops = Some(cx.spawn_in(window, async move |this, cx| {
            while let Some(payload) = drops.next().await {
                let delivered = this.update(cx, |_, cx| {
                    cx.emit(IslandEvent::Message {
                        kind: "island:file-drop".into(),
                        payload,
                    })
                });
                if delivered.is_err() {
                    break;
                }
            }
        }));
        builder.with_drag_drop_handler(move |event| {
            sender.unbounded_send(phase(event)).ok();
            true
        })
    }
}

/// A drag's phase as the owner hears it.
fn phase(event: wry::DragDropEvent) -> Value {
    let paths = |paths: Vec<std::path::PathBuf>| {
        paths
            .into_iter()
            .map(|path| Value::String(path.to_string_lossy().into_owned()))
            .collect::<Vec<_>>()
    };
    match event {
        wry::DragDropEvent::Enter {
            paths: dragged,
            position,
        } => json!({
            "phase": "enter", "paths": paths(dragged), "x": position.0, "y": position.1,
        }),
        wry::DragDropEvent::Over { position } => json!({
            "phase": "over", "paths": [], "x": position.0, "y": position.1,
        }),
        wry::DragDropEvent::Drop {
            paths: dropped,
            position,
        } => json!({
            "phase": "drop", "paths": paths(dropped), "x": position.0, "y": position.1,
        }),
        _ => json!({ "phase": "leave", "paths": [] }),
    }
}
