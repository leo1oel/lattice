//! The e2e checks of Overleaf's own history in the History panel
//! (`history::overleaf`), against the stand-in: a collaborator's edit made
//! on Overleaf is listed in the Overleaf view, with their name; the entry
//! before it, compared with now, names the file and shows its two texts;
//! restoring the file from there puts Overleaf's copy back and the project
//! here follows on the next sync; and a name typed for a version with
//! native keys is kept on Overleaf and shown on the entry.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::super::Steps;
use crate::scenario::{Run, overleaf_mock::MockOverleaf};

const BIB: &str = "@misc{a, title={A}}\n";
const REVISED: &str = "@misc{a, title={A revised}}\n";

impl Run {
    pub(super) async fn overleaf_project_history(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        mock: &MockOverleaf,
    ) -> Result<()> {
        let root = self.root(cx).await?;
        let before = mock.version();
        mock.edit("refs.bib", REVISED);
        let synced = self
            .wait_for(cx, Duration::from_secs(40), |_, _| {
                std::fs::read_to_string(root.join("refs.bib")).is_ok_and(|text| text == REVISED)
            })
            .await;

        // The Overleaf view lists it.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_history(window, cx))
        })?;
        let history = cx.update(|cx| self.shell.read(cx).history.clone());
        cx.update(|cx| history.update(cx, |history, cx| history.show_overleaf_for_scenario(cx)));
        let newest = mock.version();
        let listed = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                history
                    .read(cx)
                    .overleaf_updates()
                    .first()
                    .is_some_and(|update| {
                        update.to_version == newest
                            && update.paths == ["refs.bib"]
                            && update.authors == ["Grace Hopper"]
                    })
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        self.adapter_shot(cx, "overleaf-history").await;
        steps.check(
            "a collaborator's edit on Overleaf is listed in the History panel's Overleaf view, with their name",
            synced && listed,
            json!({ "synced": synced, "listed": listed, "updates": cx.update(|cx| history.read(cx).overleaf_updates().len()) }),
        );

        // The entry before it, compared with now: the file and its two texts.
        cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.compare_overleaf_for_scenario(before, cx)
            })
        });
        let named = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                history.read(cx).overleaf_files().is_some_and(|files| {
                    files
                        .iter()
                        .any(|file| file.pathname == "refs.bib" && file.operation == "edited")
                })
            })
            .await;
        cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.open_overleaf_file_for_scenario("refs.bib", cx)
            })
        });
        let texts = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                history
                    .read(cx)
                    .overleaf_diff_texts()
                    .is_some_and(|(old, new)| {
                        old.as_deref() == Some(BIB) && new.as_deref() == Some(REVISED)
                    })
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        self.adapter_shot(cx, "overleaf-history-compare").await;
        steps.check(
            "an Overleaf entry compared with now names the file changed since and shows its text then and now",
            named && texts,
            json!({ "named": named, "texts": texts, "files": cx.update(|cx| format!("{:?}", history.read(cx).overleaf_files())) }),
        );

        // Restored from there: Overleaf's copy, then the project here.
        let asked = cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.restore_overleaf_file_for_scenario("refs.bib", cx)
            })
        });
        let restored = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                let there = mock.file("refs.bib").as_deref() == Some(BIB);
                let here =
                    std::fs::read_to_string(root.join("refs.bib")).is_ok_and(|text| text == BIB);
                let listed = history
                    .read(cx)
                    .overleaf_updates()
                    .first()
                    .is_some_and(|update| update.origin.as_deref() == Some("file-restore"));
                there && here && listed
            })
            .await;
        steps.check(
            "restoring a file from Overleaf's history rewinds Overleaf's copy, and the project here follows",
            asked && restored,
            json!({
                "asked": asked,
                "restored": restored,
                "overleaf": mock.file("refs.bib"),
                "here": std::fs::read_to_string(root.join("refs.bib")).ok(),
                "newest": cx.update(|cx| history.read(cx).overleaf_updates().first().map(|u| format!("{u:?}"))),
                "requests": mock.history_requests(),
            }),
        );

        // The comparison still open moves with Overleaf's newest version: the
        // restore put refs.bib back to its text at that entry, so the range
        // no longer lists it (a list read once, over the old range, would
        // still say "edited").
        let moved = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                history
                    .read(cx)
                    .overleaf_files()
                    .is_some_and(|files| !files.iter().any(|file| file.pathname == "refs.bib"))
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        self.adapter_shot(cx, "overleaf-history-restored").await;
        steps.check(
            "after the restore, the open comparison reads its files again over the moved range",
            moved,
            json!({ "files": cx.update(|cx| format!("{:?}", history.read(cx).overleaf_files())) }),
        );

        // A name for the newest version, typed and saved with Enter.
        let newest = cx
            .update(|cx| {
                history
                    .read(cx)
                    .overleaf_updates()
                    .first()
                    .map(|u| u.to_version)
            })
            .context("an Overleaf entry")?;
        cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.toggle_row(format!("overleaf:{newest}"), cx)
            })
        });
        self.with_window(cx, |_, window, cx| {
            history.update(cx, |history, cx| {
                history.name_overleaf_version_for_scenario(window, cx)
            })
        })?;
        let name = "Submitted draft";
        {
            let _front = self.focused(cx, "overleaf version name").await?;
            self.type_text(cx, name).await?;
            self.press(cx, '\n', false).await?;
        }
        let kept = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                let there = mock
                    .labels()
                    .iter()
                    .any(|(version, comment)| *version == newest && comment == name);
                let shown = history.read(cx).overleaf_updates().iter().any(|update| {
                    update.to_version == newest
                        && update.labels.iter().any(|label| label.comment == name)
                });
                there && shown && !history.read(cx).overleaf_busy()
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        self.adapter_shot(cx, "overleaf-history-named").await;
        steps.check(
            "a name typed for an Overleaf version is kept on Overleaf and shown on the entry",
            kept,
            json!({ "kept": kept, "labels": mock.labels() }),
        );
        Ok(())
    }
}
