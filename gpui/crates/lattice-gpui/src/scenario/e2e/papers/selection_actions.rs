//! The paper reader's selection actions (`paper-selection-actions.tsx` and
//! its test): a drag over words of the original PDF, or a selection in the
//! full text, offers Copy source link and Add to note where it ends. The
//! link copied is the paper's PDF at the passage's page with its first and
//! last words as the title, found on the page for the PDF and looked up in
//! the PDF for the full text; Add to note appends the quote and that link to
//! `notes/<citation key>.md`, whose notice opens the note.
//!
//! Then the browser refusing the article (`openUrl(...).catch` in
//! `use-paper-pdf.ts`): the system opener is stood in for, so no browser
//! opens, and the reader's way out says it could not open the article.
//!
//! The note is removed afterwards, so the steps after these see the
//! project as it was.

use std::{cell::RefCell, path::Path, rc::Rc, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::{Value, json};

use super::super::Steps;
use crate::{
    papers::reader::{PaperReader, QuoteAction, ReaderView},
    scenario::Run,
};

/// The paper's note: its citation key's (`notes/<key>.md`).
const NOTE: &str = "notes/vaswani2017attention.md";
/// Words of the PDF's second line: a quote too short to shorten, so both
/// anchors are the whole of it (`sourceQuoteAnchors`).
const PDF_WORDS: &str = "sequence transduction models are based";
/// The full text's sentence the PDF holds too.
const SENTENCE: &str = "The dominant sequence transduction models are based on recurrent networks.";

/// Select the full text's paragraph holding `SENTENCE` as a drag would, and
/// end the drag in the reader.
const SELECT_SENTENCE: &str = "(() => {\
    const paragraph = [...document.querySelectorAll('.markdown-preview p')]\
        .find((p) => p.textContent.includes('dominant sequence transduction'));\
    if (!paragraph) return JSON.stringify({ selected: false });\
    const range = document.createRange();\
    range.selectNodeContents(paragraph);\
    const selection = window.getSelection();\
    selection.removeAllRanges();\
    selection.addRange(range);\
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));\
    return JSON.stringify({ selected: true, text: selection.toString() });\
})()";

/// The actions offered over the full text, by their labels.
const OFFERED: &str = "JSON.stringify([...document.querySelectorAll('.paper-selection-actions .paper-selection-action')].map((button) => button.textContent.trim()))";

/// Choose the full text's action labelled `label`.
fn choose(label: &str) -> String {
    format!(
        "(() => {{ const button = [...document.querySelectorAll('.paper-selection-action')].find((b) => b.textContent.includes('{label}')); button?.click(); return JSON.stringify(Boolean(button)); }})()"
    )
}

impl Run {
    fn clipboard_text(&self, cx: &mut AsyncApp) -> Option<String> {
        cx.update(|cx| cx.read_from_clipboard())
            .and_then(|item| item.text())
    }

    fn notice_titles(&self, cx: &mut AsyncApp) -> Vec<String> {
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| {
            notices
                .read(cx)
                .titles()
                .into_iter()
                .map(|title| title.to_string())
                .collect()
        })
    }

    /// The PDF's drag offers both actions; each does what it says.
    pub(super) async fn paper_pdf_actions(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        bundle: &str,
        reader: &Entity<PaperReader>,
    ) -> Result<()> {
        let Some(view) = cx.update(|cx| reader.read(cx).pdf_view()) else {
            steps.check(
                "the original PDF is shown for its selection actions",
                false,
                json!({}),
            );
            return Ok(());
        };
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let pdf_link = format!("/{bundle}/original.pdf#page=1");
        let expected_link = format!("[p. 1]({pdf_link} \"{PDF_WORDS} … {PDF_WORDS}\")");
        for action in [QuoteAction::Copy, QuoteAction::Note] {
            let found = self
                .wait_for(cx, Duration::from_secs(10), |_, cx| {
                    view.read(cx).text_span_points(0, PDF_WORDS).is_some()
                })
                .await;
            let Some((from, to)) = cx.update(|cx| view.read(cx).text_span_points(0, PDF_WORDS))
            else {
                steps.check(
                    "a drag over the original PDF's words offers Copy source link and Add to note",
                    false,
                    json!({ "words": found }),
                );
                return Ok(());
            };
            self.select_pdf_words(cx, from, to)?;
            let offered = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    reader.read(cx).quote_action_center(action).is_some()
                })
                .await;
            if action == QuoteAction::Copy {
                let text = cx.update(|cx| reader.read(cx).quote_offer().map(|(text, _)| text));
                steps.check(
                    "a drag over the original PDF's words offers Copy source link and Add to note where it ends",
                    offered && text.as_deref() == Some(PDF_WORDS),
                    json!({ "offered": offered, "text": text }),
                );
                self.island_shot(cx, "paper-selection-actions-pdf").await?;
            }
            let Some(at) = cx.update(|cx| reader.read(cx).quote_action_center(action)) else {
                steps.check(
                    "the PDF's selection pill offers the action to click",
                    false,
                    json!({ "action": format!("{action:?}"), "offered": offered }),
                );
                return Ok(());
            };
            self.click_at(cx, at)?;
            let done = self
                .wait_for(cx, Duration::from_secs(10), |_, cx| {
                    reader.read(cx).quote_offer().is_none()
                })
                .await;
            match action {
                QuoteAction::Copy => {
                    let copied = self.clipboard_text(cx);
                    let titles = self.notice_titles(cx);
                    steps.check(
                        "the PDF's Copy source link copies the PDF at the passage's page, its words as the title",
                        done && copied.as_deref() == Some(expected_link.as_str())
                            && titles.iter().any(|title| title == "Source link copied"),
                        json!({ "copied": copied, "expected": expected_link, "notices": titles }),
                    );
                }
                QuoteAction::Note => {
                    let note = std::fs::read_to_string(root.join(NOTE)).unwrap_or_default();
                    let cards = cx.update(|cx| notices.read(cx).cards());
                    let told = cards.iter().any(|card| {
                        card.title == format!("Added to {NOTE}")
                            && card.actions.iter().any(|label| label == "Open note")
                    });
                    steps.check(
                        "the PDF's Add to note starts the paper's note with the quote and its source link, and says where",
                        done && note.starts_with("# Attention Is All You Need\n\n[Attention Is All You Need](../.research/papers/1706.03762/paper.md)\n\n")
                            && note.contains(&format!("> {PDF_WORDS} {expected_link}"))
                            && told,
                        json!({ "note": note, "notices": cards.iter().map(|card| card.title.clone()).collect::<Vec<_>>() }),
                    );
                }
            }
        }
        Ok(())
    }

    /// The full text offers both actions over a selection, the passage's
    /// page found in the PDF, and the note's notice opens the note.
    pub(super) async fn paper_text_actions(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        bundle: &str,
        reader: &Entity<PaperReader>,
    ) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            reader.update(cx, |reader, cx| {
                reader.show(ReaderView::FullText, window, cx)
            })
        })?;
        if self.reader_drawn(cx, ReaderView::FullText).await.is_none() {
            steps.check(
                "the full text is shown for its selection actions",
                false,
                json!({}),
            );
            return Ok(());
        }
        let island = cx.update(|cx| {
            reader
                .read(cx)
                .editor()
                .and_then(|editor| editor.read(cx).markdown_document().cloned())
                .and_then(|document| document.read(cx).island().cloned())
        });
        let Some(island) = island else {
            steps.check(
                "the full text's island is up for its selection actions",
                false,
                json!({}),
            );
            return Ok(());
        };
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let expected_link = format!(
            "[p. 1](/{bundle}/original.pdf#page=1 \"The dominant sequence transduction … based on recurrent networks.\")"
        );
        let mut offered = Value::Null;
        for label in ["Copy source link", "Add to note"] {
            let selected = self.evaluate(cx, &island, SELECT_SENTENCE).await;
            self.pause(cx, Duration::from_millis(300)).await;
            offered = self.evaluate(cx, &island, OFFERED).await;
            if label == "Copy source link" {
                steps.check(
                    "a selection in the full text offers Copy source link and Add to note where it ends",
                    selected["text"].as_str().map(str::trim) == Some(SENTENCE)
                        && offered == json!(["Copy source link", "Add to note"]),
                    json!({ "selected": selected, "offered": offered }),
                );
                self.island_shot(cx, "paper-selection-actions-full-text")
                    .await?;
            }
            let chose = self.evaluate(cx, &island, &choose(label)).await == json!(true);
            // The page's actions finish once the owner answers; the bar
            // leaves with them.
            let mut gone = false;
            for _ in 0..100 {
                if self.evaluate(cx, &island, OFFERED).await == json!([]) {
                    gone = true;
                    break;
                }
                self.pause(cx, Duration::from_millis(100)).await;
            }
            if label == "Copy source link" {
                let copied = self.clipboard_text(cx);
                steps.check(
                    "the full text's Copy source link finds the passage's page in the PDF and copies its link",
                    chose && gone && copied.as_deref() == Some(expected_link.as_str()),
                    json!({ "chose": chose, "gone": gone, "copied": copied, "expected": expected_link }),
                );
            }
        }
        let note_path = root.join(NOTE);
        let note = std::fs::read_to_string(&note_path).unwrap_or_default();
        let title = format!("Added to {NOTE}");
        let told = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                notices.read(cx).cards().iter().any(|card| {
                    card.title == title && card.actions.iter().any(|label| label == "Open note")
                })
            })
            .await;
        steps.check(
            "the full text's Add to note appends the quote with its page in the PDF to the paper's note",
            note.contains(&format!("> {SENTENCE} {expected_link}")) && told,
            json!({ "note": note, "offered": offered, "told": told }),
        );
        // Its notice's Open note opens the note.
        let answered = self.with_window(cx, |_, window, cx| {
            notices.update(cx, |stack, cx| {
                stack.answer(&title, "Open note", window, cx)
            })
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.update(cx, |shell, cx| shell.open_editor(&note_path, cx).is_some())
            })
            .await;
        steps.check(
            "the note's notice opens the paper's note",
            answered && opened,
            json!({ "answered": answered, "opened": opened }),
        );
        let editor = cx.update(|cx| {
            self.shell
                .update(cx, |shell, cx| shell.open_editor(&note_path, cx))
        });
        if let Some(editor) = editor {
            self.close_panel(cx, &editor).await?;
        }
        std::fs::remove_file(&note_path).ok();
        std::fs::remove_dir(root.join("notes")).ok();
        Ok(())
    }

    /// The reader's way out to the web, refused by the system: Papers says
    /// so; taken, it says nothing.
    pub(super) async fn paper_browser_failure(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        reader: &Entity<PaperReader>,
    ) -> Result<()> {
        let notices = cx.update(crate::notices::install);
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let handed: Rc<RefCell<Vec<String>>> = Rc::default();
        let refused = handed.clone();
        cx.update(|cx| {
            crate::opener::stand_in(
                move |url| {
                    refused.borrow_mut().push(url.to_string());
                    Err(format!("No application can open {url}"))
                },
                cx,
            )
        });
        cx.update(|cx| reader.update(cx, |reader, cx| reader.open_in_browser(cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        let cards = cx.update(|cx| notices.read(cx).cards());
        let details = cx.update(|cx| notices.read(cx).details());
        steps.check(
            "a browser that will not open the article is reported as the Tauri app's Papers reports it",
            *handed.borrow() == ["https://arxiv.org/pdf/1706.03762"]
                && cards.iter().any(|card| card.title == "Could not open the article in your browser")
                && details.iter().any(|detail| detail.contains("No application can open")),
            json!({ "handed": *handed.borrow(), "notices": cards.iter().map(|card| card.title.clone()).collect::<Vec<_>>() }),
        );
        self.island_shot(cx, "paper-browser-failure").await?;
        // Taken, the article opens without a word.
        cx.update(|cx| notices.update(cx, |stack, cx| stack.clear(cx)));
        let taken = handed.clone();
        cx.update(|cx| {
            crate::opener::stand_in(
                move |url| {
                    taken.borrow_mut().push(url.to_string());
                    Ok(())
                },
                cx,
            )
        });
        cx.update(|cx| reader.update(cx, |reader, cx| reader.open_in_browser(cx)));
        self.pause(cx, Duration::from_millis(300)).await;
        let quiet = cx.update(|cx| notices.read(cx).titles().is_empty());
        cx.update(crate::opener::give_back);
        steps.check(
            "an article the browser takes opens without a notice",
            quiet && handed.borrow().len() == 2,
            json!({ "quiet": quiet, "handed": *handed.borrow() }),
        );
        Ok(())
    }
}
