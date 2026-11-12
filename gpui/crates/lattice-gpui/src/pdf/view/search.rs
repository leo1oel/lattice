//! Find in PDF (`use-pdf-search.ts`): the query is matched once typing
//! pauses, across the whole document on PDFium's thread, and the first
//! match on or after the page in view is scrolled to; Enter and the arrows
//! step through the rest. A rebuild runs the search again without moving
//! the reader.

use super::*;

/// A changed query is matched after this pause, as PDF.js's find controller
/// waits before it searches.
pub(in crate::pdf) const FIND_SETTLE: Duration = Duration::from_millis(250);

/// A match scrolled to lands this far below the top of the view
/// (PDF.js's `MATCH_SCROLL_OFFSET_TOP`).
pub(in crate::pdf) const MATCH_SCROLL_TOP: f32 = 50.;

/// Find in PDF.
pub(in crate::pdf) struct FindState {
    pub input: Entity<InputState>,
    pub query: String,
    pub options: FindOptions,
    pub matches: Vec<Match>,
    pub current: Option<usize>,
    /// A changed query or option has no answer yet.
    pub pending: bool,
    /// The search answered was asked of this copy and query.
    pub(in crate::pdf) searched: Option<(u64, String, FindOptions)>,
    /// Scroll to the first match once the answer comes: a search the reader
    /// typed, not one run again after a rebuild.
    pub(in crate::pdf) scroll_on_answer: bool,
    pub(in crate::pdf) task: Option<Task<()>>,
}

impl PdfView {
    /// ⌘F on the PDF: the find field takes focus, seeded with the selection.
    pub fn focus_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seed = self.selected_text_task(cx);
        let input = self.find.input.clone();
        cx.spawn_in(window, async move |this, cx| {
            let seed = match seed {
                Some(seed) => Some(seed.await),
                None => None,
            };
            this.update_in(cx, |this, window, cx| {
                if let Some(seed) = seed.filter(|seed| !seed.is_empty()) {
                    input.update(cx, |input, cx| input.set_value(seed.clone(), window, cx));
                    this.set_query(seed, true, cx);
                }
                input.update(cx, |input, cx| {
                    input.focus(window, cx);
                    input.select_all(window, cx);
                });
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn on_find_input(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Change => {
                let query = input.read(cx).value().to_string();
                self.set_query(query, true, cx);
            }
            InputEvent::PressEnter { shift, .. } => {
                if !self.find.query.trim().is_empty() {
                    self.find_again(*shift, cx);
                }
            }
            _ => {}
        }
        let _ = window;
    }

    /// Escape in the find field: clear the query, then, on an empty field, go
    /// back to reading.
    pub(in crate::pdf) fn find_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.query.is_empty() {
            window.focus(&self.focus_handle, cx);
        } else {
            self.clear_find(window, cx);
        }
    }

    pub fn clear_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find
            .input
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.set_query(String::new(), false, cx);
    }

    /// The query changed: a search for it runs once typing pauses.
    pub fn set_query(&mut self, query: String, scroll: bool, cx: &mut Context<Self>) {
        if query == self.find.query {
            return;
        }
        self.find.query = query;
        self.find.scroll_on_answer = scroll;
        if normalize_query(&self.find.query).is_none() {
            self.find.task = None;
            self.find.pending = false;
            self.find.matches.clear();
            self.find.current = None;
            self.find.searched = None;
            cx.notify();
            return;
        }
        self.find.pending = true;
        self.find.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FIND_SETTLE).await;
            this.update(cx, |this, cx| this.run_find(this.find.scroll_on_answer, cx))
                .ok();
        }));
        cx.notify();
    }

    pub fn set_find_options(&mut self, options: FindOptions, cx: &mut Context<Self>) {
        if self.find.options == options {
            return;
        }
        self.find.options = options;
        if !self.find.query.trim().is_empty() {
            self.run_find(true, cx);
        }
        cx.notify();
    }

    /// Ask PDFium for every match of the query in this copy.
    pub(super) fn run_find(&mut self, scroll: bool, cx: &mut Context<Self>) {
        let (Ok(engine), Some(doc), Some(document)) =
            (self.engine.clone(), self.doc, self.document.as_ref())
        else {
            return;
        };
        let generation = document.info.generation;
        let query = self.find.query.clone();
        let options = self.find.options;
        self.find.pending = true;
        let answer = engine.find(doc, generation, query.clone(), options);
        self.find.task = Some(cx.spawn(async move |this, cx| {
            let Ok(Ok(matches)) = answer.await else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.find.query != query || this.find.options != options {
                    return;
                }
                this.find.pending = false;
                this.find.searched = Some((generation, query, options));
                // A rebuild's search keeps the match it was on, by place.
                let keep = this
                    .find
                    .current
                    .and_then(|current| this.find.matches.get(current).cloned());
                this.find.matches = matches;
                this.find.current = if scroll {
                    first_match_from(&this.find.matches, this.current_page)
                } else {
                    keep.and_then(|kept| this.find.matches.iter().position(|m| *m == kept))
                        .or_else(|| first_match_from(&this.find.matches, this.current_page))
                };
                if scroll {
                    this.scroll_to_match();
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Enter, Shift+Enter and the arrows: the next or previous match.
    pub fn find_again(&mut self, previous: bool, cx: &mut Context<Self>) {
        if self.find.pending {
            // The answer to the typed query moves there itself.
            self.find.scroll_on_answer = true;
            return;
        }
        let count = self.find.matches.len();
        if count == 0 {
            return;
        }
        self.find.current = Some(match self.find.current {
            Some(current) if previous => (current + count - 1) % count,
            Some(current) => (current + 1) % count,
            None => first_match_from(&self.find.matches, self.current_page).unwrap_or(0),
        });
        self.scroll_to_match();
        cx.notify();
    }

    /// Bring the current match into view, 50px under the top.
    pub(super) fn scroll_to_match(&mut self) {
        let Some(found) = self.find.current.and_then(|ix| self.find.matches.get(ix)) else {
            return;
        };
        let Some([x0, y0, ..]) = found.boxes.first().copied() else {
            return;
        };
        let page = found.page;
        let visible_x = {
            let (scroll_x, _) = self.scroll_offset();
            let (width, _) = self.viewport_size();
            let rect = self.layout.page(page);
            rect.is_some_and(|rect| {
                let left = rect.x + x0 * self.layout.scale;
                left >= scroll_x && left <= scroll_x + width
            })
        };
        self.pending_scroll = Some(PendingScroll::PagePoint {
            page,
            x: (!visible_x).then_some((x0 - 400. / self.layout.scale.max(0.01)).max(0.)),
            y: y0,
            at_y: MATCH_SCROLL_TOP,
        });
        self.current_page = page;
        self.apply_pending_scroll();
    }

    /// The counter beside the matches: "…" while a changed search has no
    /// answer yet, "2 / 5", or "0 / 0".
    pub(in crate::pdf) fn match_position(&self) -> String {
        if self.find.pending {
            "…".into()
        } else if self.find.matches.is_empty() {
            "0 / 0".into()
        } else {
            format!(
                "{} / {}",
                self.find.current.map_or(0, |current| current + 1),
                self.find.matches.len()
            )
        }
    }

    pub fn find_query(&self) -> &str {
        &self.find.query
    }

    pub fn find_matches(&self) -> (usize, Option<usize>, bool) {
        (
            self.find.matches.len(),
            self.find.current,
            self.find.pending,
        )
    }
}
