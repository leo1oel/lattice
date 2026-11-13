//! The box's search (`paper-library-search.ts` `usePaperTextSearch`):
//! typing filters by the papers' metadata at once and, 120 ms after the last
//! keystroke, asks the full-text index (`papers::search_library_text`) for
//! the papers their saved text matched, with their best lines. A pass that
//! runs past 400 ms says so above the list; one that fails says the list
//! holds metadata matches only, and keeps saying so until a search answers.
//! Hits for an older query are never shown.

use std::{collections::HashMap, time::Duration};

use gpui::{App, AppContext as _, Context, Window};
use lattice_core::papers as core_papers;

use super::{
    PapersPanel, SEARCHING_NOTICE, TEXT_SEARCH_DEBOUNCE, TextSearch,
    model::{LineHit, TextMatch},
};

impl PapersPanel {
    pub(super) fn query_changed(&mut self, cx: &mut Context<Self>) {
        let text = self.query(cx);
        let query = text.trim().to_string();
        self.text_generation += 1;
        self.expanded_hits.clear();
        if query.is_empty() {
            self.text_task = None;
            self.text_hits.clear();
            self.text_query.clear();
            self.text_search = TextSearch::Idle;
            cx.notify();
            return;
        }
        // The index matches the last word as a prefix until a space follows
        // it, so a trailing space is sent.
        let sent = if text.ends_with(char::is_whitespace) {
            format!("{query} ")
        } else {
            query.clone()
        };
        // A cache that could not be read for the last query most likely
        // cannot for this one either: the failure stays until this search
        // says otherwise, rather than blinking out at every keystroke.
        if !matches!(self.text_search, TextSearch::Failed(_)) {
            self.text_search = TextSearch::Pending;
        }
        self.run_text_search(query, sent, TEXT_SEARCH_DEBOUNCE, cx);
        cx.notify();
    }

    fn run_text_search(
        &mut self,
        query: String,
        sent: String,
        delay: Duration,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let generation = self.text_generation;
        self.text_task = Some(cx.spawn(async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            let search =
                cx.background_spawn(async move { core_papers::search_library_text(&root, &sent) });
            let notice = cx
                .background_executor()
                .timer(SEARCHING_NOTICE - delay.min(SEARCHING_NOTICE));
            let mut search = std::pin::pin!(search);
            let notice = std::pin::pin!(notice);
            let found = match futures::future::select(search.as_mut(), notice).await {
                futures::future::Either::Left((found, _)) => found,
                futures::future::Either::Right((_, search)) => {
                    this.update(cx, |this, cx| {
                        if this.text_generation == generation {
                            this.text_search = TextSearch::Searching;
                            cx.notify();
                        }
                    })
                    .ok();
                    search.await
                }
            };
            this.update(cx, |this, cx| {
                if this.text_generation != generation {
                    return;
                }
                this.text_query = query;
                match found {
                    Ok(matches) => {
                        this.text_hits = matches
                            .into_iter()
                            .enumerate()
                            .map(|(rank, found)| {
                                (
                                    found.key,
                                    TextMatch {
                                        rank,
                                        hits: found
                                            .hits
                                            .into_iter()
                                            .map(LineHit::from_core)
                                            .collect(),
                                    },
                                )
                            })
                            .collect();
                        this.text_search = TextSearch::Done;
                    }
                    Err(error) => {
                        // Metadata filtering remains useful if the cache
                        // cannot be read, but the list must not read as the
                        // whole answer.
                        this.text_hits.clear();
                        this.text_search = TextSearch::Failed(error);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Run the full-text pass now (Enter on a title), or again after it
    /// failed (Try again).
    pub(crate) fn search_now(&mut self, cx: &mut Context<Self>) {
        let text = self.query(cx);
        let query = text.trim().to_string();
        if query.is_empty() {
            return;
        }
        self.text_generation += 1;
        self.text_search = TextSearch::Searching;
        self.run_text_search(query, text.trim_start().to_string(), Duration::ZERO, cx);
        cx.notify();
    }

    /// The hits that answer the box as it is now: none while the newest
    /// query is still on its way.
    pub(crate) fn current_hits(&self, cx: &App) -> Option<&HashMap<String, TextMatch>> {
        (self.text_query == self.query(cx).trim()).then_some(&self.text_hits)
    }

    pub(crate) fn clear_query(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        self.query_changed(cx);
    }
}
