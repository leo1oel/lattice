//! The last build's diagnostics on the adapter, as the Tauri app's
//! `editorDiagnosticsForFile` lints them (`compile-diagnostics.ts`, wired
//! in `source-session.ts`): each one underlines its whole line, in
//! CodeMirror lint's colours, with the same card over it as TexLab's.
//!
//! Only against the text the build compiled: once the writer edits the
//! file, its lines no longer say where TeX stopped, so the marks go, and
//! they come back if the text returns to what was compiled (an undo), as
//! the Tauri app's `compiledSources.get(file) === source` check has it.

use std::{cell::RefCell, rc::Rc};

use gpui::{App, AppContext as _, Context, Entity, Subscription, WeakEntity};
use language::BufferEvent;

use super::diagnostics::{Anchored, DiagnosticCards, Located, Severity};
use crate::{
    LatticeEditor,
    decorations::{Mark, MarkStyle},
};

/// The adapter layer the build's marks are in.
pub const LAYER: &str = "latexmk";

/// One diagnostic of the build, on a 1-based line of its file.
#[derive(Clone, Debug, PartialEq)]
pub struct BuildMark {
    pub line: u32,
    pub severity: Severity,
    pub message: String,
}

/// `marks` placed in `text`: each its whole line, clamped into the file.
pub fn whole_lines(marks: &[BuildMark], text: &str) -> Vec<Located> {
    let mut starts = vec![0usize];
    starts.extend(text.match_indices('\n').map(|(at, _)| at + 1));
    let rows = starts.len() as u32;
    marks
        .iter()
        .filter_map(|mark| {
            let row = mark.line.clamp(1, rows) as usize - 1;
            let start = starts[row];
            let end = starts.get(row + 1).map_or(text.len(), |next| next - 1);
            // A line ending `\r\n` underlines its text only.
            let end = if text[start..end].ends_with('\r') {
                end - 1
            } else {
                end
            };
            // An empty line keeps one character to hover: its line break,
            // or the one before it at the end of the file.
            let range = if end > start {
                start..end
            } else if start < text.len() {
                start..start + 1
            } else if start > 0 {
                start - 1..start
            } else {
                return None;
            };
            Some(Located {
                range,
                severity: mark.severity,
                message: mark.message.clone(),
            })
        })
        .collect()
}

/// The build's diagnostics for one editor, shown while its text is the
/// text the build compiled.
pub struct BuildDiagnostics {
    editor: WeakEntity<LatticeEditor>,
    shown: Rc<RefCell<Vec<Anchored>>>,
    /// The file's text as the build read it.
    compiled: Option<String>,
    marks: Vec<BuildMark>,
    /// Whether the marks are drawn now.
    drawn: bool,
    _edits: Subscription,
}

impl BuildDiagnostics {
    pub fn attach(editor: &Entity<LatticeEditor>, cx: &mut App) -> Entity<Self> {
        let shown: Rc<RefCell<Vec<Anchored>>> = Rc::default();
        editor.update(cx, |editor, _| {
            editor.add_hover_provider(Rc::new(DiagnosticCards {
                shown: shown.clone(),
            }));
        });
        let buffer = editor.read(cx).buffer().clone();
        cx.new(|cx: &mut Context<Self>| Self {
            editor: editor.downgrade(),
            shown,
            compiled: None,
            marks: Vec::new(),
            drawn: false,
            _edits: cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                if matches!(event, BufferEvent::Edited { .. } | BufferEvent::Reloaded) {
                    this.refresh(false, cx);
                }
            }),
        })
    }

    /// A build finished: `marks` for this file, of `compiled`, its text as
    /// the build read it (`None`: the build named nothing here).
    pub fn set(&mut self, compiled: Option<String>, marks: Vec<BuildMark>, cx: &mut Context<Self>) {
        self.compiled = compiled;
        self.marks = marks;
        self.refresh(true, cx);
    }

    /// The marks shown now, for a scenario.
    pub fn shown(&self) -> usize {
        self.shown.borrow().len()
    }

    /// Draw the marks when the text is the compiled one, else clear them;
    /// `force`: they changed, so they are drawn again either way.
    fn refresh(&mut self, force: bool, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let snapshot = editor.read(cx).buffer().read(cx).snapshot();
        let compiled = self.compiled.as_deref().filter(|compiled| {
            !self.marks.is_empty()
                && compiled.len() == snapshot.len()
                && *compiled == snapshot.text()
        });
        let current = compiled.is_some();
        if current == self.drawn && !force {
            return;
        }
        self.drawn = current;
        let located = compiled.map_or_else(Vec::new, |text| whole_lines(&self.marks, text));
        *self.shown.borrow_mut() = located
            .iter()
            .map(|located| Anchored {
                range: snapshot.anchor_before(located.range.start)
                    ..snapshot.anchor_after(located.range.end),
                severity: located.severity,
                message: located.message.clone(),
            })
            .collect();
        let marks = located
            .iter()
            .map(|located| Mark {
                range: located.range.clone(),
                style: MarkStyle::squiggle(located.severity.underline()),
            })
            .collect();
        editor.update(cx, |editor, cx| editor.set_marks(LAYER, marks, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(line: u32) -> BuildMark {
        BuildMark {
            line,
            severity: Severity::Error,
            message: "Undefined control sequence.".into(),
        }
    }

    #[test]
    fn a_build_diagnostic_underlines_its_whole_line_clamped_into_the_file() {
        let text = "\\documentclass{article}\r\n\\begin{document}\n\\foo\n";
        let located = whole_lines(&[mark(3), mark(0), mark(99)], text);
        let ranges: Vec<&str> = located.iter().map(|l| &text[l.range.clone()]).collect();
        // Line 99 lands on the empty last line, which keeps the break before it.
        assert_eq!(ranges, ["\\foo", "\\documentclass{article}", "\n"]);
    }

    #[test]
    fn an_empty_line_keeps_one_character_to_hover() {
        let text = "a\n\r\n\nb";
        let located = whole_lines(&[mark(2), mark(3)], text);
        let ranges: Vec<_> = located.iter().map(|l| l.range.clone()).collect();
        assert_eq!(ranges, [2..3, 4..5]);
        assert!(whole_lines(&[mark(1)], "").is_empty());
    }
}
