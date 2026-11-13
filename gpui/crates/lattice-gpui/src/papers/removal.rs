//! Removing a paper's entry from the primary bibliography
//! (`remove-reference-action.ts`): the writer confirms first, and when the
//! manuscript cites it chooses whether its citations go too or stay
//! unresolved. Downloaded paper files are kept either way.

use gpui::{App, AppContext as _, Context};
use lattice_core::papers::{self as core_papers, CitationRemovalMode, PaperSummary};

use super::PapersPanel;
use crate::{
    confirm::{self, Confirm},
    notices,
};

impl PapersPanel {
    /// Remove `paper`'s entry from the primary bibliography once the writer
    /// confirms (and chooses what happens to its citations, when it is
    /// cited). Downloaded files are kept.
    pub(crate) fn remove(&mut self, paper: &PaperSummary, cx: &mut Context<Self>) {
        let Some(key) = paper.citation_key.clone() else {
            notices::error(
                "Could not remove the paper",
                "This bibliography entry has no citation key to remove.",
                cx,
            );
            return;
        };
        let Some(root) = self.root.clone() else {
            return;
        };
        let view = cx.entity().downgrade();
        let title = paper.title.clone();
        let preview_root = root.clone();
        let preview_key = key.clone();
        let preview = cx.background_spawn(async move {
            core_papers::remove_reference(&preview_root, &preview_key, CitationRemovalMode::Preview)
        });
        cx.spawn(async move |_, cx| {
            let preview = preview.await;
            cx.update(|cx| match preview {
                Err(error) => notices::error("Could not remove the paper", error, cx),
                Ok(preview) => {
                    let question = format!("Remove “{title}” from the bibliography?");
                    let run = move |mode: CitationRemovalMode, cx: &mut App| {
                        let (root, key) = (root.clone(), key.clone());
                        let view = view.clone();
                        let removal = cx.background_spawn(async move {
                            core_papers::remove_reference(&root, &key, mode)
                        });
                        cx.spawn(async move |cx| {
                            let result = removal.await;
                            cx.update(|cx| {
                                match result {
                                    Ok(result) if result.removed => {}
                                    Ok(result) => {
                                        let detail = match result.blockers.first() {
                                            Some(first) => format!(
                                                "The bibliography changed while removing \\cite{{{}}} ({}:{}). Try again.",
                                                result.key, first.path, first.line
                                            ),
                                            None => format!("Could not remove \\cite{{{}}}.", result.key),
                                        };
                                        notices::error("Could not remove the paper", detail, cx);
                                    }
                                    Err(error) => {
                                        notices::error("Could not remove the paper", error, cx)
                                    }
                                }
                                view.update(cx, |this, cx| this.reload(cx)).ok();
                            });
                        })
                        .detach();
                    };
                    let run = std::rc::Rc::new(run);
                    let ask = if let Some(first) = preview.blockers.first() {
                        let count = preview.blockers.len();
                        let cited = if count == 1 {
                            "This entry is cited in 1 place.".to_string()
                        } else {
                            format!("This entry is cited in {count} places.")
                        };
                        let (keep, remove) = (run.clone(), run.clone());
                        Confirm::new(question)
                            .body(format!(
                                "{cited} The first is at {}:{}. Keeping the citation commands will leave them unresolved. Downloaded paper files will be kept.",
                                first.path, first.line
                            ))
                            .destructive()
                            .alternative("Keep citations", move |_, cx| {
                                keep(CitationRemovalMode::Keep, cx)
                            })
                            .confirm_label("Remove citations too")
                            .on_confirm(move |_, cx| remove(CitationRemovalMode::Remove, cx))
                    } else {
                        Confirm::new(question)
                            .body("Downloaded paper files will be kept.")
                            .destructive()
                            .confirm_label("Remove entry")
                            .on_confirm(move |_, cx| run(CitationRemovalMode::Block, cx))
                    };
                    confirm::ask(ask, cx);
                }
            });
        })
        .detach();
    }
}
