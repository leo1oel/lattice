//! The e2e checks of review with Overleaf (`overleaf::bridge::review`),
//! against the stand-in's threads and suggestions
//! (`scenario/overleaf_review_mock.rs`), with main.tex live:
//!
//! - a collaborator's suggestion and comment reach the live document, named;
//! - replying, resolving and reopening reach Overleaf's thread;
//! - accepting a suggestion leaves the text and clears it on both sides;
//! - rejecting one undoes it on both sides;
//! - a comment made here is posted and anchored on Overleaf;
//! - with track changes on, typing here reaches Overleaf as a suggestion,
//!   and the provisional one shown at once gives way to Overleaf's.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{App, AsyncApp, Entity};
use lattice_core::overleaf_rt::ot::{delete, insert};
use serde_json::json;

use super::super::Steps;
use crate::{
    overleaf::bridge::OverleafBridge,
    scenario::{Run, overleaf_mock::MockOverleaf},
    shell::Shell,
};

/// The UTF-16 offset of `needle` in `text`.
fn utf16_at(text: &str, needle: &str) -> Option<i64> {
    let byte = text.find(needle)?;
    Some(text[..byte].encode_utf16().count() as i64)
}

fn bridge(shell: &Entity<Shell>, cx: &App) -> Entity<OverleafBridge> {
    shell.read(cx).overleaf.clone()
}

impl Run {
    pub(super) async fn overleaf_review(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let main = self.root(cx).await?.join("main.tex");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_path(main.clone(), Some(1), window, cx)
            })
        })?;
        self.wait_for(cx, Duration::from_secs(20), |shell, cx| {
            let bridge = shell.read(cx).overleaf.read(cx);
            bridge.live_file() == Some("main.tex") && !bridge.live_sending()
        })
        .await;
        let shell = self.shell.clone();
        let act =
            |cx: &mut AsyncApp,
             work: &dyn Fn(&mut OverleafBridge, &mut gpui::Context<OverleafBridge>)| {
                cx.update(|cx| bridge(&shell, cx).update(cx, |bridge, cx| work(bridge, cx)));
            };

        // A collaborator suggests and comments.
        let suggested = mock.peer_suggested("main.tex", vec![insert(0, "Suggested ")]);
        let text = mock.file("main.tex").unwrap_or_default();
        let quote = "Grace";
        let at = utf16_at(&text, quote).unwrap_or(0);
        let thread = mock.peer_commented("main.tex", at, quote, "Is this right?");
        let arrived = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let bridge = shell.read(cx).overleaf.read(cx);
                let change = bridge.live_review("main.tex").is_some_and(|review| {
                    review.changes.iter().any(|change| {
                        change.text == "Suggested "
                            && !change.deletion
                            && bridge.author_name(change.user_id.as_deref()) == Some("Ada Lovelace")
                    })
                });
                let comment = bridge
                    .comments_in("main.tex")
                    .iter()
                    .any(|(range, thread)| {
                        range.quote == quote
                            && thread
                                .messages
                                .iter()
                                .any(|m| m.content == "Is this right?")
                    });
                change && comment
            })
            .await;
        steps.check(
            "a collaborator's suggestion and comment reach the live document, with their name",
            suggested && arrived,
            json!({ "suggested": suggested, "arrived": arrived, "thread": thread, "changes": mock.changes("main.tex"), "comments": mock.comments("main.tex") }),
        );

        let editor = cx
            .update(|cx| shell.update(cx, |shell, cx| shell.open_editor(&main, cx)))
            .context("main.tex is open")?;
        self.overleaf_review_marks(cx, steps, &editor, "Suggested ", quote)
            .await?;
        self.overleaf_margin_review(cx, steps, &editor, &thread)
            .await?;
        self.overleaf_review_panel(cx, steps).await?;

        // Replying, resolving and reopening.
        act(cx, &|bridge, cx| {
            bridge.reply_to_thread(&thread, "Yes, it is.".into(), cx)
        });
        let replied = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                mock.thread(&thread)
                    .is_some_and(|(messages, _)| messages.iter().any(|m| m == "Yes, it is."))
            })
            .await;
        act(cx, &|bridge, cx| {
            bridge.set_thread_resolved(&thread, true, cx)
        });
        let resolved = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let gone = bridge(shell, cx)
                    .read(cx)
                    .comments_in("main.tex")
                    .iter()
                    .all(|(range, _)| range.thread_id != thread);
                gone && mock.thread(&thread).is_some_and(|(_, resolved)| resolved)
            })
            .await;
        act(cx, &|bridge, cx| {
            bridge.set_thread_resolved(&thread, false, cx)
        });
        let reopened = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                bridge(shell, cx)
                    .read(cx)
                    .comments_in("main.tex")
                    .iter()
                    .any(|(range, _)| range.thread_id == thread)
            })
            .await;
        steps.check(
            "replying, resolving and reopening reach Overleaf's thread",
            replied && resolved && reopened,
            json!({ "replied": replied, "resolved": resolved, "reopened": reopened, "requests": mock.review_requests() }),
        );

        // Accepting the suggestion keeps its text.
        self.wait_for(cx, Duration::from_secs(10), |shell, cx| {
            bridge(shell, cx)
                .read(cx)
                .live_review("main.tex")
                .is_some_and(|review| {
                    !review.changes.is_empty()
                        && review
                            .changes
                            .iter()
                            .all(|c| !c.id.starts_with("provisional:"))
                })
        })
        .await;
        let ids: Vec<String> = cx.update(|cx| {
            bridge(&self.shell, cx)
                .read(cx)
                .live_review("main.tex")
                .map(|review| review.changes.iter().map(|c| c.id.clone()).collect())
                .unwrap_or_default()
        });
        act(cx, &|bridge, cx| {
            bridge.accept_changes("main.tex", ids.clone(), cx)
        });
        let accepted = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let empty = bridge(shell, cx)
                    .read(cx)
                    .live_review("main.tex")
                    .is_some_and(|review| review.changes.is_empty());
                empty && mock.changes("main.tex").is_empty()
            })
            .await;
        let kept = mock
            .file("main.tex")
            .is_some_and(|text| text.starts_with("Suggested "));
        steps.check(
            "accepting a suggestion keeps its text and clears it on both sides",
            !ids.is_empty() && accepted && kept,
            json!({ "ids": ids, "accepted": accepted, "kept": kept }),
        );

        // Rejecting a suggested deletion puts the text back.
        let proposed = mock.peer_suggested("main.tex", vec![delete(0, "Suggested ")]);
        // Acted on once Overleaf's own id has replaced the provisional one,
        // as the review panels allow it.
        let shown = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                bridge(shell, cx)
                    .read(cx)
                    .live_review("main.tex")
                    .is_some_and(|review| {
                        review
                            .changes
                            .iter()
                            .any(|c| c.deletion && !c.id.starts_with("provisional:"))
                    })
            })
            .await;
        let ids: Vec<String> = cx.update(|cx| {
            bridge(&self.shell, cx)
                .read(cx)
                .live_review("main.tex")
                .map(|review| review.changes.iter().map(|c| c.id.clone()).collect())
                .unwrap_or_default()
        });
        self.overleaf_deletion_drawn(cx, steps, &editor, "Suggested ")
            .await?;
        // As the card's Reject asks it.
        for id in &ids {
            let action = crate::editor_panel::ReviewAction::Reject(id.clone());
            cx.update(|cx| {
                editor.update(cx, |_, cx| {
                    cx.emit(crate::editor_panel::EditorPanelEvent::OverleafReview(
                        action,
                    ))
                })
            });
        }
        let rejected = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let text = shell
                    .update(cx, |shell, cx| shell.open_editor(&main, cx))
                    .map(|editor| editor.read(cx).overleaf_text(cx));
                let settled = !bridge(shell, cx).read(cx).live_sending();
                settled
                    && mock.changes("main.tex").is_empty()
                    && text.is_some()
                    && text == mock.file("main.tex")
                    && mock
                        .file("main.tex")
                        .is_some_and(|text| text.starts_with("Suggested "))
            })
            .await;
        steps.check(
            "rejecting a suggested deletion puts the text back on both sides",
            proposed && shown && rejected && mock.rejected().is_empty(),
            json!({ "proposed": proposed, "shown": shown, "rejected": rejected, "overleaf": mock.file("main.tex"), "refused": mock.rejected() }),
        );

        // A comment made here, on the selection.
        self.overleaf_annotate(cx, steps, mock, &editor, "Suggested", "Check this word.")
            .await?;

        // Track changes on: typing goes out as a suggestion.
        mock.set_track_changes(true);
        let tracking = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                bridge(shell, cx).read(cx).tracking()
            })
            .await;
        // Back in the editor, as a click puts the writer there.
        let zed = cx.update(|cx| editor.read(cx).editor().clone());
        let _writer = self.writer_in(cx, &zed).await?;
        self.type_text(cx, "Noted ").await?;
        let recorded = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let on_overleaf = mock
                    .changes("main.tex")
                    .iter()
                    .any(|c| c.text == "Noted " && c.user_id.as_deref() == Some("u-mock"));
                // Overleaf's own id replaced the provisional one.
                let here = bridge(shell, cx)
                    .read(cx)
                    .live_review("main.tex")
                    .is_some_and(|review| {
                        review
                            .changes
                            .iter()
                            .any(|c| c.text == "Noted " && !c.id.starts_with("provisional:"))
                    });
                on_overleaf && here
            })
            .await;
        mock.set_track_changes(false);
        steps.check(
            "with track changes on, typing here reaches Overleaf as a suggestion, and Overleaf's ranges replace the provisional one",
            tracking && recorded,
            json!({ "tracking": tracking, "recorded": recorded, "changes": mock.changes("main.tex"), "review": cx.update(|cx| bridge(&self.shell, cx).read(cx).live_review("main.tex").map(|r| format!("{:?}", r.changes))) }),
        );
        Ok(())
    }
}
