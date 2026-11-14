//! `shot`: the window at rest, captured for a side-by-side look review.
//!
//! Waits for the project's PDF to show and its pages to draw, then captures
//! the window. Built with the `offscreen-shots` feature, it draws the frame
//! itself and reads it back from Metal, so the screen may be locked and the
//! window covered; otherwise it asks `screencapture -l` for the window
//! server's copy of the window, which needs the window on an unlocked screen.
//!
//! `LATTICE_SHOT_OUT=PATH.png` names the image (default `shot.png`),
//! `LATTICE_APPEARANCE=light|dark` fixes the appearance (see `app.rs`), and
//! `LATTICE_SHOT_BUILD=1` builds the project before the shot.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use serde_json::{Value, json};

use super::{Run, sleep};
use crate::native;

impl Run {
    pub(super) async fn shot(&self, cx: &mut AsyncApp) -> Result<Value> {
        // GPUI stops drawing a window that is fully covered, so the window is
        // put above the others, without taking the keyboard from whatever
        // app has it, for the few seconds the shot takes.
        native::order_front(self.native(cx)?);
        self.park_pointer(cx)?;
        let shown = self.wait_for_pdf(cx).await;
        // `LATTICE_SHOT_BUILD=1` builds first, so the build chip shows a
        // finished build as Paper's Main window does.
        if std::env::var_os("LATTICE_SHOT_BUILD").is_some() {
            self.build(cx).await?;
        }
        // Page images, the editor's highlighting and the fonts settle.
        sleep(cx, Duration::from_millis(2500)).await;
        let out = std::env::var("LATTICE_SHOT_OUT").unwrap_or_else(|_| "shot.png".into());
        self.capture(cx, &out).await?;
        let (pages, editor_theme) = cx.update(|cx| {
            use theme::ActiveTheme as _;
            (
                self.shell.read(cx).pdf().read(cx).page_count(cx),
                cx.theme().name.to_string(),
            )
        });
        Ok(json!({ "png": out, "pdf_shown": shown, "pages": pages, "editor_theme": editor_theme }))
    }

    /// Whether the project's PDF showed within 30 s.
    pub(super) async fn wait_for_pdf(&self, cx: &mut AsyncApp) -> bool {
        self.wait_for(cx, Duration::from_secs(30), |shell, cx| {
            shell.read(cx).pdf().read(cx).page_count(cx) > 0
        })
        .await
    }

    #[cfg(feature = "offscreen-shots")]
    pub(super) async fn capture(&self, cx: &mut AsyncApp, out: &str) -> Result<()> {
        // A covered window gets no frames, so frames are drawn here: each one
        // asks PDFium for the pages it shows, and the images land a little
        // later, so draw until two pages are on screen (or give up after 8 s),
        // then once more for anything the last draw scheduled.
        let started = std::time::Instant::now();
        loop {
            self.with_window(cx, |_, window, cx| {
                window.refresh();
                let _ = window.draw(cx);
            })?;
            sleep(cx, Duration::from_millis(250)).await;
            let drawn = cx.update(|cx| self.shell.read(cx).pdf().read(cx).pages_drawn(cx));
            if drawn >= 2 || started.elapsed() > Duration::from_secs(8) {
                break;
            }
        }
        self.with_window(cx, |_, window, cx| {
            window.refresh();
            let _ = window.draw(cx);
        })?;
        let image = self.with_window(cx, |_, window, _| window.render_to_image())??;
        image.save(out)?;
        Ok(())
    }

    #[cfg(not(feature = "offscreen-shots"))]
    pub(super) async fn capture(&self, cx: &mut AsyncApp, out: &str) -> Result<()> {
        use anyhow::anyhow;
        use std::process::Command;

        let number = native::window_number(self.native(cx)?);
        let status = Command::new("screencapture")
            .args(["-x", "-o", &format!("-l{number}"), out])
            .status()?;
        if !status.success() {
            return Err(anyhow!(
                "screencapture failed ({status}); a locked screen composites no windows, \
                 build with --features offscreen-shots"
            ));
        }
        Ok(())
    }
}
