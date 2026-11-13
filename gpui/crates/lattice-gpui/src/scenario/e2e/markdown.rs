//! A Markdown file (`editor_panel/markdown_view.rs`, `structured/markdown.rs`),
//! written into the scratch project with front matter, a table, maths, an
//! image, a task list, a quote and a fenced block:
//!
//! - its source is Markdown, highlighted by the block and inline grammars as
//!   the Tauri app's Markdown mode styles it (a heading, a strong run);
//! - it opens in Split (the Tauri app's default for Markdown), with the
//!   Edit / Split / Preview switch, and its visual editor (the Tauri app's
//!   engine, in the markdown island) draws the document: the heading, KaTeX's
//!   maths, the table, the image through the asset protocol, and not the
//!   front matter;
//! - opening it writes nothing: the file on disk is the same bytes, and the
//!   buffer is clean;
//! - a word typed into the visual editor with native keys lands in the file
//!   as exactly that word, every other byte as it was (front matter, table
//!   and maths included); ⌘Z typed there undoes it through the buffer, and the
//!   file is back to its first bytes;
//! - text typed into the source appears in the visual editor;
//! - Preview shows the visual editor alone, which takes a jump to a line;
//! - a word typed into the visual editor just before its tab closes is in
//!   the file once the tab has gone;
//! - hidden past the (shortened) hibernation delay the page is torn down,
//!   and drawn again with the document when shown.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use language::{LanguageAwareStyling, Point};
use lattice_webview::{Island, IslandState};
use serde_json::{Value, json};
use theme::ActiveTheme as _;

use super::{Run, Steps};
use crate::{
    editor_panel::{DocumentView, EditorPanel},
    native,
};

const NOTES: &str = "---
title: Field notes
tags: [gpui, markdown]
---

# Attention notes

Some **bold** text, *italic*, `code`, and a [link](https://example.com).

![A dot](figures/e2e-dot.png)

| Model | Score |
| --- | --- |
| Base | 1 |

Inline math $e^{i\\pi} + 1 = 0$ and a display:

$$
\\int_0^1 x\\,dx = \\tfrac12
$$

- [ ] a task
- an item

> a quote

```python
print(\"hi\")
```
";

/// A 4×4 opaque PNG, so the image has a size once it loads.
const DOT_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x26, 0x93, 0x09,
    0x29, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xd0, 0xca, 0xbf, 0x06,
    0x47, 0x0c, 0xc4, 0x71, 0x00, 0x49, 0xf2, 0x16, 0xf1, 0x58, 0xf8, 0x6b, 0xea, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// Put the visual editor's caret at the end of the paragraph holding `text`.
fn caret_after(text: &str) -> String {
    format!(
        "(() => {{ const p = [...document.querySelectorAll('.lx-md-surface p')].find((node) => node.textContent.includes({text:?})); \
         if (!p) return 'missing'; const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let last = null; \
         while (walker.nextNode()) last = walker.currentNode; if (!last) return 'empty'; \
         const range = document.createRange(); range.setStart(last, last.length); range.collapse(true); \
         const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); \
         return 'placed'; }})()"
    )
}

impl Run {
    pub(super) async fn markdown_island(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        std::fs::create_dir_all(root.join("figures"))?;
        std::fs::write(root.join("figures/e2e-dot.png"), DOT_PNG)?;
        let path = root.join("e2e-notes.md");
        std::fs::write(&path, NOTES)?;
        let panel = self.open(cx, &path, None)?;

        self.markdown_source(cx, steps, &panel).await;
        let Some(island) = self.markdown_drawn(cx, steps, &panel).await else {
            return Ok(());
        };

        // Opening writes nothing.
        self.pause(cx, Duration::from_millis(1500)).await;
        let unchanged = std::fs::read_to_string(&path).is_ok_and(|text| text == NOTES);
        let clean = cx.update(|cx| !panel.read(cx).is_dirty(cx));
        steps.check(
            "opening a Markdown file in its visual editor leaves the file's bytes and the buffer as they were",
            unchanged && clean,
            json!({ "unchanged": unchanged, "clean": clean }),
        );

        self.markdown_visual_edit(cx, steps, &path, &island).await?;
        self.markdown_source_edit(cx, steps, &panel, &island)
            .await?;
        self.markdown_preview(cx, steps, &panel, &island).await?;
        self.markdown_moved(cx, steps, root, &island).await?;
        self.markdown_close_and_hibernate(cx, steps, root, &path, &panel, &island)
            .await?;
        self.markdown_split_scroll(cx, steps, root).await?;
        self.markdown_page_index(cx, steps, root).await?;
        Ok(())
    }

    /// The source's language and two of its highlights: a heading (the block
    /// grammar) and a strong run (the inline grammar, by injection).
    /// The buffer parses off the main thread, its injections after it: the
    /// highlights are read again until both are there, or 5 s have gone.
    async fn markdown_source(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
    ) {
        let started = std::time::Instant::now();
        let (language, heading, strong) = loop {
            let read = cx.update(|cx| {
                let buffer = panel
                    .read(cx)
                    .editor()
                    .read(cx)
                    .buffer()
                    .read(cx)
                    .as_singleton();
                let Some(buffer) = buffer else {
                    return (None, None, None);
                };
                let snapshot = buffer.read(cx).snapshot();
                let syntax = cx.theme().syntax().clone();
                let capture = |row: u32, needle: &str| {
                    let end = Point::new(row, snapshot.line_len(row));
                    snapshot
                        .chunks(
                            Point::new(row, 0)..end,
                            LanguageAwareStyling {
                                tree_sitter: true,
                                diagnostics: false,
                            },
                        )
                        .find(|chunk| chunk.text.contains(needle))
                        .and_then(|chunk| chunk.syntax_highlight_id)
                        .and_then(|id| syntax.get_capture_name(id).map(str::to_string))
                };
                (
                    snapshot
                        .language()
                        .map(|language| language.name().to_string()),
                    capture(5, "Attention"),
                    capture(7, "bold"),
                )
            });
            if (read.1.is_some() && read.2.is_some()) || started.elapsed() > Duration::from_secs(5)
            {
                break read;
            }
            self.pause(cx, Duration::from_millis(100)).await;
        };
        steps.check(
            "a .md file's source is Markdown: a heading in the heading style, a strong run (the injected inline grammar) in the strong one",
            language.as_deref() == Some("Markdown")
                && heading.as_deref() == Some("markup.heading")
                && strong.as_deref() == Some("emphasis.strong"),
            json!({ "language": language, "heading": heading, "strong": strong }),
        );
    }

    /// Wait for the visual editor in Split, and check what it draws.
    async fn markdown_drawn(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
    ) -> Option<Entity<Island>> {
        let view = cx.update(|cx| panel.read(cx).document_view());
        let drawn = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                panel
                    .read(cx)
                    .markdown_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        let island = cx.update(|cx| {
            panel
                .read(cx)
                .markdown_document()
                .and_then(|document| document.read(cx).island().cloned())
        });
        let Some(island) = island.clone().filter(|_| drawn) else {
            // Where the page stopped: its document, whether React mounted and
            // drew anything, and the island's state.
            let page = match &island {
                Some(island) => {
                    self.evaluate(
                        cx,
                        island,
                        "JSON.stringify({ href: location.href, ready: document.readyState, \
                         root: document.getElementById('root')?.innerHTML.length ?? null, \
                         visibility: document.visibilityState })",
                    )
                    .await
                }
                None => Value::Null,
            };
            let state = cx.update(|cx| {
                island
                    .as_ref()
                    .map(|island| format!("{:?}", island.read(cx).state()))
            });
            steps.check(
                "a .md file opens in Split with its visual editor drawn",
                false,
                json!({ "view": format!("{view:?}"), "drawn": drawn, "state": state, "page": page }),
            );
            return None;
        };
        // The image loads through the asset protocol once the page asks for it.
        let mut facts = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            facts = self
                .evaluate(
                    cx,
                    &island,
                    "JSON.stringify({ editor: !!document.querySelector('.lx-md-editor'), \
                     heading: document.querySelector('.lx-md-surface h1')?.textContent ?? null, \
                     frontMatter: (document.querySelector('.lx-md-surface')?.textContent ?? '').includes('Field notes'), \
                     katex: document.querySelectorAll('.lx-md-surface .katex').length, \
                     table: !!document.querySelector('.lx-md-surface table'), \
                     image: document.querySelector('.lx-md-image img')?.naturalWidth ?? -1, \
                     imageSrc: document.querySelector('.lx-md-image img')?.getAttribute('src') ?? null, \
                     theme: document.documentElement.dataset.theme || null, \
                     scroller: !!document.querySelector('.markdown-preview .editor-doc-scroll') })",
                )
                .await;
            if facts["image"].as_i64().is_some_and(|width| width > 0) {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        let (state, visible) = cx.update(|cx| {
            let island = island.read(cx);
            (island.state().clone(), island.native_visible(cx))
        });
        steps.check(
            "a .md file opens in Split, its visual editor drawing the heading, KaTeX's maths, the table and the image (through the asset protocol), and not the front matter",
            view == Some(DocumentView::Split)
                && state == IslandState::Ready
                && visible
                && facts["editor"] == true
                && facts["heading"] == "Attention notes"
                && facts["frontMatter"] == false
                && facts["katex"].as_u64().is_some_and(|count| count >= 2)
                && facts["table"] == true
                && facts["image"] == 4
                && facts["imageSrc"]
                    .as_str()
                    .is_some_and(|src| src.starts_with("lattice://island/asset/figures/e2e-dot.png"))
                && facts["theme"].is_string()
                && facts["scroller"] == true,
            json!({ "view": format!("{view:?}"), "state": format!("{state:?}"), "visible": visible, "page": facts }),
        );
        Some(island)
    }

    /// Type into the visual editor with native keys at the end of the first
    /// paragraph; then undo it with ⌘Z there.
    pub(super) async fn markdown_type(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        text: &str,
    ) -> Result<Value> {
        let Some(bounds) = cx.update(|cx| island.read(cx).bounds(cx)) else {
            return Ok(json!("no bounds"));
        };
        let native = self.native(cx)?;
        native::send_click(native, bounds.center())?;
        self.wait_for(cx, Duration::from_secs(3), |_, cx| {
            island.read(cx).page_focused()
        })
        .await;
        let placed = self.evaluate(cx, island, &caret_after("Some")).await;
        self.pause(cx, Duration::from_millis(150)).await;
        for character in text.chars() {
            native::send_key(native, character, false)?;
            self.pause(cx, Duration::from_millis(40)).await;
        }
        Ok(placed)
    }

    async fn markdown_visual_edit(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        path: &Path,
        island: &Entity<Island>,
    ) -> Result<()> {
        let placed = self.markdown_type(cx, island, " quokka").await?;
        let expected = NOTES.replacen(
            "[link](https://example.com).",
            "[link](https://example.com). quokka",
            1,
        );
        let saved = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(path).is_ok_and(|text| text.contains("quokka"))
            })
            .await;
        let text = std::fs::read_to_string(path).unwrap_or_default();
        steps.check(
            "a word typed into the visual editor with native keys is saved as exactly that word, every other byte of the file (front matter, table, maths) as it was",
            saved && text == expected,
            json!({ "placed": placed, "saved": saved, "exact": text == expected, "text": if text == expected { Value::Null } else { json!(text) } }),
        );

        // ⌘Z in the page undoes through the buffer; the file is back.
        let native = self.native(cx)?;
        native::send_key(native, 'z', true)?;
        let undone = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(path).is_ok_and(|text| text == NOTES)
            })
            .await;
        // The page takes the buffer's text once it settles (200 ms).
        let mut page = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            page = self
                .evaluate(
                    cx,
                    island,
                    "JSON.stringify({ quokka: (document.querySelector('.lx-md-surface')?.textContent ?? '').includes('quokka') })",
                )
                .await;
            if page["quokka"] == false {
                break;
            }
            self.pause(cx, Duration::from_millis(150)).await;
        }
        steps.check(
            "⌘Z typed in the visual editor undoes the word through the buffer: the file and the page are back as they were",
            undone && page["quokka"] == false,
            // The file as ⌘Z left it, when it is not back: a partial undo
            // (the word split over two of the buffer's undo groups) shows here.
            json!({
                "undone": undone,
                "page": page,
                "text": if undone { Value::Null } else { json!(std::fs::read_to_string(path).unwrap_or_default()) },
            }),
        );
        Ok(())
    }

    async fn markdown_source_edit(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                let editor = panel.read(cx).editor().clone();
                editor.update(cx, |editor, cx| {
                    editor.move_to_end(&editor::actions::MoveToEnd, window, cx);
                    editor.insert("\nWritten in the source.\n", window, cx);
                });
            }
        })?;
        let mut followed = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(6) {
            followed = self
                .evaluate(
                    cx,
                    island,
                    "JSON.stringify((document.querySelector('.lx-md-surface')?.textContent ?? '').includes('Written in the source.'))",
                )
                .await;
            if followed == true {
                break;
            }
            self.pause(cx, Duration::from_millis(150)).await;
        }
        steps.check(
            "text typed into the source appears in the visual editor once typing settles",
            followed == true,
            json!({ "followed": followed }),
        );
        Ok(())
    }

    async fn markdown_preview(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    panel.set_document_view(DocumentView::Preview, window, cx);
                    // A jump to the quote's line lands in the visual editor.
                    panel.go_to_line(25, window, cx);
                });
            }
        })?;
        self.pause(cx, Duration::from_millis(600)).await;
        let landed = self
            .evaluate(
                cx,
                island,
                "JSON.stringify((() => { const selection = window.getSelection(); \
                 const node = selection && selection.anchorNode; \
                 const element = node && (node.nodeType === 1 ? node : node.parentElement); \
                 return !!(element && element.closest('blockquote')); })())",
            )
            .await;
        let (view, visible) = cx.update(|cx| {
            (
                panel.read(cx).document_view(),
                island.read(cx).native_visible(cx),
            )
        });
        steps.check(
            "Preview shows the visual editor alone, and a jump to a line lands there",
            view == Some(DocumentView::Preview) && visible && landed == true,
            json!({ "view": format!("{view:?}"), "visible": visible, "landed": landed }),
        );
        Ok(())
    }

    /// The image as the visual editor holds it: the link its document names
    /// (the image node's `src`, read from the editor Tiptap hangs on its
    /// surface), the URL it was resolved to, and its natural width.
    async fn markdown_image(&self, cx: &mut AsyncApp, island: &Entity<Island>) -> Value {
        self.evaluate(
            cx,
            island,
            "JSON.stringify((() => { let link = null; \
             document.querySelector('.lx-md-surface')?.editor?.state.doc.descendants((node) => { \
               if (link === null && node.type.name === 'image') link = node.attrs.src ?? null; }); \
             const img = document.querySelector('.lx-md-image img'); \
             return { link, src: img?.getAttribute('src') ?? null, width: img?.naturalWidth ?? -1 }; })())",
        )
        .await
    }

    /// Moved in the tree, the document keeps showing the same figure: the
    /// move rebases its relative image link to point at the same file from
    /// the new folder (the Tauri app's `rewriteMovedDocumentAssetPaths`),
    /// and the visual editor resolves that link from the document's new
    /// folder (a relative link is relative to the document, CommonMark).
    /// `drafts/figures/` holds a figure of the same name, so a page that
    /// took the new path but kept the old link would show that one instead;
    /// a page that kept the old path would find no file for `../figures/…`.
    async fn markdown_moved(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        island: &Entity<Island>,
    ) -> Result<()> {
        std::fs::create_dir_all(root.join("drafts/figures"))?;
        std::fs::write(root.join("drafts/figures/e2e-dot.png"), DOT_PNG)?;
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        let figure = "lattice://island/asset/figures/e2e-dot.png";
        let mut results = Vec::new();
        for (from, target, moved_to, link) in [
            ("e2e-notes.md", "drafts", "drafts/e2e-notes.md", "../figures/e2e-dot.png"),
            ("drafts/e2e-notes.md", "", "e2e-notes.md", "figures/e2e-dot.png"),
        ] {
            cx.update(|cx| {
                tree.update(cx, |tree, cx| tree.drop_on(from.into(), target.into(), cx))
            });
            let followed = self
                .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                    root.join(moved_to).is_file()
                        && shell
                            .read(cx)
                            .active_editor_path(cx)
                            .is_some_and(|path| path == moved_to)
                })
                .await;
            let on_disk = std::fs::read_to_string(root.join(moved_to))
                .is_ok_and(|text| text.contains(&format!("![A dot]({link})")));
            let shown = |image: &Value| {
                image["link"] == link
                    && image["src"]
                        .as_str()
                        .is_some_and(|src| src.starts_with(figure))
                    && image["width"] == 4
            };
            let mut image = Value::Null;
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(15) {
                image = self.markdown_image(cx, island).await;
                if shown(&image) {
                    break;
                }
                self.pause(cx, Duration::from_millis(200)).await;
            }
            let resolved = shown(&image);
            results.push(json!({
                "to": moved_to, "followed": followed, "on_disk": on_disk,
                "resolved": resolved, "image": image,
            }));
        }
        steps.check(
            "a Markdown file moved in the tree and back: its image link is rebased to the same figure, and the visual editor resolves it from the file's new folder",
            results.iter().all(|result| {
                result["followed"] == true && result["on_disk"] == true && result["resolved"] == true
            }),
            json!(results),
        );
        Ok(())
    }

    async fn markdown_close_and_hibernate(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        path: &Path,
        panel: &Entity<EditorPanel>,
        island: &Entity<Island>,
    ) -> Result<()> {
        // Hidden past the delay: torn down, and back with the document.
        cx.update(|cx| lattice_webview::set_hibernate_after(Some(Duration::from_millis(1500)), cx));
        self.open(cx, &root.join("chapters/intro.tex"), None)?;
        let hibernated = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                *island.read(cx).state() == IslandState::Hibernated
            })
            .await;
        let reopened = self.open(cx, path, None)?;
        let woke = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                reopened
                    .read(cx)
                    .markdown_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        cx.update(|cx| lattice_webview::set_hibernate_after(None, cx));
        let page = self
            .evaluate(
                cx,
                island,
                "JSON.stringify((document.querySelector('.lx-md-surface')?.textContent ?? '').includes('Written in the source.'))",
            )
            .await;
        steps.check(
            "the visual editor hidden past the delay hibernates, and is drawn again with the document when shown",
            hibernated && woke && reopened == *panel && page == true,
            json!({ "hibernated": hibernated, "woke": woke, "page": page }),
        );

        // A word typed just before the tab closes is in the file.
        self.markdown_type(cx, island, " zebra").await?;
        self.close_panel(cx, panel).await?;
        let kept = self
            .wait_for(cx, Duration::from_secs(10), |_, _| {
                std::fs::read_to_string(path).is_ok_and(|text| text.contains("zebra"))
            })
            .await;
        steps.check(
            "a word typed into the visual editor just before its tab closes is in the file once the tab has gone",
            kept,
            json!({ "kept": kept }),
        );
        Ok(())
    }
}
