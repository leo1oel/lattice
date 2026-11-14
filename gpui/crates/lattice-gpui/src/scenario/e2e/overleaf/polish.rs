//! The e2e checks of how the linked window paces itself with Overleaf
//! (`overleaf::bridge::live`, `overleaf::channel`) and of Review here
//! (`shell::overleaf_menus`), against the stand-in:
//!
//! - with the channel carrying documents, live mode's probe of Overleaf's
//!   history slows to every 45 s, and a window off screen asks nothing;
//! - a channel waiting out its backoff joins as soon as the window comes
//!   forward, and says it reconnected;
//! - a board being edited is held from Overleaf, and goes up once the
//!   writer leaves it;
//! - Review here opens the comment by the caret, and View ▸ Margin Review
//!   is offered while the linked source is in front.

use std::{collections::BTreeSet, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _};
use serde_json::json;

use super::super::Steps;
use crate::{
    editor_panel::MarginMode,
    overleaf::bridge::ChannelStatus,
    scenario::{
        Run,
        overleaf_mock::{MockOverleaf, PROJECT_ID},
    },
};

const RECONNECTED: &str = "Overleaf live editing reconnected.";

impl Run {
    pub(super) async fn overleaf_polish(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let probes = format!("GET /project/{PROJECT_ID}/updates");
        // main.tex live, so typing in it goes out on the channel (and the
        // drop below follows from it), never as a change to push.
        let main = self.root(cx).await?.join("main.tex");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(main.clone(), Some(1), window, cx)
            })
        })?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            let bridge = shell.read(cx).overleaf.read(cx);
            bridge.channel() == ChannelStatus::Live
                && bridge.live_file() == Some("main.tex")
                && !bridge.live_sending()
        })
        .await;

        // The channel is up: only figures and new files are left to the
        // poll, so it asks every 45 s, not every 3 s.
        let before = mock.requests(&probes);
        self.pause(cx, Duration::from_secs(8)).await;
        let live_probes = mock.requests(&probes) - before;
        // Off screen, with nothing of ours owed, it asks nothing.
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell
                    .overleaf
                    .update(cx, |bridge, _| bridge.set_window_visible(false))
            })
        })?;
        mock.disable_realtime();
        mock.sever(true);
        self.type_text(cx, "% pace\n").await?;
        let dropped = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                shell.read(cx).overleaf.read(cx).channel() != ChannelStatus::Live
            })
            .await;
        // What the typing saved to disk is ours and owed, so its push may
        // still probe while hidden; once it has settled, nothing does.
        self.pause(cx, Duration::from_secs(6)).await;
        let before = mock.requests(&probes);
        self.pause(cx, Duration::from_secs(7)).await;
        let hidden_probes = mock.requests(&probes) - before;
        steps.check(
            "live mode probes Overleaf every 45 s while the channel carries documents, and not at all from a window off screen",
            live_probes <= 1 && dropped && hidden_probes == 0,
            json!({ "live": live_probes, "dropped": dropped, "hidden": hidden_probes }),
        );

        // Backing off between joins: coming forward joins now.
        let waiting = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                let bridge = shell.read(cx).overleaf.read(cx);
                bridge.channel() == ChannelStatus::Connecting
                    && bridge.channel_detail().is_some_and(|detail| {
                        ["in 4 s", "in 8 s", "in 16 s"]
                            .iter()
                            .any(|wait| detail.contains(wait))
                    })
            })
            .await;
        mock.enable_realtime();
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.overleaf.update(cx, |bridge, cx| {
                    bridge.set_window_visible(true);
                    bridge.set_window_active(true, cx);
                })
            })
        })?;
        let joined = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).overleaf.read(cx).channel() == ChannelStatus::Live
            })
            .await;
        let told = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                crate::notices::install(cx)
                    .read(cx)
                    .titles()
                    .iter()
                    .any(|title| &**title == RECONNECTED)
            })
            .await;
        steps.check(
            "a channel waiting out its backoff joins as the window comes forward, and says it reconnected",
            waiting && joined && told,
            json!({ "waiting": waiting, "joined": joined, "told": told }),
        );

        // A board being edited waits; leaving it sends it up.
        let root = self.root(cx).await?;
        let uploads = format!("POST /project/{PROJECT_ID}/upload");
        let board = "notes.tldr";
        let text = "{\"tldrawFileFormatVersion\":1,\"records\":[]}";
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.overleaf.update(cx, |bridge, cx| {
                    bridge.whole_files_shown(BTreeSet::from([board.to_string()]), cx)
                })
            })
        })?;
        let sent = mock.requests(&uploads);
        std::fs::write(root.join(board), text)?;
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.overleaf.update(cx, |bridge, cx| {
                    bridge.files_changed(Some(&[board.to_string()]), cx)
                })
            })
        })?;
        self.pause(cx, Duration::from_secs(5)).await;
        let held = mock.requests(&uploads) == sent && mock.file(board).is_none();
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell
                    .overleaf
                    .update(cx, |bridge, cx| bridge.whole_files_shown(BTreeSet::new(), cx))
            })
        })?;
        let mut went = false;
        for _ in 0..40 {
            if mock.file(board).as_deref() == Some(text) {
                went = true;
                break;
            }
            self.pause(cx, Duration::from_millis(500)).await;
        }
        steps.check(
            "a board being edited is held from Overleaf, and goes up once the writer leaves it",
            held && went,
            json!({ "held": held, "went": went, "uploads": mock.requests(&uploads) - sent }),
        );

        // Review here: the comment by the caret opens.
        let main = root.join("main.tex");
        let quote: String = mock
            .file("main.tex")
            .unwrap_or_default()
            .chars()
            .take(6)
            .collect();
        let thread = mock.peer_commented("main.tex", 0, &quote, "Here?");
        let key = format!("comment:{thread}");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(main.clone(), Some(1), window, cx);
                shell.set_margin_mode(MarginMode::Markers, cx);
            })
        })?;
        let wanted = key.clone();
        let shown = self
            .wait_for(cx, Duration::from_secs(10), move |shell, cx| {
                shell
                    .update(cx, |shell, cx| shell.open_editor(&main, cx))
                    .is_some_and(|editor| {
                        editor
                            .read(cx)
                            .margin_painted()
                            .iter()
                            .any(|(painted, _)| *painted == wanted)
                    })
            })
            .await;
        let offered = self.with_window(cx, |shell, _, cx| shell.read(cx).margin_review_offered(cx))?;
        // The palette runs it with the source focused, which makes it the
        // window's active editor.
        let focused = root.join("main.tex");
        self.with_window(cx, move |shell, window, cx| {
            if let Some(editor) = shell.update(cx, |shell, cx| shell.open_editor(&focused, cx)) {
                window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
            }
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::ReviewHere), cx)
        })?;
        let main = root.join("main.tex");
        let opened = self
            .wait_for(cx, Duration::from_secs(3), move |shell, cx| {
                shell
                    .update(cx, |shell, cx| shell.open_editor(&main, cx))
                    .is_some_and(|editor| {
                        // The earliest item from the caret's line: ours, at
                        // the file's start, unless an earlier check's
                        // comment or suggestion stands before it.
                        editor.read(cx).margin_open().is_some_and(|open| {
                            open == key.as_str()
                                || open.starts_with("comment:")
                                || open.starts_with("change:")
                        })
                    })
            })
            .await;
        let main = root.join("main.tex");
        let facts = self.with_window(cx, move |shell, _, cx| {
            let active = shell.read(cx).active_editor_path(cx);
            let editor = shell.update(cx, |shell, cx| shell.open_editor(&main, cx));
            let (layout, open, mode, cursor) = editor.as_ref().map_or(
                (None, None, None, None),
                |editor| {
                    let panel = editor.read(cx);
                    (
                        Some(format!("{:?}", panel.margin_layout())),
                        panel.margin_open().map(str::to_string),
                        Some(format!("{:?}", shell.read(cx).margin_mode)),
                        Some(panel.cursor()),
                    )
                },
            );
            json!({ "active": active, "layout": layout, "open": open, "mode": mode, "cursor": cursor })
        })?;
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.set_margin_mode(MarginMode::Auto, cx))
        })?;
        steps.check(
            "Review here opens the comment by the caret, and View ▸ Margin Review is offered for the linked source",
            shown && offered && opened,
            json!({ "shown": shown, "offered": offered, "opened": opened, "facts": facts }),
        );
        Ok(())
    }
}
