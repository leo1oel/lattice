//! The e2e checks of the project chat (`overleaf::bridge::chat`, the
//! collaboration panel's Chat tab), against the stand-in's live channel: a
//! collaborator's message arrives while the chat is not shown and counts as
//! unread, in the titlebar's count too; showing the chat reads the
//! conversation, lists that message once and clears the count; and a
//! message typed in the composer with native keys and sent with Enter
//! reaches Overleaf, comes back on the channel as the writer's own and
//! leaves the composer empty.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::{
    overleaf::collab::CollabTab,
    scenario::{Run, overleaf_mock::MockOverleaf},
};

impl Run {
    pub(super) async fn overleaf_chat(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        // The panel shows its comments, not the chat, when the message comes.
        self.with_window(cx, |shell, _, cx| {
            let panel = shell.read(cx).overleaf_collab.clone();
            panel.update(cx, |panel, cx| panel.set_tab(CollabTab::Comments, cx))
        })?;
        let question = "Ready for review?";
        mock.peer_chats(question);
        let unread = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).overleaf.read(cx).chat_unread() == 1
            })
            .await;
        steps.check(
            "a collaborator's chat message arrives on the channel and counts as unread while the chat is not shown",
            unread,
            json!({ "unread": cx.update(|cx| self.shell.read(cx).overleaf.read(cx).chat_unread()) }),
        );

        // Shown, the chat reads the conversation and has nothing unread.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_overleaf_collab(Some(CollabTab::Chat), window, cx)
            })
        })?;
        let read = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let bridge = shell.read(cx).overleaf.read(cx);
                let once = bridge
                    .chat_messages()
                    .iter()
                    .filter(|message| message.content == question)
                    .count()
                    == 1;
                once && bridge.chat_unread() == 0 && !bridge.chat_loading()
            })
            .await;
        let asked = mock
            .history_requests()
            .iter()
            .any(|request| request.starts_with("GET /messages"));
        self.pause(cx, Duration::from_millis(400)).await;
        self.adapter_shot(cx, "overleaf-chat").await;
        steps.check(
            "showing the chat reads the conversation from Overleaf, lists the message once and clears the unread count",
            read && asked,
            json!({ "read": read, "asked": asked, "requests": mock.history_requests() }),
        );

        // A reply typed in the composer and sent with Enter.
        let reply = "On it, give me an hour.";
        {
            let _front = self.focused(cx, "overleaf chat").await?;
            self.type_text(cx, reply).await?;
            self.press(cx, '\n', false).await?;
        }
        let sent = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let posted = mock
                    .chat()
                    .iter()
                    .any(|(author, content)| author == "u-mock" && content == reply);
                let bridge = shell.read(cx).overleaf.read(cx);
                let mine = bridge
                    .chat_messages()
                    .iter()
                    .any(|message| message.content == reply && message.mine);
                let emptied = shell
                    .read(cx)
                    .overleaf_collab
                    .read(cx)
                    .chat_draft(cx)
                    .is_some_and(|draft| draft.is_empty());
                posted && mine && emptied && !bridge.chat_sending() && bridge.chat_unread() == 0
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        self.adapter_shot(cx, "overleaf-chat-sent").await;
        steps.check(
            "a reply typed in the composer and sent with Enter reaches Overleaf and comes back as the writer's own",
            sent,
            json!({ "sent": sent, "chat": mock.chat() }),
        );
        Ok(())
    }
}
