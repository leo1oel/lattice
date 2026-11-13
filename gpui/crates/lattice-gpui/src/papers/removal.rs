//! Removing a paper's entry from the primary bibliography
//! (`remove-reference-action.ts`): the writer confirms first, and when the
//! manuscript cites it chooses whether its citations go too or stay
//! unresolved. Downloaded paper files are kept either way. The scan for its
//! citations reads the files on disk, so the window saves its editors
//! before it starts, and they read the files again after.

use gpui::{App, AppContext as _, Context};
use lattice_core::papers::{self as core_papers, CitationRemovalMode, PaperSummary};
use lattice_i18n::t;

use super::{PapersEvent, PapersPanel};
use crate::{
    confirm::{self, Confirm},
    notices,
};

impl PapersPanel {
    /// Remove `paper`'s entry from the primary bibliography once the writer
    /// confirms (and chooses what happens to its citations, when it is
    /// cited). Downloaded files are kept.
    pub(crate) fn remove(&mut self, paper: &PaperSummary, cx: &mut Context<Self>) {
        if paper.citation_key.is_none() {
            notices::error(
                t!("Could not remove the paper"),
                t!("This bibliography entry has no citation key to remove."),
                cx,
            );
            return;
        }
        cx.emit(PapersEvent::Remove(Box::new(paper.clone())));
    }

    /// `remove`, once what the editors held is on disk.
    pub(crate) fn remove_saved(&mut self, paper: &PaperSummary, cx: &mut Context<Self>) {
        let Some(key) = paper.citation_key.clone() else {
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
                Err(error) => notices::error(t!("Could not remove the paper"), error, cx),
                Ok(preview) => {
                    let question = t!("Remove “{title}” from the bibliography?", title = title);
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
                                            Some(first) => t!(
                                                "The bibliography changed while removing {citationCommand} ({blocker}). Try again.",
                                                citationCommand = format!("\\cite{{{}}}", result.key),
                                                blocker = format!("{}:{}", first.path, first.line)
                                            ),
                                            None => t!(
                                                "Could not remove {citationCommand}.",
                                                citationCommand = format!("\\cite{{{}}}", result.key)
                                            ),
                                        };
                                        notices::error(t!("Could not remove the paper"), detail, cx);
                                    }
                                    Err(error) => {
                                        notices::error(t!("Could not remove the paper"), error, cx)
                                    }
                                }
                                view.update(cx, |this, cx| {
                                    this.reload(cx);
                                    cx.emit(PapersEvent::Removed);
                                })
                                .ok();
                            });
                        })
                        .detach();
                    };
                    let run = std::rc::Rc::new(run);
                    let ask = if let Some(first) = preview.blockers.first() {
                        let count = preview.blockers.len();
                        let cited = if count == 1 {
                            t!("This entry is cited in 1 place.").to_string()
                        } else {
                            t!("This entry is cited in {count} places.", count = count)
                        };
                        let (keep, remove) = (run.clone(), run.clone());
                        Confirm::new(question)
                            .body(
                                [
                                    cited,
                                    t!("The first is at {path}:{line}.", path = first.path, line = first.line),
                                    t!("Keeping the citation commands will leave them unresolved.").to_string(),
                                    t!("Downloaded paper files will be kept.").to_string(),
                                ]
                                .join(" "),
                            )
                            .destructive()
                            .alternative(t!("Keep citations"), move |_, cx| {
                                keep(CitationRemovalMode::Keep, cx)
                            })
                            .confirm_label(t!("Remove citations too"))
                            .on_confirm(move |_, cx| remove(CitationRemovalMode::Remove, cx))
                    } else {
                        Confirm::new(question)
                            .body(t!("Downloaded paper files will be kept."))
                            .destructive()
                            .confirm_label(t!("Remove entry"))
                            .on_confirm(move |_, cx| run(CitationRemovalMode::Block, cx))
                    };
                    confirm::ask(ask, cx);
                }
            });
        })
        .detach();
    }
}
