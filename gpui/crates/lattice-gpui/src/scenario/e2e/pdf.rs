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
//! letting go of pages far from the screen, the separate window (opened
//! again when its project is shown again, and leaving a right dock it shares
//! with Project as it was), and main.tex's tab asking for a build that Stop
//! then drops. Building main.tex again trades the two tabs back.

use std::{cell::Cell, path::Path, rc::Rc, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{App, AsyncApp, Entity, Focusable as _};
use serde_json::{Value, json};
use trellis::model::{DockTarget, panel_of_view};

use super::Steps;
use crate::{
    native,
    pdf::{FindOptions, FitMode, LinkTarget, PdfEvent, PdfView},
    scenario::{Foreground, Run},
    shell::StopBuild,
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

mod page_draft;

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

    /// Bring the app and the main window to the front, as a reader working
    /// in it has them, and wait for the window to draw. gpui-fast only slows
    /// an inactive window to 30 frames a second, but macOS stops the frames
    /// of a covered window, and making the window key again starts them.
    async fn front(&self, cx: &mut AsyncApp, what: &'static str) -> Result<Foreground> {
        let front = self.foreground(cx, what).await?;
        self.next_frame(cx).await;
        Ok(front)
    }

    /// Whether the main window draws a frame within a second.
    async fn next_frame(&self, cx: &mut AsyncApp) -> bool {
        let drew = Rc::new(Cell::new(false));
        self.with_window(cx, {
            let drew = drew.clone();
            move |_, window, _| window.on_next_frame(move |_, _| drew.set(true))
        })
        .ok();
        for _ in 0..20 {
            if drew.get() {
                break;
            }
            self.pause(cx, Duration::from_millis(50)).await;
        }
        drew.get()
    }

    /// Whether the main window is active, whether the platform reports it
    /// visible (macOS stops the frames of a covered window), and whether it
    /// drew a frame within a second; the first time it did not, the screen
    /// is captured to show what was in front.
    async fn frames(&self, cx: &mut AsyncApp) -> Value {
        let (active, visibility) = self
            .with_window(cx, |_, window, _| {
                (
                    window.is_window_active(),
                    format!("{:?}", window.visibility()),
                )
            })
            .unwrap_or_default();
        let drew = self.next_frame(cx).await;
        if !drew {
            capture_screen_once();
        }
        json!({ "active": active, "visibility": visibility, "drew": drew })
    }

    /// What a check that waits for the live PDF to draw saw, for its
    /// failure: the window's frames, and the PDF's panel (its tabs, the one
    /// in front among them).
    async fn drawing(&self, cx: &mut AsyncApp) -> Value {
        let pdf_panel = self
            .with_window(cx, |shell, _, cx| {
                let doc = shell.read(cx).document(cx);
                serde_json::to_value(panel_of_view(&doc, "pdf")).unwrap_or_default()
            })
            .unwrap_or_default();
        let mut detail = self.frames(cx).await;
        detail["pdf_panel"] = pdf_panel;
        detail
    }

    /// ⌘W on another document's tab rearranges the window without it, and
    /// main.tex's root tab, which the arrangement has no view for, stays
    /// docked and in the shell's root tabs. (A deleted file's editor closing
    /// late, after the first build, once let the root tab go.)
    async fn closing_a_tab_keeps_root_tabs(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main_tab = |shell: &crate::shell::Shell| {
            shell.root_pdf_tabs().iter().any(|(document, panel)| {
                document == "main.tex" && shell.view_of_panel(panel.entity_id()).is_some()
            })
        };
        let before = cx.update(|cx| main_tab(self.shell.read(cx)));
        let scratch = root.join("tab-close-check.tex");
        std::fs::write(&scratch, "A tab to close.\n")?;
        let editor = self.open(cx, &scratch, None)?;
        self.with_window(cx, |_, window, cx| {
            window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
        })?;
        self.frame_after_input(cx).await?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::shell::commands::CloseTab), cx)
        })?;
        self.frame_after_input(cx).await?;
        let (closed, after) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            (
                shell.view_of_panel(editor.entity_id()).is_none(),
                main_tab(shell),
            )
        });
        std::fs::remove_file(&scratch).ok();
        steps.check(
            "closing another document's tab keeps main.tex's root PDF tab docked",
            before && closed && after,
            json!({ "before": before, "closed": closed, "after": after }),
        );
        Ok(())
    }

    /// Each check from `from` on records the window's frames after it, so a
    /// run shows where they stop.
    async fn note_frames(&self, cx: &mut AsyncApp, steps: &mut Steps, from: usize) {
        let frames = self.frames(cx).await;
        for step in &mut steps.0[from..] {
            step["detail"]["frames"] = frames.clone();
        }
    }

    pub(super) async fn pdf_viewer(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // Most steps below wait for the live PDF to draw rather than for a
        // native event to be handled, so each starts with the window in
        // front and drawing.
        let front = self.front(cx, "a second root document").await?;
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
        let last = steps.0.len() - 1;
        self.note_frames(cx, steps, last).await;
        drop(front);
        self.closing_a_tab_keeps_root_tabs(cx, steps, root).await?;

        macro_rules! pdf_step {
            ($step:expr) => {{
                let _front = self.front(cx, stringify!($step)).await?;
                let from = steps.0.len();
                $step.await?;
                self.note_frames(cx, steps, from).await;
            }};
        }
        pdf_step!(self.outline(cx, steps));
        pdf_step!(self.navigation_and_zoom(cx, steps));
        pdf_step!(self.find_in_pdf(cx, steps));
        pdf_step!(self.page_draft(cx, steps));
        pdf_step!(self.links_and_back(cx, steps));
        pdf_step!(self.select_and_copy(cx, steps));
        pdf_step!(self.dark_pages(cx, steps));
        pdf_step!(self.page_swap(cx, steps, &supplement));
        pdf_step!(self.page_window(cx, steps));
        pdf_step!(self.separate_window(cx, steps));
        pdf_step!(self.separate_window_shared_dock(cx, steps));
        pdf_step!(self.stopped_tab_build(cx, steps, &supplement));

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
        let mut detail =
            json!({ "links": links.len(), "followed": followed, "back": back, "web": web });
        if !(read && followed && back && web) {
            detail["drawing"] = self.drawing(cx).await;
        }
        steps.check(
            "PDF: a click on a section link jumps to it, Back returns, and the web link is read",
            read && followed && back && web,
            detail,
        );

        // The file link and the app-scheme link are on the page, but no
        // link the viewer would follow covers their words. The jump let go
        // of page 1's text, so it is read again after Back.
        self.wait_view(cx, 10, |view, _| view.page_text(0).is_some())
            .await;
        let (text, page) = cx.update(|cx| {
            let view = self.live_view_of(cx).read(cx);
            (view.page_text(0), view.current_page())
        });
        let (file, scheme, launchers) = match &text {
            Some(text) => {
                let chars: String = text.chars.iter().map(|ch| ch.ch).collect();
                let covered =
                    |anchor: &str| {
                        let index = chars.find(anchor)?;
                        let first = text.chars[chars[..index].chars().count()];
                        let (x, y) = ((first.x0 + first.x1) / 2., (first.y0 + first.y1) / 2.);
                        Some(text.links.iter().any(|link| {
                            link.x0 <= x && x <= link.x1 && link.y0 <= y && y <= link.y1
                        }))
                    };
                let launchers: Vec<String> = text
                    .links
                    .iter()
                    .filter_map(|link| match &link.target {
                        LinkTarget::Uri(uri) if !uri.starts_with("https://") => Some(uri.clone()),
                        _ => None,
                    })
                    .collect();
                (covered("Fileanchor"), covered("Schemeanchor"), launchers)
            }
            None => (None, None, Vec::new()),
        };
        steps.check(
            "PDF: a link to a file or to an app's own scheme is not followed",
            file == Some(false) && scheme == Some(false) && launchers.is_empty(),
            json!({
                "text_read": text.is_some(),
                "page": page,
                "file_covered": file,
                "scheme_covered": scheme,
                "other_uris": launchers,
            }),
        );
        Ok(())
    }

    async fn select_and_copy(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.wait_view(cx, 10, |view, _| view.page_text(0).is_some())
            .await;
        let (text, page, drawn) = cx.update(|cx| {
            let view = self.live_view_of(cx).read(cx);
            (view.page_text(0), view.current_page(), view.stats().clone())
        });
        let Some(text) = text else {
            let drawing = self.drawing(cx).await;
            steps.check(
                "PDF: a drag selects text and ⌘C / Ctrl+C copies it",
                false,
                json!({
                    "text_read": false,
                    "page": page,
                    "stats": format!("{drawn:?}"),
                    "drawing": drawing,
                }),
            );
            return Ok(());
        };
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
                "PDF: a drag selects text and ⌘C / Ctrl+C copies it",
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
        // Each jump lets go of the far pages and asks for the ones it
        // reached, frame or not; a frame is asked for too, so the step
        // records whether the window draws.
        self.with_window(cx, |_, window, _| window.refresh()).ok();
        let drew = self.next_frame(cx).await;
        self.pause(cx, Duration::from_millis(400)).await;
        let (held, visible) = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            (view.held_pages(), view.visible_pages())
        });
        let window = visible.start.saturating_sub(2)..visible.end + 2;
        let passed = !held.is_empty() && held.iter().all(|page| window.contains(page));
        let mut detail =
            json!({ "held": held, "visible": [visible.start, visible.end], "drew": drew });
        if !passed {
            detail["drawing"] = self.drawing(cx).await;
        }
        steps.check(
            "PDF: pages more than two away from the screen let go of their images",
            passed,
            detail,
        );
        Ok(())
    }

    async fn separate_window(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let windows = cx.update(|cx| cx.windows().len());
        let root = cx
            .update(|cx| self.shell.read(cx).root(cx))
            .context("no project is open")?;
        let remembered_open = || crate::pdf::preferences::get().window(&root).open;
        let in_window = |open: bool| {
            move |shell: &Entity<crate::shell::Shell>, cx: &mut App| {
                let count = if open { windows + 1 } else { windows };
                shell.read(cx).pdf().read(cx).in_window() == open && cx.windows().len() == count
            }
        };
        // From page 7 in the middle of the PDF, so neither viewer can land on
        // it by clamping to the end of the column.
        self.with_view(cx, |view, _, cx| view.go_to_page(6, cx))?;
        self.pause(cx, Duration::from_millis(400)).await;
        let at_page_seven = |view: &PdfView, _: &App| {
            view.page_count() == 12 && view.current_page() == 6 && view.visible_pages().start == 6
        };
        // The place each viewer was given, and where each one is.
        let place = |cx: &mut AsyncApp| {
            cx.update(|cx| format!("{:?}", self.live_view_of(cx).read(cx).view_place()))
        };
        let state = |cx: &mut AsyncApp| cx.update(|cx| view_state(self.live_view_of(cx).read(cx)));
        let carried_out = place(cx);
        self.detach_pdf(cx)?;
        let opened = self
            .wait_for(cx, Duration::from_secs(10), in_window(true))
            .await;
        let shown = self.wait_view(cx, 15, at_page_seven).await;
        let window_view = state(cx);
        let carried_back = place(cx);
        let remembered = remembered_open();
        self.dock_pdf(cx)?;
        let docked = self
            .wait_for(cx, Duration::from_secs(10), in_window(false))
            .await;
        let back = self.wait_view(cx, 15, at_page_seven).await;
        let panel_view = state(cx);
        let forgotten = !remembered_open();
        steps.check(
            "PDF: Open in separate window shows the PDF in a window of its own at the same page, and Return to workspace brings it back",
            opened && shown && docked && back,
            json!({
                "opened": opened,
                "shown": shown,
                "docked": docked,
                "back": back,
                "carried_out": carried_out,
                "window": window_view,
                "carried_back": carried_back,
                "panel": panel_view,
            }),
        );
        steps.check(
            "PDF: the project remembers its PDF in its own window, and Return to workspace clears that",
            remembered && forgotten,
            json!({ "remembered": remembered, "forgotten": forgotten }),
        );

        // Left in its own window (on page 7): another project shown takes the
        // window down and keeps the choice, and opens its own PDF at its
        // start; this project shown again opens its window again, behind the
        // workspace, at its PDF.
        self.detach_pdf(cx)?;
        let detached = self
            .wait_for(cx, Duration::from_secs(10), in_window(true))
            .await
            && remembered_open();
        let source = cx
            .update(|cx| {
                self.shell
                    .read(cx)
                    .pdf()
                    .read(cx)
                    .source()
                    .map(Path::to_path_buf)
            })
            .context("the live PDF has no file")?;
        let other = root.join("another-project");
        let other_pdf = other.join("main.pdf");
        std::fs::create_dir_all(&other)?;
        std::fs::copy(&source, &other_pdf)?;
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| {
                pdf.show_project(other, Some(other_pdf), window, cx)
            });
        })?;
        let left = self
            .wait_for(cx, Duration::from_secs(10), in_window(false))
            .await;
        let kept = remembered_open();
        self.wait_view(cx, 15, |view, _| view.page_count() == 12)
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        let other_at_start = cx.update(|cx| {
            let view = self.live_view_of(cx);
            let view = view.read(cx);
            view.page_count() == 12 && view.current_page() == 0 && view.visible_pages().start == 0
        });
        let project = root.clone();
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| {
                pdf.show_project(project, Some(source), window, cx)
            });
        })?;
        let restored = self
            .wait_for(cx, Duration::from_secs(10), in_window(true))
            .await;
        let restored_pages = self
            .wait_view(cx, 15, |view, _| view.page_count() == 12)
            .await;
        std::fs::remove_dir_all(root.join("another-project"))?;
        // Behind: the reopened window did not take the focus (on a locked
        // screen no window is active at all).
        let behind = cx.update(|cx| {
            let opened = self.shell.read(cx).pdf().read(cx).window_handle();
            opened.is_some() && cx.active_window() != opened
        });
        self.dock_pdf(cx)?;
        let docked = self
            .wait_for(cx, Duration::from_secs(10), in_window(false))
            .await
            && !remembered_open();
        steps.check(
            "PDF: another project shown opens its own PDF at its start, and a project that left its PDF in its own window opens it again behind the workspace",
            detached
                && left
                && kept
                && other_at_start
                && restored
                && restored_pages
                && behind
                && docked,
            json!({
                "detached": detached,
                "left": left,
                "kept": kept,
                "other_at_start": other_at_start,
                "restored": restored,
                "pages": restored_pages,
                "behind": behind,
                "docked": docked,
            }),
        );
        Ok(())
    }

    /// The PDF sharing the right dock with Project: Open in separate window
    /// takes only the PDF away, the dock staying open at its width with
    /// Project in it, and Return to workspace leaves them as they were too.
    async fn separate_window_shared_dock(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        let windows = cx.update(|cx| cx.windows().len());
        // Project joins the PDF's panel, behind the PDF.
        let shared = self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                let doc = shell.document(cx);
                let Some(pdf) = panel_of_view(&doc, "pdf").map(|panel| panel.id.clone()) else {
                    return false;
                };
                shell.engine_do(cx, |engine| {
                    engine.dock(
                        "project",
                        Some(DockTarget::Into {
                            into: pdf.clone(),
                            index: None,
                        }),
                    );
                    engine.select("pdf");
                });
                let doc = shell.document(cx);
                panel_of_view(&doc, "project").map(|panel| panel.id.clone())
                    == panel_of_view(&doc, "pdf").map(|panel| panel.id.clone())
            })
        })?;
        // The PDF's panel: on screen, its width, and Project in it.
        let dock = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                let shell = self.shell.read(cx);
                let doc = shell.document(cx);
                let panel = panel_of_view(&doc, "pdf").map(|panel| panel.id.clone());
                let open = panel.is_some()
                    && shell.workspace().read(cx).engine().placement_of("pdf")
                        != trellis::runtime::engine::ViewPlacement::Hidden;
                let width = panel
                    .as_deref()
                    .and_then(|panel| shell.workspace().read(cx).panel_bounds(panel))
                    .map(|bounds| bounds.size.width);
                let with_project = panel.is_some()
                    && panel_of_view(&doc, "project").map(|p| p.id.clone()) == panel;
                (open, width, with_project)
            })
        };
        let in_window = |open: bool| {
            move |shell: &Entity<crate::shell::Shell>, cx: &mut App| {
                let count = if open { windows + 1 } else { windows };
                shell.read(cx).pdf().read(cx).in_window() == open && cx.windows().len() == count
            }
        };
        let before = dock(cx);
        self.detach_pdf(cx)?;
        let opened = self
            .wait_for(cx, Duration::from_secs(10), in_window(true))
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let during = dock(cx);
        self.dock_pdf(cx)?;
        let docked = self
            .wait_for(cx, Duration::from_secs(10), in_window(false))
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let after = dock(cx);

        // The layout as it was.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.reset_layout(window, cx));
        })?;
        self.pause(cx, Duration::from_millis(300)).await;

        let shown = |state: &(bool, Option<gpui::Pixels>, bool)| json!({ "open": state.0, "width": format!("{:?}", state.1), "with_project": state.2 });
        steps.check(
            "PDF: sharing its panel with Project, Open in separate window and Return to workspace leave the panel on screen at its width with Project in it",
            shared && opened && docked && before.0 && before.2 && during == before && after == before,
            json!({
                "shared": shared,
                "opened": opened,
                "docked": docked,
                "before": shown(&before),
                "during": shown(&during),
                "after": shown(&after),
            }),
        );
        Ok(())
    }

    /// Build this document on main.tex's tab while a build runs, then Stop:
    /// the ask ends with the stopped build, so the next build compiles the
    /// document in front (supplement.tex), not main.tex.
    async fn stopped_tab_build(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        supplement: &Path,
    ) -> Result<()> {
        const STEP: &str = "PDF: Build this document on a root tab while a build runs, then Stop: the next build compiles the document in front, not that tab's";
        self.open(cx, supplement, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        // Nothing left running from the steps before.
        self.wait_for(cx, Duration::from_secs(60), |shell, cx| {
            !shell.read(cx).building()
        })
        .await;
        let tab = cx.update(|cx| {
            self.shell
                .read(cx)
                .root_pdf_tabs()
                .into_iter()
                .find(|(document, _)| document == "main.tex")
                .map(|(_, panel)| panel)
        });
        let Some(tab) = tab else {
            steps.check(STEP, false, json!({ "main_tab": false }));
            return Ok(());
        };
        let before = self.builds(cx);
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.build(&crate::shell::Build, window, cx)
            })
        })?;
        let running = cx.update(|cx| self.shell.read(cx).building());
        // The tab's menu item, while that build runs: it waits behind it.
        cx.update(|cx| {
            tab.update(cx, |_, cx| {
                cx.emit(PdfEvent::Build {
                    document: Some("main.tex".into()),
                })
            })
        });
        self.dispatch_to_shell(cx, &StopBuild)?;
        let stopped = self.built_after(cx, before).await;
        // An ordinary build next, with supplement.tex in front.
        let (built, _) = self.build(cx).await?;
        let live = cx.update(|cx| self.shell.read(cx).live_document().map(str::to_string));
        let main_tab_kept = cx.update(|cx| {
            self.shell
                .read(cx)
                .root_pdf_tabs()
                .iter()
                .any(|(document, _)| document == "main.tex")
        });
        steps.check(
            STEP,
            running
                && stopped
                && built
                && live.as_deref() == Some("supplement.tex")
                && main_tab_kept,
            json!({
                "running": running,
                "stopped": stopped,
                "built": built,
                "live": live,
                "main_tab": main_tab_kept,
            }),
        );
        Ok(())
    }

    /// Open in separate window.
    fn detach_pdf(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.detach(window, cx));
        })
    }

    /// Return to workspace, closing the window.
    fn dock_pdf(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            let pdf = shell.read(cx).pdf().clone();
            pdf.update(cx, |pdf, cx| pdf.dock(true, window, cx));
        })
    }
}

impl Run {
    /// A second main window on the same project shows its PDF too. Each
    /// window's viewer goes through the process's one PDFium worker
    /// (`PdfEngine::global`); pdfium-render binds the library once per
    /// process, so a viewer that bound its own failed in every window after
    /// the first. Its first page's image is also checked to hold the
    /// window's scale factor in device pixels per point shown, so the pages
    /// are drawn sharp on a Retina screen.
    pub(super) async fn second_window_pdf(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let opened = cx.update(|cx| crate::shell::Shell::open_window(Some(root.to_path_buf()), cx));
        let (window, shell) = opened?;
        let second = self.for_window(shell, window);
        second.root(cx).await?;
        let drawn = |shell: &Entity<crate::shell::Shell>, cx: &mut App| {
            let view = shell.read(cx).pdf().read(cx).live_view().read(cx);
            view.page_count() > 0 && !view.held_pages().is_empty()
        };
        let shown = second.wait_for(cx, Duration::from_secs(30), drawn).await;
        // Let the image drawn at the zoom the viewer settled on arrive.
        second.pause(cx, Duration::from_millis(600)).await;
        let state = second.with_window(cx, |shell, window, cx| {
            let view = shell.read(cx).pdf().read(cx).live_view().read(cx);
            (
                view.page_count(),
                view.held_pages(),
                view.image_density(0),
                window.scale_factor(),
            )
        });
        window
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        let (pages, held, density, scale_factor) = state?;
        let first = cx.update(|cx| self.shell.read(cx).pdf().read(cx).page_count(cx));
        let sharp = density.is_some_and(|density| (density - scale_factor).abs() < 0.02);
        steps.check(
            "a second window's PDF loads and draws beside the first window's, at the window's scale factor",
            shown && pages > 0 && first > 0 && sharp,
            json!({
                "pages": pages,
                "held": held,
                "first_window_pages": first,
                "density": density,
                "scale_factor": scale_factor,
            }),
        );
        Ok(())
    }
}

/// Where a viewer is and what it was laid out for.
fn view_state(view: &PdfView) -> Value {
    let visible = view.visible_pages();
    let viewport = view.viewport_bounds().size;
    json!({
        "page": view.current_page(),
        "visible": [visible.start, visible.end],
        "viewport": [f32::from(viewport.width), f32::from(viewport.height)],
        "scale": view.scale(),
        "fit": format!("{:?}", view.fit()),
        "pending_scroll": view.has_pending_scroll(),
    })
}

/// The screen, the first time the main window draws no frame, into the file
/// `LATTICE_E2E_FRAMELESS_SHOT` names (the macOS workflow sets it and
/// uploads the file with the result).
fn capture_screen_once() {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static TAKEN: AtomicBool = AtomicBool::new(false);
        let Some(path) = std::env::var_os("LATTICE_E2E_FRAMELESS_SHOT") else {
            return;
        };
        if TAKEN.swap(true, Ordering::Relaxed) {
            return;
        }
        match std::process::Command::new("screencapture")
            .arg("-x")
            .arg(&path)
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(status) => log::warn!("screencapture exited with {status}"),
            Err(error) => log::warn!("screencapture: {error}"),
        }
    }
}
