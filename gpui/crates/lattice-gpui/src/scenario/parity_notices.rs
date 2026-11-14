//! The notices' screen of the parity harness (`LATTICE_PARITY_SCREEN`
//! `toasts`), staged as `design-system/screens/scenes.mjs` stages it: three
//! notices that stay, the error last, so the stack shows its pile with the
//! error in front and the two before it as slivers behind.

use std::time::Duration;

use gpui::AsyncApp;
use lattice_ui::components::ToastLevel;

use super::{Run, sleep};
use crate::notices::{self, Notice};

impl Run {
    pub(super) async fn parity_notices(&self, cx: &mut AsyncApp) {
        cx.update(|cx| {
            notices::show(
                Notice::new(ToastLevel::Info, "Imported 2 items into figures")
                    .source("Project")
                    .persistent(),
                cx,
            );
            notices::show(
                Notice::new(ToastLevel::Warning, "Your TeX packages are out of date")
                    .source("LaTeX setup")
                    .detail(
                        "Updates available (3). Updating asks for administrator approval and can take a few minutes.",
                    )
                    .persistent(),
                cx,
            );
            notices::show(
                Notice::new(ToastLevel::Error, "Build failed")
                    .source("Build")
                    .detail("Undefined control sequence on line 12 of main.tex")
                    .persistent(),
                cx,
            );
        });
        sleep(cx, Duration::from_millis(800)).await;
    }
}
