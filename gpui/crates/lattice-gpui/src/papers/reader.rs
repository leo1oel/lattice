//! A saved paper's reading surface (`src/canvas/paper-reader.tsx`,
//! `.paper-reader-*` in `editor-workspace.css`): a document tab holding the
//! paper's full text, or its overview, rendered as Markdown in the reading
//! face, under a strip that names it (title, authors, and its source, which
//! opens the original on the web) with the views it has and the original
//! PDF the bundle keeps.
//!
//! The text is the bundle's own (`paper.md`, `blog.md`), read through the
//! file system as lattice-core writes it; a link inside it opens in the
//! browser. The Markdown is Zed's renderer (`markdown`), styled with
//! Lattice's tokens: the reading face at the typeset size on the editor's
//! sheet, a 720px column, headings in the interface's weights.

use lattice_i18n::{join_phrases, t};
use std::path::PathBuf;

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, TextStyleRefinement, Window, div,
    prelude::FluentBuilder as _, px, relative,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_core::papers::PaperSummary;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Segmented},
    scrollbar::FluidScrollbar,
    tokens::FONT_WEIGHT_MEDIUM,
};
use markdown::{HeadingLevelStyles, Markdown, MarkdownElement, MarkdownFont, MarkdownStyle};

use super::{model, row::tooltip};

/// Which of the bundle's texts is on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReaderView {
    FullText,
    Overview,
}

impl ReaderView {
    fn file(self) -> &'static str {
        match self {
            ReaderView::FullText => "paper.md",
            ReaderView::Overview => "blog.md",
        }
    }
}

pub enum PaperReaderEvent {
    /// Open the original PDF the bundle keeps (project-relative).
    OpenPdf(String),
}

pub struct PaperReader {
    root: PathBuf,
    paper: PaperSummary,
    view: ReaderView,
    markdown: Entity<Markdown>,
    error: Option<String>,
    scroll: ScrollHandle,
    focus: FocusHandle,
    _read: Option<Task<()>>,
}

impl EventEmitter<PanelEvent> for PaperReader {}
impl EventEmitter<PaperReaderEvent> for PaperReader {}

impl PaperReader {
    pub fn new(
        root: PathBuf,
        paper: PaperSummary,
        view: ReaderView,
        cx: &mut Context<Self>,
    ) -> Self {
        let markdown = cx.new(|cx| Markdown::new(SharedString::default(), None, None, cx));
        let mut this = Self {
            root,
            paper,
            view,
            markdown,
            error: None,
            scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            _read: None,
        };
        this.read(cx);
        this
    }

    pub fn paper(&self) -> &PaperSummary {
        &self.paper
    }

    /// The text on screen, as read (without its front matter).
    pub fn text(&self, cx: &App) -> Option<SharedString> {
        self.error
            .is_none()
            .then(|| self.markdown.read(cx).source().clone())
    }

    /// The reading file on screen, from the project root.
    pub fn path(&self) -> String {
        format!(
            ".research/papers/{}/{}",
            self.paper.arxiv_id,
            self.view.file()
        )
    }

    /// Show `view` (the full text or the overview).
    pub fn show(&mut self, view: ReaderView, cx: &mut Context<Self>) {
        if self.view != view {
            self.view = view;
            self.read(cx);
        }
    }

    /// The paper as the library lists it now (a refreshed record).
    pub fn set_paper(&mut self, paper: PaperSummary, cx: &mut Context<Self>) {
        let texts = (paper.has_full_text, paper.has_blog);
        let changed = texts != (self.paper.has_full_text, self.paper.has_blog);
        self.paper = paper;
        if changed {
            // A download left a full text where only the overview was; the
            // view on screen stays where the writer is in it.
            let view = if self.paper.has_full_text {
                ReaderView::FullText
            } else {
                ReaderView::Overview
            };
            self.show(view, cx);
        }
        cx.notify();
    }

    fn read(&mut self, cx: &mut Context<Self>) {
        let path = self.root.join(self.path());
        let read = cx.background_spawn(async move { std::fs::read_to_string(&path) });
        self._read = Some(cx.spawn(async move |this, cx| {
            let text = read.await;
            this.update(cx, |this, cx| {
                match text {
                    Ok(text) => {
                        this.error = None;
                        let body = model::strip_frontmatter(&text).to_string();
                        this.markdown
                            .update(cx, |markdown, cx| markdown.reset(body.into(), cx));
                    }
                    Err(error) => {
                        this.error = Some(t!(
                            "Could not read {path}: {error}",
                            path = this.path(),
                            error = error
                        ))
                    }
                }
                this.scroll.set_offset(gpui::point(px(0.), px(0.)));
                cx.notify();
            })
            .ok();
        }));
    }

    fn style(&self, window: &Window, cx: &App) -> MarkdownStyle {
        let palette = cx.palette().clone();
        let fonts = cx.lattice().fonts.clone();
        let mut style = MarkdownStyle::themed(MarkdownFont::Preview, window, cx);
        style.base_text_style.font_family = fonts.ui.clone();
        style.base_text_style.font_size = px(14.).into();
        style.base_text_style.line_height = relative(1.6);
        style.base_text_style.color = palette.text;
        style.paragraph_spacing = px(12.);
        style.paragraph_line_height = relative(1.6);
        style.selection_background_color = palette.selection;
        style.rule_color = palette.line;
        style.block_quote_border_color = palette.line_strong;
        style.link = TextStyleRefinement {
            color: Some(palette.accent),
            ..Default::default()
        };
        style.inline_code = TextStyleRefinement {
            font_family: Some(fonts.editor.clone()),
            font_size: Some(px(12.5).into()),
            background_color: Some(palette.text.opacity(0.05)),
            ..Default::default()
        };
        let heading = |size: f32, weight: gpui::FontWeight, family: Option<SharedString>| {
            TextStyleRefinement {
                font_size: Some(px(size).into()),
                font_weight: Some(weight),
                font_family: family,
                color: Some(palette.text),
                line_height: Some(relative(1.3)),
                ..Default::default()
            }
        };
        style.heading_level_styles = Some(HeadingLevelStyles {
            h1: Some(heading(
                26.,
                gpui::FontWeight::NORMAL,
                Some(fonts.display.clone()),
            )),
            h2: Some(heading(18., gpui::FontWeight::SEMIBOLD, None)),
            h3: Some(heading(15., gpui::FontWeight::SEMIBOLD, None)),
            h4: Some(heading(14., gpui::FontWeight::SEMIBOLD, None)),
            h5: Some(heading(14., FONT_WEIGHT_MEDIUM, None)),
            h6: Some(heading(13., FONT_WEIGHT_MEDIUM, None)),
        });
        style
    }

    /// Blog and Paper, in the tab strip as the Tauri header has them
    /// (`trellis-header-tools.tsx`), when the bundle has both.
    fn content_switch(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        (self.paper.has_full_text && self.paper.has_blog).then(|| {
            let view = self.view;
            Segmented::new("paper-reader-view")
                .label(
                    t!("Blog"),
                    view == ReaderView::Overview,
                    cx.listener(|this, _, _, cx| this.show(ReaderView::Overview, cx)),
                )
                .label(
                    t!("Paper"),
                    view == ReaderView::FullText,
                    cx.listener(|this, _, _, cx| this.show(ReaderView::FullText, cx)),
                )
        })
    }

    /// The strip over the text: the paper's identity and the way to the
    /// original PDF.
    fn header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let source = model::source_label(&self.paper);
        let link = model::link_url(&self.paper);
        let authors = model::short_authors(&self.paper);
        let pdf = self
            .paper
            .has_local_pdf
            .then(|| format!(".research/papers/{}/original.pdf", self.paper.arxiv_id));
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(16.))
            .h(px(40.))
            .pl(px(16.))
            .pr(px(10.))
            .border_b_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_baseline()
                    .gap(px(6.))
                    .whitespace_nowrap()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(self.paper.title.clone()),
                    )
                    .when_some(authors, |line, authors| {
                        line.child(div().flex_none().child(authors))
                    })
                    .when_some(source, |line, source| {
                        let source_ink = palette.text_secondary;
                        let hover_ink = palette.text;
                        // The source is the way out to the original, so it is
                        // the browser action.
                        let label = join_phrases(&[source.as_str(), t!("Open article in browser")]);
                        line.child(
                            div()
                                .id("paper-reader-source")
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(3.))
                                .text_color(source_ink)
                                .child(div().truncate().child(source))
                                .when_some(link, |source, link| {
                                    source
                                        .cursor_pointer()
                                        .hover(move |style| style.text_color(hover_ink))
                                        .tooltip(tooltip(label))
                                        .on_click(move |_, _, cx| model::open_link(&link, cx))
                                        .child(Icon::EXTERNAL_LINK.element(px(11.), source_ink))
                                }),
                        )
                    }),
            )
            .when_some(pdf, |strip, pdf| {
                strip.child(
                    Button::new("paper-reader-pdf", t!("PDF"))
                        .ghost()
                        .compact()
                        .icon(Icon::FILE_TEXT)
                        .tooltip(t!("View original PDF"))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(PaperReaderEvent::OpenPdf(pdf.clone()))
                        })),
                )
            })
    }
}

impl Focusable for PaperReader {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl BasePanel for PaperReader {
    fn panel_name(&self) -> &'static str {
        "PaperReader"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for PaperReader {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(self.paper.title.clone().into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.paper.title.clone()
    }

    fn title_suffix(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        self.content_switch(cx)
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for PaperReader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let style = self.style(window, cx);
        let body = match &self.error {
            Some(error) => div()
                .p(px(24.))
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(error.clone())
                .into_any_element(),
            None => MarkdownElement::new(self.markdown.clone(), style)
                .on_url_click(|url, _, cx| model::open_link(&url, cx))
                .into_any_element(),
        };
        div()
            .id("paper-reader")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.editor)
            .child(self.header(cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("paper-reader-scroll")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .child(
                                div()
                                    .mx_auto()
                                    .max_w(px(720.))
                                    .px(px(32.))
                                    .pt(px(28.))
                                    .pb(px(64.))
                                    .child(body),
                            ),
                    )
                    .child(FluidScrollbar::vertical(
                        "paper-reader-scrollbar",
                        &self.scroll,
                    )),
            )
    }
}
