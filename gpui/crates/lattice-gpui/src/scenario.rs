//! Scripted runs driven with native input: an end-to-end check of the
//! writing flow (macOS and Windows), and the measurements the pass criteria
//! ask for (macOS).
//!
//! `lattice-gpui PROJECT --scenario e2e|perf|memory|ime|ime-protocol|shot --out RESULT.json`

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, anyhow};
use editor::ToPoint as _;
use gpui::{AnyWindowHandle, App, AsyncApp, Entity, Window};
use serde_json::json;

use crate::{editor_panel::EditorPanel, native, shell::Shell};

mod e2e;
#[cfg(target_os = "macos")]
mod measure;
#[cfg(target_os = "macos")]
mod shot;

pub struct ScenarioArgs {
    pub name: String,
    pub out: PathBuf,
}

/// `[PROJECT] [--scenario NAME --out FILE]`
pub fn parse_args() -> (Option<PathBuf>, Option<ScenarioArgs>) {
    let mut root = None;
    let mut name = None;
    let mut out = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--scenario") => name = args.next().and_then(|v| v.into_string().ok()),
            Some("--out") => out = args.next().map(PathBuf::from),
            _ => root = Some(PathBuf::from(arg)),
        }
    }
    let scenario = name.map(|name| ScenarioArgs {
        out: out.unwrap_or_else(|| PathBuf::from(format!("{name}.json"))),
        name,
    });
    (root, scenario)
}

pub fn start(shell: Entity<Shell>, window: AnyWindowHandle, args: ScenarioArgs, cx: &mut App) {
    cx.spawn(async move |cx| {
        let run = Run { shell, window };
        native::begin_latency_critical_activity();
        // The input method needs a key window in an active app. Other
        // scenarios leave whatever the user has in front alone;
        // LATTICE_SCENARIO_FRONT=1 brings the window to the front for them
        // too.
        let front = args.name == "ime" || std::env::var_os("LATTICE_SCENARIO_FRONT").is_some();
        if front && let Ok(native) = run.native(cx) {
            native::bring_to_front(native);
        }
        let result = match args.name.as_str() {
            "e2e" => run.e2e(cx).await,
            #[cfg(target_os = "macos")]
            "perf" => run.perf(cx).await,
            #[cfg(target_os = "macos")]
            "ime" => run.ime(cx).await,
            #[cfg(target_os = "macos")]
            "memory" => run.memory(cx).await,
            #[cfg(target_os = "macos")]
            "ime-protocol" => run.ime_protocol(cx).await,
            #[cfg(target_os = "macos")]
            "shot" => run.shot(cx).await,
            other => Err(anyhow!("unknown scenario {other} on this platform")),
        };
        let value = result.unwrap_or_else(|error| json!({ "error": format!("{error:#}") }));
        let text = serde_json::to_string_pretty(&value).unwrap_or_default();
        if let Err(error) = std::fs::write(&args.out, text) {
            log::error!("writing {}: {error}", args.out.display());
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

struct Run {
    shell: Entity<Shell>,
    window: AnyWindowHandle,
}

impl Run {
    fn native(&self, cx: &mut AsyncApp) -> Result<native::Native> {
        self.with_window(cx, |_, window, _| native::native(window))?
    }
}

async fn sleep(cx: &AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

impl Run {
    fn with_window<R>(
        &self,
        cx: &mut AsyncApp,
        f: impl FnOnce(&Entity<Shell>, &mut Window, &mut App) -> R,
    ) -> Result<R> {
        let shell = self.shell.clone();
        self.window
            .update(cx, move |_, window, cx| f(&shell, window, cx))
    }

    async fn wait_for(
        &self,
        cx: &mut AsyncApp,
        timeout: Duration,
        mut done: impl FnMut(&Entity<Shell>, &mut App) -> bool,
    ) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            let shell = self.shell.clone();
            if cx.update(|cx| done(&shell, cx)) {
                return true;
            }
            sleep(cx, Duration::from_millis(50)).await;
        }
        false
    }

    fn root(&self, cx: &mut AsyncApp) -> Result<PathBuf> {
        cx.update(|cx| self.shell.read(cx).root().cloned())
            .context("open a project folder first")
    }

    fn open(
        &self,
        cx: &mut AsyncApp,
        path: &Path,
        line: Option<u32>,
    ) -> Result<Entity<EditorPanel>> {
        let path = path.to_path_buf();
        self.with_window(cx, move |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_path(path, line, window, cx))
        })?
        .context("the file did not open in an editor")
    }

    /// Build and wait for the result.
    async fn build(&self, cx: &mut AsyncApp) -> Result<(bool, Duration)> {
        let started = Instant::now();
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.build(&crate::shell::Build, window, cx)
            })
        })?;
        let finished = self
            .wait_for(cx, Duration::from_secs(180), |shell, cx| {
                let panel = shell.read(cx).build_panel().read(cx);
                !panel.is_running() && panel.succeeded().is_some()
            })
            .await;
        if !finished {
            return Err(anyhow!("the build did not finish within 3 minutes"));
        }
        let succeeded = cx.update(|cx| {
            self.shell
                .read(cx)
                .build_panel()
                .read(cx)
                .succeeded()
                .unwrap_or(false)
        });
        Ok((succeeded, started.elapsed()))
    }

    /// Types `text` one key at a time.
    async fn type_text(&self, cx: &mut AsyncApp, text: &str) -> Result<()> {
        for character in text.chars() {
            self.press(cx, character, false).await?;
        }
        Ok(())
    }

    /// One key press, with the shortcut modifier (⌘ on macOS, Ctrl on
    /// Windows) held when `command`, handled by the window when this returns.
    async fn press(&self, cx: &mut AsyncApp, character: char, command: bool) -> Result<()> {
        native::send_key(self.native(cx)?, character, command)?;
        // AppKit handles a sent event before `sendEvent:` returns. Windows
        // posts the key for GPUI's message loop, which has to run first.
        #[cfg(target_os = "windows")]
        {
            sleep(cx, native::QUEUE_SETTLE).await;
            native::release_keys()?;
        }
        Ok(())
    }

    fn cursor_row(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> u32 {
        cx.update(|cx| {
            let editor = editor.read(cx).editor().read(cx);
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            editor
                .selections
                .newest_anchor()
                .head()
                .to_point(&snapshot)
                .row
        })
    }

    fn editor_text(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> String {
        cx.update(|cx| editor.read(cx).editor().read(cx).text(cx))
    }
}
