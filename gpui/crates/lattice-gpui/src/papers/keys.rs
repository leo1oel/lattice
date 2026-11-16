//! The Papers list's keyboard (`paper-list-keys.ts`): the arrows, Home and
//! End move between papers, across groups, landing where a click on the row
//! would; a matched paper's lines (and the "N more" after them) are stops of
//! their own, after its row. The up arrow from the first paper returns to
//! the search box, whose down arrow comes into the list. Enter or Space on
//! a stop does what a click there does, and in a wide panel the keyboard
//! selects as it moves, as a pointer's first click does.
//!
//! The stop is the panel's own: the list is one focus target, and the stop
//! it holds draws the ring while the keyboard drove the focus there.

use gpui::{Context, KeyDownEvent, Window};

use super::{PapersEvent, PapersPanel, model};

/// Where the keyboard is in the list: a paper's row (`stop` 0) or one of
/// its matched lines after it (1 on), the last of which may be "N more".
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeyStop {
    pub key: String,
    pub stop: usize,
}

/// How many lines a matched paper shows before "N more" (`render_hits`).
pub(super) const HITS_SHOWN: usize = 3;

/// How a key moves: by one, or to an end.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    By(isize),
    First,
    Last,
}

fn step_of(event: &KeyDownEvent) -> Option<Step> {
    let modifiers = event.keystroke.modifiers;
    if modifiers.alt || modifiers.platform || modifiers.control || modifiers.shift {
        return None;
    }
    match event.keystroke.key.as_str() {
        "down" => Some(Step::By(1)),
        "up" => Some(Step::By(-1)),
        "home" => Some(Step::First),
        "end" => Some(Step::Last),
        _ => None,
    }
}

/// Where a step lands, from stop `at` of row `from` among rows whose stop
/// counts are `stops`; `None` leaves the list for the search box.
fn land(stops: &[usize], from: usize, at: usize, step: Step) -> Option<(usize, usize)> {
    let last = stops.len().saturating_sub(1);
    let to = match step {
        Step::By(by) => {
            let next = at as isize + by;
            if next >= 0 && (next as usize) < stops[from] {
                return Some((from, next as usize));
            }
            if from == 0 && by < 0 {
                return None;
            }
            (from as isize + by).clamp(0, last as isize) as usize
        }
        Step::First => 0,
        Step::Last => last,
    };
    // Coming up into a paper lands on its last line; anything else on its row.
    let stop = if step == Step::By(-1) && to < from {
        stops[to] - 1
    } else {
        0
    };
    Some((to, stop))
}

impl PapersPanel {
    /// Each shown paper's key and how many stops it has: its row, then its
    /// matched lines and "N more".
    fn stops(&self, cx: &gpui::App) -> Vec<(String, usize)> {
        let hits = self.current_hits(cx);
        let shown = self.shown(cx);
        let order = model::group(shown.clone(), self.group, &self.facts);
        order
            .iter()
            .flat_map(|section| section.papers.iter())
            .map(|paper| {
                let key = model::paper_key(paper);
                let lines = hits
                    .and_then(|hits| hits.get(&model::search_identity(paper)))
                    .map_or(0, |found| found.hits.len());
                let lines = if self.expanded_hits.contains(&key) {
                    lines
                } else if lines > HITS_SHOWN {
                    HITS_SHOWN + 1
                } else {
                    lines
                };
                (key, 1 + lines)
            })
            .collect()
    }

    /// The box's down arrow: the keyboard goes on to the first paper; false
    /// with nothing to move to.
    pub(super) fn focus_list(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((key, _)) = self.stops(cx).into_iter().next() else {
            return false;
        };
        self.move_to(KeyStop { key, stop: 0 }, window, cx);
        true
    }

    /// A pointer's click on a stop: the keyboard goes on from there, with
    /// the list left where the pointer had it.
    pub(super) fn point_at(&mut self, key: &str, stop: usize) {
        self.key_stop = Some(KeyStop {
            key: key.to_string(),
            stop,
        });
        self.reveal_stop = false;
    }

    fn move_to(&mut self, stop: KeyStop, window: &mut Window, cx: &mut Context<Self>) {
        if self.wide() && stop.stop == 0 {
            self.select(Some(stop.key.clone()), cx);
        }
        // The keyboard on a readable paper's row says it is likely to be
        // opened, as the pointer does (the row's `onFocus`).
        if stop.stop == 0
            && let Some(paper) = self
                .papers
                .iter()
                .find(|paper| model::paper_key(paper) == stop.key && model::readable(paper))
        {
            cx.emit(PapersEvent::Likely(Box::new(paper.clone())));
        }
        self.key_stop = Some(stop);
        self.reveal_stop = true;
        window.focus(&self.focus_handle, cx);
        cx.notify();
    }

    /// The list's arrows, Home, End, Enter and Space; true when handled.
    pub(super) fn list_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.focus_handle.is_focused(window) {
            return false;
        }
        let stops = self.stops(cx);
        let from = self.key_stop.as_ref().and_then(|stop| {
            stops
                .iter()
                .position(|(key, _)| *key == stop.key)
                .map(|row| (row, stop.stop.min(stops[row].1 - 1)))
        });
        let key = event.keystroke.key.as_str();
        if matches!(key, "enter" | "space") && !event.keystroke.modifiers.modified() {
            let Some((row, stop)) = from else {
                return false;
            };
            self.press(&stops[row].0, stop, window, cx);
            return true;
        }
        let Some(step) = step_of(event) else {
            return false;
        };
        let counts: Vec<usize> = stops.iter().map(|(_, count)| *count).collect();
        if counts.is_empty() {
            return false;
        }
        let (from, at) = from.unwrap_or((0, 0));
        match land(&counts, from, at, step) {
            Some((row, stop)) => self.move_to(
                KeyStop {
                    key: stops[row].0.clone(),
                    stop,
                },
                window,
                cx,
            ),
            None => {
                self.key_stop = None;
                self.input.update(cx, |input, cx| input.focus(window, cx));
                cx.notify();
            }
        }
        true
    }

    /// Enter or Space on a stop: a row opens its paper (or downloads it); a
    /// line opens the paper there; "N more" shows the rest.
    fn press(&mut self, key: &str, stop: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(paper) = self
            .papers
            .iter()
            .find(|paper| model::paper_key(paper) == key)
            .cloned()
        else {
            return;
        };
        if stop == 0 {
            if model::can_activate(&paper) {
                self.activate(&paper, None, window, cx);
            }
            return;
        }
        let hit = self
            .current_hits(cx)
            .and_then(|hits| hits.get(&model::search_identity(&paper)))
            .and_then(|found| found.hits.get(stop - 1))
            .cloned();
        let expanded = self.expanded_hits.contains(key);
        match hit {
            Some(hit) if expanded || stop <= HITS_SHOWN => {
                self.activate(&paper, Some(&hit), window, cx)
            }
            _ => {
                // "N more": the line after the last shown keeps the stop.
                self.expanded_hits.insert(key.to_string());
                cx.notify();
            }
        }
    }

    /// What a stop the keyboard moved to draws beside itself: a probe that,
    /// once laid out, scrolls the list just far enough to show it.
    pub(crate) fn reveal_probe(
        &self,
        key: &str,
        stop: usize,
        cx: &Context<Self>,
    ) -> Option<gpui::AnyElement> {
        use gpui::{IntoElement as _, Styled as _};
        let held = self.key_stop.as_ref()?;
        if !self.reveal_stop || held.key != key || held.stop != stop {
            return None;
        }
        let scroll = self.scroll.clone();
        let view = cx.entity().downgrade();
        Some(
            gpui::canvas(
                move |bounds, window, cx| {
                    view.update(cx, |this, _| this.reveal_stop = false).ok();
                    let viewport = scroll.bounds();
                    let mut offset = scroll.offset();
                    let (top, bottom) = (bounds.top(), bounds.bottom());
                    if top < viewport.top() {
                        offset.y += viewport.top() - top;
                    } else if bottom > viewport.bottom() {
                        offset.y -= (bottom - viewport.bottom()).min(top - viewport.top());
                    } else {
                        return;
                    }
                    scroll.set_offset(offset);
                    window.refresh();
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0()
            .into_any_element(),
        )
    }

    /// Where the keyboard is in the list, and whether the box holds it, for
    /// a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn keyboard(&self, window: &Window, cx: &gpui::App) -> (Option<KeyStop>, bool) {
        use gpui::Focusable as _;
        let in_box = self.input.read(cx).focus_handle(cx).is_focused(window);
        let in_list = self.focus_handle.is_focused(window);
        (self.key_stop.clone().filter(|_| in_list), in_box)
    }

    /// Put the keyboard in the search box, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn focus_box(&self, window: &mut Window, cx: &mut gpui::App) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    /// Whether `key`'s stop `stop` draws the keyboard's ring now.
    pub(crate) fn rings(&self, key: &str, stop: usize, window: &Window) -> bool {
        self.key_stop
            .as_ref()
            .is_some_and(|held| held.key == key && held.stop == stop)
            && self.focus_handle.is_focused(window)
            && window.last_input_was_keyboard()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arrows_walk_rows_and_their_lines_and_leave_from_the_top() {
        // Three papers; the second has two matched lines.
        let stops = [1, 3, 1];
        assert_eq!(land(&stops, 0, 0, Step::By(1)), Some((1, 0)));
        assert_eq!(land(&stops, 1, 0, Step::By(1)), Some((1, 1)));
        assert_eq!(land(&stops, 1, 2, Step::By(1)), Some((2, 0)));
        // Up into a paper lands on its last line.
        assert_eq!(land(&stops, 2, 0, Step::By(-1)), Some((1, 2)));
        assert_eq!(land(&stops, 1, 1, Step::By(-1)), Some((1, 0)));
        // Up from the first paper's row goes back to the box.
        assert_eq!(land(&stops, 0, 0, Step::By(-1)), None);
        // Down past the end stays on the last.
        assert_eq!(land(&stops, 2, 0, Step::By(1)), Some((2, 0)));
        assert_eq!(land(&stops, 1, 1, Step::First), Some((0, 0)));
        assert_eq!(land(&stops, 0, 0, Step::Last), Some((2, 0)));
    }
}
