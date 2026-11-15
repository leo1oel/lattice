//! What the Agent is told of the window beyond the source editor
//! (`agent/host_context.rs`, `shell/agent_context.rs`), its turn
//! (`shell/agent_turn.rs`) and Lattice's own writes (`agent/host_writes.rs`):
//!
//! - the compiled PDF's page and page count reach the Agent's context;
//! - text selected in the PDF, with the PDF in focus, is the shared
//!   selection, on the PDF surface; back in the editor, it goes;
//! - a turn the page reports running is the window's, and its start marks
//!   Get started's Agent step; reported over, it is gone;
//! - an image opened over the source, or focused in a split beside it, is
//!   the active file, without a caret, while a tool view such as the
//!   Project tree takes the keyboard;
//! - an Open Slide deck in front is the active file, without a caret, and
//!   its page hears the turn's presence and its end;
//! - switching project mid-turn asks first and keeps the project;
//! - an editor's save is reported to the Agent as Lattice's own write.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _};
use serde_json::{Value, json};

const DECK: &str = include_str!(
    "../../../../../../src-tauri/templates/tutorial/slides/understanding-attention/index.tsx"
);

use super::Steps;
use crate::{
    agent::SurfaceEvent, editor_panel::EditorPanelEvent, scenario::Run,
    shell::trellis_layout::file_key,
};

impl Run {
    pub(super) async fn agent_context(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("main.tex"), Some(1))?;
        let surface = cx.update(|cx| self.shell.read(cx).agent.panel.read(cx).surface().clone());
        let workspace = |cx: &mut AsyncApp| cx.update(|cx| surface.read(cx).workspace().clone());
        self.wait_for_pdf(cx).await;
        let pages = cx.update(|cx| self.shell.read(cx).pdf().read(cx).page_count(cx));
        let placed = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeFile"] == "main.tex"
                    && workspace["pdfPage"] == 1
                    && workspace["pdfPageCount"] == json!(pages)
            })
            .await;
        steps.check(
            "the compiled PDF's page and page count reach the Agent's context",
            placed && pages > 0,
            json!({ "pages": pages, "workspace": workspace(cx) }),
        );

        // Text selected in the PDF, the PDF in focus.
        self.with_window(cx, |shell, window, cx| {
            let panel = shell.read(cx).pdf().clone();
            let view = panel.read(cx).live_view().clone();
            view.update(cx, |view, cx| view.select((0, 0), (0, 40), cx));
            let focus = panel.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        })?;
        let shared = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeSurface"] == "pdf"
                    && workspace["selectionSource"] == "pdf"
                    && workspace["selection"].as_str().is_some_and(|text| !text.is_empty())
            })
            .await;
        steps.check(
            "text selected in the PDF is the Agent's selection, on the PDF surface",
            shared,
            json!({ "workspace": workspace(cx) }),
        );
        self.with_window(cx, |_, window, cx| {
            let focus = editor.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
        })?;
        let back = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeSurface"] == "editor" && workspace.get("selectionSource").is_none()
            })
            .await;
        steps.check(
            "back in the editor, the PDF's selection goes from the Agent's context",
            back,
            json!({ "workspace": workspace(cx) }),
        );
        self.with_window(cx, |shell, _, cx| {
            let view = shell.read(cx).pdf().read(cx).live_view().clone();
            view.update(cx, |view, cx| view.select((0, 0), (0, 0), cx));
        })?;

        // An image opened into the editor's pane: the Agent's active file,
        // with no caret; the source back in front is again.
        let figure = root.join("figure.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([40, 80, 160, 255]))
            .save_with_format(&figure, image::ImageFormat::Png)?;
        self.with_window(cx, {
            let figure = figure.clone();
            move |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.open_path(figure, None, window, cx))
            }
        })?;
        let image_in_front = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeFile"] == "figure.png"
                    && workspace.get("editorPosition").is_none_or(Value::is_null)
            })
            .await;
        let image_workspace = workspace(cx);
        self.open(cx, &root.join("main.tex"), Some(1))?;
        let source_back = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                surface.read(cx).workspace()["activeFile"] == "main.tex"
            })
            .await;
        steps.check(
            "an image opened over the source is the Agent's active file, without a caret, until the source is back",
            image_in_front && source_back,
            json!({ "image": image_workspace, "back": workspace(cx) }),
        );

        // The image in a split beside the source, focused there: the
        // Agent's active file, with no caret; the source focused again is.
        let before = cx.update(|cx| self.shell.read(cx).document(cx));
        let views = cx.update(|cx| {
            let doc = self.shell.read(cx).document(cx);
            let view_of = |key: &str| {
                doc.views
                    .iter()
                    .find(|(_, record)| file_key(Some(record)) == key)
                    .map(|(id, _)| id.clone())
            };
            let source = view_of("main.tex");
            let panel = source.as_ref().and_then(|source| {
                trellis::model::panels_of(doc.root.as_ref())
                    .into_iter()
                    .find(|panel| panel.views.contains(source))
                    .map(|panel| panel.id.clone())
            });
            view_of("figure.png").zip(panel)
        });
        let mut split_front = false;
        let mut split_workspace = Value::Null;
        let mut split_kept = false;
        let mut split_tree = Value::Null;
        if let Some((image, panel)) = views {
            self.with_window(cx, move |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.engine_do(cx, |engine| {
                        engine.dock(
                            &image,
                            Some(trellis::model::DockTarget::Beside {
                                beside: panel,
                                edge: trellis::model::Edge::Right,
                                share: Some(0.5),
                            }),
                        );
                        engine.focus(&image);
                    });
                    shell.focus_view_content(&image, window, cx);
                })
            })?;
            split_front = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    let workspace = surface.read(cx).workspace();
                    workspace["activeFile"] == "figure.png"
                        && workspace.get("editorPosition").is_none_or(Value::is_null)
                })
                .await;
            split_workspace = workspace(cx);
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.show_view("project", true, window, cx);
                    shell.focus_view_content("project", window, cx);
                })
            })?;
            self.pause(cx, Duration::from_millis(300)).await;
            let (tree_focused, tree_workspace) = cx.update(|cx| {
                let focused = self
                    .shell
                    .read(cx)
                    .workspace()
                    .read(cx)
                    .engine()
                    .focused_view()
                    == Some("project");
                (focused, surface.read(cx).workspace().clone())
            });
            split_kept = tree_focused
                && tree_workspace["activeFile"] == "figure.png"
                && tree_workspace
                    .get("editorPosition")
                    .is_none_or(Value::is_null);
            split_tree = json!({ "focused": tree_focused, "workspace": tree_workspace });
        }
        self.open(cx, &root.join("main.tex"), Some(1))?;
        let split_back = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                surface.read(cx).workspace()["activeFile"] == "main.tex"
            })
            .await;
        steps.check(
            "an image focused in a split beside the source is the Agent's active file, without a caret, through the Project tree's focus, until the source is focused again",
            split_front && split_kept && split_back,
            json!({ "image": split_workspace, "tree": split_tree, "back": workspace(cx) }),
        );
        self.with_window(cx, move |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.engine_do(cx, |engine| engine.set_document(before, false))
            })
        })?;
        std::fs::remove_file(&figure).ok();

        // An Open Slide deck in front: the Agent's active file, with no caret.
        let deck = root.join("slides/agent-deck/index.tsx");
        std::fs::create_dir_all(deck.parent().unwrap())?;
        std::fs::write(&deck, DECK)?;
        let opened = self
            .open_structured(cx, &deck, Duration::from_secs(30))
            .await?;
        let in_front = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                let workspace = surface.read(cx).workspace();
                workspace["activeFile"] == "slides/agent-deck/index.tsx"
                    && workspace.get("editorPosition").is_none_or(Value::is_null)
            })
            .await;
        steps.check(
            "an Open Slide deck in front is the Agent's active file, without a caret",
            opened.is_some() && in_front,
            json!({ "workspace": workspace(cx) }),
        );
        let report = "(() => { window.latticeHost?.post('slides:context', \
             { slideId: 'agent-deck', pageIndex: 0, pageNumber: 1, totalPages: 1, slideTitle: '', \
               view: 'slides', pagePath: 'slides/agent-deck/index.tsx', pendingComments: [], \
               pendingEdits: false }); \
             return true; })()";
        if let Some((_, island)) = &opened {
            self.evaluate(cx, island, report).await;
        }
        let presented = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                surface.read(cx).workspace()["presentation"]["pagePath"]
                    == "slides/agent-deck/index.tsx"
            })
            .await;
        steps.check(
            "the deck's reported slide is the Agent's presentation context while it is in front",
            presented,
            json!({ "workspace": workspace(cx) }),
        );
        let listen = "(() => { if (!window.latticeHost) return false; \
             if (!window.__e2eDeck) { window.__e2eDeck = []; \
               window.latticeHost.on('agent:deck-presence', (p) => window.__e2eDeck.push(p)); } \
             return true; })()";
        let heard = "JSON.stringify(window.__e2eDeck || null)";
        if let Some((_, island)) = &opened {
            self.evaluate(cx, island, listen).await;
        }

        // The panel's turn, as its page reports it.
        let presence = json!({ "state": "running", "threadId": "t", "decks": [] });
        cx.update(|cx| {
            surface.update(cx, |_, cx| {
                cx.emit(SurfaceEvent::Turn(Some(presence)));
                cx.emit(SurfaceEvent::TurnStarted);
            })
        });
        self.pause(cx, Duration::from_millis(100)).await;
        let (running, marked) = cx.update(|cx| {
            (
                self.shell.read(cx).agent_turn_running(),
                crate::get_started::progress::global_read(cx)
                    .is_some_and(|progress| progress.is_done(crate::get_started::Step::Agent)),
            )
        });
        let mut lit = Value::Null;
        if let Some((_, island)) = &opened {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                lit = self.evaluate(cx, island, heard).await;
                if lit.as_array().is_some_and(|told| {
                    told.last().is_some_and(|last| last["state"] == "running")
                }) {
                    break;
                }
                self.pause(cx, Duration::from_millis(100)).await;
            }
        }
        steps.check(
            "the open deck's page hears the running turn's presence",
            lit.as_array()
                .is_some_and(|told| told.last().is_some_and(|last| last["state"] == "running")),
            json!({ "heard": lit }),
        );
        self.island_shot(cx, "agent-turn-deck").await?;

        // Switching project mid-turn asks first, and stays put.
        let other = root.with_file_name("agent-other-project");
        std::fs::create_dir_all(&other)?;
        std::fs::write(other.join("main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}\n")?;
        let before = cx.update(|cx| self.shell.read(cx).root(cx));
        self.with_window(cx, |shell, window, cx| {
            let other = other.clone();
            shell.update(cx, |shell, cx| shell.open_project(other, window, cx));
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (asked, question, after) = cx.update(|cx| {
            let host = crate::confirm::install(cx);
            (
                crate::confirm::is_pending(cx),
                host.read(cx).question().map(|title| title.to_string()),
                self.shell.read(cx).root(cx),
            )
        });
        // Answer it away without switching.
        self.with_window(cx, |_, window, cx| {
            crate::confirm::ask(crate::confirm::Confirm::new("e2e").on_confirm(|_, _| {}), cx);
            crate::confirm::install(cx).update(cx, |host, cx| host.accept(window, cx));
        })?;
        steps.check(
            "switching project during the Agent's turn asks before interrupting it, and the project stays until answered",
            asked
                && question.as_deref().is_some_and(|title| title.starts_with("Switch away"))
                && before.is_some()
                && after == before,
            json!({ "asked": asked, "question": question, "before": before, "after": after }),
        );

        cx.update(|cx| surface.update(cx, |_, cx| cx.emit(SurfaceEvent::Turn(None))));
        self.pause(cx, Duration::from_millis(100)).await;
        let over = cx.update(|cx| !self.shell.read(cx).agent_turn_running());
        let mut ended = Value::Null;
        if let Some((_, island)) = &opened {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                ended = self.evaluate(cx, island, heard).await;
                if ended.as_array().is_some_and(|told| told.last().is_some_and(Value::is_null)) {
                    break;
                }
                self.pause(cx, Duration::from_millis(100)).await;
            }
        }
        steps.check(
            "a running turn is the window's until the page reports it over, and its start marks Get started's Agent step",
            running && marked && over,
            json!({ "running": running, "marked": marked, "over": over }),
        );
        steps.check(
            "the turn over, the deck's page hears its presence cleared",
            ended.as_array().is_some_and(|told| told.last().is_some_and(Value::is_null)),
            json!({ "heard": ended }),
        );
        if let Some((panel, _)) = &opened {
            self.close_panel(cx, panel).await?;
        }

        // A build running alone, with no turn and no terminal command, also
        // asks before the switch interrupts it (`confirmLeavingProject`).
        let before = cx.update(|cx| self.shell.read(cx).root(cx));
        let (alone, settled) = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                let settled = shell.build_and_settle(window, cx);
                let alone = shell.building()
                    && !shell.agent_turn_running()
                    && shell.terminal.read(cx).running(None, cx).is_empty();
                shell.open_project(other.clone(), window, cx);
                (alone, settled)
            })
        })?;
        let (asked, question, after) = cx.update(|cx| {
            let host = crate::confirm::install(cx);
            (
                crate::confirm::is_pending(cx),
                host.read(cx).question().map(|title| title.to_string()),
                self.shell.read(cx).root(cx),
            )
        });
        self.with_window(cx, |_, window, cx| {
            crate::confirm::ask(crate::confirm::Confirm::new("e2e").on_confirm(|_, _| {}), cx);
            crate::confirm::install(cx).update(cx, |host, cx| host.accept(window, cx));
        })?;
        settled.await;
        steps.check(
            "switching project while only a build runs asks before interrupting it, and the project stays",
            alone
                && asked
                && question.as_deref().is_some_and(|title| title.starts_with("Switch away"))
                && before.is_some()
                && after == before,
            json!({ "alone": alone, "asked": asked, "question": question, "before": before, "after": after }),
        );
        std::fs::remove_dir_all(root.join("slides/agent-deck")).ok();
        std::fs::remove_dir_all(&other).ok();
        let editor = self.open(cx, &root.join("main.tex"), None)?;

        // The writer's save, beside a turn.
        let before = cx.update(|cx| surface.read(cx).host_writes_reported());
        cx.update(|cx| editor.update(cx, |_, cx| cx.emit(EditorPanelEvent::Saved)));
        self.pause(cx, Duration::from_millis(100)).await;
        let writes: Vec<String> = cx.update(|cx| {
            surface
                .read(cx)
                .host_writes_since(before)
                .cloned()
                .collect()
        });
        steps.check(
            "an editor's save is reported to the Agent as Lattice's own write",
            writes.iter().any(|path| path == "main.tex"),
            json!({ "before": before, "writes": writes }),
        );
        Ok(())
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 31,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/agent/host_context.rs",
        "gpui/crates/lattice-gpui/src/agent/host_writes.rs",
        "gpui/crates/lattice-gpui/src/shell/agent_context.rs",
        "gpui/crates/lattice-gpui/src/shell/agent_turn.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.agent_context(cx, steps, &fixture.root)),
};
