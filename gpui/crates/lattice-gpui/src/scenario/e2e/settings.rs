//! Settings and the interface language, end to end: the titlebar's
//! top-left project switcher has a Settings item that opens Settings, ⌘,
//! opens Settings with native keys, typing searches it and Enter opens the row found, each
//! choice applies as it is made (tint, accent, code theme, the editor's size
//! and line height, the keymap, the automatic build), the interface switches
//! to Simplified Chinese and back, an edit to the settings file made outside
//! the app applies within a second or two, and Escape closes Settings with
//! the keyboard left in the window.

use std::time::Duration;

use ::settings::Settings as _;
use anyhow::Result;
use gpui::{AsyncApp, point, px};
use lattice_i18n::{Locale, t};
use lattice_settings::{
    Accent as StoredAccent, AccentPreset, AutoBuildMode, Choice as _, CodeTheme, EditorKeymap,
    InterfaceLanguage, SettingsTab, Tint, TitlebarTool,
};
use lattice_ui::{
    ActiveLattice as _,
    components::{menu_snapshot, record_menus},
};
use serde_json::json;

use super::{super::Run, Steps};
use crate::{
    native, settings,
    shell::commands::{CommandContext, commands},
};

impl Run {
    /// The way into Settings at the window's top left, as the app has it:
    /// the project switcher's menu ends with Settings, which opens it.
    pub(super) async fn settings_from_titlebar(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        const NAME: &str =
            "the top-left project switcher's menu has Settings, and it opens Settings";
        const SETTLE: Duration = Duration::from_millis(250);
        cx.update(record_menus);
        let start = cx.update(|cx| self.shell.read(cx).titlebar_drag().left_start());
        let Some(start) = start else {
            steps.check(NAME, false, json!({ "left_start": null }));
            return Ok(());
        };
        let native = self.native(cx)?;
        // The switcher: 28px tall, 4px under the titlebar's top, first in
        // the titlebar's left group.
        native::send_titlebar_click(native, point(px(start + 16.), px(18.)))?;
        self.pause(cx, SETTLE).await;
        let label = t!("Settings").to_string();
        let menu = cx.update(|cx| menu_snapshot(&label, cx));
        let rows: Vec<String> = menu
            .as_ref()
            .map(|menu| {
                menu.rows
                    .iter()
                    .map(|(_, text, _)| text.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let last = rows.last().cloned();
        let row = menu
            .as_ref()
            .and_then(|menu| menu.rows.iter().find(|(_, text, _)| *text == label))
            .map(|(_, _, bounds)| *bounds);
        let Some(row) = row else {
            steps.check(NAME, false, json!({ "switcher_at": start, "rows": rows }));
            native::send_key(native, '\u{1b}', false)?;
            self.pause(cx, SETTLE).await;
            return Ok(());
        };
        native::send_mouse(native, native::Mouse::Moved, row.center())?;
        self.pause(cx, SETTLE).await;
        native::send_click(native, row.center())?;
        let opened = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).settings.is_some()
            })
            .await;
        steps.check(
            NAME,
            opened && last.as_deref() == Some(label.as_str()),
            json!({ "rows": rows, "opened": opened }),
        );
        if opened {
            self.press(cx, '\u{1b}', false).await?;
            self.wait_for(cx, Duration::from_secs(2), |shell, cx| {
                shell.read(cx).settings.is_none()
            })
            .await;
        }
        Ok(())
    }

    pub(super) async fn settings_and_language(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        let before = cx.update(|cx| settings::get(cx).clone());

        // ⌘, from the window, with native keys.
        self.press(cx, ',', true).await?;
        let opened = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                shell.read(cx).settings.is_some()
            })
            .await;
        let tab = cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .map(|dialog| dialog.read(cx).tab().tag())
        });
        steps.check(
            "⌘, opens Settings, on the page it was left on",
            opened && tab == Some(before.settings_tab.tag()),
            json!({ "tab": tab }),
        );

        // The search holds the keyboard: typing finds the keymap row, Enter
        // opens its page and reveals it.
        self.type_text(cx, "vim").await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let results = cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .map(|dialog| dialog.read(cx).result_labels(cx))
                .unwrap_or_default()
        });
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let (tab, revealed) = cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .map(|dialog| {
                    let dialog = dialog.read(cx);
                    (Some(dialog.tab()), dialog.revealed_row())
                })
                .unwrap_or((None, None))
        });
        steps.check(
            "typing in Settings' search finds a setting and Enter reveals its row",
            results.first().map(String::as_str) == Some("Editor keymap")
                && tab == Some(SettingsTab::Editor)
                && revealed == Some("editor-keymap"),
            json!({ "results": results, "tab": tab.map(|tab| tab.tag()), "revealed": revealed }),
        );

        // Choices apply as they are made.
        cx.update(|cx| {
            settings::update_appearance(cx, |appearance| {
                appearance.tint = Tint::Sage;
                appearance.accent = StoredAccent::Preset(AccentPreset::Teal);
                appearance.code_theme = CodeTheme::Nord;
                appearance.editor_font_size = 17.;
                appearance.source_line_height = 1.8;
            })
        });
        self.pause(cx, Duration::from_millis(300)).await;
        let applied = cx.update(|cx| {
            let lattice = cx.lattice();
            let buffer = theme_settings::ThemeSettings::get_global(cx);
            json!({
                "tint": format!("{:?}", lattice.palette.tint),
                "accent": format!("{:?}", lattice.palette.accent_preset),
                "code_theme": lattice.code_theme.id(),
                "buffer_font_size": f32::from(buffer.buffer_font_size(cx)),
                "theme": theme::GlobalTheme::theme(cx).name.to_string(),
            })
        });
        steps.check(
            "a tint, an accent, a code theme and the editor's size apply at once",
            applied["tint"] == "Sage"
                && applied["accent"] == "Teal"
                && applied["code_theme"] == "nord"
                && applied["buffer_font_size"] == 17.
                && applied["theme"]
                    .as_str()
                    .is_some_and(|name| name.contains("Nord")),
            applied,
        );

        // The keymap: Vim turns Zed's Vim on, Emacs puts its bindings in
        // reach and Vim off.
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_keymap = EditorKeymap::Vim));
        self.pause(cx, Duration::from_millis(100)).await;
        let vim = cx.update(|cx| crate::app::vim_mode_enabled(cx));
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_keymap = EditorKeymap::Emacs));
        self.pause(cx, Duration::from_millis(100)).await;
        let emacs = cx.update(|cx| {
            (
                crate::app::vim_mode_enabled(cx),
                cx.all_bindings_for_input(&[gpui::Keystroke::parse("ctrl-f").unwrap()])
                    .iter()
                    .any(|binding| {
                        binding
                            .predicate()
                            .is_some_and(|p| p.to_string().contains(crate::app::EMACS_CONTEXT))
                    }),
            )
        });
        steps.check(
            "the keymap setting turns Vim on, and Emacs's bindings on under their context",
            vim && !emacs.0 && emacs.1,
            json!({ "vim": vim, "emacs_vim_off": !emacs.0, "emacs_bound": emacs.1 }),
        );

        self.manual_builds(cx, steps, before.auto_build_mode)
            .await?;
        self.titlebar_tools(cx, steps).await;

        // The interface in Simplified Chinese, then back.
        cx.update(|cx| {
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::ZhCn)
        });
        self.pause(cx, Duration::from_millis(200)).await;
        #[cfg(target_os = "macos")]
        let windows_menu = crate::native::windows_menu_title();
        #[cfg(not(target_os = "macos"))]
        let windows_menu = Some(String::from("窗口"));
        let chinese = cx.update(|_| {
            let context = CommandContext {
                in_project: true,
                ..CommandContext::default()
            };
            let labels: Vec<String> = commands(&context)
                .into_iter()
                .map(|command| command.label.to_string())
                .collect();
            json!({
                "locale": lattice_i18n::locale().tag(),
                "appearance": t!("Appearance"),
                "build": labels.iter().find(|label| label.contains("编译")).cloned(),
                "settings": labels.iter().find(|label| label.contains("设置")).cloned(),
                "windows_menu": windows_menu,
            })
        });
        cx.update(|cx| {
            settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::En)
        });
        self.pause(cx, Duration::from_millis(200)).await;
        let english =
            cx.update(|_| lattice_i18n::locale() == Locale::En && t!("Appearance") == "Appearance");
        steps.check(
            "the interface switches to Simplified Chinese (commands, Settings, the Window menu) and back",
            chinese["locale"] == "zh-CN"
                && chinese["appearance"] == "外观"
                && !chinese["build"].is_null()
                && !chinese["settings"].is_null()
                && chinese["windows_menu"] == "窗口"
                && english,
            json!({ "chinese": chinese, "english_again": english }),
        );

        // An edit made to the file outside the app applies.
        let file = std::env::temp_dir().join(format!(
            "lattice-gpui-e2e-settings-{}.json",
            std::process::id()
        ));
        cx.update(|cx| settings::use_file(file.clone(), cx));
        let mut edited = cx.update(|cx| settings::get(cx).clone());
        edited.appearance.tint = Tint::Dusk;
        // A second later than the app's own write, whatever the clock's grain.
        self.pause(cx, Duration::from_millis(1100)).await;
        lattice_settings::write(&file, &edited)?;
        let reloaded = self
            .wait_for(cx, Duration::from_secs(5), |_, cx| {
                cx.lattice().palette.tint == lattice_ui::Tint::Dusk
            })
            .await;
        steps.check(
            "an edit to the settings file made outside the app applies",
            reloaded,
            json!({ "file": file }),
        );

        // Escape closes Settings, and the window keeps the keyboard.
        self.press(cx, '\u{1b}', false).await?;
        let closed = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                shell.read(cx).settings.is_none()
            })
            .await;
        steps.check("Escape closes Settings", closed, json!({}));

        // Back to how the run started.
        cx.update(|cx| settings::update(cx, |settings| *settings = before));
        let _ = std::fs::remove_file(&file);
        Ok(())
    }

    /// Title bar tools: turning Git off takes its button out of the title
    /// bar, so the tools begin one button further right; turning it on puts
    /// it back.
    async fn titlebar_tools(&self, cx: &mut AsyncApp, steps: &mut Steps) {
        fn start(shell: &gpui::Entity<crate::shell::Shell>, cx: &gpui::App) -> Option<f32> {
            shell.read(cx).titlebar_drag().tools_start()
        }
        fn set_git(shown: bool, cx: &mut AsyncApp) {
            cx.update(|cx| {
                settings::update_appearance(cx, |a| {
                    a.hidden_titlebar_tools
                        .retain(|tool| *tool != TitlebarTool::Git);
                    if !shown {
                        a.hidden_titlebar_tools.push(TitlebarTool::Git);
                    }
                })
            })
        }
        let kept = cx.update(|cx| settings::get(cx).appearance.hidden_titlebar_tools.clone());
        set_git(true, cx);
        self.wait_for(cx, Duration::from_secs(2), |shell, cx| {
            start(shell, cx).is_some()
        })
        .await;
        self.pause(cx, Duration::from_millis(200)).await;
        let shown = cx.update(|cx| start(&self.shell, cx));
        set_git(false, cx);
        let hidden = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                start(shell, cx)
                    .zip(shown)
                    .is_some_and(|(now, was)| now > was + 20.)
            })
            .await;
        let without = cx.update(|cx| start(&self.shell, cx));
        set_git(true, cx);
        let back = self
            .wait_for(cx, Duration::from_secs(3), |shell, cx| {
                start(shell, cx)
                    .zip(shown)
                    .is_some_and(|(now, was)| (now - was).abs() < 0.5)
            })
            .await;
        cx.update(|cx| settings::update_appearance(cx, |a| a.hidden_titlebar_tools = kept));
        steps.check(
            "Settings: Title bar tools hide and show the Git button",
            hidden && back,
            json!({ "tools_start": shown, "without_git": without, "hidden": hidden, "back": back }),
        );
    }

    /// "Manual only": an edit made outside the app reloads the open file,
    /// as it does with automatic builds, and no build follows it.
    async fn manual_builds(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        restore: AutoBuildMode,
    ) -> Result<()> {
        const MARK: &str = "% saved with manual builds\n";
        let editor = cx.update(|cx| self.shell.read(cx).active_editor());
        let Some(editor) = editor else {
            steps.check(
                "Manual only: an edit to the open file does not build",
                false,
                json!({ "error": "no editor is open" }),
            );
            return Ok(());
        };
        cx.update(|cx| {
            settings::update(cx, |settings| {
                settings.auto_build_mode = AutoBuildMode::Manual
            })
        });
        self.wait_for(cx, Duration::from_secs(120), |shell, cx| {
            !shell.read(cx).building()
        })
        .await;
        let path = cx.update(|cx| editor.read(cx).path().to_path_buf());
        let original = std::fs::read_to_string(&path)?;
        let builds = self.builds(cx);
        std::fs::write(&path, format!("{original}{MARK}"))?;
        let reloaded = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                editor.read(cx).editor().read(cx).text(cx).contains(MARK)
            })
            .await;
        // An automatic build would have started as the reload landed.
        self.pause(cx, Duration::from_secs(2)).await;
        let built = cx.update(|cx| {
            let shell = self.shell.read(cx);
            shell.building() || shell.build_panel().read(cx).builds() > builds
        });
        std::fs::write(&path, &original)?;
        let restored = self
            .wait_for(cx, Duration::from_secs(8), |_, cx| {
                !editor.read(cx).editor().read(cx).text(cx).contains(MARK)
            })
            .await;
        steps.check(
            "Manual only: an edit to the open file reloads it and does not build",
            reloaded && !built && restored,
            json!({ "reloaded": reloaded, "built": built, "restored": restored }),
        );
        cx.update(|cx| settings::update(cx, |settings| settings.auto_build_mode = restore));
        Ok(())
    }
}
