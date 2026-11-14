//! The broken build's compile repair, as far as a scratch run can take it:
//! the card offers Fix all on the failed build, which locks the editors
//! while the repair starts; a scratch run has no Agent service staged, so
//! the relay refuses it, and the card says why with the editors writable
//! again and Fix all offered once more.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{build::repair::RepairStatus, build_panel::BuildAction, scenario::Run};

impl Run {
    async fn compile_repair(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &std::path::Path) -> Result<()> {
        let editor = self.open(cx, &root.join("chapters/intro.tex"), None)?;
        let read_only = |cx: &mut AsyncApp| cx.update(|cx| editor.read(cx).editor().read(cx).read_only(cx));
        let offered = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            let errors = panel
                .diagnostics()
                .iter()
                .filter(|diagnostic| diagnostic.level == "error")
                .count();
            (errors, panel.repair().is_none(), panel.fix_disabled())
        });
        steps.check(
            "a failed build's card offers Fix all",
            offered.0 > 0 && offered.1 && !offered.2,
            json!({ "errors": offered.0, "no_repair": offered.1, "disabled": offered.2 }),
        );

        cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().clone();
            panel.update(cx, |panel, cx| panel.act(BuildAction::FixAll, cx));
        });
        let started = cx.update(|cx| {
            self.shell
                .read(cx)
                .build_panel()
                .read(cx)
                .repair()
                .map(|repair| repair.status)
        });
        let locked = read_only(cx);
        steps.check(
            "Fix all starts a repair and the editors are read-only while it runs",
            matches!(started, Some(RepairStatus::Starting | RepairStatus::Failed)) && locked,
            json!({ "status": format!("{started:?}"), "read_only": locked }),
        );

        let ended = self
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                shell
                    .read(cx)
                    .build_panel()
                    .read(cx)
                    .repair()
                    .is_some_and(|repair| !repair.busy())
            })
            .await;
        let after = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            panel
                .repair()
                .map(|repair| (repair.status, repair.message.clone(), panel.card_shown(), panel.fix_disabled()))
        });
        let unlocked = !read_only(cx);
        steps.check(
            "without the Agent's service the repair fails, saying why, and the editors are writable again",
            ended
                && unlocked
                && after.as_ref().is_some_and(|(status, message, shown, disabled)| {
                    *status == RepairStatus::Failed
                        && message.as_ref().is_some_and(|message| !message.is_empty())
                        && *shown
                        && !disabled
                }),
            json!({ "ended": ended, "unlocked": unlocked, "after": after.map(|(status, message, shown, disabled)| json!({
                "status": format!("{status:?}"), "message": message, "shown": shown, "disabled": disabled,
            })) }),
        );
        self.snapshot(cx, "compile-repair-failed").await;
        Ok(())
    }
}

/// This file's registration as the e2e module `compile_repair`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Vim,
    rank: 30,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/build_repair.rs",
        "gpui/crates/lattice-gpui/src/build/repair.rs",
        "gpui/crates/lattice-gpui/src/build/card/repair.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.compile_repair(cx, steps, &fixture.root)),
};
