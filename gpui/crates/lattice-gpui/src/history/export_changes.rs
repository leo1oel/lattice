//! The PDF with changes marked, as a sheet over the comparison, ported from
//! the Tauri app's `ExportChangesDialog` (`src/history/export-changes-dialog.tsx`,
//! its rules in `compare-versions.css`): how the changes are drawn on the
//! left, a page drawn that way on the right (options beside a live preview),
//! 440px wide, 820 with the preview, the preview dropped in a window under
//! 720px.
//!
//! The preview is the comparison's own first three changes, drawn the way
//! latexdiff draws them (new words wavy-underlined, deleted ones struck or
//! gone, each citation numbered as the page first cites it, a bar in the
//! margin), not the typeset page: building one takes as long as the export.
//!
//! The export is lattice-core's `latex::export_changes_pdf`, on the
//! background executor. Closing the sheet, or the comparison under it,
//! stops latexdiff or the build at once (`ChangesExports::cancel`). The
//! choices are kept for the next export this session.

use std::{
    collections::HashMap,
    ops::Range,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
};

use gpui::{
    AnyElement, App, Context, HighlightStyle, IntoElement, ParentElement as _, Render,
    SharedString, StrikethroughStyle, Styled as _, StyledText, Task, UnderlineStyle, WeakEntity,
    Window, div, prelude::FluentBuilder as _, px, rgb,
};
use lattice_core::{
    git::GitLogFile,
    latex::{ChangesExports, ChangesPdf, ChangesPdfOptions},
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, LayerPlacement, ModalLayer, Segmented, Switch, ToastLevel},
    tokens::{FONT_WEIGHT_MEDIUM, RADIUS_DIALOG},
};
use regex::Regex;

use super::{
    compare::CompareView,
    prose::{ProsePassage, inline_edit_spans, joined_passage, prose_passages},
    widgets::inline_message,
};
use crate::notices::{self, Notice, NoticeAction};

/// The last choices, for the next export this session.
static LAST_OPTIONS: Mutex<Options> = Mutex::new(Options {
    colour: true,
    keep_deleted: true,
    margin_bars: true,
    only_changed_pages: false,
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Options {
    colour: bool,
    keep_deleted: bool,
    margin_bars: bool,
    only_changed_pages: bool,
}

impl Options {
    fn core(self) -> ChangesPdfOptions {
        ChangesPdfOptions {
            colour: self.colour,
            keep_deleted: self.keep_deleted,
            margin_bars: self.margin_bars,
            only_changed_pages: self.only_changed_pages,
        }
    }
}

/// What lattice-core answers when the export was stopped (latex/changes.rs).
const CANCELLED: &str = "The export with changes marked was cancelled.";
/// How many changed passages the page preview draws.
const PREVIEW_PASSAGES: usize = 3;

/// `main.tex` → `main-changes.pdf`, where the export saves it.
fn changes_pdf_name(root_document: &str) -> String {
    format!("{}-changes.pdf", strip_tex(root_document))
}

fn strip_tex(path: &str) -> &str {
    if path.to_ascii_lowercase().ends_with(".tex") {
        &path[..path.len() - 4]
    } else {
        path
    }
}

pub struct ExportChangesSheet {
    root: PathBuf,
    root_document: String,
    from: String,
    to: Option<String>,
    from_name: String,
    to_name: String,
    changed: Vec<GitLogFile>,
    compare: WeakEntity<CompareView>,
    options: Options,
    running: bool,
    error: String,
    preview: Vec<ProsePassage>,
    exports: Arc<ChangesExports>,
    _preview: Option<Task<()>>,
}

impl ExportChangesSheet {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root: PathBuf,
        root_document: String,
        from: String,
        to: Option<String>,
        from_name: String,
        to_name: String,
        changed: Vec<GitLogFile>,
        compare: WeakEntity<CompareView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let options = *LAST_OPTIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut sheet = Self {
            root,
            root_document,
            from,
            to,
            from_name,
            to_name,
            changed,
            compare,
            options,
            running: false,
            error: String::new(),
            preview: Vec::new(),
            exports: Arc::new(ChangesExports::default()),
            _preview: None,
        };
        sheet.read_preview(cx);
        sheet
    }

    /// Now was read again under the sheet: read the preview again too.
    pub fn files_read_again(&mut self, _read: u64, cx: &mut Context<Self>) {
        self.read_preview(cx);
    }

    /// The first changed passages across the comparison's .tex files, the
    /// root document first.
    fn read_preview(&mut self, cx: &mut Context<Self>) {
        let mut sources: Vec<GitLogFile> = self
            .changed
            .iter()
            .filter(|file| file.path.to_ascii_lowercase().ends_with(".tex"))
            .cloned()
            .collect();
        sources.sort_by_key(|file| file.path != self.root_document);
        let (root, from, to) = (self.root.clone(), self.from.clone(), self.to.clone());
        let read = cx.background_executor().spawn(async move {
            let mut passages = Vec::new();
            for file in sources {
                if passages.len() >= PREVIEW_PASSAGES {
                    break;
                }
                let Ok(diff) = lattice_core::git::compare_file(
                    &root,
                    &from,
                    to.as_deref(),
                    &file.path,
                    file.old_path.as_deref(),
                ) else {
                    continue;
                };
                if diff.binary {
                    continue;
                }
                let found = prose_passages(
                    diff.before.as_deref().unwrap_or(""),
                    diff.after.as_deref().unwrap_or(""),
                )
                .unwrap_or_default();
                passages.extend(
                    found
                        .iter()
                        .map(joined_passage)
                        .filter(|passage| !passage.edits.is_empty()),
                );
            }
            passages.truncate(PREVIEW_PASSAGES);
            passages
        });
        self._preview = Some(cx.spawn(async move |this, cx| {
            let passages = read.await;
            this.update(cx, |this, cx| {
                if this.preview != passages {
                    this.preview = passages;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn set(&mut self, change: impl FnOnce(&mut Options), cx: &mut Context<Self>) {
        change(&mut self.options);
        *LAST_OPTIONS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = self.options;
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if self.running {
            self.running = false;
            self.exports.cancel();
        }
        if let Some(compare) = self.compare.upgrade() {
            compare.update(cx, |compare, cx| compare.close_export(cx));
        }
    }

    fn export(&mut self, cx: &mut Context<Self>) {
        self.running = true;
        self.error.clear();
        cx.notify();
        let (root, from, to, options) = (
            self.root.clone(),
            self.from.clone(),
            self.to.clone(),
            self.options.core(),
        );
        let exports = self.exports.clone();
        let export = exports.begin();
        let run = cx.background_executor().spawn(async move {
            lattice_core::latex::export_changes_pdf(
                &root,
                &from,
                to.as_deref(),
                options,
                &exports,
                export,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = run.await;
            this.update(cx, |this, cx| {
                this.running = false;
                match result {
                    Ok(pdf) => {
                        this.saved(pdf, cx);
                        this.close(cx);
                    }
                    Err(message) if message == CANCELLED => {}
                    Err(message) => {
                        this.error = if message.starts_with("latexdiff is not installed") {
                            t!("latexdiff is not installed. It comes with MacTeX; with BasicTeX, run “sudo tlmgr install latexdiff” in Terminal, then export again.").into()
                        } else {
                            message
                        };
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Say where it was saved, with Open and Show in Finder.
    fn saved(&self, pdf: ChangesPdf, cx: &mut Context<Self>) {
        let mut notice = Notice::new(ToastLevel::Success, t!("Saved {0}", pdf.path));
        if pdf.simplified {
            notice = notice.detail(t!("Maths, figures and citations are left unmarked: the fully marked document did not build."));
        } else if pdf.unmarked > 0 {
            notice = notice.detail(t!(
                "Some changes are shown without marks: marked, they kept the PDF from building."
            ));
        }
        let compare = self.compare.clone();
        let path = pdf.path.clone();
        notice = notice.action(NoticeAction::new(t!("Open"), move |_, cx| {
            compare
                .update(cx, |compare, cx| compare.open_saved(path.clone(), cx))
                .ok();
        }));
        let absolute = self.root.join(&pdf.path);
        notice = notice.action(NoticeAction::new(t!("Show in Finder"), move |_, cx| {
            cx.reveal_path(&absolute);
        }));
        notices::show(notice, cx);
    }
}

impl Drop for ExportChangesSheet {
    fn drop(&mut self) {
        // The comparison closing takes the sheet with it; latexdiff must not run on.
        if self.running {
            self.exports.cancel();
        }
    }
}

/// A citation as the page would number it, rather than its source.
static CITATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"~?\\(?:cite[a-zA-Z]*|parencite|textcite|autocite)\*?(?:\[[^\]]*\])*\{([^}]*)\}")
        .expect("the citation pattern compiles")
});
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("the spaces pattern compiles"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PageMark {
    Deleted,
    Inserted,
}

/// The passages as latexdiff marks them, each a paragraph's text and its
/// marked ranges; the citations numbered through every passage.
/// A passage's text and its marked ranges.
type MarkedPassage = (String, Vec<(Range<usize>, PageMark)>);

fn marked_passages(passages: &[ProsePassage], keep_deleted: bool) -> Vec<MarkedPassage> {
    let mut numbers: HashMap<String, usize> = HashMap::new();
    let mut flat = |part: &str| -> String {
        let cited = CITATION.replace_all(part, |captures: &regex::Captures| {
            let keys = captures[1].trim().to_string();
            let next = numbers.len() + 1;
            let number = *numbers.entry(keys).or_insert(next);
            format!(" [{number}]")
        });
        SPACES.replace_all(&cited, " ").into_owned()
    };
    passages
        .iter()
        .map(|passage| {
            let text = &passage.text;
            let mut out = String::new();
            let mut marks = Vec::new();
            let mut cursor = 0;
            for span in inline_edit_spans(text, &passage.edits) {
                out.push_str(&flat(&text[cursor..span.from]));
                let struck = !span.deleted.trim().is_empty() && keep_deleted;
                if struck {
                    let start = out.len();
                    out.push_str(flat(&span.deleted).trim());
                    marks.push((start..out.len(), PageMark::Deleted));
                }
                if struck && !span.inserted.trim().is_empty() {
                    out.push(' ');
                }
                if !span.inserted.trim().is_empty() {
                    let start = out.len();
                    out.push_str(flat(&span.inserted).trim());
                    marks.push((start..out.len(), PageMark::Inserted));
                }
                // The spaces at the change's edges stay outside the marks.
                let edge = if span.inserted.is_empty() {
                    &span.deleted
                } else {
                    &span.inserted
                };
                if edge.ends_with(char::is_whitespace) {
                    out.push(' ');
                }
                cursor = span.to;
            }
            out.push_str(&flat(&text[cursor..]));
            (out, marks)
        })
        .collect()
}

/// latexdiff's own inks, as the page draws them: blue additions, red
/// deletions, changebar's grey.
const PAGE_INK: u32 = 0x1d1d1f;
const ADDED: u32 = 0x1f49d8;
const DELETED: u32 = 0xc8102e;
const BAR: u32 = 0xa6a6a6;

impl ExportChangesSheet {
    fn render_preview(&self, cx: &App) -> AnyElement {
        let palette = cx.palette().clone();
        let options = self.options;
        let paragraphs = marked_passages(&self.preview, options.keep_deleted)
            .into_iter()
            .map(|(text, marks)| {
                let highlights: Vec<(Range<usize>, HighlightStyle)> = marks
                    .into_iter()
                    .map(|(range, mark)| {
                        let style = match mark {
                            PageMark::Inserted => HighlightStyle {
                                color: options.colour.then(|| rgb(ADDED).into()),
                                underline: Some(UnderlineStyle {
                                    thickness: px(0.5),
                                    color: None,
                                    wavy: true,
                                }),
                                ..HighlightStyle::default()
                            },
                            PageMark::Deleted => HighlightStyle {
                                color: options.colour.then(|| rgb(DELETED).into()),
                                strikethrough: Some(StrikethroughStyle {
                                    thickness: px(0.5),
                                    color: None,
                                }),
                                ..HighlightStyle::default()
                            },
                        };
                        (range, style)
                    })
                    .collect();
                // The paragraph indents 1.2em as the page sets it.
                let text: SharedString = format!("\u{2003}{text}").into();
                let shift = "\u{2003}".len();
                let highlights = highlights
                    .into_iter()
                    .map(|(range, style)| (range.start + shift..range.end + shift, style));
                div()
                    .relative()
                    .mb(px(8.))
                    .when(options.margin_bars, |this| {
                        this.child(
                            div()
                                .absolute()
                                .top(px(1.))
                                .bottom(px(1.))
                                .left(px(-12.))
                                .w(px(2.))
                                .bg(if options.colour { rgb(ADDED) } else { rgb(BAR) }),
                        )
                    })
                    .child(StyledText::new(text).with_highlights(highlights.collect::<Vec<_>>()))
            });
        let micro = TextRole::Micro.font_size(lattice_ui::TypeScale::Interface, cx);
        let page = div()
            .relative()
            .w_full()
            .max_w(px(320.))
            .min_h(px(320. * 11. / 8.5))
            .py(px(32.))
            .px(px(24.))
            .overflow_hidden()
            .bg(palette.pdf_page)
            .shadow(Elevation::Raised.shadows(&palette))
            .text_color(rgb(PAGE_INK))
            .text_size(micro * 0.8)
            .line_height(gpui::relative(1.4))
            .children(paragraphs);
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(20.))
            .border_l_1()
            .border_color(palette.line)
            .bg(palette.pdf_ground)
            .child(page)
            .into_any_element()
    }

    fn switch_field(
        &self,
        id: &'static str,
        label: &'static str,
        on: bool,
        set: fn(&mut Options, bool),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let this = cx.entity().downgrade();
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .pt(px(10.))
            .pb(px(4.))
            .border_t_1()
            .border_color(palette.line)
            .child(
                div()
                    .min_w_0()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text)
                    .child(label),
            )
            .child(Switch::new(id, on).on_toggle(move |value, _, cx| {
                let value = *value;
                this.update(cx, |sheet, cx| sheet.set(|options| set(options, value), cx))
                    .ok();
            }))
            .into_any_element()
    }
}

impl Render for ExportChangesSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let wide = window.viewport_size().width >= px(720.);
        let preview = (wide && !self.preview.is_empty()).then(|| self.render_preview(cx));
        let width = if preview.is_some() {
            px(820.)
        } else {
            px(440.)
        };
        let width = width.min(window.viewport_size().width - px(40.));
        let saved = changes_pdf_name(&self.root_document);
        let pdf = format!("{}.pdf", strip_tex(&self.root_document));
        let options = self.options;
        let range = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .mt(px(-8.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(
                div()
                    .min_w_0()
                    .max_w_full()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(palette.text)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .child(self.from_name.clone()),
            )
            .child(Icon::ARROW_UP_DOWN.element(px(12.), palette.text_secondary))
            .child(
                div()
                    .min_w_0()
                    .max_w_full()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(palette.text)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .child(self.to_name.clone()),
            );
        let style = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(t!("Mark changes"))
            .child(
                div().flex().child(
                    Segmented::new("export-changes-style")
                        .filled()
                        .label(
                            t!("In colour"),
                            options.colour,
                            cx.listener(|this, _, _, cx| {
                                this.set(|options| options.colour = true, cx)
                            }),
                        )
                        .label(
                            t!("Underline only"),
                            !options.colour,
                            cx.listener(|this, _, _, cx| {
                                this.set(|options| options.colour = false, cx)
                            }),
                        ),
                ),
            );
        let running = self.running;
        let actions = div()
            .flex()
            .justify_end()
            .gap(px(8.))
            .mt(px(4.))
            .child(
                Button::new("export-changes-cancel", t!("Cancel"))
                    .ghost()
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
            )
            .child(
                Button::new(
                    "export-changes-run",
                    if running {
                        t!("Exporting…")
                    } else {
                        t!("Export PDF")
                    },
                )
                .primary()
                .icon(Icon::FILE_DOWN)
                .disabled(running)
                .on_click(cx.listener(|this, _, _, cx| this.export(cx))),
            );
        let form = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(12.))
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(t!("PDF with changes marked")),
            )
            .child(range)
            .child(style)
            .child(self.switch_field(
                "export-changes-deleted",
                t!("Keep deleted text, struck through"),
                options.keep_deleted,
                |o, v| o.keep_deleted = v,
                cx,
            ))
            .child(self.switch_field(
                "export-changes-bars",
                t!("Bars in the margin"),
                options.margin_bars,
                |o, v| o.margin_bars = v,
                cx,
            ))
            .child(self.switch_field(
                "export-changes-pages",
                t!("Only pages with changes"),
                options.only_changed_pages,
                |o, v| o.only_changed_pages = v,
                cx,
            ))
            .child(
                div()
                    .text_role(TextRole::Micro, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("Saves {saved} beside {pdf}", saved = &saved, pdf = &pdf)),
            )
            .when(!self.error.is_empty(), |this| {
                this.child(inline_message(self.error.clone(), true, cx))
            })
            .child(actions);
        let card = div()
            .w(width)
            .flex()
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .overflow_hidden()
            .child(form)
            .children(preview);
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "export-changes",
            LayerPlacement::Center,
            lattice_ui::components::rise_in("export-changes-card", card),
            move |_, cx| {
                this.update(cx, |sheet, cx| sheet.close(cx)).ok();
            },
        )
        .closable_by_scrim(!running)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_saved_pdf_beside_the_paper() {
        assert_eq!(changes_pdf_name("main.tex"), "main-changes.pdf");
        assert_eq!(changes_pdf_name("paper/Main.TEX"), "paper/Main-changes.pdf");
    }

    #[test]
    fn numbers_citations_and_marks_the_changes_as_latexdiff_does() {
        let passages: Vec<ProsePassage> = prose_passages(
            "Attention helps \\cite{a}. It works \\cite{b}.\n",
            "Attention aids \\cite{a}. It works \\cite{b}.\n",
        )
        .unwrap()
        .iter()
        .map(joined_passage)
        .collect();
        let marked = marked_passages(&passages, true);
        let (text, marks) = &marked[0];
        assert!(text.contains("[1]") && text.contains("[2]"), "{text}");
        let shown: Vec<(&str, PageMark)> = marks
            .iter()
            .map(|(range, mark)| (&text[range.clone()], *mark))
            .collect();
        assert_eq!(
            shown,
            [("helps", PageMark::Deleted), ("aids", PageMark::Inserted)],
            "{text}"
        );
        // Without the deleted text, only the insertion is marked.
        let (text, marks) = &marked_passages(&passages, false)[0];
        assert_eq!(marks.len(), 1, "{text}");
        assert!(!text.contains("helps"), "{text}");
    }
}
