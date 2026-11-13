//! TexLab's diagnostics on the adapter: each one a mark (CodeMirror lint's
//! wavy underline, in its colours) with a hover card that says what TexLab
//! found.
//!
//! As in the Tauri app (`src/build/use-texlab-diagnostics.ts`,
//! `texlab-diagnostics.ts`): the file is synced to TexLab 700 ms after the
//! last edit, when its editor gains focus, and again after every build,
//! and what TexLab publishes for it replaces what was shown. TexLab keeps
//! one document, so only the editor the writer is in, or the one already
//! TexLab's document, syncs: opening, moving or reloading a file in the
//! background does not take TexLab from the file being written. A diagnostic's range is clamped into the
//! buffer, an empty one underlines up to 12 characters, and a box warning
//! TexLab pins to the very start of the root document (it comes from a
//! generated file) is not drawn there. As in the Tauri app, whose lint
//! gutter is gone, nothing is drawn in the gutter.

use std::{cell::RefCell, ops::Range, rc::Rc, time::Duration};

use gpui::{
    App, AppContext as _, Context, Entity, Hsla, IntoElement, ParentElement as _, RenderOnce,
    Styled as _, Subscription, Task, WeakEntity, Window, div, px, relative, rgb,
};
use language::{Anchor, BufferEvent, BufferSnapshot, ToOffset as _};
use lattice_core::models::Diagnostic;
use lattice_ui::{ActiveLattice as _, Elevation};
use theme::ActiveTheme as _;

use crate::{
    LatticeEditor, TexlabService,
    decorations::{Mark, MarkStyle},
    hover::{HoverProvider, HoverTarget},
    texlab::TexlabEvent,
};

/// The adapter layer TexLab's marks are in.
pub const LAYER: &str = "texlab";
/// How long after the last edit the file goes to TexLab.
pub const SYNC_DELAY: Duration = Duration::from_millis(700);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl Severity {
    /// `diagnosticSeverity`: error and fatal, warning and warn, else info.
    pub fn of(level: &str) -> Self {
        match level.trim().to_lowercase().as_str() {
            "error" | "fatal" => Severity::Error,
            "warning" | "warn" => Severity::Warning,
            _ => Severity::Info,
        }
    }

    /// CodeMirror lint's underline colours, which the Tauri app keeps.
    pub(crate) fn underline(self) -> Hsla {
        match self {
            Severity::Error => rgb(0xdd1111).into(),
            Severity::Warning => rgb(0xffa500).into(),
            Severity::Info => rgb(0x999999).into(),
        }
    }

    /// The lint tooltip's left edge: danger, the code theme's attribute
    /// colour, the accent (`.cm-diagnostic-*` in editor-workspace.css).
    pub(crate) fn edge(self, cx: &App) -> Hsla {
        let palette = cx.palette();
        match self {
            Severity::Error => palette.danger,
            Severity::Warning => cx
                .theme()
                .syntax()
                .style_for_name("attribute")
                .and_then(|style| style.color)
                .unwrap_or(palette.warning),
            Severity::Info => palette.accent,
        }
    }
}

/// A diagnostic placed in the buffer.
#[derive(Clone, Debug, PartialEq)]
pub struct Located {
    pub range: Range<usize>,
    pub severity: Severity,
    pub message: String,
}

#[derive(Clone)]
struct Anchored {
    range: Range<Anchor>,
    severity: Severity,
    message: String,
}

/// `file` with forward slashes and no `.` or empty segments.
fn clean_path(file: &str) -> String {
    let file = file.replace('\\', "/");
    file.split('/')
        .enumerate()
        .filter(|(index, part)| *part != "." && (!part.is_empty() || *index == 0))
        .map(|(_, part)| part)
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether a diagnostic's `file` names the project-relative `active` file.
pub fn matches_file(file: Option<&str>, active: &str) -> bool {
    let (Some(file), false) = (file, active.is_empty()) else {
        return false;
    };
    let (file, active) = (clean_path(file), clean_path(active));
    let absolute = file.starts_with('/') || file.get(1..3) == Some(":/");
    file == active || (absolute && file.ends_with(&format!("/{active}")))
}

/// The byte offset of the 1-based UTF-16 `column` (LSP's unit) in `line`,
/// clamped to the line.
fn utf16_column(line: &str, column: u32) -> usize {
    let mut units = 0u32;
    for (at, character) in line.char_indices() {
        if units >= column.saturating_sub(1) {
            return at;
        }
        units += character.len_utf16() as u32;
    }
    line.len()
}

/// TexLab's diagnostics for `path`, placed in `text`
/// (`editorTexlabDiagnosticsForFile`).
pub fn locate(diagnostics: &[Diagnostic], path: &str, text: &str) -> Vec<Located> {
    let mut starts = vec![0usize];
    starts.extend(text.match_indices('\n').map(|(at, _)| at + 1));
    let rows = starts.len() as u32;
    let line = |row: u32| {
        let start = starts[row as usize];
        let end = starts
            .get(row as usize + 1)
            .map_or(text.len(), |next| next - 1);
        (start, &text[start..end])
    };
    diagnostics
        .iter()
        .filter(|diagnostic| matches_file(diagnostic.file.as_deref(), path))
        .filter(|diagnostic| {
            // A box warning from a generated file (main.bbl), pinned to
            // the root document's origin: not a source location.
            let at_origin = diagnostic.line == Some(1)
                && diagnostic.column == Some(1)
                && diagnostic.end_line == Some(1)
                && diagnostic.end_column == Some(1);
            let boxed = diagnostic.message.starts_with("Underfull \\")
                || diagnostic.message.starts_with("Overfull \\");
            !(at_origin && boxed)
        })
        .filter_map(|diagnostic| {
            let start_row = diagnostic.line.unwrap_or(1).clamp(1, rows) - 1;
            let end_row = diagnostic
                .end_line
                .map_or(start_row, |line| line.clamp(1, rows) - 1);
            let (start_at, start_line) = line(start_row);
            let (end_at, end_line) = line(end_row);
            let from = start_at + diagnostic.column.map_or(0, |c| utf16_column(start_line, c));
            let mut to = end_at
                + diagnostic
                    .end_column
                    .map_or(end_line.len(), |c| utf16_column(end_line, c));
            if to <= from {
                // An empty or inverted range underlines up to 12 characters
                // of the start line.
                let rest = &text[from..start_at + start_line.len()];
                to = from + rest.char_indices().nth(12).map_or(rest.len(), |(at, _)| at);
            }
            (to > from).then(|| Located {
                range: from..to,
                severity: Severity::of(&diagnostic.level),
                message: diagnostic.message.clone(),
            })
        })
        .collect()
}

/// TexLab's diagnostics for one editor, kept in step with its buffer.
pub struct TexlabDiagnostics {
    editor: WeakEntity<LatticeEditor>,
    service: Entity<TexlabService>,
    path: String,
    shown: Rc<RefCell<Vec<Anchored>>>,
    raw: Vec<Diagnostic>,
    /// The writer is in this editor.
    focused: bool,
    _sync: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl TexlabDiagnostics {
    /// Show TexLab's diagnostics for `path` (project-relative) in `editor`.
    pub fn attach(
        editor: &Entity<LatticeEditor>,
        service: Entity<TexlabService>,
        path: String,
        cx: &mut App,
    ) -> Entity<Self> {
        let shown: Rc<RefCell<Vec<Anchored>>> = Rc::default();
        editor.update(cx, |editor, _| {
            editor.add_hover_provider(Rc::new(DiagnosticCards {
                shown: shown.clone(),
            }));
        });
        let buffer = editor.read(cx).buffer().clone();
        cx.new(|cx: &mut Context<Self>| {
            let subscriptions = vec![
                cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                    if matches!(event, BufferEvent::Edited { .. }) {
                        this.schedule_sync(cx);
                    }
                }),
                cx.subscribe(&service, |this, _, event: &TexlabEvent, cx| {
                    let TexlabEvent::Diagnostics { path, diagnostics } = event;
                    if matches_file(Some(path), &this.path) {
                        this.raw = diagnostics.clone();
                        this.show(cx);
                    }
                }),
            ];
            let mut this = Self {
                editor: editor.downgrade(),
                service,
                path,
                shown,
                raw: Vec::new(),
                focused: false,
                _sync: None,
                _subscriptions: subscriptions,
            };
            this.schedule_sync(cx);
            this
        })
    }

    /// The file was renamed or moved: sync it under its new path, or not at
    /// all once that path is no longer a `.tex` file.
    pub fn set_path(&mut self, path: String, cx: &mut Context<Self>) {
        // Scheduled under the old path, which decides whether it may sync;
        // the sync reads the new one when it fires.
        self.schedule_sync(cx);
        self.path = path;
        if !self.path.ends_with(".tex") {
            self._sync = None;
        }
        self.raw.clear();
        self.show(cx);
    }

    /// Sync again after a build, so TexLab reads the new log.
    pub fn resync(&mut self, cx: &mut Context<Self>) {
        self.schedule_sync(cx);
    }

    /// The writer went into its editor, or left it. Going in makes this the
    /// document TexLab has open.
    pub fn set_focused(&mut self, focused: bool, cx: &mut Context<Self>) {
        self.focused = focused;
        if focused {
            self.schedule_sync(cx);
        }
    }

    /// Whether this file may sync now: the writer is in it, or it is the
    /// document TexLab has open already.
    fn may_sync(&self, cx: &App) -> bool {
        may_schedule(
            self.focused,
            self.service.read(cx).document(),
            self.path.as_str(),
        )
    }

    /// What is shown now, placed in the buffer as it is.
    pub fn located(&self, cx: &App) -> Vec<Located> {
        let Some(editor) = self.editor.upgrade() else {
            return Vec::new();
        };
        let text = editor.read(cx).buffer().read(cx).snapshot();
        self.shown
            .borrow()
            .iter()
            .map(|anchored| Located {
                range: anchored.range.start.to_offset(&text)..anchored.range.end.to_offset(&text),
                severity: anchored.severity,
                message: anchored.message.clone(),
            })
            .collect()
    }

    fn schedule_sync(&mut self, cx: &mut Context<Self>) {
        if !self.path.ends_with(".tex") || !self.may_sync(cx) {
            return;
        }
        // When it fires, it still syncs unless another editor took TexLab's
        // document in the meantime while the writer is not in this one.
        let document = self.service.read(cx).document().map(str::to_string);
        self._sync = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SYNC_DELAY).await;
            this.update(cx, |this, cx| {
                let Some(editor) = this.editor.upgrade() else {
                    return;
                };
                if !may_fire(
                    this.focused,
                    this.service.read(cx).document(),
                    document.as_deref(),
                ) {
                    return;
                }
                let text = editor.read(cx).buffer().read(cx).text();
                let path = this.path.clone();
                this.service
                    .update(cx, |service, cx| service.sync(path, text, cx));
            })
            .ok();
        }));
    }

    fn show(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let text = editor.read(cx).buffer().read(cx).snapshot();
        let located = locate(&self.raw, &self.path, &text.text());
        *self.shown.borrow_mut() = located
            .iter()
            .map(|located| Anchored {
                range: text.anchor_before(located.range.start)
                    ..text.anchor_after(located.range.end),
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

/// The card over a diagnostic's underline: what TexLab found there.
struct DiagnosticCards {
    shown: Rc<RefCell<Vec<Anchored>>>,
}

impl HoverProvider for DiagnosticCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, _: &App) -> Option<HoverTarget> {
        let shown = self.shown.borrow();
        let hits: Vec<_> = shown
            .iter()
            .filter(|anchored| {
                let range =
                    anchored.range.start.to_offset(text)..anchored.range.end.to_offset(text);
                offset >= range.start && offset < range.end
            })
            .cloned()
            .collect();
        if hits.is_empty() {
            return None;
        }
        let start = hits
            .iter()
            .map(|hit| hit.range.start.to_offset(text))
            .min()?;
        let end = hits.iter().map(|hit| hit.range.end.to_offset(text)).max()?;
        let items: Vec<_> = hits
            .into_iter()
            .map(|hit| (hit.severity, hit.message))
            .collect();
        Some(HoverTarget {
            range: start..end,
            id: "diagnostic",
            card: Rc::new(move |context, _, _| {
                DiagnosticCard {
                    items: items.clone(),
                    max_width: context.max_width,
                }
                .into_any_element()
            }),
        })
    }
}

/// The lint tooltip: one row per diagnostic, its message over the source,
/// a 5px edge in its severity's colour (`.cm-tooltip-lint .cm-diagnostic`).
#[derive(IntoElement)]
struct DiagnosticCard {
    items: Vec<(Severity, String)>,
    max_width: gpui::Pixels,
}

impl RenderOnce for DiagnosticCard {
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
            .children(self.items.into_iter().map(|(severity, message)| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .py(px(8.))
                    .px(px(10.))
                    .border_l(px(5.))
                    .border_color(severity.edge(cx))
                    .child(message)
                    .child(
                        div()
                            .text_color(palette.text_secondary)
                            .text_size(px(13. * 0.9))
                            .child("texlab"),
                    )
            }))
    }
}

/// Whether an editor for `path` may schedule a sync: the writer is in it, or
/// it is TexLab's `document` already. TexLab keeps one document, so any other
/// editor syncing would take it from the file being written.
fn may_schedule(focused: bool, document: Option<&str>, path: &str) -> bool {
    focused || document == Some(path)
}

/// Whether a sync scheduled while TexLab's document was `then` still runs
/// when its timer fires and the document is `now`: the writer is in its
/// editor, or no other editor has taken the document in between. The path is
/// not compared again, as a file moved meanwhile syncs under its new one.
fn may_fire(focused: bool, now: Option<&str>, then: Option<&str>) -> bool {
    focused || now == then
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostic(
        line: u32,
        column: Option<u32>,
        end: Option<(u32, u32)>,
        level: &str,
        message: &str,
    ) -> Diagnostic {
        Diagnostic {
            file: Some("chapters/intro.tex".into()),
            line: Some(line),
            column,
            end_line: end.map(|(line, _)| line),
            end_column: end.map(|(_, column)| column),
            level: level.into(),
            message: message.into(),
            code: None,
            params: Default::default(),
        }
    }

    /// Two editors and TexLab's one document, driven through the gate as
    /// the panels drive it: `schedule` when an editor schedules a sync, and
    /// `fire` when its 700 ms timer runs out (which syncs, so the editor
    /// becomes TexLab's document).
    struct Texlab {
        document: Option<&'static str>,
    }

    struct Pending {
        path: &'static str,
        then: Option<&'static str>,
    }

    impl Texlab {
        fn schedule(&self, path: &'static str, focused: bool) -> Option<Pending> {
            may_schedule(focused, self.document, path).then_some(Pending {
                path,
                then: self.document,
            })
        }

        fn fire(&mut self, pending: Option<Pending>, focused: bool) {
            if let Some(pending) = pending
                && may_fire(focused, self.document, pending.then)
            {
                self.document = Some(pending.path);
            }
        }
    }

    #[test]
    fn a_focus_switch_before_the_timer_keeps_texlab_on_the_focused_file() {
        // The writer typed in A, which is TexLab's document; a build runs.
        let mut texlab = Texlab {
            document: Some("a.tex"),
        };
        // They click into B: B schedules its focus sync.
        let b = texlab.schedule("b.tex", true);
        // The build finishes: A, no longer focused but still TexLab's
        // document, schedules its resync; B's own resync replaces its task.
        let a = texlab.schedule("a.tex", false);
        assert!(a.is_some(), "TexLab's document may still resync");
        let b = texlab.schedule("b.tex", true).or(b);
        // B's timer fires first and takes the document.
        texlab.fire(b, true);
        assert_eq!(texlab.document, Some("b.tex"));
        // A's fires later: it must not take TexLab back from B.
        texlab.fire(a, false);
        assert_eq!(texlab.document, Some("b.tex"));
    }

    #[test]
    fn a_background_reload_does_not_take_texlab_from_the_focused_file() {
        // The writer is in main.tex, TexLab's document.
        let mut texlab = Texlab {
            document: Some("main.tex"),
        };
        // intro.tex, open in the background, reloads an outside edit (or is
        // opened, moved, or resynced after a build): it does not schedule.
        let intro = texlab.schedule("chapters/intro.tex", false);
        assert!(intro.is_none());
        texlab.fire(intro, false);
        assert_eq!(texlab.document, Some("main.tex"));
        // main.tex's own resync after the build still runs.
        let main = texlab.schedule("main.tex", true);
        texlab.fire(main, true);
        assert_eq!(texlab.document, Some("main.tex"));
    }

    #[test]
    fn the_focused_or_still_current_file_syncs_when_its_timer_fires() {
        // An edit made in A just before the writer clicks into the PDF pane
        // (no editor focused) still syncs: nobody took the document.
        let mut texlab = Texlab {
            document: Some("a.tex"),
        };
        let a = texlab.schedule("a.tex", true);
        texlab.fire(a, false);
        assert_eq!(texlab.document, Some("a.tex"));
        // A focused editor syncs even if another took the document meanwhile.
        let b = texlab.schedule("b.tex", true);
        texlab.document = Some("c.tex");
        texlab.fire(b, true);
        assert_eq!(texlab.document, Some("b.tex"));
        // Nothing open yet: the first focused file takes TexLab.
        assert!(may_schedule(true, None, "a.tex"));
        assert!(!may_schedule(false, None, "a.tex"));
    }

    #[test]
    fn files_match_relative_or_by_their_tail() {
        assert!(matches_file(
            Some("./chapters//intro.tex"),
            "chapters/intro.tex"
        ));
        assert!(matches_file(
            Some("/tmp/p/chapters/intro.tex"),
            "chapters/intro.tex"
        ));
        assert!(!matches_file(Some("intro.tex"), "chapters/intro.tex"));
        assert!(!matches_file(None, "chapters/intro.tex"));
        assert_eq!(Severity::of(" Fatal "), Severity::Error);
        assert_eq!(Severity::of("hint"), Severity::Info);
    }

    #[test]
    fn diagnostics_are_clamped_into_the_buffer() {
        let text = "\\documentclass{article}\nSee \\ref{x} and é\\cite{k}.\n";
        let located = locate(
            &[
                // TexLab's columns are UTF-16 units: é is one.
                diagnostic(2, Some(18), Some((2, 26)), "warning", "Unknown citation"),
                // Past the last line: clamped to it.
                diagnostic(9, Some(1), None, "error", "Clamped"),
                // An empty range underlines up to 12 characters.
                diagnostic(2, Some(5), Some((2, 5)), "warning", "Empty"),
                // A box warning at the origin is not drawn there.
                diagnostic(
                    1,
                    Some(1),
                    Some((1, 1)),
                    "warning",
                    "Overfull \\hbox (1pt too wide)",
                ),
            ],
            "chapters/intro.tex",
            text,
        );
        assert_eq!(located.len(), 2, "{located:?}");
        assert_eq!(&text[located[0].range.clone()], "\\cite{k}");
        assert_eq!(located[0].severity, Severity::Warning);
        // Clamped to the last line, which is empty: nothing to underline.
        let empty = &located[1];
        assert_eq!(empty.message, "Empty");
        assert_eq!(&text[empty.range.clone()], "\\ref{x} and ");
        assert!(located.iter().all(|l| l.range.end <= text.len()));
    }
}
