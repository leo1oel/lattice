//! The e2e checks of the source selection toolbar and highlights
//! (`editor_panel/selection_toolbar.rs`, `highlight_palette.rs`,
//! `lattice_editor::latex::{format_toggle, highlights}`,
//! `lattice_editor::markdown_format`): a word of the chapter selected shows
//! the LaTeX toolbar over it; Bold wraps it in `\textbf` and shows pressed,
//! and Bold again takes it off; the pen highlights it with the palette's
//! yellow, which paints it in the source behind a swatch of its colour, and
//! Remove highlight takes that off; the palette's custom colour takes a
//! drag on its field and Return, and highlights in the colour dragged to;
//! then in a Markdown file a selection shows the Markdown toolbar, whose
//! Bold writes `**…**` and whose block menu makes the line a heading. The
//! chapter and the Markdown file are put back as they were.

use std::{path::Path, time::Duration};

use anyhow::Result;
use editor::SelectionEffects;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const WORD: &str = "introduces";

impl Run {
    pub(super) async fn selection_toolbar(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter)?;
        let editor = self.open(cx, &chapter, Some(1))?;
        self.select_text(cx, &editor, WORD)?;
        let shown = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| editor.read(cx).selection_toolbar_shown())
            .await;
        self.adapter_shot(cx, "selection-toolbar-latex").await;
        steps.check(
            "a LaTeX selection shows the selection toolbar over it",
            shown,
            json!({ "shown": shown }),
        );

        // Bold on, pressed; Bold again, off.
        self.toolbar(cx, &editor, ToolbarStep::Bold)?;
        let bold = self.editor_text(cx, &editor).contains(&format!("\\textbf{{{WORD}}}"));
        let pressed = cx.update(|cx| editor.read(cx).toolbar_pressed_bold(cx));
        self.toolbar(cx, &editor, ToolbarStep::Bold)?;
        let off = self.editor_text(cx, &editor) == original;
        steps.check(
            "Bold wraps the selection in \\textbf and shows pressed; Bold again takes it off",
            bold && pressed && off,
            json!({ "bold": bold, "pressed": pressed, "off": off }),
        );

        // The pen highlights with the yellow highlighter, painted in the source.
        self.select_text(cx, &editor, WORD)?;
        self.toolbar(cx, &editor, ToolbarStep::Pen)?;
        let highlighted = self
            .editor_text(cx, &editor)
            .contains(&format!("\\colorbox[HTML]{{FFF1A6}}{{{WORD}}}"));
        let painted = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor.read(cx).highlights_painted(cx) == 1
            })
            .await;
        let swatch = self.swatch(cx, &editor).await;
        self.adapter_shot(cx, "selection-toolbar-highlight").await;
        self.toolbar(cx, &editor, ToolbarStep::Unhighlight)?;
        let removed = self.editor_text(cx, &editor) == original;
        steps.check(
            "the pen highlights the selection in the yellow highlighter, painted in the source behind a square swatch before its \\colorbox; Remove highlight takes it off",
            highlighted && painted && swatch.is_some() && removed,
            json!({ "highlighted": highlighted, "painted": painted, "swatch": swatch.map(|b| format!("{b:?}")), "removed": removed }),
        );

        // The custom colour: a press on the field and a drag up and right, to
        // 30% saturation and 95% brightness of the field's box, then Return.
        self.select_text(cx, &editor, WORD)?;
        self.toolbar(cx, &editor, ToolbarStep::Custom)?;
        let laid_out = self
            .wait_for(cx, Duration::from_secs(3), |_, cx| {
                editor
                    .read(cx)
                    .custom_picker()
                    .is_some_and(|picker| picker.read(cx).field_bounds().is_some())
            })
            .await;
        let picker = cx.update(|cx| editor.read(cx).custom_picker());
        let field = picker.as_ref().and_then(|picker| cx.update(|cx| picker.read(cx).field_bounds()));
        self.adapter_shot(cx, "selection-toolbar-custom-colour").await;
        let mut dragged = None;
        let mut applied = false;
        if let (Some(picker), Some(field)) = (picker, field) {
            let at = |x: f32, y: f32| {
                gpui::point(field.left() + field.size.width * x, field.top() + field.size.height * y)
            };
            let (start, end) = (at(0.1, 0.5), at(0.3, 0.05));
            self.with_window(cx, |_, window, cx| {
                for event in [
                    gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                        button: gpui::MouseButton::Left,
                        position: start,
                        modifiers: gpui::Modifiers::default(),
                        click_count: 1,
                        first_mouse: false,
                    }),
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position: end,
                        pressed_button: Some(gpui::MouseButton::Left),
                        modifiers: gpui::Modifiers::default(),
                    }),
                    gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                        button: gpui::MouseButton::Left,
                        position: end,
                        modifiers: gpui::Modifiers::default(),
                        click_count: 1,
                    }),
                ] {
                    window.dispatch_event(event, cx);
                }
            })?;
            let (hsv, hex) = cx.update(|cx| (picker.read(cx).hsv(), picker.read(cx).hex(cx)));
            dragged = Some((hsv.s, hsv.v, hex.clone()));
            self.with_window(cx, |_, window, cx| {
                window.dispatch_event(
                    gpui::PlatformInput::KeyDown(gpui::KeyDownEvent {
                        keystroke: gpui::Keystroke::parse("enter").expect("enter parses"),
                        is_held: false,
                        prefer_character_input: false,
                    }),
                    cx,
                )
            })?;
            applied = hex.is_some_and(|hex| {
                hex != "#FFF1A6"
                    && self
                        .editor_text(cx, &editor)
                        .contains(&format!("\\colorbox[HTML]{{{}}}{{{WORD}}}", &hex[1..]))
            });
        }
        let at_drag = dragged
            .as_ref()
            .is_some_and(|(s, v, _)| (s - 30.).abs() < 0.5 && (v - 95.).abs() < 0.5);
        let custom_swatch = self.swatch(cx, &editor).await;
        self.adapter_shot(cx, "selection-toolbar-custom-highlight").await;
        self.toolbar(cx, &editor, ToolbarStep::Unhighlight)?;
        let custom_removed = self.editor_text(cx, &editor) == original;
        steps.check(
            "the palette's custom colour takes a drag on its field to 30% saturation and 95% brightness, and Return highlights the selection in that colour behind its swatch",
            laid_out && at_drag && applied && custom_swatch.is_some() && custom_removed,
            json!({
                "laid_out": laid_out,
                "dragged": dragged.map(|(s, v, hex)| json!({ "s": s, "v": v, "hex": hex })),
                "applied": applied,
                "swatch": custom_swatch.map(|b| format!("{b:?}")),
                "removed": custom_removed,
            }),
        );
        self.save_and_restore(cx, &editor, &chapter, &original).await?;

        // A Markdown selection: the Markdown toolbar's formats and blocks.
        let notes = root.join("notes.md");
        std::fs::write(&notes, "plain words\n")?;
        let markdown = self.open(cx, &notes, Some(1))?;
        self.select_text(cx, &markdown, "plain")?;
        let md_shown = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| markdown.read(cx).selection_toolbar_shown())
            .await;
        self.toolbar(cx, &markdown, ToolbarStep::Bold)?;
        let md_bold = self.editor_text(cx, &markdown).starts_with("**plain** words");
        self.toolbar(cx, &markdown, ToolbarStep::Heading)?;
        let md_heading = self.editor_text(cx, &markdown).starts_with("# **plain** words");
        self.adapter_shot(cx, "selection-toolbar-markdown").await;
        steps.check(
            "a Markdown selection shows the Markdown toolbar; Bold writes **…** and the block menu makes the line a heading",
            md_shown && md_bold && md_heading,
            json!({ "shown": md_shown, "bold": md_bold, "heading": md_heading, "text": self.editor_text(cx, &markdown) }),
        );
        self.save_and_restore(cx, &markdown, &notes, "plain words\n").await?;
        let _ = std::fs::remove_file(&notes);
        Ok(())
    }

    fn select_text(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, quote: &str) -> Result<()> {
        let text = self.editor_text(cx, editor);
        let start = text.find(quote).unwrap_or(0);
        let zed = cx.update(|cx| editor.read(cx).editor().clone());
        self.with_window(cx, |_, window, cx| {
            window.focus(&gpui::Focusable::focus_handle(zed.read(cx), cx), cx);
            zed.update(cx, |zed, cx| {
                zed.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([editor::MultiBufferOffset(start)
                        ..editor::MultiBufferOffset(start + quote.len())])
                })
            })
        })
    }

    /// The swatch painted before the one `\\colorbox` in `editor`, once it
    /// is: square, smaller than a line, standing where the wrapper starts.
    async fn swatch(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Option<gpui::Bounds<gpui::Pixels>> {
        let lattice = cx.update(|cx| editor.read(cx).lattice_editor().clone());
        let wrapper = self.editor_text(cx, editor).find("\\colorbox[HTML]")?;
        let found = |cx: &gpui::App| {
            lattice
                .read(cx)
                .painted()
                .inline
                .iter()
                .find(|(layer, offset, bounds)| {
                    *layer == "highlight-paint-swatches"
                        && *offset == wrapper
                        && (bounds.size.width - bounds.size.height).abs() < gpui::px(0.5)
                        && bounds.size.width > gpui::px(4.)
                        && bounds.size.width < gpui::px(16.)
                })
                .map(|(_, _, bounds)| *bounds)
        };
        self.wait_for(cx, Duration::from_secs(3), |_, cx| found(cx).is_some()).await;
        cx.update(|cx| found(cx))
    }

    fn toolbar(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, step: ToolbarStep) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| editor.scripted_toolbar(step.name(), window, cx))
        })
    }

    /// Put `file` back as it was, in the editor and on disk.
    async fn save_and_restore(
        &self,
        cx: &mut AsyncApp,
        editor: &Entity<EditorPanel>,
        file: &Path,
        text: &str,
    ) -> Result<()> {
        let text = text.to_string();
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let length = editor.text(cx).len();
                editor.replace_range(0, length, &text, 0, window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(1600)).await;
        let _ = file;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum ToolbarStep {
    Bold,
    Pen,
    Unhighlight,
    Heading,
    Custom,
}

impl ToolbarStep {
    fn name(self) -> &'static str {
        match self {
            ToolbarStep::Bold => "bold",
            ToolbarStep::Pen => "pen",
            ToolbarStep::Unhighlight => "unhighlight",
            ToolbarStep::Heading => "heading-1",
            ToolbarStep::Custom => "custom",
        }
    }
}

/// This file's registration as the e2e module `selection_toolbar`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 41,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/selection_toolbar.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/selection_toolbar/tools.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/selection_toolbar/menus.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/highlight_palette.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/highlight_palette/custom.rs",
        "gpui/crates/lattice-ui/src/components/color_picker.rs",
        "gpui/crates/lattice-ui/src/color.rs",
        "gpui/crates/lattice-editor/src/inline_texts.rs",
        "gpui/crates/lattice-editor/src/latex/format_toggle.rs",
        "gpui/crates/lattice-editor/src/latex/highlights.rs",
        "gpui/crates/lattice-editor/src/markdown_format.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.selection_toolbar(cx, steps, &fixture.root)),
};
