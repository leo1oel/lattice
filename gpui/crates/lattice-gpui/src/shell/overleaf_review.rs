//! The window's side of review with Overleaf: each open editor shows the
//! comments and suggestions on its file (`editor_panel::overleaf_review`),
//! refreshed whenever the bridge changes, and a suggestion card's Accept or
//! Reject goes to the bridge.

use gpui::{Context, Entity, Window};
use lattice_i18n::t;

use super::Shell;
use crate::{
    editor_panel::{ChangeMark, CommentMark, EditorPanel, MarginMessage, MarginMode, ReviewAction},
    overleaf::people::person_color,
};

impl Shell {
    /// Every open editor shows its file's comments and suggestions.
    pub(super) fn show_overleaf_review(&mut self, cx: &mut Context<Self>) {
        let bridge = self.overleaf.read(cx);
        let can_act = bridge.can_review();
        let shown: Vec<(Entity<EditorPanel>, Vec<CommentMark>, Vec<ChangeMark>)> = self
            .open_editors()
            .into_iter()
            .map(|editor| {
                let path = editor.read(cx).relative().to_string();
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
                (editor, comments, changes)
            })
            .collect();
        let active = self
            .active_editor()
            .map(|editor| editor.read(cx).relative().to_string());
        self.overleaf_collab
            .update(cx, |panel, cx| panel.set_active(active, cx));
        let mode = self.margin_mode;
        for (editor, comments, changes) in shown {
            editor.update(cx, |editor, cx| {
                editor.set_margin_mode(mode, cx);
                editor.set_overleaf_review(comments, changes, cx)
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
        for editor in self.open_editors() {
            editor.update(cx, |editor, cx| editor.set_margin_mode(mode, cx));
        }
    }
}
