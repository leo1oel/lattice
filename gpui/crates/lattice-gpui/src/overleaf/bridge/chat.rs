//! The linked project's Overleaf chat, kept current without polling (the
//! Tauri app's `use-overleaf-chat.ts`).
//!
//! The conversation so far comes from REST (`lattice_core::overleaf::
//! chat_messages`) the first time the panel needs it, and again each time the
//! channel joins after that, since what was said while it was down never
//! arrives on it; everything else arrives on the channel as it is sent, the
//! writer's own messages included (Overleaf echoes them to the whole room).
//! The two are merged by id: a message can land on the channel while the read
//! is in flight, and Overleaf replays recent ones after a reconnect.
//!
//! The unread count is what makes a message visible while the panel is
//! closed: arrivals from someone else count until the panel shows the chat.

use lattice_core::overleaf::OverleafMessage;

use super::*;

/// How much of the conversation is read: what the Tauri app reads.
const HISTORY_LIMIT: u32 = 100;

#[derive(Default)]
pub(super) struct ChatState {
    /// Oldest first.
    messages: Vec<OverleafMessage>,
    /// Messages from someone else since the panel last showed the chat.
    unread: usize,
    /// The conversation has been read at least once for this project.
    loaded: bool,
    reading: Option<Task<()>>,
    generation: u64,
    sending: bool,
    error: Option<SharedString>,
}

impl OverleafBridge {
    /// The conversation, oldest first.
    pub fn chat_messages(&self) -> &[OverleafMessage] {
        &self.chat.messages
    }

    pub fn chat_unread(&self) -> usize {
        self.chat.unread
    }

    /// The conversation is being read and nothing of it is here yet.
    pub fn chat_loading(&self) -> bool {
        self.chat.reading.is_some() && self.chat.messages.is_empty()
    }

    pub fn chat_sending(&self) -> bool {
        self.chat.sending
    }

    /// The last read's or send's failure, worded for the writer.
    pub fn chat_error(&self) -> Option<&SharedString> {
        self.chat.error.as_ref()
    }

    /// The conversation has not been read, nor is it being read.
    pub fn chat_unasked(&self) -> bool {
        !self.chat.loaded && self.chat.reading.is_none() && self.chat.error.is_none()
    }

    /// Read the conversation, unless it has been read already or is being
    /// read: what opening the chat asks for.
    pub fn load_chat(&mut self, cx: &mut Context<Self>) {
        if !self.chat.loaded && self.chat.reading.is_none() {
            self.read_chat(cx);
        }
    }

    /// The panel shows the chat: nothing in it is unread.
    pub fn mark_chat_read(&mut self, cx: &mut Context<Self>) {
        if self.chat.unread > 0 {
            self.chat.unread = 0;
            cx.notify();
        }
    }

    /// Post `content`; `done` runs once Overleaf has it. The message itself
    /// arrives on the channel, as everyone's does, so nothing is added here:
    /// doing both would show it twice.
    pub fn send_chat(
        &mut self,
        content: String,
        done: impl FnOnce(&mut App) + 'static,
        cx: &mut Context<Self>,
    ) {
        let content = content.trim().to_string();
        let Some(root) = self.root.clone() else {
            return;
        };
        if content.is_empty() || self.chat.sending {
            return;
        }
        self.chat.sending = true;
        self.chat.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let sent = cx
                .background_spawn(async move {
                    lattice_core::overleaf::send_chat_message(
                        &super::super::config_dir(),
                        &root,
                        &content,
                    )
                })
                .await;
            let (sent, expired) = super::super::settled(sent);
            if expired {
                cx.update(super::super::session_changed);
            }
            this.update(cx, |this, cx| {
                this.chat.sending = false;
                match sent {
                    Ok(()) => done(cx),
                    Err(error) => this.chat.error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn read_chat(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        self.chat.generation += 1;
        let generation = self.chat.generation;
        self.chat.error = None;
        self.chat.reading = Some(cx.spawn(async move |this, cx| {
            let read = cx
                .background_spawn(async move {
                    lattice_core::overleaf::chat_messages(
                        &super::super::config_dir(),
                        &root,
                        HISTORY_LIMIT,
                    )
                })
                .await;
            let (read, expired) = super::super::settled(read);
            if expired {
                cx.update(super::super::session_changed);
            }
            this.update(cx, |this, cx| {
                if this.chat.generation != generation {
                    return;
                }
                this.chat.reading = None;
                match read {
                    Ok(history) => {
                        this.chat.loaded = true;
                        merge_messages(&mut this.chat.messages, history);
                    }
                    Err(error) => this.chat.error = Some(error.into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The channel joined: what was said while it was down is read again,
    /// once the conversation has been read at all.
    pub(super) fn chat_joined(&mut self, cx: &mut Context<Self>) {
        if self.chat.loaded {
            self.read_chat(cx);
        }
    }

    /// The project changed or closed: nothing of its chat stays.
    pub(super) fn chat_reset(&mut self) {
        let generation = self.chat.generation + 1;
        self.chat = ChatState {
            generation,
            ..Default::default()
        };
    }

    /// A message arrived on the channel.
    pub(super) fn chat_event(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
        let RealtimeEvent::ChatMessage {
            id,
            content,
            author_name,
            author_email,
            timestamp,
        } = event
        else {
            return;
        };
        // A replay after a reconnect is neither new nor unread.
        if self.chat.messages.iter().any(|message| message.id == id) {
            return;
        }
        let own = self
            .status
            .as_ref()
            .and_then(|status| status.email.as_deref());
        let mine = is_own(own, author_email.as_deref());
        let message = OverleafMessage {
            id,
            content,
            author_name,
            author_email,
            timestamp,
            mine,
        };
        merge_messages(&mut self.chat.messages, vec![message]);
        if !mine {
            self.chat.unread += 1;
        }
        cx.notify();
    }
}

/// Which messages are the writer's own: Overleaf's channel names an author
/// by address only, and addresses differ in case between its endpoints.
fn is_own(own: Option<&str>, author: Option<&str>) -> bool {
    match (own, author) {
        (Some(own), Some(author)) => own.trim().eq_ignore_ascii_case(author.trim()),
        _ => false,
    }
}

/// Fold `incoming` into `messages` by id, the read's copy winning (it says
/// whether a message is the writer's from the account itself), and keep the
/// conversation in time order.
fn merge_messages(messages: &mut Vec<OverleafMessage>, incoming: Vec<OverleafMessage>) {
    for message in incoming {
        match messages.iter_mut().find(|known| known.id == message.id) {
            Some(known) => *known = message,
            None => messages.push(message),
        }
    }
    // Stable, so messages sent in the same millisecond keep their arrival order.
    messages.sort_by_key(|message| message.timestamp);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, at: i64) -> OverleafMessage {
        OverleafMessage {
            id: id.to_string(),
            content: format!("message {id}"),
            author_name: "Ada Lovelace".to_string(),
            author_email: Some("ada@example.edu".to_string()),
            timestamp: at,
            mine: false,
        }
    }

    #[test]
    fn a_read_keeps_what_arrived_while_it_was_in_flight() {
        // The channel delivered m3 before the read of m1 and m2 came back.
        let mut messages = vec![message("m3", 30)];
        merge_messages(&mut messages, vec![message("m1", 10), message("m2", 20)]);
        let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "m3"]);
    }

    #[test]
    fn a_message_read_twice_is_listed_once() {
        let mut messages = vec![message("m1", 10)];
        let mut again = message("m1", 10);
        again.mine = true;
        merge_messages(&mut messages, vec![again]);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].mine, "the read's copy says whose it is");
    }

    #[test]
    fn own_messages_match_the_address_whatever_its_case() {
        assert!(is_own(Some("Ada@Example.edu"), Some(" ada@example.edu")));
        assert!(!is_own(Some("ada@example.edu"), Some("grace@example.edu")));
        assert!(!is_own(None, Some("ada@example.edu")));
        assert!(!is_own(Some("ada@example.edu"), None));
    }
}
