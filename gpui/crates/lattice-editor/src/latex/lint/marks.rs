//! The LaTeX source's own lint on the adapter (`super::index_lint`'s
//! findings): each one CodeMirror lint's wavy underline in its severity's
//! colour, with the lint tooltip over it, as the Tauri app's
//! `linter(indexDiagnostics)` shows them beside TexLab's. The card names
//! what checked the finding under its message, and offers a finding's
//! action as an outlined button: Fix case respells the path in the buffer,
//! Create file asks the host ([`LintMarksEvent::CreateFile`]).
//!
//! What runs the lint, and when, is the host's: it hands this the findings
//! for the buffer as it was ([`LintMarks::show`]), and they are anchored so
//! an edit made since moves them with the text until the next run.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    WeakEntity, Window, div, px, relative,
};
use language::{Anchor, Buffer, BufferSnapshot, ToOffset as _};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, Elevation};

use super::{Lint, LintAction, Source};
use crate::{
    LatticeEditor,
    decorations::{Mark, MarkStyle},
    hover::{HoverProvider, HoverTarget},
    latex::diagnostics::Severity,
};

/// The adapter layer the lint's marks are in.
pub const LAYER: &str = "lint";

/// What a card asks of the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LintMarksEvent {
    /// Create the project-relative file (a missing `\input`'s Create file),
    /// as the tree's New file does.
    CreateFile(String),
}

#[derive(Clone)]
enum AnchoredAction {
    CreateFile(String),
    FixCase {
        range: Range<Anchor>,
        insert: String,
    },
}

#[derive(Clone)]
struct Anchored {
    range: Range<Anchor>,
    severity: Severity,
    message: String,
    source: Source,
    action: Option<AnchoredAction>,
}

/// The lint's findings shown in one editor.
pub struct LintMarks {
    editor: WeakEntity<LatticeEditor>,
    shown: Rc<RefCell<Vec<Anchored>>>,
}

impl EventEmitter<LintMarksEvent> for LintMarks {}

impl LintMarks {
    /// Show the lint in `editor`, with nothing found yet.
    pub fn attach(editor: &Entity<LatticeEditor>, cx: &mut App) -> Entity<Self> {
        let shown: Rc<RefCell<Vec<Anchored>>> = Rc::default();
        let buffer = editor.read(cx).buffer().downgrade();
        let marks = cx.new(|_| Self {
            editor: editor.downgrade(),
            shown: shown.clone(),
        });
        let cards = LintCards {
            shown,
            marks: marks.downgrade(),
            buffer,
        };
        editor.update(cx, |editor, _| editor.add_hover_provider(Rc::new(cards)));
        marks
    }

    /// Replace what is shown with `lints`, found in `text` (the buffer as
    /// the run read it, which edits may have moved on from since).
    pub fn show(&mut self, lints: Vec<Lint>, text: &BufferSnapshot, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let clamp = |range: &Range<usize>| {
            let end = range.end.min(text.len());
            text.anchor_before(range.start.min(end))..text.anchor_after(end)
        };
        *self.shown.borrow_mut() = lints
            .into_iter()
            .map(|lint| Anchored {
                range: clamp(&lint.range),
                severity: lint.severity,
                message: lint.message,
                source: lint.source,
                action: lint.action.map(|action| match action {
                    LintAction::CreateFile(path) => AnchoredAction::CreateFile(path),
                    LintAction::FixCase { range, insert } => AnchoredAction::FixCase {
                        range: clamp(&range),
                        insert,
                    },
                }),
            })
            .collect();
        self.paint(&editor, cx);
    }

    fn paint(&self, editor: &Entity<LatticeEditor>, cx: &mut App) {
        let text = editor.read(cx).buffer().read(cx).snapshot();
        let marks = self
            .shown
            .borrow()
            .iter()
            .map(|anchored| Mark {
                range: anchored.range.start.to_offset(&text)..anchored.range.end.to_offset(&text),
                style: MarkStyle::squiggle(anchored.severity.underline()),
            })
            .filter(|mark| !mark.range.is_empty())
            .collect();
        editor.update(cx, |editor, cx| editor.set_marks(LAYER, marks, cx));
    }

    /// What is shown now, placed in the buffer as it is.
    pub fn shown(&self, cx: &App) -> Vec<Lint> {
        let Some(editor) = self.editor.upgrade() else {
            return Vec::new();
        };
        let text = editor.read(cx).buffer().read(cx).snapshot();
        let offsets =
            |range: &Range<Anchor>| range.start.to_offset(&text)..range.end.to_offset(&text);
        self.shown
            .borrow()
            .iter()
            .map(|anchored| Lint {
                range: offsets(&anchored.range),
                severity: anchored.severity,
                message: anchored.message.clone(),
                source: anchored.source,
                action: anchored.action.as_ref().map(|action| match action {
                    AnchoredAction::CreateFile(path) => LintAction::CreateFile(path.clone()),
                    AnchoredAction::FixCase { range, insert } => LintAction::FixCase {
                        range: offsets(range),
                        insert: insert.clone(),
                    },
                }),
            })
            .collect()
    }

    /// Run the action of the `index`th finding shown, as its card's button
    /// does; false when it has none.
    pub fn run_action(&mut self, index: usize, cx: &mut Context<Self>) -> bool {
        let Some(action) = self
            .shown
            .borrow()
            .get(index)
            .and_then(|anchored| anchored.action.clone())
        else {
            return false;
        };
        let Some(buffer) = self
            .editor
            .upgrade()
            .map(|editor| editor.read(cx).buffer().clone())
        else {
            return false;
        };
        // This entity is being updated already: Create file is emitted
        // here, not through `run`, which updates it.
        match &action {
            AnchoredAction::CreateFile(path) => cx.emit(LintMarksEvent::CreateFile(path.clone())),
            AnchoredAction::FixCase { .. } => run(&action, &buffer, cx.weak_entity(), cx),
        }
        true
    }
}

/// Fix case writes the file's spelling over the path, if the path there is
/// still the one found (in any case); Create file goes to the host.
fn run(
    action: &AnchoredAction,
    buffer: &Entity<Buffer>,
    marks: WeakEntity<LintMarks>,
    cx: &mut App,
) {
    match action {
        AnchoredAction::CreateFile(path) => {
            marks
                .update(cx, |_, cx| {
                    cx.emit(LintMarksEvent::CreateFile(path.clone()))
                })
                .ok();
        }
        AnchoredAction::FixCase { range, insert } => buffer.update(cx, |buffer, cx| {
            let snapshot = buffer.snapshot();
            let range = range.start.to_offset(&snapshot)..range.end.to_offset(&snapshot);
            let written: String = snapshot.text_for_range(range.clone()).collect();
            if written != *insert && written.to_lowercase() == insert.to_lowercase() {
                buffer.edit([(range, insert.as_str())], None, cx);
            }
        }),
    }
}

/// The card over a finding's underline.
struct LintCards {
    shown: Rc<RefCell<Vec<Anchored>>>,
    marks: WeakEntity<LintMarks>,
    buffer: WeakEntity<Buffer>,
}

impl HoverProvider for LintCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, _: &App) -> Option<HoverTarget> {
        let shown = self.shown.borrow();
        let hits: Vec<Anchored> = shown
            .iter()
            .filter(|anchored| {
                let range =
                    anchored.range.start.to_offset(text)..anchored.range.end.to_offset(text);
                offset >= range.start && offset < range.end
            })
            .cloned()
            .collect();
        let start = hits
            .iter()
            .map(|hit| hit.range.start.to_offset(text))
            .min()?;
        let end = hits.iter().map(|hit| hit.range.end.to_offset(text)).max()?;
        let (marks, buffer) = (self.marks.clone(), self.buffer.clone());
        Some(HoverTarget {
            range: start..end,
            id: "lint",
            card: Rc::new(move |context, _, _| {
                LintCard {
                    hits: hits.clone(),
                    marks: marks.clone(),
                    buffer: buffer.clone(),
                    max_width: context.max_width,
                }
                .into_any_element()
            }),
        })
    }
}

/// CodeMirror's lint tooltip as the Tauri app styles it
/// (`.cm-tooltip-lint`): one row per finding with a 5px edge in its
/// severity's colour, the message, its action as a small outlined button,
/// and what checked it.
#[derive(IntoElement)]
struct LintCard {
    hits: Vec<Anchored>,
    marks: WeakEntity<LintMarks>,
    buffer: WeakEntity<Buffer>,
    max_width: gpui::Pixels,
}

impl RenderOnce for LintCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        div()
            .flex()
            .flex_col()
            .max_w(px(440.).min(self.max_width))
            .rounded(px(6.))
            .overflow_hidden()
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .text_color(palette.text)
            .font_family(editor_font)
            .text_size(px(13.))
            .line_height(relative(1.45))
            .children(self.hits.into_iter().enumerate().map(|(ix, hit)| {
                let action = hit.action.clone().map(|action| {
                    let label = match action {
                        AnchoredAction::CreateFile(_) => t!("Create file"),
                        AnchoredAction::FixCase { .. } => t!("Fix case"),
                    };
                    let (marks, buffer) = (self.marks.clone(), self.buffer.clone());
                    div()
                        .id(SharedString::from(format!("lint-action-{ix}")))
                        .min_h(px(24.))
                        .px(px(8.))
                        .py(px(3.))
                        .flex()
                        .items_center()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(palette.line_strong)
                        .bg(palette.raised)
                        .text_color(palette.text_secondary)
                        .line_height(relative(1.25))
                        .cursor_pointer()
                        .hover(|style| style.bg(palette.hover).text_color(palette.text))
                        .child(label.to_string())
                        .on_click(move |_, _, cx| {
                            if let Some(buffer) = buffer.upgrade() {
                                run(&action, &buffer, marks.clone(), cx);
                            }
                        })
                });
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x(px(4.))
                    .gap_y(px(6.))
                    .py(px(8.))
                    .px(px(10.))
                    .border_l(px(5.))
                    .border_color(hit.severity.edge(cx))
                    .child(div().w_full().child(hit.message))
                    .children(action)
                    .child(
                        div()
                            .w_full()
                            .text_color(palette.text_secondary)
                            .text_size(px(13. * 0.9))
                            .child(hit.source.name()),
                    )
            }))
    }
}
