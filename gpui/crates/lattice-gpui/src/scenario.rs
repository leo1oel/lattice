//! Scripted runs driven with native input: an end-to-end check of the
//! writing flow (macOS and Windows), and the measurements the pass criteria
//! ask for (macOS).
//!
//! `lattice-gpui PROJECT --scenario e2e|islands|overleaf|perf|memory|ime|ime-protocol|shot|parity|pdf-shots --out RESULT.json`

use std::{
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, anyhow};
use editor::ToPoint as _;
use gpui::{AnyWindowHandle, App, AsyncApp, Entity, Window};
use serde_json::json;

use crate::{editor_panel::EditorPanel, native, shell::Shell};

mod drag;
mod e2e;
mod input_lock;
#[cfg(target_os = "macos")]
mod measure;
mod overleaf_mock;
mod overleaf_realtime_mock;
#[cfg(target_os = "macos")]
mod parity;
#[cfg(target_os = "macos")]
mod parity_history;
#[cfg(target_os = "macos")]
mod parity_overleaf;
mod parity_submission;
#[cfg(target_os = "macos")]
mod parity_welcome;
#[cfg(target_os = "macos")]
mod pdf_shots;
mod shell_steps;
#[cfg(target_os = "macos")]
mod shot;

pub struct ScenarioArgs {
    pub name: String,
    pub out: PathBuf,
    /// `--only`: the `e2e` modules to run beside its smoke flow
    /// (`e2e/steps.rs`, `MODULES`).
    pub only: Option<String>,
}

/// `[PROJECT] [--scenario NAME --out FILE [--only MODULES]]`
pub fn parse_args() -> (Option<PathBuf>, Option<ScenarioArgs>) {
    let mut root = None;
    let mut name = None;
    let mut out = None;
    let mut only = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--scenario") => name = args.next().and_then(|v| v.into_string().ok()),
            Some("--out") => out = args.next().map(PathBuf::from),
            Some("--only") => only = args.next().and_then(|v| v.into_string().ok()),
            _ => root = Some(PathBuf::from(arg)),
        }
    }
    let scenario = name.map(|name| ScenarioArgs {
        out: out.unwrap_or_else(|| PathBuf::from(format!("{name}.json"))),
        name,
        only,
    });
    (root, scenario)
}

pub fn start(shell: Entity<Shell>, window: AnyWindowHandle, args: ScenarioArgs, cx: &mut App) {
    cx.spawn(async move |cx| {
        let run = Run {
            shell,
            window,
            input: Rc::new(input_lock::InputLock::new()),
        };
        native::begin_latency_critical_activity();
        // The input method needs a key window in an active app, for the
        // whole run. Other scenarios stay in the background and front their
        // window only for the steps that need it (`input_lock.rs`);
        // LATTICE_SCENARIO_FRONT=1 holds them in front for the whole run too.
        let front = args.name == "ime" || std::env::var_os("LATTICE_SCENARIO_FRONT").is_some();
        let whole_run = if front {
            run.foreground(cx, "the whole run").await.ok()
        } else {
            None
        };
        let result = match args.name.as_str() {
            "e2e" => match args.only.as_deref().map(e2e::set_only) {
                Some(Err(error)) => Err(error),
                _ => run.e2e(cx).await,
            },
            "narrow-window" => run.narrow_window_alone(cx).await,
            "live-preview" => run.live_preview_scenario(cx).await,
            #[cfg(target_os = "macos")]
            "islands" => run.islands(cx).await,
            #[cfg(target_os = "macos")]
            "overleaf" => run.overleaf_alone(cx).await,
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
            #[cfg(target_os = "macos")]
            "parity" => run.parity(cx).await,
            #[cfg(target_os = "macos")]
            "pdf-shots" => run.pdf_shots(cx).await,
            other => Err(anyhow!("unknown scenario {other} on this platform")),
        };
        drop(whole_run);
        // A step that failed inside a section left it with `?`, which gave
        // the lock back; this covers anything that did not.
        run.input.release_all();
        let mut value = result.unwrap_or_else(|error| json!({ "error": format!("{error:#}") }));
        if let Some(object) = value.as_object_mut() {
            object.insert("foreground".into(), run.input.summary());
        }
        native::release_private_pasteboard();
        let text = serde_json::to_string_pretty(&value).unwrap_or_default();
        if let Err(error) = std::fs::write(&args.out, text) {
            log::error!("writing {}: {error}", args.out.display());
        }
        // A quit that never finishes (seen once with two runs side by side,
        // the app idle after `terminate:`) would hold `script/e2e` forever;
        // after a minute the process exits, and the script's check that the
        // quit saved the typed text decides the run.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(60));
            log::error!("the app did not quit within 60 s of the scenario's end; exiting");
            std::process::exit(3);
        });
        cx.update(|cx| cx.quit());
    })
    .detach();
}

struct Run {
    shell: Entity<Shell>,
    window: AnyWindowHandle,
    /// Shared with the `Run`s of the scenario's other windows.
    input: Rc<input_lock::InputLock>,
}

/// While alive, the scenario is in a foreground section (`input_lock.rs`):
/// it holds the machine-wide input lock, its app is active and the window it
/// was entered for is key. Dropping it leaves the section.
#[must_use = "the section ends when this is dropped"]
struct Foreground(Rc<input_lock::InputLock>);

impl Drop for Foreground {
    fn drop(&mut self) {
        self.0.leave();
    }
}

impl Run {
    fn native(&self, cx: &mut AsyncApp) -> Result<native::Native> {
        self.with_window(cx, |_, window, _| native::native(window))?
    }

    /// A `Run` for another of the scenario's windows, sharing its lock.
    fn for_window(&self, shell: Entity<Shell>, window: AnyWindowHandle) -> Run {
        Run {
            shell,
            window,
            input: self.input.clone(),
        }
    }

    /// Enter a foreground section (`input_lock.rs`): wait for the machine-wide
    /// input lock, then activate the app and make this window key, and wait
    /// until it is. Steps that need the app active or the window key, or that
    /// use the pasteboard, run while the returned guard lives; the outermost
    /// guard's drop deactivates the app and gives the lock back.
    async fn foreground(&self, cx: &mut AsyncApp, what: &'static str) -> Result<Foreground> {
        let guard = Foreground(self.input.clone());
        if self.input.enter(what) {
            let mut announced = false;
            loop {
                match self.input.try_take().context("taking the GPUI e2e lock")? {
                    input_lock::Attempt::Taken => {
                        self.input.taken();
                        break;
                    }
                    input_lock::Attempt::TookOver(pid) => eprintln!(
                        "  (taking over {} from pid {pid}, which died holding it)",
                        input_lock::LOCK_DIR
                    ),
                    input_lock::Attempt::HeldBy(owner) => {
                        if !announced {
                            let owner = if owner.is_empty() {
                                "a process starting up".to_string()
                            } else {
                                owner
                            };
                            eprintln!("  (waiting for the GPUI e2e lock held by {owner})");
                            announced = true;
                        }
                        self.pause(cx, Duration::from_millis(100)).await;
                    }
                }
            }
        }
        native::bring_to_front(self.native(cx)?);
        let window = self.window;
        let key = self
            .wait_for(cx, Duration::from_secs(1), move |_, cx| {
                native::app_is_active()
                    && window
                        .update(cx, |_, window, _| window.is_window_active())
                        .unwrap_or(false)
            })
            .await;
        // A locked screen activates no app, and needs none activated: the
        // window keeps drawing (GPUI_LAB_IGNORE_OCCLUSION, `pump_frame`).
        if !key {
            log::info!("the window did not become key within 1 s of being brought to the front");
        }
        Ok(guard)
    }

    /// Enter a section whose steps need only GPUI's own idea of focus: the
    /// window active, so it draws focused editors' carets and overlays, runs
    /// at full frame rate and gives a focused element its focus events. With
    /// gpui-fast's lab switch `GPUI_LAB_ASSUME_KEY` (patches/README.md,
    /// set by script/e2e) every window of this run already is, without the
    /// machine's front, so the section takes neither the lock nor the front
    /// and runs beside other runs; it is listed in the result's
    /// `foreground.without_lock`. Without the switch, or if the window does
    /// not report itself active (a binary built without the patch), it is a
    /// foreground section. Steps that need what macOS serves only the real
    /// key window of the active app (the input method, a webview's keyboard
    /// focus, the menu bar's key equivalents, a menu closing as the window
    /// resigns key) use `foreground`.
    async fn focused(&self, cx: &mut AsyncApp, what: &'static str) -> Result<Option<Foreground>> {
        if input_lock::assume_key()
            && self
                .with_window(cx, |_, window, _| window.is_window_active())
                .unwrap_or(false)
        {
            self.input.without_lock(what);
            return Ok(None);
        }
        self.foreground(cx, what).await.map(Some)
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
            self.pump_frame(cx);
            sleep(cx, Duration::from_millis(50)).await;
        }
        false
    }

    /// Wait `duration`, drawing frames meanwhile (`pump_frame`).
    async fn pause(&self, cx: &mut AsyncApp, duration: Duration) {
        let started = Instant::now();
        while started.elapsed() < duration {
            self.pump_frame(cx);
            sleep(cx, Duration::from_millis(50).min(duration)).await;
        }
    }

    /// Park the pointer in the window's bottom-right gutter, where Paper's
    /// scenes park it, so no row or button is drawn hovered wherever the real
    /// cursor happens to be. Shots and the e2e steps on both platforms use it.
    fn park_pointer(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            let size = window.viewport_size();
            let corner = gpui::point(size.width - gpui::px(4.), size.height - gpui::px(4.));
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position: corner,
                    pressed_button: None,
                    modifiers: gpui::Modifiers::default(),
                }),
                cx,
            );
        })
    }

    /// Draw a frame now, in a build with `offscreen-shots`: a window on a
    /// locked screen gets none from the display, and some of what a scenario
    /// checks waits for one (the tree's rename field takes focus once its
    /// row is drawn). A window on screen draws its own, so this does nothing
    /// in other builds.
    fn pump_frame(&self, _cx: &mut AsyncApp) {
        self.input.observe();
        #[cfg(feature = "offscreen-shots")]
        self.with_window(_cx, |_, window, cx| {
            window.refresh();
            let _ = window.draw(cx);
            window.simulate_next_frame(cx);
        })
        .ok();
    }

    /// The project's folder, once lattice-core has opened it (in the
    /// background) and its main document is in an editor.
    async fn root(&self, cx: &mut AsyncApp) -> Result<PathBuf> {
        self.wait_for(cx, Duration::from_secs(30), |shell, cx| {
            shell.read(cx).root(cx).is_some()
        })
        .await;
        cx.update(|cx| self.shell.read(cx).root(cx))
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
        // Any build under way or queued (an automatic one after a save)
        // finishes first; this one is queued behind it.
        let finished = self
            .wait_for(cx, Duration::from_secs(180), |shell, cx| {
                let shell = shell.read(cx);
                !shell.building() && shell.build_panel().read(cx).succeeded().is_some()
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
        self.pump_frame(cx);
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
