//! The Papers panel's writes that read the manuscript on disk (Remove and
//! Refresh entry): what the editors hold is saved first, and a save that
//! fails stops them, as `remove-reference-action.ts` does.

use std::path::PathBuf;

use gpui::Context;
use lattice_core::papers::PaperSummary;
use lattice_i18n::t;

use super::Shell;
use crate::notices;

impl Shell {
    /// The removal's scan for citations reads the files on disk: what the
    /// editors hold is saved first, and a save that fails stops it, as
    /// `remove-reference-action.ts` does.
    pub(super) fn remove_paper(&mut self, paper: PaperSummary, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let saves = Self::save_dirty(&self.open_editors(), cx);
        let papers = self.papers.downgrade();
        cx.spawn(async move |_, cx| {
            for save in saves {
                match save.await {
                    Ok(true) => {}
                    // A write held or failed has said why already.
                    Ok(false) => return,
                    Err(error) => {
                        cx.update(|cx| {
                            notices::error(
                                t!("Could not remove the paper"),
                                format!("{error:#}"),
                                cx,
                            )
                        });
                        return;
                    }
                }
            }
            papers
                .update(cx, |papers, cx| papers.remove_saved(&paper, root, cx))
                .ok();
        })
        .detach();
    }

    /// Refresh entry re-reads the bibliography on disk: what the editors
    /// hold is saved first, and a save that fails stops it.
    pub(super) fn refresh_entry(&mut self, root: PathBuf, key: String, cx: &mut Context<Self>) {
        let saves = Self::save_dirty(&self.open_editors(), cx);
        let papers = self.papers.downgrade();
        cx.spawn(async move |_, cx| {
            for save in saves {
                match save.await {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(error) => {
                        cx.update(|cx| notices::error(t!("Papers"), format!("{error:#}"), cx));
                        return;
                    }
                }
            }
            papers
                .update(cx, |papers, cx| papers.refresh_saved(root, key, cx))
                .ok();
        })
        .detach();
    }
}
