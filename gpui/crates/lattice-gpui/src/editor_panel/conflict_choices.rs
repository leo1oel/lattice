//! Conflicts resolved where they are (`src/editor/conflict-choices.ts`):
//! each spot a merge could not decide (standard `<<<<<<<` markers, from an
//! Overleaf sync, Git or an Agent Undo) carries its own Keep mine, Keep
//! theirs and Keep both above it, and its two sides are tinted apart.
//! Choosing rewrites only that spot, as one undoable edit; the file saves and
//! syncs as any edit does, and a sync holds a file back only while markers
//! are left in it.
//!
//! The sides come from `history::conflicts`, the parser the resolver uses,
//! so the diff3 base section (`|||||||`, which Overleaf sync writes) is never
//! kept by either choice.

use std::sync::Arc;

use editor::{MultiBufferOffset, RowHighlightOptions};
use gpui::{App, Context, Hsla, IntoElement as _, ParentElement as _, Styled as _, div, px};
use language::{Bias, Point};
use lattice_editor::blocks::{BlockSide, BlockWidget};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, components::Button};

use super::EditorPanel;
use crate::history::conflicts::{ConflictChoice, ConflictHunk, conflict_hunks};

const BLOCK: &str = "conflict-choices";
const START: &str = "<<<<<<<";

/// The rows of each side, for their tints.
enum OursRows {}
enum TheirsRows {}

/// Whether the layer has anything on screen to take down.
#[derive(Default)]
pub(super) struct ConflictLayer {
    painted: bool,
}

/// The sides' tints (`.cm-conflict-ours`, `.cm-conflict-theirs`).
fn ours_tint(cx: &App) -> Hsla {
    cx.palette().success_soft
}

fn theirs_tint(cx: &App) -> Hsla {
    cx.palette().accent_soft
}

/// The part of a spot a marker line opens, or None for a line of text.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Ours,
    Base,
    Theirs,
    End,
}

fn marker(line: &str) -> Option<Section> {
    let (marker, rest) = (line.get(..7)?, line.get(7..)?);
    if !(rest.is_empty() || rest.starts_with(' ')) {
        return None;
    }
    match marker {
        "<<<<<<<" => Some(Section::Ours),
        "|||||||" => Some(Section::Base),
        "=======" => Some(Section::Theirs),
        ">>>>>>>" => Some(Section::End),
        _ => None,
    }
}

impl EditorPanel {
    /// Put the choices and tints on the buffer's spots, or take them down
    /// when none is left. Read-only editors get neither.
    pub(super) fn paint_conflicts(&mut self, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).text();
        let editable = !self.editor.read(cx).read_only(cx);
        let hunks = if editable && text.contains(START) {
            conflict_hunks(&text)
        } else {
            Vec::new()
        };
        if hunks.is_empty() && !self.conflicts.painted {
            return;
        }
        self.conflicts.painted = !hunks.is_empty();
        let panel = cx.entity().downgrade();
        let blocks = hunks
            .iter()
            .map(|hunk| {
                let row = (hunk.line - 1) as u32;
                let panel = panel.clone();
                BlockWidget {
                    line: row,
                    side: BlockSide::Above,
                    lines: 1,
                    render: Arc::new(move |_| {
                        let choice =
                            |id: &'static str, label: &'static str, choice: ConflictChoice| {
                                let panel = panel.clone();
                                Button::new((id, row as usize), label).compact().on_click(
                                    move |_, _, cx| {
                                        panel
                                            .update(cx, |panel, cx| {
                                                panel.choose_conflict(row, choice, cx)
                                            })
                                            .ok();
                                    },
                                )
                            };
                        div()
                            .flex()
                            .gap(px(8.))
                            .py(px(4.))
                            .child(choice(
                                "conflict-ours",
                                t!("Keep mine"),
                                ConflictChoice::Ours,
                            ))
                            .child(choice(
                                "conflict-theirs",
                                t!("Keep theirs"),
                                ConflictChoice::Theirs,
                            ))
                            .child(choice(
                                "conflict-both",
                                t!("Keep both"),
                                ConflictChoice::Both,
                            ))
                            .into_any_element()
                    }),
                }
            })
            .collect();
        self.lattice
            .update(cx, |lattice, cx| lattice.set_blocks(BLOCK, blocks, cx));
        let lines: Vec<&str> = text.split('\n').collect();
        self.editor.update(cx, |editor, cx| {
            editor.clear_row_highlights::<OursRows>();
            editor.clear_row_highlights::<TheirsRows>();
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let options = RowHighlightOptions {
                autoscroll: false,
                include_gutter: false,
            };
            for hunk in &hunks {
                let first = hunk.line - 1;
                let mut section = Section::Ours;
                for row in first..first + hunk.rows {
                    let line = lines.get(row).copied().unwrap_or_default();
                    if let Some(opened) = marker(line) {
                        section = opened;
                        continue;
                    }
                    // The base section is neither side's: left untinted.
                    let color = match section {
                        Section::Ours => ours_tint as fn(&App) -> Hsla,
                        Section::Theirs => theirs_tint,
                        Section::Base | Section::End => continue,
                    };
                    let row = row as u32;
                    let start = snapshot.anchor_before(Point::new(row, 0));
                    let end = snapshot
                        .anchor_after(snapshot.clip_point(Point::new(row + 1, 0), Bias::Left));
                    if section == Section::Ours {
                        editor.highlight_rows::<OursRows>(start..end, color, options, cx);
                    } else {
                        editor.highlight_rows::<TheirsRows>(start..end, color, options, cx);
                    }
                }
            }
            cx.notify();
        });
    }

    /// Resolve the spot starting on `row` with `choice`; nothing when no
    /// spot starts there any more.
    pub(super) fn choose_conflict(
        &mut self,
        row: u32,
        choice: ConflictChoice,
        cx: &mut Context<Self>,
    ) {
        let text = self.buffer.read(cx).text();
        let Some(hunk) = conflict_hunks(&text)
            .into_iter()
            .find(|hunk| hunk.line - 1 == row as usize)
        else {
            return;
        };
        let (range, insert) = spot_edit(&text, &hunk, choice);
        self.editor.update(cx, |editor, cx| {
            editor.buffer().update(cx, |buffer, cx| {
                // Its own undo step, never merged with typing on either side.
                buffer.finalize_last_transaction(cx);
                buffer.edit(
                    [(
                        MultiBufferOffset(range.start)..MultiBufferOffset(range.end),
                        insert,
                    )],
                    None,
                    cx,
                );
                buffer.finalize_last_transaction(cx);
            });
        });
    }
}

/// The byte range a spot covers in `text` (its trailing line break
/// included) and what a choice leaves in its place.
fn spot_edit(
    text: &str,
    hunk: &ConflictHunk,
    choice: ConflictChoice,
) -> (std::ops::Range<usize>, String) {
    let first = hunk.line - 1;
    let mut start = 0;
    let mut end = text.len();
    let mut offset = 0;
    for (row, line) in text.split('\n').enumerate() {
        if row == first {
            start = offset;
        }
        offset += line.len() + 1;
        if row == first + hunk.rows - 1 {
            end = offset.min(text.len());
            break;
        }
    }
    let lines: Vec<&String> = match choice {
        ConflictChoice::Ours => hunk.ours.iter().collect(),
        ConflictChoice::Theirs => hunk.theirs.iter().collect(),
        ConflictChoice::Both => hunk.ours.iter().chain(&hunk.theirs).collect(),
    };
    if lines.is_empty() {
        return (start..end, String::new());
    }
    let ends_line = text[..end].ends_with('\n');
    let mut insert = lines
        .iter()
        .map(|line| line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if ends_line {
        insert.push('\n');
    }
    (start..end, insert)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKED: &str = "Intro.\n<<<<<<< This Mac\nThe result never holds.\n||||||| Last sync\nThe result holds.\n=======\nThe result holds always.\n>>>>>>> Overleaf\nEnd.\n";

    fn apply(text: &str, choice: ConflictChoice) -> String {
        let hunk = conflict_hunks(text).remove(0);
        let (range, insert) = spot_edit(text, &hunk, choice);
        format!("{}{insert}{}", &text[..range.start], &text[range.end..])
    }

    #[test]
    fn keeps_each_side_never_the_last_synced_text() {
        assert_eq!(
            apply(MARKED, ConflictChoice::Ours),
            "Intro.\nThe result never holds.\nEnd.\n"
        );
        assert_eq!(
            apply(MARKED, ConflictChoice::Theirs),
            "Intro.\nThe result holds always.\nEnd.\n"
        );
        assert_eq!(
            apply(MARKED, ConflictChoice::Both),
            "Intro.\nThe result never holds.\nThe result holds always.\nEnd.\n"
        );
    }

    #[test]
    fn removes_a_spot_whose_kept_side_is_empty_line_break_and_all() {
        let text = "a\n<<<<<<< This Mac\n=======\ngone\n>>>>>>> Overleaf\nb";
        assert_eq!(apply(text, ConflictChoice::Ours), "a\nb");
        let last = "a\n<<<<<<< This Mac\nmine\n=======\ntheirs\n>>>>>>> Overleaf";
        assert_eq!(apply(last, ConflictChoice::Theirs), "a\ntheirs");
    }

    #[test]
    fn reads_each_marker_and_only_markers() {
        assert!(marker("<<<<<<< This Mac") == Some(Section::Ours));
        assert!(marker("||||||| Last sync") == Some(Section::Base));
        assert!(marker("=======") == Some(Section::Theirs));
        assert!(marker(">>>>>>> Overleaf") == Some(Section::End));
        assert!(marker("========").is_none());
        assert!(marker("text").is_none());
    }
}
