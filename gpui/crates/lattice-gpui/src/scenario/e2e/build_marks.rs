//! The broken build's error underlined in the editor, as the Tauri app's
//! linter draws it: on the chapter whose text the build compiled, gone once
//! that text is edited, back when an undo returns it to what was compiled.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn build_marks(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &std::path::Path) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, None)?;
        let id = editor.entity_id();
        let shown = |cx: &mut AsyncApp| cx.update(|cx| self.shell.read(cx).build_marks_shown(id, cx));
        let marked = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).build_marks_shown(id, cx) > 0
            })
            .await;
        let before = shown(cx);
        steps.check(
            "a failed build underlines its error's line in the editor whose text it compiled",
            marked,
            json!({ "marks": before }),
        );

        let buffer = cx.update(|cx| editor.read(cx).lattice_editor().read(cx).buffer().clone());
        cx.update(|cx| buffer.update(cx, |buffer, cx| buffer.edit([(0..0, "%")], None, cx)));
        self.pause(cx, Duration::from_millis(100)).await;
        let edited = shown(cx);
        cx.update(|cx| buffer.update(cx, |buffer, cx| buffer.undo(cx)));
        self.pause(cx, Duration::from_millis(100)).await;
        let undone = shown(cx);
        steps.check(
            "the build's marks go when the text is edited and come back when an undo restores it",
            edited == 0 && undone == before && before > 0,
            json!({ "before": before, "edited": edited, "undone": undone }),
        );
        Ok(())
    }
}

/// This file's registration as the e2e module `build_marks` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Vim,
    rank: 20,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/build_watch.rs",
        "gpui/crates/lattice-editor/src/latex/build_diagnostics.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.build_marks(cx, steps, &fixture.root)),
};
