//! Why a file did not open (`shell/open_failure.rs`) and the bundled
//! reading-aid faces (`lattice-ui/src/fonts.rs`): a text file past the
//! editor's limit is named in an error notice instead of a modal, any other
//! failure is an error notice too, and Atkinson Hyperlegible and
//! OpenDyslexic resolve from the app's own bundle and set the editor.

use std::time::Duration;

use ::settings::Settings as _;
use anyhow::Result;
use gpui::{AsyncApp, font};
use lattice_ui::fonts::READING_AIDS;
use serde_json::json;

use super::{Fixture, Steps};
use crate::{notices, scenario::Run, settings};

impl Run {
    async fn open_failure(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        fixture: &Fixture,
    ) -> Result<()> {
        let stack = cx.update(notices::install);
        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));

        // 9 MiB of plain LaTeX: text, past lattice-core's 8 MiB editor limit.
        let big = fixture.root.join("too-big.tex");
        let line = "% a long comment line that pads the file out past the limit\n";
        let body = line.repeat(9 * 1024 * 1024 / line.len() + 1);
        std::fs::write(&big, &body)?;
        let opened = self.open(cx, &big, None).is_ok();
        self.pause(cx, Duration::from_millis(500)).await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "a text file past the editor's limit is named in an error notice, not opened",
            !opened
                && titles
                    .iter()
                    .any(|title| &**title == "too-big.tex is too large to open in the editor"),
            json!({ "opened": opened, "bytes": body.len(), "titles": titles }),
        );
        self.snapshot(cx, "open-failure-too-large").await;

        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));
        let missing = fixture.root.join("no-such-file.tex");
        let opened = self.open(cx, &missing, None).is_ok();
        self.pause(cx, Duration::from_millis(500)).await;
        let titles = cx.update(|cx| stack.read(cx).titles());
        steps.check(
            "another open failure is an error notice too, and is not called too large",
            !opened
                && titles.len() == 1
                && !titles[0].contains("too large")
                && !titles[0].is_empty(),
            json!({ "opened": opened, "titles": titles }),
        );
        self.snapshot(cx, "open-failure-other").await;
        cx.update(|cx| stack.update(cx, |stack, cx| stack.clear(cx)));
        std::fs::remove_file(&big).ok();

        // The reading aids resolve to their own faces, not a fallback.
        let faces = cx.update(|cx| {
            let text = cx.text_system();
            let names = text.all_font_names();
            READING_AIDS
                .iter()
                .map(|family| {
                    json!({
                        "family": family,
                        "listed": names.iter().any(|name| name == family),
                        "resolves": text.get_font_for_id(text.resolve_font(&font(*family))).map(|face| face.family.to_string()),
                    })
                })
                .collect::<Vec<_>>()
        });
        let missing_face = cx.update(|cx| {
            let text = cx.text_system();
            text.get_font_for_id(text.resolve_font(&font("No Such Reading Aid Face")))
                .map(|face| face.family.to_string())
        });
        steps.check(
            "Atkinson Hyperlegible and OpenDyslexic resolve from the bundle, where an unknown face does not",
            faces.iter().all(|face| face["resolves"] == face["family"])
                && missing_face.as_deref() != Some("No Such Reading Aid Face"),
            json!({ "faces": faces, "unknown_face_resolves": missing_face }),
        );

        let editor = self.open(cx, &fixture.root.join("main.tex"), Some(1))?;
        let was = cx.update(|cx| settings::get(cx).appearance.source_font.clone());
        for family in READING_AIDS {
            cx.update(|cx| {
                settings::update_appearance(cx, |a| a.source_font = family.to_string())
            });
            self.pause(cx, Duration::from_millis(300)).await;
            let applied = cx.update(|cx| {
                let _ = &editor;
                theme_settings::ThemeSettings::get_global(cx)
                    .buffer_font
                    .family
                    .to_string()
            });
            steps.check(
                &format!("choosing {family} for the source sets the editor in it"),
                applied == family,
                json!({ "buffer_font": applied }),
            );
            self.snapshot(cx, &format!("reading-aid-{}", family.replace(' ', "-")))
                .await;
        }
        cx.update(|cx| settings::update_appearance(cx, |a| a.source_font = was));
        Ok(())
    }
}

/// This file's registration as the e2e module `open_failure` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 93,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/open_failure.rs",
        "gpui/crates/lattice-ui/src/fonts.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.open_failure(cx, steps, fixture)),
};
