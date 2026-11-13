//! Settings' four live controls, end to end: the interface size (⌘= / ⌘−
//! / ⌘0 with native keys, the window's layout and scale, the size pill and
//! Settings' own change), interface sounds (a build the writer asked for is
//! heard, turned off it is not, and a running notice settling is heard),
//! spell checking (a misspelling marked and carded, added to the project's
//! dictionary, the setting off and on, the card's words in Simplified
//! Chinese) and translucency (the window's vibrancy and the palette's glass
//! at each strength, or the reason there is none).

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
use lattice_editor::latex::spelling::{self as spelling_check, SpellingEvent};
use lattice_settings::{InterfaceLanguage, Translucency};
use lattice_ui::{ActiveLattice as _, Glass, components::ToastLevel};
use serde_json::json;

use super::{super::Run, Steps};
use crate::{
    notices::{self, Notice},
    settings, sounds,
    window_material::{self, Backing},
};

impl Run {
    pub(super) async fn live_controls(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let before = cx.update(|cx| settings::get(cx).clone());
        self.interface_size(cx, steps).await?;
        self.interface_sounds(cx, steps).await?;
        self.spell_checking(cx, steps).await?;
        self.translucency(cx, steps).await?;
        cx.update(|cx| settings::update(cx, |settings| *settings = before));
        Ok(())
    }

    /// The window's zoom, viewport width and scale factor now.
    fn zoom_state(&self, cx: &mut AsyncApp) -> Result<(f32, f32, f32)> {
        self.with_window(cx, |_, window, _| {
            (
                window.interface_zoom(),
                f32::from(window.viewport_size().width),
                window.scale_factor(),
            )
        })
    }

    pub(super) async fn wait_for_zoom(&self, cx: &mut AsyncApp, zoom: f32) -> bool {
        for _ in 0..60 {
            if self
                .zoom_state(cx)
                .is_ok_and(|(now, _, _)| (now - zoom).abs() < 1e-3)
            {
                return true;
            }
            self.pause(cx, Duration::from_millis(50)).await;
        }
        false
    }

    async fn interface_size(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        cx.update(|cx| settings::update_appearance(cx, |a| a.interface_scale = 1.));
        self.wait_for_zoom(cx, 1.).await;
        let (_, width, scale) = self.zoom_state(cx)?;

        // ⌘= steps up: the window lays out in 1/1.1 of its width, drawn at
        // 1.1 times the scale, and the size pill comes up.
        self.press(cx, '=', true).await?;
        let zoomed = self.wait_for_zoom(cx, 1.1).await;
        let (zoom, zoomed_width, zoomed_scale) = self.zoom_state(cx)?;
        let pill = cx.update(|cx| self.shell.read(cx).zoom_hud().read(cx).is_shown());
        let stored = cx.update(|cx| settings::get(cx).appearance.interface_scale);
        steps.check(
            "⌘= makes the interface larger: the window reflows at 110% and the size pill shows",
            zoomed
                && (stored - 1.1).abs() < 1e-3
                && (zoomed_width * 1.1 - width).abs() < 1.
                && (zoomed_scale - scale * 1.1).abs() < 1e-3
                && pill,
            json!({
                "zoom": zoom, "stored": stored, "width": [width, zoomed_width],
                "scale": [scale, zoomed_scale], "pill": pill,
            }),
        );

        // ⌘− past the smallest size holds at 90%.
        for _ in 0..3 {
            self.press(cx, '-', true).await?;
        }
        let smallest = self.wait_for_zoom(cx, 0.9).await;
        // The pill goes 1.6 s after the last change.
        self.pause(cx, Duration::from_millis(2200)).await;
        let pill_gone = cx.update(|cx| !self.shell.read(cx).zoom_hud().read(cx).is_shown());
        steps.check(
            "⌘− steps down and holds at 90%, and the size pill goes after a moment",
            smallest && pill_gone,
            json!({ "smallest": smallest, "pill_gone": pill_gone }),
        );

        // Settings changes the size without the pill; ⌘0 resets it.
        cx.update(|cx| settings::update_appearance(cx, |a| a.interface_scale = 1.35));
        let from_settings = self.wait_for_zoom(cx, 1.35).await;
        let quiet = cx.update(|cx| !self.shell.read(cx).zoom_hud().read(cx).is_shown());
        self.press(cx, '0', true).await?;
        let reset = self.wait_for_zoom(cx, 1.).await;
        let (_, reset_width, _) = self.zoom_state(cx)?;
        steps.check(
            "Settings sets the size without the pill, and ⌘0 brings the interface back to 100%",
            from_settings && quiet && reset && (reset_width - width).abs() < 0.5,
            json!({
                "from_settings": from_settings, "quiet": quiet, "reset": reset,
                "width": reset_width,
            }),
        );
        Ok(())
    }

    fn played(&self, cx: &mut AsyncApp) -> Vec<(sounds::Cue, f32)> {
        cx.update(|cx| {
            cx.try_global::<sounds::Played>()
                .map(|played| played.0.clone())
                .unwrap_or_default()
        })
    }

    async fn interface_sounds(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        cx.update(|cx| {
            cx.set_global(sounds::Played::default());
            settings::update_appearance(cx, |a| a.interface_sounds = true)
        });
        let (succeeded, _) = self.build(cx).await?;
        // The cue comes as the build's last pass ends.
        self.pause(cx, Duration::from_millis(200)).await;
        let heard = self.played(cx);
        let expected = if succeeded {
            sounds::Cue::Success
        } else {
            sounds::Cue::Error
        };
        steps.check(
            "a build the writer asked for ends in its interface sound",
            heard.len() == 1 && heard[0].0 == expected && heard[0].1 > 0.05,
            json!({ "succeeded": succeeded, "heard": format!("{heard:?}") }),
        );

        cx.update(|cx| settings::update_appearance(cx, |a| a.interface_sounds = false));
        self.build(cx).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let silent = self.played(cx).len() == 1;

        // A notice of an operation under way settling into success.
        cx.update(|cx| {
            settings::update_appearance(cx, |a| a.interface_sounds = true);
            notices::show(
                Notice::new(ToastLevel::Info, "Downloading")
                    .key("e2e-sound")
                    .running(),
                cx,
            );
            notices::show(
                Notice::new(ToastLevel::Success, "Downloaded").key("e2e-sound"),
                cx,
            );
            notices::dismiss("e2e-sound", cx);
        });
        let settled = self.played(cx);
        steps.check(
            "with Interface sounds off a build is silent, and a running notice settling is heard",
            silent && settled.len() == 2 && settled[1].0 == sounds::Cue::Success,
            json!({ "silent": silent, "heard": format!("{settled:?}") }),
        );
        Ok(())
    }

    async fn spell_checking(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        const TEXT: &str = "\nThis is introductiom.\nA sentnce follows.\n";
        let Some(editor) = cx.update(|cx| self.shell.read(cx).active_editor()) else {
            steps.check(
                "spell checking marks a misspelling",
                false,
                json!({ "error": "no editor is open" }),
            );
            return Ok(());
        };
        let Some(spelling) = cx.update(|cx| editor.read(cx).spelling().cloned()) else {
            steps.check(
                "spell checking marks a misspelling",
                false,
                json!({ "error": "the editor has no spell check" }),
            );
            return Ok(());
        };
        let project = cx.update(|cx| self.shell.read(cx).project().cloned());
        let words_before = cx.update(|cx| {
            project
                .as_ref()
                .map(|project| project.read(cx).manifest().spelling_words.clone())
                .unwrap_or_default()
        });
        let buffer = cx.update(|cx| editor.read(cx).lattice_editor().read(cx).buffer().clone());
        cx.update(|cx| {
            buffer.update(cx, |buffer, cx| {
                let end = buffer.len();
                buffer.edit([(end..end, TEXT)], None, cx);
            })
        });
        let flagged = |word: &'static str| {
            let spelling = spelling.clone();
            let buffer = buffer.clone();
            move |_: &gpui::Entity<crate::shell::Shell>, cx: &mut gpui::App| {
                let text = buffer.read(cx).text();
                spelling
                    .read(cx)
                    .findings(cx)
                    .iter()
                    .any(|finding| text.get(finding.range.clone()) == Some(word))
            }
        };
        let marked = self
            .wait_for(cx, Duration::from_secs(10), flagged("introductiom"))
            .await;
        let detail = cx.update(|cx| {
            let text = buffer.read(cx).text();
            let findings = spelling.read(cx).findings(cx);
            let finding = findings
                .iter()
                .find(|finding| text.get(finding.range.clone()) == Some("introductiom"));
            let marks = editor
                .read(cx)
                .lattice_editor()
                .read(cx)
                .mark_ranges(spelling_check::LAYER, cx);
            json!({
                "finding": finding.map(|finding| json!({
                    "severity": format!("{:?}", finding.severity),
                    "source": finding.source,
                    "word": finding.project_word,
                    "message": finding.message,
                })),
                "marked": finding.is_some_and(|finding| marks.contains(&finding.range)),
            })
        });
        steps.check(
            "spell checking marks a misspelling with Harper's red underline and its card",
            marked
                && detail["marked"] == true
                && detail["finding"]["severity"] == "Error"
                && detail["finding"]["source"] == "Harper"
                && detail["finding"]["word"] == "introductiom",
            detail,
        );

        // Add to project dictionary: the manifest takes the word and the
        // mark goes.
        cx.update(|cx| {
            spelling.update(cx, |_, cx| {
                cx.emit(SpellingEvent::AddWord("introductiom".into()))
            })
        });
        let added = self
            .wait_for(cx, Duration::from_secs(10), {
                let flagged = flagged("introductiom");
                let project = project.clone();
                move |shell, cx| {
                    project.as_ref().is_some_and(|project| {
                        project
                            .read(cx)
                            .manifest()
                            .spelling_words
                            .iter()
                            .any(|word| word == "introductiom")
                    }) && !flagged(shell, cx)
                }
            })
            .await;
        steps.check(
            "Add to project dictionary writes the word to the project and clears its mark",
            added,
            json!({}),
        );

        // Off clears every mark; on brings them back.
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_spellcheck = false));
        let off = self
            .wait_for(cx, Duration::from_secs(5), {
                let spelling = spelling.clone();
                move |_, cx| spelling.read(cx).findings(cx).is_empty()
            })
            .await;
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_spellcheck = true));
        let on = self
            .wait_for(cx, Duration::from_secs(10), flagged("sentnce"))
            .await;
        steps.check(
            "turning Check spelling off clears the marks, and on checks again",
            off && on,
            json!({ "off": off, "on": on }),
        );

        // In Simplified Chinese a grammar finding's card names its rule.
        cx.update(|cx| {
            buffer.update(cx, |buffer, cx| {
                let end = buffer.len();
                buffer.edit(
                    [(end..end, "this sentence starts with lowercase prose.\n")],
                    None,
                    cx,
                );
            });
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::ZhCn)
        });
        let grammar = self
            .wait_for(cx, Duration::from_secs(10), {
                let spelling = spelling.clone();
                move |_, cx| {
                    spelling
                        .read(cx)
                        .findings(cx)
                        .iter()
                        .any(|finding| finding.rule.as_deref() == Some("SentenceCapitalization"))
                }
            })
            .await;
        let zh = cx.update(|cx| {
            spelling
                .read(cx)
                .findings(cx)
                .iter()
                .find(|finding| finding.rule.as_deref() == Some("SentenceCapitalization"))
                .map(|finding| {
                    let (rule, detail) = spelling_check::describe(finding);
                    json!({ "rule": rule, "detail": detail, "severity": format!("{:?}", finding.severity) })
                })
        });
        cx.update(|cx| {
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::En)
        });
        let chinese = |value: &serde_json::Value| {
            value
                .as_str()
                .is_some_and(|text| text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)))
        };
        steps.check(
            "a grammar finding is an orange warning, its card in Simplified Chinese naming the rule",
            grammar
                && zh.as_ref().is_some_and(|zh| {
                    zh["severity"] == "Warning" && chinese(&zh["rule"]) && chinese(&zh["detail"])
                }),
            json!({ "grammar": grammar, "zh": zh }),
        );

        // Back as it was: the text, and the project's dictionary.
        cx.update(|cx| {
            buffer.update(cx, |buffer, cx| {
                let text = buffer.text();
                if let Some(at) = text.find(TEXT) {
                    let end = buffer.len();
                    buffer.edit([(at..end, "")], None, cx);
                }
            });
            if let Some(project) = &project {
                settings::set_spelling_words(project, words_before, cx);
            }
        });
        Ok(())
    }

    async fn translucency(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let mut seen = Vec::new();
        let mut passed = true;
        for (level, glass) in [
            (Translucency::Subtle, Glass::Subtle),
            (Translucency::Strong, Glass::Strong),
            (Translucency::Off, Glass::Off),
        ] {
            self.with_window(cx, |_, _, cx| {
                settings::update_appearance(cx, |a| a.translucency = level)
            })?;
            self.pause(cx, Duration::from_millis(200)).await;
            let shown =
                self.with_window(cx, |_, window, _| window_material::material_shown(window))?;
            let state = cx.update(|cx| {
                let palette = cx.palette();
                (
                    window_material::backing(cx),
                    palette.glass,
                    palette.window_material.a,
                    palette.shell.a,
                    palette.navigator.a,
                )
            });
            let (backing, now, window_alpha, shell_alpha, navigator_alpha) = state;
            let ok = match backing {
                Backing::Translucent => {
                    now == glass
                        && shown
                        && window_alpha == 0.
                        && shell_alpha < 0.5
                        && navigator_alpha < 1.
                }
                // Off, Reduce transparency, or not on this platform: opaque.
                Backing::Opaque | Backing::ReducedTransparency | Backing::Unsupported => {
                    now == Glass::Off
                        && !shown
                        && window_alpha == 1.
                        && (level == Translucency::Off || backing != Backing::Opaque)
                }
            };
            passed &= ok;
            seen.push(json!({
                "level": format!("{level:?}"), "backing": format!("{backing:?}"),
                "glass": format!("{now:?}"), "material": shown, "window_alpha": window_alpha,
                "shell_alpha": shell_alpha, "navigator_alpha": navigator_alpha,
            }));
        }
        steps.check(
            "Translucency puts the window's vibrancy behind a frosted shell at Subtle and Strong, and takes it away at Off",
            passed,
            json!(seen),
        );
        Ok(())
    }
}
