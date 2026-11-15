//! The lines an outside edit landed in the open file, washed for a moment
//! (`src/editor/change-marks.ts`'s landed lines, `.cm-landed-line` in
//! `editor-workspace.css`): they come up on the success wash, hold it and
//! let it go over the linger tier (`lattice_ui::attention::change_wash`), so
//! the eye finds what the Agent or another app changed without reading the
//! page again. Under reduced motion the wash stays put for its moment.
//!
//! The disk check hands over the text it is about to load in place of the
//! buffer's; once the buffer reads exactly that text, the lines it brought
//! are washed. A line the replaced stretch already had (a line that only
//! moved, or one the reload rewrote unchanged) is not new and keeps no
//! wash, and a rewritten file washes its first 200 new lines at most.
//!
//! Zed's row highlights take their colour from a function of the app, so
//! the wash's moment lives in a global the colour reads, and a task asks
//! the editor for frames until it is over, then takes that editor's rows
//! away unless the editor was washed again since.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use editor::{Editor, RowHighlightOptions};
use gpui::{App, Context, Entity, EntityId, Global, Hsla};
use language::{Bias, Point};
use lattice_ui::{ActiveLattice as _, attention};

use crate::editor_panel::{EditorPanel, normalize_breaks};

/// An outside edit marks its first lines this many at most: a rewritten
/// file is not a highlighter (`MAX_LANDED_LINES`).
const MAX_LANDED_LINES: usize = 200;
/// How long the wash waits for the buffer to take the landed text.
const TAKE_WAIT: Duration = Duration::from_secs(2);
/// One frame at 60 Hz.
const FRAME: Duration = Duration::from_millis(16);

/// The wash showing now, which every washed row's colour reads, and when
/// each editor's own rows were last washed, so each editor takes its rows
/// away when its own wash is over.
#[derive(Default)]
struct ChangeWash {
    started: Option<Instant>,
    reduce_motion: bool,
    editors: HashMap<EntityId, Instant>,
}

impl Global for ChangeWash {}

/// The marker type Zed keys the wash's row highlights by.
struct LandedRows;

fn wash_color(cx: &App) -> Hsla {
    let soft = cx.palette().success_soft;
    let share = cx
        .try_global::<ChangeWash>()
        .and_then(|wash| {
            Some(attention::change_wash(
                wash.started?.elapsed(),
                wash.reduce_motion,
            ))
        })
        .unwrap_or(0.);
    soft.opacity(soft.a * share)
}

fn lines(text: &str) -> Vec<&str> {
    text.split('\n').collect()
}

/// The rows of `after` (0-based) that `before` did not have. The editor
/// takes outside text as one replacement from the first differing line to
/// the last (`text-change.ts`), so a line inside it that reads as one the
/// replaced lines already had is not new and keeps no wash (`landedMarks`).
fn landed_rows(before: &str, after: &str) -> Vec<u32> {
    let (a, b) = (lines(before), lines(after));
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head
        && tail < b.len() - head
        && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    let mut had: HashMap<&str, usize> = HashMap::new();
    for line in &a[head..a.len() - tail] {
        *had.entry(line).or_default() += 1;
    }
    let mut rows = Vec::new();
    for (row, line) in b.iter().enumerate().take(b.len() - tail).skip(head) {
        if rows.len() >= MAX_LANDED_LINES {
            break;
        }
        match had.get_mut(line) {
            Some(left) if *left > 0 => *left -= 1,
            _ => rows.push(row as u32),
        }
    }
    rows
}

impl EditorPanel {
    /// The disk check is about to load `after` in place of the buffer's
    /// text: wash the lines it brings once the buffer reads it.
    pub(in crate::editor_panel) fn wash_landed(&mut self, after: &str, cx: &mut Context<Self>) {
        let before = self.buffer.read(cx).text();
        // The buffer keeps `\n` line breaks whatever the file has.
        let after = normalize_breaks(after);
        let rows = landed_rows(&before, &after);
        if rows.is_empty() {
            return;
        }
        let editor = self.editor.clone();
        cx.spawn(async move |this, cx| {
            let waited = Instant::now();
            loop {
                let Ok(taken) = this.update(cx, |this, cx| this.buffer.read(cx).text() == after)
                else {
                    return;
                };
                if taken {
                    break;
                }
                if waited.elapsed() > TAKE_WAIT {
                    return;
                }
                cx.background_executor().timer(FRAME).await;
            }
            cx.update(|cx| wash(&editor, &rows, cx));
        })
        .detach();
    }
}

/// Wash `rows` of `editor` for the moment.
fn wash(editor: &Entity<Editor>, rows: &[u32], cx: &mut App) {
    let started = Instant::now();
    let reduce_motion = cx.reduce_motion();
    let id = editor.entity_id();
    let wash = cx.default_global::<ChangeWash>();
    wash.started = Some(started);
    wash.reduce_motion = reduce_motion;
    wash.editors.insert(id, started);
    editor.update(cx, |editor, cx| {
        let snapshot = editor.buffer().read(cx).snapshot(cx);
        editor.clear_row_highlights::<LandedRows>();
        for &row in rows {
            let start = snapshot.anchor_before(Point::new(row, 0));
            // To the next line's start, so an empty line washes too.
            let end =
                snapshot.anchor_after(snapshot.clip_point(Point::new(row + 1, 0), Bias::Left));
            editor.highlight_rows::<LandedRows>(
                start..end,
                wash_color,
                RowHighlightOptions {
                    autoscroll: false,
                    include_gutter: false,
                },
                cx,
            );
        }
    });
    let editor = editor.downgrade();
    cx.spawn(async move |cx| {
        // The colour follows the latest wash anywhere, so the rows stay
        // until that one has let go too.
        let ends = |cx: &mut App| {
            cx.try_global::<ChangeWash>()
                .and_then(|wash| wash.started)
                .unwrap_or(started)
                .max(started)
                + attention::LINGER
        };
        while Instant::now() < cx.update(ends) {
            cx.background_executor().timer(FRAME).await;
            if editor.update(cx, |_, cx| cx.notify()).is_err() {
                break;
            }
        }
        cx.update(|cx| {
            // A later wash of the same editor keeps its own rows.
            let wash = cx.default_global::<ChangeWash>();
            if wash.editors.get(&id) != Some(&started) {
                return;
            }
            wash.editors.remove(&id);
            editor
                .update(cx, |editor, cx| {
                    editor.clear_row_highlights::<LandedRows>();
                    cx.notify();
                })
                .ok();
        });
    })
    .detach();
}

/// The rows the wash paints now (0-based), for a scenario.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn washed_rows(editor: &Editor, cx: &App) -> Vec<u32> {
    let snapshot = editor.buffer().read(cx).snapshot(cx);
    editor
        .highlighted_rows::<LandedRows>(cx)
        .map(|(range, _)| {
            use editor::ToPoint as _;
            range.start.to_point(&snapshot).row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::landed_rows;

    #[test]
    fn new_lines_wash_and_moved_or_kept_lines_do_not() {
        let before = "\\section{A}\nOne.\nTwo.\nThree.\n";
        // A line rewritten, one added, one moved up past it.
        let after = "\\section{A}\nOne, changed.\nThree.\nAdded.\nTwo.\n";
        assert_eq!(landed_rows(before, after), [1, 3]);
        assert!(landed_rows(before, before).is_empty());
        // A deletion lands nothing.
        assert!(landed_rows(before, "\\section{A}\nOne.\nThree.\n").is_empty());
    }
}
