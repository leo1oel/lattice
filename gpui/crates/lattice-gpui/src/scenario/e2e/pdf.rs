//! The e2e checks of the PDF viewer, on a second root document the scenario
//! writes into the project: twelve pages with a section link, a web link,
//! links to a file and to an app's own scheme, and a word to find on four of
//! them.
//!
//! Building it makes it the live PDF and gives main.tex a tab of its own
//! with its last PDF; then the outline (its heading lines past a comment
//! block of wide characters), the viewer's page navigation, zoom and fit,
//! find, a link followed with a native click and undone with Back (and the
//! file and app-scheme links left unfollowed), a selection
//! dragged with the native mouse and copied with ⌘C / Ctrl+C, dark pages, a
//! rebuild that changes one page and redraws only that one, the page window
//! letting go of pages far from the screen, and the separate window. Building
//! main.tex again trades the two tabs back.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{App, AsyncApp, Entity, Focusable as _};
use serde_json::json;

use super::Steps;
use crate::{
    native,
    pdf::{FindOptions, FitMode, LinkTarget, PdfView},
    scenario::Run,
};

/// Twelve pages: a link to section 9, a web link, and a link to a file and
/// one to an app's own scheme (neither may open) on the first, the word
/// "zebracorn" on pages 2, 4 and 6 and "zebracorns" on page 8, and a
/// sentence on page 10 the rebuild check rewrites with the same letters.
/// Before the first heading, a comment block pdfLaTeX skips: it hides a
/// heading from the outline, and its wide characters (three bytes each) must
/// not move the lines of the headings after it.
const SUPPLEMENT: &str = r"\documentclass{article}
\usepackage{hyperref}
\usepackage{verbatim}
\begin{document}
\begin{comment}
中文注释：这一段不会排版，大纲也不读它。
\section{Hidden}
\end{comment}
\section{Overview}
Selectable sentence here. See Section~\ref{sec:target} and \url{https://example.org}.
Never opened: \href{file:///System/Applications/Calculator.app}{Fileanchor} and \href{lattice-test://x}{Schemeanchor}.
\newpage
\section{Two} A zebracorn appears.
\newpage
\section{Three} Plain text.
\newpage
\section{Four} Another zebracorn appears.
\newpage
\section{Five} Plain text.
\newpage
\section{Six} A third zebracorn appears.
\newpage
\section{Seven} Plain text.
\newpage
\section{Eight} Many zebracorns appear.
\newpage
\section{Target}\label{sec:target} The link lands here.
\newpage
\section{Ten} Swap target ten.
\newpage
\section{Eleven} Plain text.
\newpage
\section{Twelve} The end.
\end{document}
";

impl Run {
    fn live_view(&self, cx: &mut AsyncApp) -> Entity<PdfView> {
        cx.update(|cx| self.live_view_of(cx))
    }

    fn live_view_of(&self, cx: &App) -> Entity<PdfView> {
        self.shell.read(cx).pdf().read(cx).live_view().clone()
    }

    fn with_view<R>(
        &self,
        cx: &mut AsyncApp,
        f: impl FnOnce(&mut PdfView, &mut gpui::Window, &mut gpui::Context<PdfView>) -> R,
    ) -> Result<R> {
        let view = self.live_view(cx);
        self.with_window(cx, move |_, window, cx| {
            view.update(cx, |view, cx| f(view, window, cx))
        })
    }

    async fn wait_view(
        &self,
        cx: &mut AsyncApp,
        seconds: u64,
        mut done: impl FnMut(&PdfView, &App) -> bool,
    ) -> bool {
        self.wait_for(cx, Duration::from_secs(seconds), |shell, cx| {
            let view = shell.read(cx).pdf().read(cx).live_view().clone();
            done(view.read(cx), cx)
        })
        .await
    }

    pub(super) async fn pdf_viewer(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let supplement = root.join("supplement.tex");
        std::fs::write(&supplement, SUPPLEMENT)?;
        self.open(cx, &supplement, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (built, _) = self.build(cx).await?;
        let shown = self
            .wait_view(cx, 30, |view, _| view.page_count() == 12)
            .await;
        let tabs = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                shell
                    .read(cx)
                    .root_pdf_tabs()
                    .iter()
                    .any(|(document, panel)| {
                        document == "main.tex"
                            && panel.read(cx).live_view().read(cx).page_count() > 0
                    })
            })
            .await;
        let live = cx.update(|cx| self.shell.read(cx).live_document().map(str::to_string));
        steps.check(
            "a second root document's build shows its PDF, and main.tex keeps its last PDF in a tab of its own",
            built && shown && tabs && live.as_deref() == Some("supplement.tex"),
            json!({ "built": built, "pages": shown, "main_tab": tabs, "live": live }),
        );

        self.outline(cx, steps).await?;
        self.navigation_and_zoom(cx, steps).await?;
        self.find_in_pdf(cx, steps).await?;
        self.page_draft(cx, steps).await?;
        self.links_and_back(cx, steps).await?;
        self.select_and_copy(cx, steps).await?;
        self.dark_pages(cx, steps).await?;
        self.page_swap(cx, steps, &supplement).await?;
        self.page_window(cx, steps).await?;
        self.separate_window(cx, steps).await?;

        // main.tex built again: the two trade places back.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (built, _) = self.build(cx).await?;
        let traded = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                let shell = shell.read(cx);
                let tabs = shell.root_pdf_tabs();
                shell.live_document() == Some("main.tex")
                    && tabs
                        .iter()
                        .any(|(document, _)| document == "supplement.tex")
                    && !tabs.iter().any(|(document, _)| document == "main.tex")
                    && shell.pdf().read(cx).page_count(cx) == 1
            })
            .await;
        steps.check(
            "building main.tex again makes it the live PDF and gives the supplement its own tab",
            built && traded,
            json!({ "built": built }),
        );
        Ok(())
    }

    /// The live document's outline, and an Outline row that opens its line
    /// and marks its place in the PDF.
    async fn outline(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let read = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let shell = shell.read(cx);
                shell.outline().len() == 12
                    && shell
                        .outline()
                        .iter()
                        .any(|heading| heading.title == "Target")
                    && shell.pdf().read(cx).live_view().read(cx).has_outline()
            })
            .await;
        let target = cx.update(|cx| {
            self.shell
                .read(cx)
                .outline()
                .iter()
                .find(|heading| heading.title == "Target")
                .cloned()
        });
        let mut marked = false;
        if let Some(target) = &target {
            let (path, line) = (target.path.clone(), target.line);
            self.with_view(cx, move |_, _, cx| {
                cx.emit(crate::pdf::PdfViewEvent::Outline { path, line })
            })?;
            marked = self
                .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                    let shell = shell.read(cx);
                    shell.active_editor_path(cx).as_deref() == Some("supplement.tex")
                        && shell
                            .pdf()
                            .read(cx)
                            .sync_mark(cx)
                            .is_some_and(|(page, scroll)| page == 8 && !scroll)
                })
                .await;
        }
        steps.check(
            "PDF: the Outline lists the headings, and a row opens its line and marks it in the PDF",
            read && marked,
            json!({ "target": target.map(|heading| heading.line), "marked": marked }),
        );

        // Each heading's line is the line of its `\section` in the source
        // the scenario wrote; the one inside the comment block is not listed.
        let expected: Vec<(String, u32)> = SUPPLEMENT
            .lines()
            .zip(1..)
            .filter_map(|(text, line)| {
                let title = text.strip_prefix("\\section{")?.split('}').next()?;
                (title != "Hidden").then(|| (title.to_string(), line))
            })
            .collect();
        let listed: Vec<(String, u32)> = cx.update(|cx| {
            self.shell
                .read(cx)
                .outline()
                .iter()
                .filter(|heading| heading.path == "supplement.tex")
                .map(|heading| (heading.title.clone(), heading.line))
                .collect()
        });
        steps.check(
            "PDF: a comment block of wide characters before the headings hides its own heading and keeps every heading's line",
            expected.len() == 12 && listed == expected,
            json!({ "expected": expected, "listed": listed }),
        );
        Ok(())
    }

    async fn navigation_and_zoom(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.go_to_page(0, cx))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.with_view(cx, |view, _, cx| view.step_page(1, cx))?;
        let next = self
            .wait_view(cx, 5, |view, _| view.current_page() == 1)
            .await;
        self.with_view(cx, |view, _, cx| view.go_to_page(6, cx))?;
        let jumped = self
            .wait_view(cx, 5, |view, _| view.current_page() == 6)
            .await;
        steps.check(
            "PDF: Next page and a page jump move the view",
            next && jumped,
            json!({ "page": cx.update(|cx| self.live_view_of(cx).read(cx).current_page()) }),
        );

        let (fit, fitted) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        self.with_view(cx, |view, _, cx| view.step_zoom(1., cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (zoom_fit, zoomed) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        self.with_view(cx, |view, _, cx| view.toggle_fit(FitMode::Height, cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (height_fit, height_scale) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        self.with_view(cx, |view, _, cx| view.toggle_fit(FitMode::Width, cx))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (back_fit, back_scale) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.fit(), view.scale())
        });
        // A zoom step is a tenth from the scale rounded to one decimal.
        let step = ((fitted + 0.1) * 10.).round() / 10.;
        steps.check(
            "PDF: a zoom step leaves the fit, the height fit shows the whole page, and the width fit comes back",
            fit == Some(FitMode::Width)
                && zoom_fit.is_none()
                && (zoomed - step).abs() < 0.001
                && height_fit == Some(FitMode::Height)
                && height_scale <= fitted + 0.001
                && back_fit == Some(FitMode::Width)
                && (back_scale - fitted).abs() < 0.01,
            json!({ "fitted": fitted, "zoomed": zoomed, "height": height_scale, "back": back_scale }),
        );
        Ok(())
    }

    /// Find in PDF with the keys: ⌘F / Ctrl+F on the pages focuses the
    /// field, the query is typed, Enter steps to the next match, Escape
    /// clears it and a second Escape goes back to the pages.
    async fn find_in_pdf(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, window, cx| {
            view.go_to_page(0, cx);
            window.focus(&view.focus_handle(cx), cx);
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.press(cx, 'f', true).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.type_text(cx, "zebracorn").await?;
        let found = self
            .wait_view(cx, 20, |view, _| {
                let (total, _, pending) = view.find_matches();
                !pending && total == 4 && view.find_query() == "zebracorn"
            })
            .await;
        let landed = self
            .wait_view(cx, 5, |view, _| view.current_page() == 1)
            .await;
        self.press(cx, '\n', false).await?;
        let next = self
            .wait_view(cx, 5, |view, _| {
                view.find_matches().1 == Some(1) && view.current_page() == 3
            })
            .await;
        self.with_view(cx, |view, _, cx| {
            view.set_find_options(
                FindOptions {
                    match_case: false,
                    whole_word: true,
                },
                cx,
            )
        })?;
        let words = self
            .wait_view(cx, 20, |view, _| {
                let (total, _, pending) = view.find_matches();
                !pending && total == 3
            })
            .await;
        let counter = cx.update(|cx| self.live_view_of(cx).read(cx).find_matches());
        self.press(cx, '\u{1b}', false).await?;
        let cleared = self
            .wait_view(cx, 5, |view, _| {
                view.find_query().is_empty() && view.find_matches().0 == 0
            })
            .await;
        steps.check(
            "PDF: ⌘F / Ctrl+F and typing find the matches, Enter moves to the next, Whole word drops \"zebracorns\", Escape clears",
            found && landed && next && words && cleared,
            json!({ "found": found, "landed": landed, "next": next, "words": words, "cleared": cleared, "matches": counter.0, "current": counter.1 }),
        );
        self.with_view(cx, |view, window, cx| {
            view.set_find_options(FindOptions::default(), cx);
            view.clear_find(window, cx);
        })?;
        Ok(())
    }

    /// The page value: clicked, a number typed and Enter goes there; Escape
    /// drops a draft.
    async fn page_draft(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, window, cx| {
            view.edit_draft_to(false, "7", window, cx)
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.press(cx, '\n', false).await?;
        let went = self
            .wait_view(cx, 5, |view, _| view.current_page() == 6)
            .await;
        self.with_view(cx, |view, window, cx| {
            view.edit_draft_to(false, "2", window, cx)
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let stayed = cx.update(|cx| self.live_view_of(cx).read(cx).current_page()) == 6;
        steps.check(
            "PDF: a page number typed into the page value and Enter go there, and Escape drops a draft",
            went && stayed,
            json!({ "went": went, "stayed": stayed }),
        );
        Ok(())
    }

    async fn links_and_back(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.go_to_page(0, cx))?;
        let read = self
            .wait_view(cx, 10, |view, _| {
                view.links(0).is_some_and(|links| links.len() >= 2)
            })
            .await;
        let links = cx.update(|cx| self.live_view_of(cx).read(cx).links(0).unwrap_or_default());
        let internal = links
            .iter()
            .find(|link| matches!(link.target, LinkTarget::Page { page: 8, .. }))
            .cloned();
        let web = links
            .iter()
            .any(|link| matches!(&link.target, LinkTarget::Uri(uri) if uri.starts_with("https://example.org")));
        let mut followed = false;
        let mut back = false;
        if let Some(link) = &internal {
            let center = cx
                .update(|cx| {
                    self.live_view_of(cx).read(cx).window_point(
                        0,
                        (link.x0 + link.x1) / 2.,
                        (link.y0 + link.y1) / 2.,
                    )
                })
                .context("the link is not on screen")?;
            let native = self.native(cx)?;
            native::send_mouse(native, native::Mouse::Down, center)?;
            super::super::sleep(cx, Duration::from_millis(40)).await;
            native::send_mouse(native, native::Mouse::Up, center)?;
            followed = self
                .wait_view(cx, 5, |view, _| {
                    view.current_page() == 8 && view.can_go_back()
                })
                .await;
            self.with_view(cx, |view, _, cx| view.navigate(false, cx))?;
            back = self
                .wait_view(cx, 5, |view, _| {
                    view.current_page() == 0 && view.can_go_forward()
                })
                .await;
        }
        steps.check(
            "PDF: a click on a section link jumps to it, Back returns, and the web link is read",
            read && followed && back && web,
            json!({ "links": links.len(), "followed": followed, "back": back, "web": web }),
        );

        // The file link and the app-scheme link are on the page, but no
        // link the viewer would follow covers their words.
        let text = cx
            .update(|cx| self.live_view_of(cx).read(cx).page_text(0))
            .context("page 1's text was not read")?;
        let chars: String = text.chars.iter().map(|ch| ch.ch).collect();
        let covered = |anchor: &str| {
            let index = chars.find(anchor)?;
            let first = text.chars[chars[..index].chars().count()];
            let (x, y) = ((first.x0 + first.x1) / 2., (first.y0 + first.y1) / 2.);
            Some(
                text.links
                    .iter()
                    .any(|link| link.x0 <= x && x <= link.x1 && link.y0 <= y && y <= link.y1),
            )
        };
        let (file, scheme) = (covered("Fileanchor"), covered("Schemeanchor"));
        let launchers: Vec<String> = text
            .links
            .iter()
            .filter_map(|link| match &link.target {
                LinkTarget::Uri(uri) if !uri.starts_with("https://") => Some(uri.clone()),
                _ => None,
            })
            .collect();
        steps.check(
            "PDF: a link to a file or to an app's own scheme is not followed",
            file == Some(false) && scheme == Some(false) && launchers.is_empty(),
            json!({ "file_covered": file, "scheme_covered": scheme, "other_uris": launchers }),
        );
        Ok(())
    }

    async fn select_and_copy(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let text = cx
            .update(|cx| self.live_view_of(cx).read(cx).page_text(0))
            .context("page 1's text was not read")?;
        let chars: String = text.chars.iter().map(|ch| ch.ch).collect();
        let sentence = "Selectable sentence here.";
        let start = chars
            .find(sentence)
            .map(|byte| chars[..byte].chars().count())
            .context("the sentence is not on page 1")?;
        let end = start + sentence.chars().count() - 1;
        let (first, last) = (text.chars[start], text.chars[end]);
        let points = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (
                view.window_point(0, first.x0 + 0.5, (first.y0 + first.y1) / 2.),
                view.window_point(0, last.x1 - 0.5, (last.y0 + last.y1) / 2.),
            )
        });
        let (Some(from), Some(to)) = points else {
            steps.check(
                "PDF: a drag selects text and ⌘C copies it",
                false,
                json!({}),
            );
            return Ok(());
        };
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Down, from)?;
        super::super::sleep(cx, Duration::from_millis(40)).await;
        for step in 1..=8 {
            let t = step as f32 / 8.;
            let point = gpui::point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            native::send_mouse(native, native::Mouse::Dragged, point)?;
            super::super::sleep(cx, Duration::from_millis(20)).await;
        }
        native::send_mouse(native, native::Mouse::Up, to)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let selected = cx.update(|cx| self.live_view_of(cx).read(cx).has_selection());
        self.press(cx, 'c', true).await?;
        let copied = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                cx.read_from_clipboard()
                    .and_then(|item| item.text())
                    .is_some_and(|text| text == sentence)
            })
            .await;
        let clipboard = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        steps.check(
            "PDF: a drag selects text and ⌘C / Ctrl+C copies it",
            selected && copied,
            json!({ "selected": selected, "clipboard": clipboard }),
        );
        Ok(())
    }

    async fn dark_pages(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        let dark = self
            .wait_view(cx, 10, |view, _| {
                view.dark_pages() && view.images_follow_dark_pages()
            })
            .await;
        self.with_view(cx, |view, _, cx| view.toggle_dark_pages(cx))?;
        let light = self
            .wait_view(cx, 10, |view, _| {
                !view.dark_pages() && view.images_follow_dark_pages()
            })
            .await;
        steps.check(
            "PDF: Dark pages draws the pages dark, and back",
            dark && light,
            json!({ "dark": dark, "light": light }),
        );
        Ok(())
    }

    /// A rebuild that changes one page redraws only that page: its signature
    /// (lattice-core's `pdf_pages`) is the only one that differs.
    async fn page_swap(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        supplement: &Path,
    ) -> Result<()> {
        self.with_view(cx, |view, _, cx| view.go_to_page(9, cx))?;
        let swaps = cx.update(|cx| self.live_view_of(cx).read(cx).stats().swaps.len());
        // The same letters, so no font's subset changes with them.
        let text =
            std::fs::read_to_string(supplement)?.replace("Swap target ten.", "Target swap ten.");
        std::fs::write(supplement, text)?;
        // The outside edit reloads the editor and builds; this build runs
        // after that one (and finds nothing more to typeset).
        self.pause(cx, Duration::from_millis(500)).await;
        let (built, _) = self.build(cx).await?;
        let swapped = |view: &PdfView| {
            view.stats().swaps[swaps..]
                .iter()
                .any(|redrawn| redrawn.as_slice() == [9])
        };
        let reloaded = self.wait_view(cx, 20, |view, _| swapped(view)).await;
        let stats = cx.update(|cx| self.live_view_of(cx).read(cx).stats().clone());
        steps.check(
            "PDF: a rebuild that changed one page redraws only that page and keeps the others",
            built && reloaded,
            json!({ "reloads": stats.swaps.get(swaps..) }),
        );
        Ok(())
    }

    async fn page_window(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        // Through every page, one at a time, then the last.
        for page in 0..12 {
            self.with_view(cx, |view, _, cx| view.go_to_page(page, cx))?;
            self.pause(cx, Duration::from_millis(80)).await;
        }
        self.pause(cx, Duration::from_millis(400)).await;
        let (held, visible) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.held_pages(), view.visible_pages())
        });
        let window = visible.start.saturating_sub(2)..visible.end + 2;
        steps.check(
            "PDF: pages more than two away from the screen let go of their images",
            !held.is_empty() && held.iter().all(|page| window.contains(page)),
            json!({ "held": held, "visible": [visible.start, visible.end] }),
        );
        Ok(())
    }

    async fn separate_window(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let windows = cx.update(|cx| cx.windows().len());
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .context("no project is open")?;
        let remembered_open = || crate::pdf::preferences::get().window(&root).open;
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let pdf = shell.read(cx).pdf().read(cx);
                pdf.in_window() && cx.windows().len() == windows + 1
            })
            .await;
        let shown = self
            .wait_view(cx, 15, |view, _| {
                view.page_count() == 12 && view.current_page() == 11
            })
            .await;
        let remembered = remembered_open();
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })?;
        let docked = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let pdf = shell.read(cx).pdf().read(cx);
                !pdf.in_window() && cx.windows().len() == windows
            })
            .await;
        let back = self
            .wait_view(cx, 15, |view, _| {
                view.page_count() == 12 && view.current_page() == 11
            })
            .await;
        let forgotten = !remembered_open();
        steps.check(
            "PDF: Open in separate window shows the PDF in a window of its own at the same page, and Return to workspace brings it back",
            opened && shown && docked && back,
            json!({ "opened": opened, "shown": shown, "docked": docked, "back": back }),
        );
        steps.check(
            "PDF: the project remembers its PDF in its own window, and Return to workspace clears that",
            remembered && forgotten,
            json!({ "remembered": remembered, "forgotten": forgotten }),
        );
        Ok(())
    }
}
