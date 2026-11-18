//! The app updater, as the Tauri app's (`src/telemetry/app-updater.tsx`):
//! a check at launch and every six hours, an offer ("New version {version}",
//! Update now), the download with its progress, the install, and the restart
//! into it; Lattice ▸ Check for Updates… checks at once and says when nothing
//! is new. A restart that would stop a build asks first ("Restart Lattice
//! now?"), and every window saves its open edits before it (`on_app_quit`).
//! The offer to restart later ("Lattice {version} is ready") comes with the
//! automatic mode's Settings row.
//!
//! It is off until the writer turns on Settings › Editor & builds › Preview
//! updates (`appUpdates`): until then it checks nothing, the menu has no
//! Check for Updates…, and Report a problem files at once. Its channel
//! ([`GPUI_ENDPOINT`]) is the GPUI app's own, apart from the Tauri app's
//! `latest.json`, and its archives are signed with the Tauri updater's key
//! (`scripts/gpui-bundle.mjs` signs them, as tauri-action signs the Tauri
//! app's).

pub mod install;
pub mod manifest;

use std::time::Duration;

use gpui::{App, AppContext as _, Context, Entity, Global, MenuItem, Task};
use lattice_i18n::{t, tc};
use lattice_ui::components::{ToastLevel, ToastProgress};

use crate::{
    app_log::{self, Level, NewEntry},
    notices::{self, Notice, NoticeAction},
};

/// Where a release channel's manifest is, and the minisign public key its
/// archives are signed with (base64, as `tauri.conf.json` keeps it).
#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    pub endpoint: String,
    pub public_key: String,
}

/// The GPUI app's release manifest: the `latest.json` asset of the
/// `gpui-channel` prerelease, which only GPUI builds are published to. A
/// prerelease is never GitHub's latest release, so the Tauri app's
/// `releases/latest/download/latest.json` never sees it.
pub const GPUI_ENDPOINT: &str =
    "https://github.com/leo1oel/lattice/releases/download/gpui-channel/latest.json";

/// The channel this run updates from: [`GPUI_ENDPOINT`], checked with the
/// Tauri updater's public key (`plugins.updater.pubkey` in tauri.conf.json).
pub fn channel() -> Option<Channel> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).ok()?;
    let public_key = config["plugins"]["updater"]["pubkey"].as_str()?;
    Some(Channel {
        endpoint: GPUI_ENDPOINT.to_string(),
        public_key: public_key.to_string(),
    })
}

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const NOTICE_KEY: &str = "app-update";

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available(manifest::Release),
    Downloading {
        version: String,
        progress: Option<f32>,
    },
    Installing(String),
    /// Installed on disk, used from the next launch or a restart.
    Ready(String),
    Error(String),
}

pub struct Updater {
    channel: Option<Channel>,
    pub phase: Phase,
    _task: Option<Task<()>>,
    _schedule: Option<Task<()>>,
}

struct UpdaterGlobal(Entity<Updater>);
impl Global for UpdaterGlobal {}

/// Make the updater; with a channel, check at launch and every six hours
/// while Preview updates is on.
pub fn install(scripted: bool, cx: &mut App) -> Entity<Updater> {
    let updater = cx.new(|cx| {
        let mut updater = Updater {
            channel: channel(),
            phase: Phase::Idle,
            _task: None,
            _schedule: None,
        };
        if updater.channel.is_some() && !scripted {
            updater._schedule = Some(cx.spawn(
                async move |this: gpui::WeakEntity<Updater>, cx: &mut gpui::AsyncApp| {
                    loop {
                        if this.update(cx, |this, cx| this.check(false, cx)).is_err() {
                            return;
                        }
                        cx.background_executor().timer(CHECK_INTERVAL).await;
                    }
                },
            ));
        }
        updater
    });
    cx.set_global(UpdaterGlobal(updater.clone()));
    updater
}

pub fn global(cx: &App) -> Option<Entity<Updater>> {
    cx.try_global::<UpdaterGlobal>()
        .map(|global| global.0.clone())
}

/// Preview updates was turned on or off: check at once when it comes on,
/// and add or take away Check for Updates….
pub fn setting_changed(cx: &mut App) {
    if let Some(updater) = global(cx) {
        updater.update(cx, |updater, cx| updater.check(false, cx));
    }
    crate::shell::menus::refresh(cx);
}

/// Lattice ▸ Check for Updates…, or Restart to Update… once one is
/// installed; nothing while the updater is off.
pub fn menu_item(cx: &App) -> Option<MenuItem> {
    // Off without a channel: no Check for Updates… at all.
    let updater = global(cx)?;
    let updater = updater.read(cx);
    updater.active_channel(cx)?;
    Some(match updater.phase {
        Phase::Ready(_) => {
            MenuItem::action(tc!("macOS menu bar", "Restart to Update…"), CheckForUpdates)
        }
        _ => MenuItem::action(tc!("macOS menu bar", "Check for Updates…"), CheckForUpdates),
    })
}

gpui::actions!(lattice, [CheckForUpdates]);

/// The newer release the updater knows of, for Report a problem and a
/// failure's hint (`getKnownUpdate`).
pub fn known_update(cx: &App) -> Option<String> {
    match &global(cx)?.read(cx).phase {
        Phase::Available(release) => Some(release.version.clone()),
        Phase::Ready(version) => Some(version.clone()),
        _ => None,
    }
}

/// Update now from outside the updater (Report a problem's offer).
pub fn update_now(cx: &mut App) {
    if let Some(updater) = global(cx) {
        updater.update(cx, |updater, cx| updater.update_now(cx));
    }
}

fn source() -> String {
    t!("App updater").to_string()
}

impl Updater {
    /// The channel, while Preview updates is on.
    fn active_channel(&self, cx: &App) -> Option<Channel> {
        self.channel
            .clone()
            .filter(|_| crate::settings::get(cx).app_updates)
    }

    /// Check the channel; `announce` (the menu) also says when nothing is
    /// new or the check failed.
    pub fn check(&mut self, announce: bool, cx: &mut Context<Self>) {
        let Some(channel) = self.active_channel(cx) else {
            return;
        };
        if let Phase::Ready(_) = self.phase {
            if announce {
                self.restart(false, cx);
            }
            return;
        }
        if matches!(
            self.phase,
            Phase::Checking | Phase::Downloading { .. } | Phase::Installing(_)
        ) {
            return;
        }
        self.phase = Phase::Checking;
        cx.notify();
        let running = lattice_core::VERSION.to_string();
        let found = cx.background_spawn(async move {
            install::fetch_text(&channel.endpoint)
                .and_then(|text| manifest::newer_release(&text, &running))
        });
        self._task = Some(cx.spawn(async move |this, cx| {
            let found = found.await;
            this.update(cx, |this, cx| match found {
                Ok(Some(release)) => {
                    this.phase = Phase::Available(release.clone());
                    crate::shell::menus::refresh(cx);
                    this.offer(&release.version, cx);
                }
                Ok(None) => {
                    this.phase = Phase::UpToDate;
                    if announce {
                        show(
                            ToastLevel::Success,
                            t!("Lattice is up to date").to_string(),
                            t!("Version {version}", version = lattice_core::VERSION).to_string(),
                            Vec::new(),
                            cx,
                        );
                    }
                }
                Err(error) => {
                    this.phase = Phase::Error(error.clone());
                    let title = t!("Couldn’t check for Lattice updates").to_string();
                    if announce {
                        show(ToastLevel::Error, title, error, Vec::new(), cx);
                    } else {
                        app_log::global(cx).update(cx, |log, cx| {
                            log.add(
                                NewEntry {
                                    level: Level::Error,
                                    source: source(),
                                    title,
                                    detail: error,
                                    context: None,
                                },
                                None,
                                false,
                                cx,
                            );
                        });
                    }
                }
            })
            .ok();
        }));
    }

    fn offer(&mut self, version: &str, cx: &mut Context<Self>) {
        let this = cx.weak_entity();
        show(
            ToastLevel::Info,
            t!("New version {version}", version = version).to_string(),
            String::new(),
            vec![NoticeAction::new(t!("Update now"), move |_, cx| {
                this.update(cx, |this, cx| this.install(cx)).ok();
            })],
            cx,
        );
    }

    pub fn update_now(&mut self, cx: &mut Context<Self>) {
        match self.phase {
            Phase::Available(_) => self.install(cx),
            Phase::Ready(_) => self.restart(false, cx),
            _ => self.check(true, cx),
        }
    }

    /// Download, check and install the release offered, then restart into it.
    pub fn install(&mut self, cx: &mut Context<Self>) {
        let (Phase::Available(release), Some(channel)) =
            (self.phase.clone(), self.active_channel(cx))
        else {
            return;
        };
        let version = release.version.clone();
        let version_line = t!("Version {version}", version = version).to_string();
        self.phase = Phase::Downloading {
            version: version.clone(),
            progress: None,
        };
        show_running(
            t!("Downloading update…").to_string(),
            version_line.clone(),
            cx,
        );
        let (progress_tx, mut progress_rx) = futures::channel::mpsc::unbounded::<Option<f32>>();
        let work = cx.background_spawn(async move {
            let bytes = {
                let progress_tx = progress_tx;
                install::download(&release.platform.url, |share| {
                    progress_tx.unbounded_send(share).ok();
                })?
            };
            install::verify(&bytes, &release.platform.signature, &channel.public_key)?;
            let bundle = install::running_bundle()
                .ok_or_else(|| "Lattice is not running from an app bundle".to_string())?;
            install::replace_bundle(&bytes, &bundle)
        });
        self._task = Some(cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(share) = progress_rx.next().await {
                this.update(cx, |this, cx| {
                    if let Phase::Downloading { progress, .. } = &mut this.phase {
                        *progress = share;
                        cx.notify();
                        notices::update_progress(
                            NOTICE_KEY,
                            share.map_or(ToastProgress::Indeterminate, ToastProgress::Fraction),
                            cx,
                        );
                    }
                })
                .ok();
            }
            this.update(cx, |this, cx| {
                this.phase = Phase::Installing(version.clone());
                show_running(t!("Installing…").to_string(), version_line.clone(), cx);
            })
            .ok();
            let installed = work.await;
            this.update(cx, |this, cx| match installed {
                Ok(()) => {
                    this.phase = Phase::Ready(version.clone());
                    crate::shell::menus::refresh(cx);
                    this.restart(false, cx);
                }
                Err(error) => {
                    this.phase = Phase::Error(error.clone());
                    show(
                        ToastLevel::Error,
                        t!("Lattice update failed").to_string(),
                        error,
                        Vec::new(),
                        cx,
                    );
                }
            })
            .ok();
        }));
    }

    /// Restart into the installed release; a build under way asks first
    /// unless `confirmed`.
    fn restart(&mut self, confirmed: bool, cx: &mut Context<Self>) {
        let Phase::Ready(version) = self.phase.clone() else {
            return;
        };
        let builds = crate::shell::windows::running_builds(cx);
        if !confirmed && builds > 0 {
            let running = if builds == 1 {
                t!("a compile").to_string()
            } else {
                t!("{builds} compiles", builds = builds).to_string()
            };
            let this = cx.weak_entity();
            show(
                ToastLevel::Warning,
                t!("Restart Lattice now?").to_string(),
                t!("Restarting now stops {running}.", running = running).to_string(),
                vec![NoticeAction::new(t!("Restart anyway"), move |_, cx| {
                    this.update(cx, |this, cx| this.restart(true, cx)).ok();
                })],
                cx,
            );
            return;
        }
        show_running(
            t!("Restarting…").to_string(),
            t!("Version {version}", version = version).to_string(),
            cx,
        );
        // Each window writes its open edits as the app quits.
        cx.defer(|cx| cx.restart());
    }
}

fn show(
    level: ToastLevel,
    title: String,
    detail: String,
    actions: Vec<NoticeAction>,
    cx: &mut App,
) {
    let mut notice = Notice::new(level, title).source(source()).key(NOTICE_KEY);
    if !detail.is_empty() {
        notice = notice.detail(detail);
    }
    let waits = !actions.is_empty();
    for action in actions {
        notice = notice.action(action);
    }
    if waits {
        notice = notice.persistent();
    }
    notices::show(notice, cx);
}

fn show_running(title: String, detail: String, cx: &mut App) {
    notices::show(
        Notice::new(ToastLevel::Info, title)
            .source(source())
            .detail(detail)
            .key(NOTICE_KEY)
            .running(),
        cx,
    );
}

/// The app-wide handler for Check for Updates… (and Restart to Update…).
pub fn register_actions(cx: &mut App) {
    cx.on_action(|_: &CheckForUpdates, cx| {
        if let Some(updater) = global(cx) {
            updater.update(cx, |updater, cx| updater.check(true, cx));
        }
    });
}

/// Point the updater at `channel` and turn Preview updates on, for a
/// scenario (a run's env is set before it starts).
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn use_channel(channel: Channel, cx: &mut App) {
    if let Some(updater) = global(cx) {
        updater.update(cx, |updater, cx| {
            updater.channel = Some(channel);
            updater.phase = Phase::Idle;
            cx.notify();
        });
    }
    crate::settings::update(cx, |settings| settings.app_updates = true);
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_channel_is_the_gpui_feed_checked_with_the_tauri_updaters_key() {
        let channel = super::channel().unwrap();
        assert_eq!(channel.endpoint, super::GPUI_ENDPOINT);
        assert!(!channel.endpoint.contains("/latest/download/"));
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(channel.public_key, config["plugins"]["updater"]["pubkey"]);
    }
}
