//! The submission screens of the parity harness (`LATTICE_PARITY_SCREEN`
//! `todos`, `checklist` and `arxivExport`), staged as `design-system/screens/scenes.mjs`
//! stages them on the mock backend:
//!
//! - `todos`: Manuscript TODOs opened from the palette into the documents'
//!   panel. The tutorial has no markers, and the mock backend answers none,
//!   so both show the empty state.
//! - `checklist`: Submission checklist opened from the palette into the
//!   documents' panel, read from the tutorial as the mock backend answers
//!   it (no deadline, no budgets).
//! - `arxivExport`: Export for arXiv… over the window with `?arxiv=ready`
//!   (`tools/perf-bench/bench-arxiv.ts`): a NeurIPS paper whose pack builds
//!   alone, two TODOs among its comments. Its pack is staged here as the
//!   module answers it, in place of the real check of the tutorial.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_core::latex::{
    ArxivCheck, ArxivPackage, Bibliography, CommentLine, Comments, CompileCheck, CompileOutcome,
    PackageFile,
};

use super::{Run, sleep};

/// The bench's `ready` pack, comments removed and `\input` files merged.
fn bench_pack() -> ArxivPackage {
    let file = |path: &str, bytes: u64| PackageFile {
        path: path.into(),
        bytes,
    };
    let files = vec![
        file("figures/attention-heads.pdf", 412_300),
        file("figures/attention-map.pdf", 1_160_000),
        file("figures/training-curve.png", 208_400),
        file("main.bbl", 6_210),
        file("main.tex", 45_180),
        file("neurips_2024.sty", 13_640),
    ];
    let comment = |file: &str, line: u32, text: &str, todo: bool| CommentLine {
        file: file.into(),
        line,
        text: text.into(),
        todo,
    };
    ArxivPackage {
        root_document: "main.tex".into(),
        total_bytes: files.iter().map(|file| file.bytes).sum(),
        figures: files
            .iter()
            .filter(|file| file.path.ends_with(".pdf") || file.path.ends_with(".png"))
            .map(|file| file.path.clone())
            .collect(),
        files,
        size_limit_bytes: 50_000_000,
        left_out: [
            "attention-demo.html",
            "attention-map.tldr",
            "notes.md",
            "references.bib",
            "results.lattice-sheet",
            "slides/",
        ]
        .map(String::from)
        .to_vec(),
        missing: Vec::new(),
        miscased: Vec::new(),
        bibliography: Bibliography::Included {
            file: "main.bbl".into(),
        },
        comments: Comments {
            removed: true,
            count: 27,
            todos: 2,
            lines: vec![
                comment(
                    "main.tex",
                    48,
                    "TODO: tighten the abstract to 150 words",
                    true,
                ),
                comment(
                    "sections/method.tex",
                    112,
                    "TODO: cite the FlashAttention paper here",
                    true,
                ),
                comment("main.tex", 12, "\\usepackage[final]{neurips_2024}", false),
                comment(
                    "sections/introduction.tex",
                    7,
                    "Ana: should this come before the related work?",
                    false,
                ),
                comment(
                    "sections/method.tex",
                    30,
                    "older wording kept for reference",
                    false,
                ),
            ],
        },
        merged: vec![
            "sections/introduction.tex".into(),
            "sections/method.tex".into(),
        ],
        engine: "pdf".into(),
        digest: "bench".into(),
        compile: Some(CompileCheck {
            outcome: CompileOutcome::Ok,
            pages: Some(9),
            duration_ms: 3_100,
            error: None,
            log: None,
        }),
    }
}

impl Run {
    /// Stage the `todos`, `checklist` or `arxivExport` screen; whether it is on screen.
    pub(super) async fn parity_submission(&self, cx: &mut AsyncApp, screen: &str) -> Result<bool> {
        match screen {
            "todos" => {
                self.with_window(cx, |shell, window, cx| {
                    shell.update(cx, |shell, cx| shell.open_todos(window, cx))
                })?;
                sleep(cx, Duration::from_millis(600)).await;
                Ok(cx.update(|cx| self.shell.read(cx).view_on_screen("todos", cx)))
            }
            "checklist" => {
                self.with_window(cx, |shell, window, cx| {
                    shell.update(cx, |shell, cx| shell.open_checklist(window, cx))
                })?;
                let checklist = cx.update(|cx| self.shell.read(cx).checklist.clone());
                for _ in 0..40 {
                    if cx.update(|cx| checklist.read(cx).facts_read()) {
                        break;
                    }
                    sleep(cx, Duration::from_millis(100)).await;
                }
                sleep(cx, Duration::from_millis(600)).await;
                Ok(cx.update(|cx| self.shell.read(cx).view_on_screen("checklist", cx)))
            }
            "arxivExport" => {
                self.with_window(cx, |shell, window, cx| {
                    shell.update(cx, |shell, cx| shell.open_arxiv_export(window, cx))
                })?;
                sleep(cx, Duration::from_millis(300)).await;
                Ok(cx.update(|cx| {
                    let sheet = self
                        .shell
                        .read(cx)
                        .sheets
                        .arxiv
                        .as_ref()
                        .map(|(sheet, _)| sheet.clone());
                    sheet.is_some_and(|sheet| {
                        sheet.update(cx, |sheet, cx| {
                            sheet.stage_for_parity(ArxivCheck::Package(Box::new(bench_pack())), cx)
                        });
                        true
                    })
                }))
            }
            _ => Ok(false),
        }
    }
}
