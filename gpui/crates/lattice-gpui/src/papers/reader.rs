//! A saved paper's reading surface (`src/canvas/paper-reader.tsx`,
//! `.paper-reader-*` in `editor-workspace.css`): the paper's tab, holding
//! its full text or its overview, or the original PDF in their place, under
//! a strip that names the paper.
//!
//! The texts are the bundle's own files (`paper.md`, `blog.md`), each the
//! shell's editor for that file (`editor_panel/paper_text.rs`), so a paper
//! reads in the Tauri app's visual editor in its reading form (KaTeX, the
//! figures, the heading rail, the masthead) and edits, saves and undoes as
//! the Tauri app's paper documents do; Edit, Split and Preview are the
//! editor's own, beside the Blog / Paper switch in the tab's strip
//! (`trellis-header-tools.tsx`). The shell makes each editor when the view
//! first asks for it ([`PaperReaderEvent::Show`]).
//!
//! The strip (`.paper-reader-header`) names the paper in one line: its
//! title, short authors and source, the title and authors left out while the
//! full text's own masthead is on screen. The source is the way out to the
//! original, so it is the browser action, its arrow showing only under the
//! pointer. Its actions: the original PDF, shown here in place of the text
//! (`usePaperPdf`: the bundle's own, else arXiv's, alphaXiv's or a cited
//! `.pdf`, fetched once), and a browser button when the paper has no source
//! label. A narrow strip folds the actions to icons, then drops the authors.

use std::{cell::Cell, collections::HashSet, path::PathBuf, rc::Rc};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_core::papers::PaperSummary;
use lattice_i18n::{join_phrases, n, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Menu, MenuAction, Segmented},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{model, row::tooltip};
use crate::editor_panel::{EditorPanel, EditorPanelEvent};
use crate::pdf::{PdfView, PdfViewEvent};
use crate::structured::{PaperPdfIdentity, PaperReading};

/// Which of the bundle's texts is on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReaderView {
    FullText,
    Overview,
}

impl ReaderView {
    pub fn file(self) -> &'static str {
        match self {
            ReaderView::FullText => "paper.md",
            ReaderView::Overview => "blog.md",
        }
    }

    fn name(self) -> &'static str {
        match self {
            ReaderView::FullText => t!("Paper"),
            ReaderView::Overview => t!("Blog"),
        }
    }
}

/// The reading file of `paper` in `view`, from the project root
/// (`paperDocumentPath`).
pub fn reading_path(arxiv_id: &str, view: ReaderView) -> String {
    format!(".research/papers/{arxiv_id}/{}", view.file())
}

/// The strip folds its actions to icons this narrow (`@container
/// paper-reader (max-width: 520px)`), and drops the authors at 440px.
const ICONS_ONLY_BELOW: f32 = 520.;
const NO_AUTHORS_BELOW: f32 = 440.;

pub enum PaperReaderEvent {
    /// The view asks for its text's editor: the shell makes it and hands it
    /// over with [`PaperReader::set_text`].
    Show(ReaderView),
}

/// Where the paper's original PDF is (`paperPdfSource`).
#[derive(Clone, Debug, PartialEq)]
enum PdfSource {
    /// The bundle's own, which the writer read and annotated.
    Local(String),
    /// arXiv's, alphaXiv's or a cited `.pdf` on the web.
    Remote(String),
}

fn pdf_source(paper: &PaperSummary) -> Option<PdfSource> {
    if paper.has_local_pdf {
        return Some(PdfSource::Local(format!(
            ".research/papers/{}/original.pdf",
            paper.arxiv_id
        )));
    }
    model::pdf_url(paper).map(PdfSource::Remote)
}

/// Where the source button opens the paper on the web (`paperBrowserUrl`):
/// its PDF there, else the page it was cited from.
fn browser_url(paper: &PaperSummary) -> Option<String> {
    model::pdf_url(paper).or_else(|| model::web_link(paper.url.as_deref()))
}

/// The papers last read as their PDF, by arXiv id (`paper-pdf-reading.ts`):
/// one opens on its PDF again.
#[derive(Default)]
struct PdfReading(HashSet<String>);

impl gpui::Global for PdfReading {}

/// The original PDF shown in the text's place.
struct ShownPdf {
    view: Entity<PdfView>,
    source: PdfSource,
    /// The 0-based page a source link asked for, shown once pages load.
    pending_page: Option<usize>,
    _loaded: Subscription,
    /// Still being fetched from the web.
    loading: bool,
    error: Option<SharedString>,
    _fetch: Option<Task<()>>,
    _events: Subscription,
}

pub struct PaperReader {
    root: PathBuf,
    paper: PaperSummary,
    view: ReaderView,
    texts: Vec<(ReaderView, Entity<EditorPanel>, Subscription)>,
    pdf: Option<ShownPdf>,
    /// The full text's masthead is on screen: the strip leaves out the title
    /// and authors it carries.
    masthead: bool,
    /// The strip's width as last drawn, for its narrow rules.
    width: Rc<Cell<Option<Pixels>>>,
    /// The tab is its group's displayed one. The text's editor shows its
    /// page only then, and only while no PDF stands in its place: the
    /// dock tells the reader, which tells the editor on screen.
    active: bool,
    focus: FocusHandle,
}

impl EventEmitter<PanelEvent> for PaperReader {}
impl EventEmitter<PaperReaderEvent> for PaperReader {}

impl PaperReader {
    pub fn new(root: PathBuf, paper: PaperSummary, view: ReaderView, cx: &mut Context<Self>) -> Self {
        Self {
            root,
            paper,
            view,
            texts: Vec::new(),
            pdf: None,
            masthead: false,
            width: Rc::default(),
            active: false,
            focus: cx.focus_handle(),
        }
    }

    pub fn paper(&self) -> &PaperSummary {
        &self.paper
    }

    pub fn view(&self) -> ReaderView {
        self.view
    }

    /// The reading file on screen, from the project root.
    pub fn path(&self) -> String {
        reading_path(&self.paper.arxiv_id, self.view)
    }

    /// The editor of the text on screen, once the shell has made it.
    pub fn editor(&self) -> Option<&Entity<EditorPanel>> {
        self.text_of(self.view)
    }

    fn text_of(&self, view: ReaderView) -> Option<&Entity<EditorPanel>> {
        self.texts
            .iter()
            .find(|(shown, ..)| *shown == view)
            .map(|(_, editor, _)| editor)
    }

    /// Every text's editor the reader holds.
    pub fn editors(&self) -> impl Iterator<Item = &Entity<EditorPanel>> {
        self.texts.iter().map(|(_, editor, _)| editor)
    }

    /// The text on screen, as its editor holds it (for scenarios and the
    /// Agent's context).
    pub fn text(&self, cx: &App) -> Option<String> {
        self.editor().map(|editor| editor.read(cx).text(cx))
    }

    /// Whether the original PDF is shown in the text's place.
    pub fn showing_pdf(&self) -> bool {
        self.pdf.is_some()
    }

    /// The pages of the PDF shown, once it has loaded (for scenarios).
    pub fn pdf_pages(&self, cx: &App) -> usize {
        self.pdf
            .as_ref()
            .map_or(0, |pdf| pdf.view.read(cx).page_count())
    }

    fn reading(&self, view: ReaderView) -> PaperReading {
        PaperReading {
            title: self.paper.title.clone(),
            // `paperAuthorNames(...).join(", ")`: the whole list.
            authors: Some(model::author_names(&self.paper).join(", "))
                .filter(|names| !names.is_empty()),
            full_text: view == ReaderView::FullText,
            pdf: pdf_source(&self.paper).map(|_| PaperPdfIdentity {
                arxiv_id: self.paper.arxiv_id.clone(),
                url: self.paper.url.clone(),
                has_local_pdf: self.paper.has_local_pdf,
            }),
        }
    }

    /// The shell made `view`'s editor: it reads as the paper's text.
    pub fn set_text(
        &mut self,
        view: ReaderView,
        editor: Entity<EditorPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let reading = self.reading(view);
        editor.update(cx, |editor, cx| editor.set_paper_reading(Some(reading), cx));
        let subscription = cx.subscribe_in(&editor, window, move |this, _, event, window, cx| {
            match event {
                EditorPanelEvent::Masthead(in_view)
                    if this.view == view && this.masthead != *in_view =>
                {
                    this.masthead = *in_view;
                    cx.notify();
                }
                EditorPanelEvent::PaperSource(page) => {
                    this.open_pdf(window, cx);
                    this.go_to_pdf_page(*page as usize, cx);
                }
                _ => {}
            }
        });
        self.texts.retain(|(shown, ..)| *shown != view);
        self.texts.push((view, editor, subscription));
        self.sync_shown(window, cx);
        cx.notify();
    }

    /// Tell each text's editor whether it is on screen: the one in view,
    /// while the tab is displayed and no PDF stands in its place.
    fn sync_shown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let shown = self.active && self.pdf.is_none();
        let texts: Vec<_> = self
            .texts
            .iter()
            .map(|(view, editor, _)| (*view == self.view && shown, editor.clone()))
            .collect();
        for (on_screen, editor) in texts {
            editor.update(cx, |editor, cx| BasePanel::set_active(editor, on_screen, window, cx));
        }
    }

    /// Show `view` (the full text or the overview): the writer chose its
    /// text, so the paper is no longer read as its PDF.
    pub fn show(&mut self, view: ReaderView, window: &mut Window, cx: &mut Context<Self>) {
        self.close_pdf(cx);
        if self.view != view {
            self.view = view;
            self.masthead = false;
        }
        self.sync_shown(window, cx);
        if self.editor().is_none() {
            cx.emit(PaperReaderEvent::Show(view));
        }
        if let Some(editor) = self.editor() {
            window.focus(&editor.focus_handle(cx), cx);
        }
        cx.notify();
    }

    /// The paper as the library lists it now (a refreshed record): the
    /// texts' mastheads follow, and a download that left a full text where
    /// only the overview was opens it.
    pub fn set_paper(&mut self, paper: PaperSummary, window: &mut Window, cx: &mut Context<Self>) {
        let gained_text = paper.has_full_text && !self.paper.has_full_text;
        self.paper = paper;
        let readings: Vec<_> = self
            .texts
            .iter()
            .map(|(view, editor, _)| (editor.clone(), self.reading(*view)))
            .collect();
        for (editor, reading) in readings {
            editor.update(cx, |editor, cx| editor.set_paper_reading(Some(reading), cx));
        }
        if gained_text {
            self.show(ReaderView::FullText, window, cx);
        }
        cx.notify();
    }

    /// Open the paper on its PDF when it was last read that way.
    pub fn resume_pdf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let read_as_pdf = cx
            .try_global::<PdfReading>()
            .is_some_and(|reading| reading.0.contains(&self.paper.arxiv_id));
        if read_as_pdf && pdf_source(&self.paper).is_some() {
            self.open_pdf(window, cx);
        }
    }

    fn remember_pdf_reading(&self, reading: bool, cx: &mut App) {
        let id = self.paper.arxiv_id.clone();
        let readings = &mut cx.default_global::<PdfReading>().0;
        if reading {
            readings.insert(id);
        } else {
            readings.remove(&id);
        }
    }

    /// Show the original PDF in the text's place.
    pub fn open_pdf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(source) = pdf_source(&self.paper) else {
            return;
        };
        self.remember_pdf_reading(true, cx);
        if self.pdf.as_ref().is_some_and(|pdf| pdf.source == source) {
            return;
        }
        // The way back names the text it returns to (`Back to {view}`).
        let back = match self.view {
            ReaderView::FullText => n!("Back to Paper"),
            ReaderView::Overview => n!("Back to Blog"),
        };
        let view = cx.new(|cx| {
            let mut view = PdfView::new(window, cx);
            view.set_build(false, false, cx);
            view.set_action(
                Some(crate::pdf::ToolbarAction {
                    label: back,
                    icon: Icon::ARROW_LEFT,
                }),
                cx,
            );
            view
        });
        let events = cx.subscribe_in(&view, window, |this, _, event, window, cx| {
            if let PdfViewEvent::Action = event {
                this.show(this.view, window, cx);
            }
        });
        // A page asked for before the pages had loaded is shown once they
        // have.
        let loaded = cx.observe(&view, |this, view, cx| {
            let Some(pdf) = this.pdf.as_mut().filter(|pdf| pdf.view == view) else {
                return;
            };
            if let Some(page) = pdf.pending_page
                && view.read(cx).page_count() > page
            {
                pdf.pending_page = None;
                view.update(cx, |view, cx| view.go_to_page(page, cx));
            }
        });
        let mut shown = ShownPdf {
            view: view.clone(),
            source: source.clone(),
            pending_page: None,
            _loaded: loaded,
            loading: false,
            error: None,
            _fetch: None,
            _events: events,
        };
        match &source {
            PdfSource::Local(relative) => {
                let path = self.root.join(relative);
                view.update(cx, |view, cx| view.open(path, window, cx));
            }
            PdfSource::Remote(url) => {
                shown.loading = true;
                shown._fetch = Some(self.fetch_pdf(url.clone(), view, window, cx));
            }
        }
        self.pdf = Some(shown);
        self.sync_shown(window, cx);
        window.focus(&self.focus_handle(cx), cx);
        cx.notify();
    }

    /// Fetch the PDF on the web once, into a file the viewer reads.
    fn fetch_pdf(
        &self,
        url: String,
        view: Entity<PdfView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let file = std::env::temp_dir()
            .join("lattice-gpui-paper-pdfs")
            .join(format!("{}.pdf", pdf_cache_name(&url)));
        cx.spawn_in(window, async move |this, cx| {
            let fetched = cx
                .background_spawn({
                    let file = file.clone();
                    async move {
                        if file.is_file() {
                            return Ok(());
                        }
                        let bytes = lattice_core::paper_pdf_proxy::fetch_pdf(&url)?;
                        if let Some(folder) = file.parent() {
                            std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
                        }
                        std::fs::write(&file, bytes).map_err(|error| error.to_string())
                    }
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                let Some(pdf) = this.pdf.as_mut().filter(|pdf| pdf.view == view) else {
                    return;
                };
                pdf.loading = false;
                match fetched {
                    Ok(()) => view.update(cx, |view, cx| view.open(file, window, cx)),
                    Err(error) => {
                        log::warn!("paper PDF: {error}");
                        pdf.error = Some(t!("Could not load PDF").into());
                    }
                }
                cx.notify();
            })
            .ok();
        })
    }

    /// Show the 1-based `page` of the PDF shown (`openPdf({ page })`).
    fn go_to_pdf_page(&mut self, page: usize, cx: &mut Context<Self>) {
        let Some(pdf) = &mut self.pdf else {
            return;
        };
        let page = page.saturating_sub(1);
        if pdf.view.read(cx).page_count() > page {
            pdf.view.update(cx, |view, cx| view.go_to_page(page, cx));
        } else {
            pdf.pending_page = Some(page);
        }
    }

    fn close_pdf(&mut self, cx: &mut Context<Self>) {
        if self.pdf.take().is_some() {
            self.remember_pdf_reading(false, cx);
            cx.notify();
        }
    }

    /// Open the paper on the web.
    fn open_in_browser(&self, cx: &mut App) {
        if let Some(url) = browser_url(&self.paper) {
            model::open_link(&url, cx);
        }
    }

    /// The tooltip of the way out to the web (`browserActionLabel`): a PDF
    /// shown here from the web opens there; otherwise the article's page.
    fn browser_label(&self) -> &'static str {
        match pdf_source(&self.paper) {
            Some(PdfSource::Remote(_)) => t!("Open PDF in browser"),
            _ => t!("Open article in browser"),
        }
    }

    /// Blog and Paper, in the tab strip as the Tauri header has them
    /// (`trellis-header-tools.tsx`), before the text's own Edit, Split and
    /// Preview. A paper with one text keeps the switch's room, unpressable.
    fn content_switch(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let both = self.paper.has_full_text && self.paper.has_blog;
        let view = self.view;
        let this = cx.entity().downgrade();
        let choice = |shown: ReaderView| {
            let this = this.clone();
            move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
                this.update(cx, |reader, cx| reader.show(shown, window, cx)).ok();
            }
        };
        let switch = Segmented::new("paper-reader-view")
            .parity("paper/content")
            .icon_choice(
                Icon::NEWSPAPER,
                ReaderView::Overview.name(),
                view == ReaderView::Overview,
                choice(ReaderView::Overview),
            )
            .icon_choice(
                Icon::FILE_TEXT,
                ReaderView::FullText.name(),
                view == ReaderView::FullText,
                choice(ReaderView::FullText),
            );
        let modes = (self.pdf.is_none())
            .then(|| self.editor().cloned())
            .flatten()
            .and_then(|editor| editor.update(cx, |editor, cx| editor.view_switch_element(window, cx)));
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(div().when(!both, |slot| slot.invisible()).child(switch))
            .children(modes)
            .into_any_element()
    }

    /// The panel menu's leading items: Blog and Paper, then the text's own.
    pub fn panel_menu(reader: &Entity<Self>, menu: Menu, cx: &App) -> Menu {
        let this = reader.read(cx);
        let mut menu = menu;
        if this.paper.has_full_text && this.paper.has_blog {
            for view in [ReaderView::Overview, ReaderView::FullText] {
                let reader = reader.downgrade();
                menu = menu.item(
                    MenuAction::new(view.name(), move |window, cx| {
                        reader
                            .update(cx, |reader, cx| reader.show(view, window, cx))
                            .ok();
                    })
                    .checked(this.view == view),
                );
            }
            menu = menu.separator();
        }
        match this.editor() {
            Some(editor) if this.pdf.is_none() => editor.read(cx).panel_menu(menu, cx),
            _ => menu,
        }
    }

    /// The strip over the text: the paper's identity and its actions.
    fn header(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let palette = cx.palette().clone();
        let width = self.width.get().map_or(f32::MAX, f32::from);
        let icons_only = width < ICONS_ONLY_BELOW;
        let source = model::source_label(&self.paper);
        let browser = browser_url(&self.paper).is_some();
        let authors = (!self.masthead && width >= NO_AUTHORS_BELOW)
            .then(|| model::short_authors(&self.paper))
            .flatten();
        let browser_label = self.browser_label();
        let pdf_source = pdf_source(&self.paper);
        let pdf_open = self.pdf.is_some();
        let separator = || {
            div()
                .flex_none()
                .mx(px(6.))
                .text_color(palette.text_secondary)
                .child("\u{00a0}")
        };
        let mut identity = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_baseline()
            .whitespace_nowrap()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary);
        let mut parts = 0;
        if !self.masthead {
            identity = identity.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_role(TextRole::BodyCompact, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text)
                    .child(self.paper.title.clone()),
            );
            parts += 1;
        }
        if let Some(authors) = authors {
            if parts > 0 {
                identity = identity.child(separator());
            }
            identity = identity.child(
                div()
                    .flex_none()
                    .max_w(relative_width(width, 0.3))
                    .truncate()
                    .text_color(palette.text_secondary)
                    .child(authors),
            );
            parts += 1;
        }
        if let Some(source) = source.clone() {
            if parts > 0 {
                identity = identity.child(separator());
            }
            let label = join_phrases(&[source.as_str(), browser_label]);
            let ink = palette.text_secondary;
            let hover_ink = palette.text;
            identity = identity.child(
                div()
                    .id("paper-reader-source")
                    .group("paper-reader-source")
                    .flex()
                    .flex_none()
                    .min_w(px(40.))
                    .max_w(relative_width(width, 0.4))
                    .items_baseline()
                    .text_color(ink)
                    .child(div().min_w_0().truncate().child(source))
                    .when(browser, |source| {
                        source
                            .cursor_pointer()
                            .hover(move |style| style.text_color(hover_ink))
                            .tooltip(tooltip(label))
                            .on_click(cx.listener(|this, _, _, cx| this.open_in_browser(cx)))
                            .child(
                                // The arrow shows only under the pointer: the
                                // source reads as text until pointed at.
                                div()
                                    .flex_none()
                                    .self_center()
                                    .ml(px(2.))
                                    .invisible()
                                    .group_hover("paper-reader-source", |style| style.visible())
                                    .child(Icon::EXTERNAL_LINK.element(px(11.), hover_ink)),
                            )
                    }),
            );
        }
        let action = |id: &'static str| {
            div()
                .id(id)
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .gap(px(4.))
                .min_w(px(24.))
                .h(px(24.))
                .px(if icons_only { px(0.) } else { px(8.) })
                .rounded(px(6.))
                .text_role(TextRole::Micro, cx)
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(palette.text_secondary)
                .cursor_pointer()
                .hover(|style| style.bg(palette.hover).text_color(palette.text))
        };
        let width_cell = self.width.clone();
        div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_end()
            .gap(px(16.))
            .min_h(px(40.))
            .pl(px(16.))
            .pr(px(10.))
            .border_b_1()
            .border_color(palette.line)
            .child(
                canvas(
                    move |bounds, _, _| width_cell.set(Some(bounds.size.width)),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(identity)
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_end()
                    .gap(px(4.))
                    .when_some(pdf_source, |actions, _| {
                        actions.child(
                            action("paper-reader-pdf")
                                .when(pdf_open, |button| {
                                    button.bg(palette.hover).text_color(palette.text)
                                })
                                .tooltip(tooltip(t!("View original PDF")))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if this.pdf.is_some() {
                                        let view = this.view;
                                        this.show(view, window, cx);
                                    } else {
                                        this.open_pdf(window, cx);
                                    }
                                }))
                                .child(Icon::FILE_TEXT.element(px(14.), palette.text_secondary))
                                .when(!icons_only, |button| button.child(t!("PDF"))),
                        )
                    })
                    .when(source.is_none() && browser, |actions| {
                        actions.child(
                            action("paper-reader-browser")
                                .w(px(24.))
                                .px(px(0.))
                                .tooltip(tooltip(browser_label))
                                .on_click(cx.listener(|this, _, _, cx| this.open_in_browser(cx)))
                                .child(Icon::EXTERNAL_LINK.element(px(14.), palette.text_secondary)),
                        )
                    }),
            )
    }

    fn body(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let placeholder = |text: SharedString| {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .text_role(TextRole::Body, cx)
                .text_color(palette.text_secondary)
                .child(Icon::FILE_TEXT.element(px(28.), palette.text_secondary))
                .child(text)
                .into_any_element()
        };
        if let Some(pdf) = &self.pdf {
            if let Some(error) = &pdf.error {
                return placeholder(error.clone());
            }
            if pdf.loading {
                return placeholder(t!("Loading PDF…").into());
            }
            return div()
                .flex_1()
                .min_h_0()
                .child(pdf.view.clone())
                .into_any_element();
        }
        match self.editor() {
            Some(editor) => div()
                .flex_1()
                .min_h_0()
                .child(editor.clone())
                .into_any_element(),
            None => div().flex_1().into_any_element(),
        }
    }
}

/// `fraction` of the strip's width, or no cap before it has been drawn.
fn relative_width(width: f32, fraction: f32) -> Pixels {
    if width == f32::MAX {
        px(f32::MAX)
    } else {
        px(width * fraction)
    }
}

/// A file name for the PDF at `url`, the same for the same address.
fn pdf_cache_name(url: &str) -> String {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

impl Focusable for PaperReader {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        if let Some(pdf) = &self.pdf {
            return pdf.view.focus_handle(cx);
        }
        match self.editor() {
            Some(editor) => editor.focus_handle(cx),
            None => self.focus.clone(),
        }
    }
}

impl BasePanel for PaperReader {
    fn panel_name(&self) -> &'static str {
        "PaperReader"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }

    fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.active = active;
        self.sync_shown(window, cx);
    }

    /// The tab left the dock: each text saves what it holds first, as its
    /// own tab would.
    fn on_removed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.active = false;
        let editors: Vec<_> = self.editors().cloned().collect();
        for editor in editors {
            editor.update(cx, |editor, cx| BasePanel::on_removed(editor, window, cx));
        }
    }
}

impl Panel for PaperReader {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(self.paper.title.clone().into())
    }

    fn title(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match self.editor() {
            Some(editor) if editor.read(cx).is_dirty(cx) => format!("{} •", self.paper.title),
            _ => self.paper.title.clone(),
        }
    }

    fn title_suffix(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        Some(self.content_switch(window, cx))
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for PaperReader {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let header = self.header(cx);
        let body = self.body(cx);
        div()
            .id("paper-reader")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(palette.editor)
            .child(header)
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paper(arxiv_id: &str, url: Option<&str>, local: bool) -> PaperSummary {
        let mut paper = crate::papers::model::test_support::paper("A paper");
        paper.arxiv_id = arxiv_id.into();
        paper.url = url.map(str::to_string);
        paper.has_local_pdf = local;
        paper
    }

    // `paperPdfSource` (src/canvas/use-paper-pdf.ts): the bundle's own PDF
    // first, then arXiv's, then a cited `.pdf`; a page that is not a PDF has
    // none.
    #[test]
    fn the_original_pdf_is_the_bundles_then_the_webs() {
        assert_eq!(
            pdf_source(&paper("1706.03762", None, true)),
            Some(PdfSource::Local(
                ".research/papers/1706.03762/original.pdf".into()
            ))
        );
        assert_eq!(
            pdf_source(&paper("1706.03762", None, false)),
            Some(PdfSource::Remote("https://arxiv.org/pdf/1706.03762".into()))
        );
        assert_eq!(
            pdf_source(&paper("web-1", Some("https://example.org/a/paper.PDF"), false)),
            Some(PdfSource::Remote("https://example.org/a/paper.PDF".into()))
        );
        assert_eq!(
            pdf_source(&paper("web-2", Some("https://example.org/post"), false)),
            None
        );
    }

    // `paperBrowserUrl`: the PDF on the web first, else the cited page.
    #[test]
    fn the_browser_opens_the_pdf_on_the_web_else_the_page() {
        assert_eq!(
            browser_url(&paper("1706.03762", Some("https://example.org/post"), true)).as_deref(),
            Some("https://arxiv.org/pdf/1706.03762")
        );
        assert_eq!(
            browser_url(&paper("web-2", Some("https://example.org/post"), false)).as_deref(),
            Some("https://example.org/post")
        );
        assert_eq!(browser_url(&paper("web-3", None, false)), None);
    }

    #[test]
    fn a_reading_file_is_named_by_its_view() {
        assert_eq!(
            reading_path("1706.03762", ReaderView::FullText),
            ".research/papers/1706.03762/paper.md"
        );
        assert_eq!(
            reading_path("hep-th/9901001", ReaderView::Overview),
            ".research/papers/hep-th/9901001/blog.md"
        );
    }
}
