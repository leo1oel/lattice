//! The import conflict dialog (`shell/import_conflict.rs`): an import onto
//! names the folder already has asks once, Keep both first; Replace
//! overwrites the file, Skip leaves it out and says so under the summary.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_core::project::NameConflict;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{notices, scenario::Run, shell::import_conflict};

impl Run {
    async fn import_conflict(&self, cx: &mut AsyncApp, steps: &mut Steps, fixture: &Fixture) -> Result<()> {
        let outside = tempfile_dir()?;
        let name = "conflict-check.txt";
        let source = outside.join(name);
        let landed = fixture.root.join(name);
        std::fs::write(&landed, "old\n")?;
        let host = cx.update(import_conflict::install);
        let stack = cx.update(notices::install);
        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));

        let mut answers = Vec::new();
        for (choice, text) in [(NameConflict::Replace, "replaced\n"), (NameConflict::Skip, "skipped\n")] {
            std::fs::write(&source, text)?;
            let sources = vec![source.to_string_lossy().into_owned()];
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.import_for_scenario(sources, String::new(), window, cx)
                })
            })?;
            let asked = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| host.read(cx).asking().is_some())
                .await;
            let question = cx.update(|cx| host.read(cx).asking());
            self.with_window(cx, |_, window, cx| {
                host.update(cx, |host, cx| host.choose(choice, window, cx))
            })?;
            let done = self
                .wait_for(cx, Duration::from_secs(5), |_, cx| {
                    stack
                        .read(cx)
                        .cards()
                        .iter()
                        .any(|card| card.title.starts_with("Imported") || card.title == "Nothing imported")
                })
                .await;
            let cards = cx.update(|cx| stack.read(cx).cards());
            answers.push(json!({
                "choice": format!("{choice:?}"),
                "asked": asked,
                "question": question.map(|(title, first)| (title.to_string(), format!("{first:?}"))),
                "done": done,
                "on_disk": std::fs::read_to_string(&landed).ok(),
                "notices": cards.iter().map(|card| card.title.clone()).collect::<Vec<_>>(),
            }));
            cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));
        }
        let replaced = answers[0]["asked"] == true
            && answers[0]["question"][1] == "KeepBoth"
            && answers[0]["on_disk"] == "replaced\n";
        let skipped = answers[1]["asked"] == true
            && answers[1]["on_disk"] == "replaced\n"
            && answers[1]["notices"][0] == "Nothing imported";
        steps.check(
            "an import onto a taken name asks once with Keep both first; Replace overwrites it and Skip leaves it, saying nothing was imported",
            replaced && skipped,
            json!({ "answers": answers }),
        );
        std::fs::remove_file(&landed).ok();
        std::fs::remove_dir_all(&outside).ok();
        Ok(())
    }
}

fn tempfile_dir() -> Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("lattice-e2e-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// This file's registration as the e2e module `import_conflict` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 91,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/import_conflict.rs",
        "gpui/crates/lattice-gpui/src/shell/imports.rs",
        "gpui/crates/lattice-ui/src/components/sheet.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.import_conflict(cx, steps, fixture)),
};
