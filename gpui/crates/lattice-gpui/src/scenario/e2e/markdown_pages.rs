//! The visual editor's page index (`structured/markdown.rs`'s `md:project`
//! and `md:pages-changed`, `MarkdownWorkspaceIndex` in the page), through
//! what the writer sees of it: the `[[page#` completion's headings.
//!
//! - a Markdown page added to the project is offered with its headings;
//! - that page's text changed on disk to a heading of the same length (so
//!   the tree, sizes included, is the same) is offered with the new heading
//!   and without the old one, as the Tauri app's index re-reads it.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{Run, Steps};

/// Ask the `[[e2e-other#` completion again: drop its `#`, and (in a later
/// task, so ProseMirror sees two edits rather than none) type it back, which
/// runs the suggestion's query.
const DROP_HASH: &str = "document.execCommand('delete')";
const TYPE_HASH: &str = "document.execCommand('insertText', false, '#')";
const LABELS: &str = "JSON.stringify([...document.querySelectorAll('.lx-md-menu [role=option] .lx-md-menu-label')].map((node) => node.textContent))";

const PAGE: &str = "# Links\n\nSome text.\n";
const OTHER_BEFORE: &str = "# Other page\n\n## Alpha1\n";
// The same length as OTHER_BEFORE: the tree the host sees is unchanged.
const OTHER_AFTER: &str = "# Other page\n\n## Beta22\n";

impl Run {
    pub(super) async fn markdown_page_index(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let name = "the visual editor's [[page# completion offers a page added to the project, and its new heading once its text changes on disk";
        let path = root.join("e2e-links.md");
        std::fs::write(&path, PAGE)?;
        let panel = self.open(cx, &path, None)?;
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
        let Some(island) = island.filter(|_| drawn) else {
            steps.check(name, false, json!({ "drawn": drawn }));
            return Ok(());
        };

        // What the host tells the page about the project, for the detail.
        self.evaluate(
            cx,
            &island,
            "(() => { window.__e2eHeard = []; const heard = (type, summary) => window.latticeHost.on(type, (payload) => window.__e2eHeard.push([type, summary(payload)])); \
             heard('md:project', (payload) => payload.files.length); heard('md:pages-changed', (payload) => payload.paths); \
             heard('md:assets-changed', () => null); return true; })()",
        )
        .await;
        let other = root.join("e2e-other.md");
        std::fs::write(&other, OTHER_BEFORE)?;
        // Focus the page with a native click and put the caret after "Some".
        let placed = self.markdown_type(cx, &island, "").await?;
        self.evaluate(
            cx,
            &island,
            "document.execCommand('insertText', false, ' [[e2e-other#')",
        )
        .await;
        let added = self.offered(cx, &island, "Alpha1", None).await;

        std::fs::write(&other, OTHER_AFTER)?;
        let changed = self.offered(cx, &island, "Beta22", Some("Alpha1")).await;
        let heard = self
            .evaluate(cx, &island, "JSON.stringify(window.__e2eHeard)")
            .await;

        steps.check(
            name,
            added["found"] == true && changed["found"] == true,
            json!({ "placed": placed, "added": added, "changed": changed, "heard": heard }),
        );

        // Pages the project tree leaves out (installed packages, dotted
        // folders) are not offered, though the watcher reports them; a page
        // of the same name in the tree is, which shows the query works.
        let outside = "Markdown pages outside the project tree (node_modules/, .github/) changed on disk are not offered by [[page#, while a page of the same name in the tree is";
        for (dir, heading) in [("node_modules/e2e-pkg", "Gamma3"), (".github", "Delta4")] {
            std::fs::create_dir_all(root.join(dir))?;
            std::fs::write(
                root.join(dir).join("e2e-ghost.md"),
                format!("# Ghost\n\n## {heading}\n"),
            )?;
        }
        // A page in the tree changes in the same burst, so the host does
        // post `md:pages-changed` for it.
        std::fs::write(&other, OTHER_BEFORE)?;
        let reread = self.offered(cx, &island, "Alpha1", Some("Beta22")).await;
        // Turn `[[e2e-other#` into `[[e2e-ghost#`.
        for _ in 0.."e2e-other#".len() {
            self.evaluate(cx, &island, DROP_HASH).await;
        }
        self.pause(cx, Duration::from_millis(150)).await;
        self.evaluate(
            cx,
            &island,
            "document.execCommand('insertText', false, 'e2e-ghost#')",
        )
        .await;
        self.pause(cx, Duration::from_millis(1500)).await;
        let ghost_labels = self.evaluate(cx, &island, LABELS).await;
        std::fs::write(root.join("e2e-ghost.md"), "# Ghost\n\n## Omega5\n")?;
        let in_tree = self.offered(cx, &island, "Omega5", None).await;
        let heard = self
            .evaluate(cx, &island, "JSON.stringify(window.__e2eHeard)")
            .await;
        let leaked = |labels: &Value| {
            labels.as_array().is_some_and(|labels| {
                labels.iter().any(|label| label == "Gamma3" || label == "Delta4")
            })
        };
        let heard_outside = {
            let heard = heard.to_string();
            heard.contains("node_modules") || heard.contains(".github")
        };
        steps.check(
            outside,
            reread["found"] == true
                && in_tree["found"] == true
                && !leaked(&ghost_labels)
                && !leaked(&in_tree["labels"])
                && !heard_outside,
            json!({ "reread": reread, "ghost_labels": ghost_labels, "in_tree": in_tree, "heard": heard }),
        );
        self.close_panel(cx, &panel).await?;
        Ok(())
    }

    /// Requery the completion until it offers `wanted` (and not `gone`), or
    /// 10 s have passed.
    async fn offered(
        &self,
        cx: &mut AsyncApp,
        island: &Entity<Island>,
        wanted: &str,
        gone: Option<&str>,
    ) -> Value {
        let mut labels = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            self.pause(cx, Duration::from_millis(300)).await;
            self.evaluate(cx, island, DROP_HASH).await;
            self.pause(cx, Duration::from_millis(150)).await;
            self.evaluate(cx, island, TYPE_HASH).await;
            self.pause(cx, Duration::from_millis(150)).await;
            labels = self.evaluate(cx, island, LABELS).await;
            let has = |label: &str| {
                labels
                    .as_array()
                    .is_some_and(|labels| labels.iter().any(|item| item == label))
            };
            if has(wanted) && gone.is_none_or(|gone| !has(gone)) {
                return json!({ "found": true, "labels": labels });
            }
        }
        json!({ "found": false, "labels": labels })
    }
}
