//! The window's side of review with Overleaf: each open editor shows the
//! comments and suggestions on its file (`editor_panel::overleaf_review`),
//! refreshed whenever the bridge changes, and a suggestion card's Accept or
//! Reject goes to the bridge.

use gpui::{Context, Entity, Window};
use lattice_i18n::t;
use serde_json::{Value, json};

use super::Shell;
use crate::{
    editor_panel::{ChangeMark, CommentMark, EditorPanel, MarginMessage, MarginMode, ReviewAction},
    overleaf::{
        bridge::OverleafBridge,
        people::{people_hues, person_color},
    },
};

/// What a `.tex` file's Visual page runs the Tauri app's Overleaf comment
/// marks and margin review from: the file's threads where they are
/// anchored, everyone's hues as the Tauri app keys them, the window's
/// margin review mode and whether this account may act. The page lists the
/// file as its own document, so an anchor's document is the file's path.
fn visual_review(bridge: &OverleafBridge, path: &str, mode: MarginMode) -> Value {
    let (anchors, threads): (Vec<Value>, Vec<Value>) = bridge
        .comments_in(path)
        .into_iter()
        .map(|(range, thread)| {
            let anchor = json!({
                "threadId": range.thread_id,
                "docId": path,
                "position": range.position,
                "quote": range.quote,
            });
            (anchor, serde_json::to_value(thread).unwrap_or(Value::Null))
        })
        .unzip();
    let mode = match mode {
        MarginMode::Auto => "auto",
        MarginMode::Markers => "markers",
        MarginMode::Off => "off",
    };
    let changes = changes_payload(bridge, path);
    json!({
        "threads": threads,
        "anchors": anchors,
        "hues": people_hues(bridge, path),
        "mode": mode,
        "canAct": bridge.can_review(),
        "changes": changes["changes"],
        "authors": changes["authors"],
    })
}

/// A file's Overleaf suggestions, their authors' names and whether this
/// account may act on them, for a visual editor's marks, cards and margin
/// review (`overleafTrackChangesExtension`; `markdownVisualChanges`).
fn changes_payload(bridge: &OverleafBridge, path: &str) -> Value {
    let changes = bridge
        .live_review(path)
        .map(|review| review.changes.clone())
        .unwrap_or_default();
    let mut authors: Vec<(String, String)> = Vec::new();
    for user in changes
        .iter()
        .filter_map(|change| change.user_id.as_deref())
    {
        if !authors.iter().any(|(id, _)| id == user)
            && let Some(name) = bridge.author_name(Some(user))
        {
            authors.push((user.to_string(), name.to_string()));
        }
    }
    json!({ "changes": changes, "authors": authors, "canAct": bridge.can_review() })
}

impl Shell {
    /// Every open editor shows its file's comments and suggestions.
    pub(super) fn show_overleaf_review(&mut self, cx: &mut Context<Self>) {
        let bridge = self.overleaf.read(cx);
        let can_act = bridge.can_review();
        let mode = self.margin_mode;
        type Shown = (
            Entity<EditorPanel>,
            Vec<CommentMark>,
            Vec<ChangeMark>,
            Option<Value>,
            Option<Value>,
        );
        let shown: Vec<Shown> = self
            .open_editors()
            .into_iter()
            .filter_map(|editor| {
                let path = editor.read(cx).relative().to_string();
                if bridge.typing_unsent(&path) {
                    return None;
                }
                let comments = bridge
                    .comments_in(&path)
                    .into_iter()
                    .map(|(range, thread)| {
                        let opener = thread.messages.first();
                        let color = opener.map_or(person_color(bridge, "", None, false), |m| {
                            person_color(bridge, &m.author_name, m.author_email.as_deref(), m.mine)
                        });
                        let messages = thread
                            .messages
                            .iter()
                            .map(|m| MarginMessage {
                                author: if m.mine {
                                    t!("You").into()
                                } else {
                                    m.author_name.clone().into()
                                },
                                color: person_color(
                                    bridge,
                                    &m.author_name,
                                    m.author_email.as_deref(),
                                    m.mine,
                                ),
                                at: chrono::DateTime::from_timestamp_millis(m.timestamp)
                                    .map(|at| {
                                        crate::overleaf::picker::relative_time(&at.to_rfc3339())
                                    })
                                    .unwrap_or_default(),
                                content: m.content.clone(),
                            })
                            .collect();
                        CommentMark {
                            messages,
                            len: range.quote.encode_utf16().count() as i64,
                            from: range.position,
                            thread_id: range.thread_id,
                            color,
                        }
                    })
                    .collect();
                let changes = bridge
                    .live_review(&path)
                    .map(|review| {
                        review
                            .changes
                            .iter()
                            .map(|change| ChangeMark {
                                author: bridge
                                    .author_name(change.user_id.as_deref())
                                    .map(|name| name.to_string().into())
                                    .unwrap_or_else(|| t!("Unknown").into()),
                                change: change.clone(),
                                can_act,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                // Only a `.tex` file has a Visual page to send it to.
                let visual = editor
                    .read(cx)
                    .latex_view(cx)
                    .map(|_| visual_review(bridge, &path, mode));
                // A Markdown file's visual editor paints the suggestions too.
                let markdown = editor
                    .read(cx)
                    .shows_markdown_page()
                    .then(|| changes_payload(bridge, &path));
                Some((editor, comments, changes, visual, markdown))
            })
            .collect();
        let active = self
            .active_editor()
            .map(|editor| editor.read(cx).relative().to_string());
        self.overleaf_collab
            .update(cx, |panel, cx| panel.set_active(active, cx));
        for (editor, comments, changes, visual, markdown) in shown {
            editor.update(cx, |editor, cx| {
                editor.set_margin_mode(mode, cx);
                editor.set_overleaf_review(comments, changes, cx);
                if let Some(visual) = visual {
                    editor.set_overleaf_visual_review(visual, cx);
                }
                if let Some(markdown) = markdown {
                    editor.set_markdown_overleaf_changes(markdown, cx);
                }
            });
        }
    }

    /// A suggestion card's or a margin card's action.
    pub(super) fn overleaf_review_action(
        &mut self,
        editor: &Entity<EditorPanel>,
        action: &ReviewAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let path = editor.read(cx).relative().to_string();
        match action {
            ReviewAction::Accept(id) => self.overleaf.update(cx, |bridge, cx| {
                bridge.accept_changes(&path, vec![id.clone()], cx)
            }),
            ReviewAction::Reject(id) => self.overleaf.update(cx, |bridge, cx| {
                bridge.reject_changes(&path, vec![id.clone()], cx)
            }),
            ReviewAction::Resolve(thread) => self.overleaf.update(cx, |bridge, cx| {
                bridge.set_thread_resolved(thread, true, cx)
            }),
            ReviewAction::DeleteThread(thread) => {
                let bridge = self.overleaf.clone();
                let thread = thread.clone();
                crate::confirm::ask(
                    crate::confirm::Confirm::new(t!("Delete this discussion?"))
                        .body(t!("Every message in the thread will be removed from Overleaf. This cannot be undone."))
                        .confirm_label(t!("Delete"))
                        .destructive()
                        .on_confirm(move |_, cx| {
                            bridge.update(cx, |bridge, cx| bridge.delete_thread(&thread, cx));
                        }),
                    cx,
                );
            }
            ReviewAction::ReplyWith { thread, content } => {
                self.overleaf.update(cx, |bridge, cx| {
                    bridge.reply_to_thread(thread, content.clone(), |_| {}, cx)
                })
            }
            ReviewAction::Reopen(thread) => self.overleaf.update(cx, |bridge, cx| {
                bridge.set_thread_resolved(thread, false, cx)
            }),
            ReviewAction::DeleteConfirmed(thread) => self
                .overleaf
                .update(cx, |bridge, cx| bridge.delete_thread(thread, cx)),
            ReviewAction::EditMessage { thread, message, content } => {
                self.overleaf.update(cx, |bridge, cx| {
                    bridge.edit_message(thread, message, content.clone(), |_| {}, cx)
                })
            }
            ReviewAction::DeleteMessage { thread, message } => self
                .overleaf
                .update(cx, |bridge, cx| bridge.delete_message(thread, message, cx)),
            ReviewAction::Reply(thread) => {
                let thread = thread.clone();
                self.overleaf_collab
                    .update(cx, |panel, cx| panel.reply_to(thread, window, cx));
                self.reveal_tool("comments", window, cx);
            }
        }
    }

    /// The window's margin review mode (the palette's "Margin review: …").
    pub(crate) fn set_margin_mode(&mut self, mode: MarginMode, cx: &mut Context<Self>) {
        self.margin_mode = mode;
        super::menus::refresh(cx);
        for editor in self.open_editors() {
            editor.update(cx, |editor, cx| editor.set_margin_mode(mode, cx));
        }
        self.show_overleaf_review(cx);
    }
}
