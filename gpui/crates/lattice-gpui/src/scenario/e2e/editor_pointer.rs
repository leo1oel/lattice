//! Pointing at the source editor's text, shared by the checks of its
//! extension points (`editor_adapter`) and of Overleaf's review drawn in it
//! (`overleaf::review_marks`): where a character is on screen, a native
//! pointer coming to rest there, waiting for a hover card to open, and the
//! window saved for a look review.

use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Bounds, Entity, Pixels, Point, point, px};
use lattice_editor::LatticeEditor;

use super::editor_adapter::CARD_WAIT;
use crate::{editor_panel::EditorPanel, native, scenario::Run};

impl Run {
    /// Save the window as `name` under `LATTICE_E2E_SHOTS`, when set.
    pub(in crate::scenario) async fn adapter_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            // A covered window is not drawn: bring it above the others,
            // leaving the keyboard where it is.
            if let Ok(native) = self.native(cx) {
                native::order_front(native);
            }
            // A card or menu that just opened is still rising in.
            self.pause(cx, Duration::from_millis(450)).await;
            let path = std::path::Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
                log::warn!("could not save {}: {error:#}", path.display());
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }

    /// Where `needle`'s `nth` character is on screen, in `panel`'s text,
    /// once the editor has been drawn.
    pub(in crate::scenario) async fn text_point(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        lattice: &Entity<LatticeEditor>,
        needle: &str,
        nth: usize,
    ) -> Result<(usize, Bounds<Pixels>)> {
        let text = self.editor_text(cx, panel);
        let offset = text.find(needle).context("the text is in the file")? + nth;
        let wait_lattice = lattice.clone();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            wait_lattice.read(cx).painted().bounds.is_some()
        })
        .await;
        let lattice = lattice.clone();
        let rect = self
            .with_window(cx, move |_, window, cx| {
                lattice.update(cx, |lattice, cx| lattice.offset_bounds(offset, window, cx))
            })?
            .context("the editor was not drawn")?;
        Ok((offset, rect))
    }

    pub(in crate::scenario) async fn hover_at(
        &self,
        cx: &mut AsyncApp,
        at: Point<Pixels>,
    ) -> Result<()> {
        let native = self.native(cx)?;
        // A short approach, as a hand makes, then the rest.
        native::send_mouse(native, native::Mouse::Moved, point(at.x - px(6.), at.y))?;
        self.pause(cx, Duration::from_millis(30)).await;
        native::send_mouse(native, native::Mouse::Moved, at)
    }

    pub(in crate::scenario) async fn wait_for_card(
        &self,
        cx: &mut AsyncApp,
        lattice: &Entity<LatticeEditor>,
        id: &str,
    ) -> Option<(std::ops::Range<usize>, Option<Bounds<Pixels>>)> {
        let lattice_wait = lattice.clone();
        let wait_id = id.to_string();
        let shown = self
            .wait_for(cx, CARD_WAIT, move |_, cx| {
                let lattice = lattice_wait.read(cx);
                lattice
                    .shown_hover(cx)
                    .iter()
                    .any(|(shown, _)| *shown == wait_id)
                    && lattice.painted().card.is_some()
            })
            .await;
        if !shown {
            return None;
        }
        // A card's first frame is placed before its height is known; its side
        // is settled on the next one, under its entrance.
        self.pause(cx, Duration::from_millis(450)).await;
        cx.update(|cx| {
            let lattice = lattice.read(cx);
            lattice
                .shown_hover(cx)
                .into_iter()
                .find(|(shown, _)| *shown == id)
                .map(|(_, range)| (range, lattice.painted().card))
        })
    }
}
