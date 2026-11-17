//! The `latex_visual` module's checks of a citation chip's card and Why
//! cited in the Visual page (`editor_panel/latex_visual_citations.rs`,
//! `gpui/islands/latex/citations.ts`), offline, on a paper the library has
//! the text of, a Crossref verdict cached for its DOI (as a Check
//! references run leaves one), cited twice in the page, once naming a page:
//!
//! - the pointer resting on the first chip opens its card as the
//!   Tauri app's Visual mode draws it (`latex-hover-cards.ts`
//!   `fillCitationEntry`, `citation-card-uses.ts`): the entry's title, the
//!   library's authors, the Verified by Crossref and arXiv badges, "Cited 2×
//!   here" with the page the second cite's note names, and Open paper, Go to
//!   entry and Copy key (a chip's card offers no Why cited; the source's
//!   card does, with the caret in the chip);
//! - a native click in the chip shows its source, and a native right-click
//!   on the key there opens Why cited; a role and a note chosen with native
//!   clicks and keys and saved file the reason in the project's
//!   annotations on that occurrence of the key, and the chip's card then
//!   shows the role and the note on its row; Remove takes it out again;
//! - the card's Open paper hands the key to the Papers panel, which opens
//!   the paper in its reader (`PapersEvent::Read`), never the browser.
//!
//! With `LATTICE_E2E_SHOTS=DIR` it saves the window with the card and with
//! the popover, in light and dark (`latex-visual-citation-card-*.png`,
//! `latex-visual-why-cited-*.png`).

#![cfg(target_os = "macos")]

use std::{cell::RefCell, path::Path, rc::Rc, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, Pixels, Point, point, px};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{Run, Steps};
use crate::{
    annotations::store,
    native,
    papers::{PapersEvent, PapersPanel},
};

/// The key the module's document cites twice (`latex_visual.rs`'s `PAPER`).
const KEY: &str = "e2evisual2024";
const ENTRY: &str = "\n@article{e2evisual2024,\n  title = {Visual Citations in Practice},\n  author = {{Lattice Team} and Doe, Jane},\n  journal = {Journal of Examples},\n  year = {2024},\n  eprint = {2401.00001},\n  doi = {10.5555/e2e.visual.2024}\n}\n";
const BUNDLE: &str = ".research/papers/2401.00001";
const TEXT: &str = "---\ntitle: Visual Citations in Practice\n---\n\n# Visual Citations in Practice\n\n## Abstract\n\nCitations drawn as chips still say what they cite.\n";
const HEALTH: &str = ".research/cache/citation-health-v1.json";

/// The library's paper, written into the project, and what it replaced.
pub(super) struct CitedPaper {
    bibliography: String,
    health: Option<Vec<u8>>,
}

impl CitedPaper {
    /// Cite the paper in the primary bibliography, save its text, and cache
    /// Crossref's "nothing to report" for its DOI.
    pub(super) fn write(root: &Path) -> Result<Self> {
        let bibliography = std::fs::read_to_string(root.join("references.bib"))?;
        let health = std::fs::read(root.join(HEALTH)).ok();
        std::fs::create_dir_all(root.join(BUNDLE))?;
        std::fs::write(root.join(BUNDLE).join("paper.md"), TEXT)?;
        std::fs::create_dir_all(root.join(".research/cache"))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let cache = json!({ "schema": 1, "entries": { "10.5555/e2e.visual.2024": {
            "checked_at_epoch": now,
            "health": { "kind": "unknown", "checkedAt": "2026-11-15T00:00:00Z" },
        } } });
        std::fs::write(root.join(HEALTH), serde_json::to_vec(&cache)?)?;
        std::fs::write(
            root.join("references.bib"),
            format!("{bibliography}{ENTRY}"),
        )?;
        Ok(Self {
            bibliography,
            health,
        })
    }

    /// Put the project back as it was.
    pub(super) fn restore(self, root: &Path) {
        std::fs::write(root.join("references.bib"), self.bibliography).ok();
        std::fs::remove_dir_all(root.join(BUNDLE)).ok();
        match self.health {
            Some(bytes) => std::fs::write(root.join(HEALTH), bytes).ok(),
            None => std::fs::remove_file(root.join(HEALTH)).ok(),
        };
    }
}

/// The citation card on the page, as one JSON object (null when none).
const CARD: &str = "JSON.stringify((() => { \
    const card = document.querySelector('.citation-hover-card'); \
    if (!card) return null; \
    const text = (selector) => card.querySelector(selector)?.textContent ?? null; \
    return { title: text('.citation-card-title'), authors: text('.citation-card-authors'), \
      facts: [...card.querySelectorAll('.citation-card-fact')].map((node) => node.textContent), \
      uses: text('.citation-card-uses-heading'), \
      rows: [...card.querySelectorAll('.citation-card-use')].map((row) => ({ \
        page: row.querySelector('.citation-card-use-page')?.textContent ?? null, \
        role: row.querySelector('.citation-card-use-role')?.dataset.role ?? null, \
        note: row.querySelector('.citation-card-use-note')?.textContent ?? null })), \
      actions: [...card.querySelectorAll('.citation-card-actions button')].map((button) => button.textContent) }; \
  })())";

/// The centre of what `find` (a JS expression giving an element or a
/// range) covers, in the page's pixels, as `{ x, y }` or null.
fn centre_of(find: &str) -> String {
    format!(
        "JSON.stringify((() => {{ const target = {find}; if (!target) return null; \
         const rect = target.getBoundingClientRect(); \
         return rect.width ? {{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }} : null; }})())"
    )
}

/// The `nth` chip of the key.
fn chip(nth: usize) -> String {
    centre_of(&format!(
        "[...document.querySelectorAll('.cm-latex-visual .lx-tex-cite')].filter((chip) => \
         chip.querySelector('[data-key={KEY:?}]'))[{nth}]"
    ))
}

/// The key as the chip's source writes it, once the caret shows it.
fn key_in_source() -> String {
    centre_of(&format!(
        "(() => {{ const walker = document.createTreeWalker(document.querySelector('.cm-content'), NodeFilter.SHOW_TEXT); \
         for (let node = walker.nextNode(); node; node = walker.nextNode()) {{ \
           const at = node.textContent.indexOf({KEY:?}); \
           if (at < 0 || node.parentElement.closest('.lx-tex-cite')) continue; \
           const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + {len}); return range; }} \
         return null; }})()",
        len = KEY.len()
    ))
}

impl Run {
    /// Where `script` (one of `centre_of`'s) places its target in the
    /// window, once it is there.
    async fn page_point(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        script: &str,
    ) -> Option<Point<Pixels>> {
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            let at = self.evaluate(cx, island, script).await;
            let origin = cx
                .update(|cx| island.read(cx).bounds(cx))
                .map(|bounds| bounds.origin);
            if let (Some(x), Some(y), Some(origin)) = (at["x"].as_f64(), at["y"].as_f64(), origin) {
                return Some(origin + point(px(x as f32), px(y as f32)));
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        None
    }

    /// The page's value for `script` once `done` says so, or the last one.
    async fn page_until(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        script: &str,
        done: impl Fn(&Value) -> bool,
    ) -> Value {
        let mut value = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            value = self.evaluate(cx, island, script).await;
            if done(&value) {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        value
    }

    /// Rest the pointer on the first chip and read its card, once `done`.
    /// WebKit takes no hover from the moves `sendEvent:` hands a window
    /// (a native click or right-click still lands), so the pointer's rest
    /// is the page's own `mousemove` at the chip, which CodeMirror's hover
    /// reads as a pointer's, sent again while no card shows; and the window
    /// is put in front first, where WebKit does not hold back the timer that
    /// card waits on.
    async fn chip_card(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        done: impl Fn(&Value) -> bool,
    ) -> Result<Value> {
        native::order_front(self.native(cx)?);
        let rest = format!(
            "JSON.stringify((() => {{ const at = JSON.parse({chip}); if (!at) return false; \
             const target = document.elementFromPoint(at.x, at.y); if (!target) return false; \
             for (const dx of [-4, 0]) target.dispatchEvent(new MouseEvent('mousemove', \
               {{ bubbles: true, clientX: at.x + dx, clientY: at.y }})); \
             return true; }})())",
            chip = chip(0)
        );
        let mut card = Value::Null;
        for _ in 0..4 {
            if self.evaluate(cx, island, &rest).await != true {
                self.pause(cx, Duration::from_millis(300)).await;
                continue;
            }
            card = self.page_until(cx, island, CARD, &done).await;
            if done(&card) {
                break;
            }
        }
        Ok(card)
    }

    /// Show the first chip's source with a click in it, then right-click
    /// its key: Why cited opens there.
    async fn open_why_cited(&self, cx: &mut AsyncApp, island: &Entity<Island>) -> Result<bool> {
        let native = self.native(cx)?;
        let Some(at) = self.page_point(cx, island, &chip(0)).await else {
            return Ok(false);
        };
        native::send_click(native, at)?;
        let Some(key) = self.page_point(cx, island, &key_in_source()).await else {
            return Ok(false);
        };
        native::send_right_click(native, key)?;
        let open = "JSON.stringify(!!document.querySelector('.citation-reason-popover'))";
        let opened = self
            .page_until(cx, island, open, |open| *open == true)
            .await
            == true;
        // The popover slides in (`drawer-in`): its controls are measured
        // where they come to rest.
        self.pause(cx, Duration::from_millis(600)).await;
        Ok(opened)
    }

    /// The chip's card, and Why cited, Remove and Open paper on its key.
    pub(super) async fn latex_visual_citations(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<Island>,
        path: &Path,
    ) -> Result<()> {
        let root = path.parent().unwrap_or(Path::new("/")).to_path_buf();
        let relative = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let native = self.native(cx)?;
        let card = self
            .chip_card(cx, island, |card| {
                card["uses"].is_string()
                    && card["facts"]
                        .as_array()
                        .is_some_and(|facts| facts.len() == 2)
            })
            .await?;
        let rows = card["rows"].as_array().cloned().unwrap_or_default();
        steps.check(
            "a citation chip's card in the Visual page shows the library's facts as the Tauri app's Visual mode does: the title, the library's authors, Verified by Crossref and the arXiv id, Cited 2× here with the page the second cite names, and Open paper, Go to entry and Copy key",
            card["title"] == "Visual Citations in Practice"
                && card["authors"].as_str().is_some_and(|authors| authors.contains("Lattice Team") && !authors.contains('{'))
                && card["facts"] == json!(["Verified by Crossref", "arXiv 2401.00001"])
                && card["uses"] == "Cited 2× here"
                && rows.len() == 2
                && rows[1]["page"] == "p. 5"
                && card["actions"] == json!(["Open paper", "Go to entry", "Copy key"]),
            json!({ "card": card }),
        );
        self.window_shots(cx, "latex-visual-citation-card").await?;

        // Why cited from the key's source, a role and a note typed in it.
        let opened = self.open_why_cited(cx, island).await?;
        let method =
            centre_of("document.querySelector('.citation-role-chip[data-role=\"method\"]')");
        if opened {
            let chosen = "JSON.stringify(document.querySelector('.citation-role-chip[data-role=\"method\"]')?.getAttribute('aria-checked') === 'true')";
            for _ in 0..3 {
                let Some(role) = self.page_point(cx, island, &method).await else {
                    break;
                };
                native::send_click(native, role)?;
                self.pause(cx, Duration::from_millis(300)).await;
                if self.evaluate(cx, island, chosen).await == true {
                    break;
                }
            }
            // Typed only into the popover's note, never into the text under it.
            let note = "JSON.stringify(document.activeElement?.classList.contains('citation-reason-note') ?? false)";
            let in_note = self
                .page_until(cx, island, note, |focused| *focused == true)
                .await
                == true;
            for character in "Its method".chars().filter(|_| in_note) {
                native::send_key(native, character, false)?;
                self.pause(cx, Duration::from_millis(30)).await;
            }
        }
        self.window_shots(cx, "latex-visual-why-cited").await?;
        if let Some(save) = self
            .page_point(
                cx,
                island,
                &centre_of(
                    "[...document.querySelectorAll('.citation-reason-actions button')].at(-1)",
                ),
            )
            .await
        {
            native::send_click(native, save)?;
        }
        let reason_of = |cx: &gpui::App| {
            store::try_store(cx)?
                .read(cx)
                .notes(&root)?
                .annotations
                .iter()
                .find(|item| {
                    item.path == relative
                        && item.citation.as_ref().is_some_and(|why| why.key == KEY)
                })
                .cloned()
        };
        let filed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| reason_of(cx).is_some())
            .await;
        let reason = cx.update(|cx| reason_of(cx));
        let text = std::fs::read_to_string(path).unwrap_or_default();
        // The first cite's key, in UTF-16 units as the Tauri app stores it.
        let first = text
            .find(&format!("{{{KEY}}}"))
            .map(|at| text[..at + 1].encode_utf16().count() as u32);
        steps.check(
            "a native right-click on a key in the Visual page's chip source opens Why cited, and the role and note saved there file a citation reason on that occurrence in the project's annotations",
            opened
                && filed
                && reason.as_ref().is_some_and(|reason| {
                    reason.citation.as_ref().is_some_and(|why| why.role == "method")
                        && reason.body == "Its method"
                        && reason.quote == KEY
                        && Some(reason.from) == first
                }),
            json!({ "opened": opened, "filed": filed, "reason": reason.as_ref().map(|reason| json!({ "from": reason.from, "quote": reason.quote, "body": reason.body })), "first": first }),
        );

        // The caret out of the chip, so it is drawn again; its card's row says why.
        if let Some(prose) = self
            .page_point(
                cx,
                island,
                &centre_of("document.querySelector('.cm-latex-visual .lx-tex-bold')"),
            )
            .await
        {
            native::send_click(native, prose)?;
        }
        let card = self
            .chip_card(cx, island, |card| card["rows"][0]["role"].is_string())
            .await?;
        steps.check(
            "the chip's card then shows the reason's role and note on that cite's row",
            card["rows"][0]["role"] == "method" && card["rows"][0]["note"] == "Its method",
            json!({ "rows": card["rows"] }),
        );

        // Remove, from Why cited opened again.
        let reopened = self.open_why_cited(cx, island).await? && filed;
        if let Some(remove) = self
            .page_point(
                cx,
                island,
                &centre_of("document.querySelector('.citation-reason-remove')"),
            )
            .await
        {
            native::send_click(native, remove)?;
        }
        let removed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| reason_of(cx).is_none())
            .await;
        steps.check(
            "Why cited's Remove in the Visual page takes the reason out of the project's annotations",
            reopened && removed,
            json!({ "reopened": reopened, "removed": removed }),
        );
        if let Some(prose) = self
            .page_point(
                cx,
                island,
                &centre_of("document.querySelector('.cm-latex-visual .lx-tex-bold')"),
            )
            .await
        {
            native::send_click(native, prose)?;
        }
        self.latex_visual_open_paper(cx, steps, island).await
    }

    /// The card's Open paper hands the key to the Papers panel, which
    /// opens the paper it has the text of in its reader.
    async fn latex_visual_open_paper(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<Island>,
    ) -> Result<()> {
        let papers: Entity<PapersPanel> = cx.update(|cx| self.shell.read(cx).papers().clone());
        let read: Rc<RefCell<Vec<Option<String>>>> = Rc::default();
        let _heard = cx.update(|cx| {
            let read = read.clone();
            cx.subscribe(&papers, move |_, event, _| {
                if let PapersEvent::Read(paper) = event {
                    read.borrow_mut().push(paper.citation_key.clone());
                }
            })
        });
        let card = self
            .chip_card(cx, island, |card| card["actions"][0] == "Open paper")
            .await?;
        let button = centre_of(
            "[...document.querySelectorAll('.citation-hover-card .citation-card-actions button')].find((button) => button.textContent === 'Open paper')",
        );
        if card["actions"][0] == "Open paper"
            && let Some(at) = self.page_point(cx, island, &button).await
        {
            native::send_click(self.native(cx)?, at)?;
        }
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |_, _| !read.borrow().is_empty())
            .await;
        let read = read.borrow().clone();
        steps.check(
            "the Visual card's Open paper opens the library's paper for the key in its reader, as the source card's does",
            opened && read == [Some(KEY.to_string())],
            json!({ "read": read }),
        );
        Ok(())
    }
}
