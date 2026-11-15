//! The paper's original PDF in its reader (`usePaperPdf` in
//! `src/canvas/use-paper-pdf.ts`): where it is (the bundle's own, else
//! arXiv's, alphaXiv's or a cited `.pdf`), fetched once from the web into a
//! file the viewer reads, shown in the text's place at the page a source
//! link asks for, and remembered for the paper (`paper-pdf-reading.ts`).

use std::collections::HashSet;

use gpui::{App, AppContext as _, Context, Entity, Focusable as _, Subscription, Task, Window};
use lattice_core::papers::PaperSummary;
use lattice_i18n::{n, t};
use lattice_ui::Icon;

use super::{PaperReader, ReaderView};
use crate::papers::model;
use crate::pdf::{PdfView, PdfViewEvent};

/// Where the paper's original PDF is (`paperPdfSource`).
#[derive(Clone, Debug, PartialEq)]
pub(super) enum PdfSource {
    /// The bundle's own, which the writer read and annotated.
    Local(String),
    /// arXiv's, alphaXiv's or a cited `.pdf` on the web.
    Remote(String),
}

pub(super) fn pdf_source(paper: &PaperSummary) -> Option<PdfSource> {
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
pub(super) fn browser_url(paper: &PaperSummary) -> Option<String> {
    model::pdf_url(paper).or_else(|| model::web_link(paper.url.as_deref()))
}

/// The papers last read as their PDF, by arXiv id (`paper-pdf-reading.ts`):
/// one opens on its PDF again.
#[derive(Default)]
struct PdfReading(HashSet<String>);

impl gpui::Global for PdfReading {}

/// The original PDF shown in the text's place.
pub(super) struct ShownPdf {
    pub(super) view: Entity<PdfView>,
    source: PdfSource,
    /// The 0-based page a source link asked for, shown once pages load.
    pending_page: Option<usize>,
    _loaded: Subscription,
    /// Still being fetched from the web.
    pub(super) loading: bool,
    pub(super) error: Option<gpui::SharedString>,
    _fetch: Option<Task<()>>,
    _events: Subscription,
}

impl PaperReader {
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
                        cache_pdf(&file, || lattice_core::paper_pdf_proxy::fetch_pdf(&url))
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
    pub(super) fn go_to_pdf_page(&mut self, page: usize, cx: &mut Context<Self>) {
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

    pub(super) fn close_pdf(&mut self, cx: &mut Context<Self>) {
        if self.pdf.take().is_some() {
            self.remember_pdf_reading(false, cx);
            cx.notify();
        }
    }
}

/// A file name for the PDF at `url`, the same for the same address.
fn pdf_cache_name(url: &str) -> String {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Leave a whole PDF at `file`: one already there is kept when it reads as
/// a PDF, else `fetch`'s bytes land under a name of their own and are moved
/// into place, so a reader never meets a half-written file.
fn cache_pdf(
    file: &std::path::Path,
    fetch: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    use std::io::Read as _;
    let mut head = [0u8; 5];
    if std::fs::File::open(file)
        .and_then(|mut cached| cached.read_exact(&mut head))
        .is_ok()
        && &head == b"%PDF-"
    {
        return Ok(());
    }
    let bytes = fetch()?;
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let partial = file.with_extension(format!("{}-{nanos}.part", std::process::id()));
    std::fs::write(&partial, bytes)
        .and_then(|()| std::fs::rename(&partial, file))
        .map_err(|error| {
            std::fs::remove_file(&partial).ok();
            error.to_string()
        })
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
            pdf_source(&paper(
                "web-1",
                Some("https://example.org/a/paper.PDF"),
                false
            )),
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

    // A download cut short leaves a file that is not a PDF: the next open
    // fetches again, and a whole PDF already cached is read without one.
    #[test]
    fn only_a_whole_pdf_is_read_from_the_cache() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("paper.pdf");
        std::fs::write(&file, b"%PD").unwrap();
        cache_pdf(&file, || Ok(b"%PDF-1.7 whole".to_vec())).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"%PDF-1.7 whole");
        cache_pdf(&file, || panic!("a cached PDF is fetched again")).unwrap();
        assert!(cache_pdf(&folder.path().join("none.pdf"), || Err("offline".into())).is_err());
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 1);
    }
}
