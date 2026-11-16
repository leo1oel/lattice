//! A note made on the compiled PDF of a project linked to Overleaf
//! (`pdf-annotation-composer.tsx`'s Overleaf destination): the PDF knows
//! main.tex is open live, and a note on its words, sent as the PDF's note
//! sends it, is placed again in Overleaf's live text and posted as a
//! comment thread anchored on those words.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::scenario::{Run, overleaf_mock::MockOverleaf};

impl Run {
    pub(super) async fn overleaf_pdf_note(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        const STEP: &str = "a note made on the PDF of a project linked to Overleaf goes to Overleaf as a comment anchored on its words, in the file open live";
        let knows_live = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .pdf()
                    .read(cx)
                    .overleaf_notes()
                    .is_some_and(|overleaf| {
                        overleaf.is_some_and(|overleaf| {
                            overleaf.live_file.as_deref() == Some("main.tex")
                        })
                    })
            })
            .await;
        let live = cx.update(|cx| {
            self.shell
                .read(cx)
                .overleaf
                .read(cx)
                .live_text("main.tex")
                .map(str::to_string)
        });
        let quote = "written on Overleaf";
        let line = live.as_deref().and_then(|text| {
            text.find(quote)
                .map(|at| text[..at].matches('\n').count() + 1)
        });
        let Some(line) = line else {
            steps.check(
                STEP,
                false,
                json!({ "knows_live": knows_live, "live": live }),
            );
            return Ok(());
        };
        let body = "Say where it was written.";
        let sent = self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                let panel = shell.pdf().clone();
                shell.post_pdf_note(&panel, 0, "main.tex", line, quote, quote, body, window, cx)
            })
        })?;
        let anchored = self
            .wait_for(cx, Duration::from_secs(15), |_, _| {
                mock.comments("main.tex").iter().any(|range| {
                    range.quote == quote
                        && mock
                            .thread(&range.thread_id)
                            .is_some_and(|(messages, _)| messages.iter().any(|m| m == body))
                })
            })
            .await;
        steps.check(
            STEP,
            knows_live && anchored && mock.rejected().is_empty(),
            json!({ "knows_live": knows_live, "sent": format!("{sent:?}"), "anchored": anchored, "comments": mock.comments("main.tex") }),
        );

        // A collaborator changed the words since the build: the PDF's
        // selection no longer reads as the quote SyncTeX mapped, so the note
        // is refused in place and nothing reaches Overleaf.
        const STALE: &str = "a PDF note whose words no longer read as its quote in Overleaf's live text is refused, and nothing is posted";
        let before = mock.comments("main.tex").len();
        let stale_quote = "words a collaborator has since removed";
        let refused = self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                let panel = shell.pdf().clone();
                shell.post_pdf_note(
                    &panel,
                    0,
                    "main.tex",
                    line,
                    stale_quote,
                    stale_quote,
                    "Never sent.",
                    window,
                    cx,
                )
            })
        })?;
        // Give a wrongly sent comment time to land before counting.
        cx.background_executor()
            .timer(Duration::from_secs(2))
            .await;
        let after = mock.comments("main.tex").len();
        let says_changed = refused
            .as_ref()
            .err()
            .is_some_and(|error| error.contains("source changed"));
        steps.check(
            STALE,
            says_changed && after == before,
            json!({ "refused": format!("{refused:?}"), "comments_before": before, "comments_after": after }),
        );
        Ok(())
    }
}
