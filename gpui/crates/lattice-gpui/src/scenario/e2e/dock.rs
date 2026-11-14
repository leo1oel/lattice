//! The window's own steps on the Trellis workspace (`../shell_steps.rs`) as
//! the e2e module `dock`: the PDF dragged by its tab to the documents' edge
//! and middle with native mouse events, and the layouts that follow.

/// This file's registration as the e2e module `dock` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 10,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/scenario/shell_steps.rs",
        "gpui/crates/trellis/",
        "gpui/crates/lattice-gpui/src/shell/arrange.rs",
        "gpui/crates/lattice-gpui/src/shell/trellis_layout",
    ],
    run: |run, cx, steps, _| {
        Box::pin(async move {
            for (name, passed, detail) in run.shell_steps(cx).await? {
                steps.check(name, passed, detail);
            }
            Ok(())
        })
    },
};
