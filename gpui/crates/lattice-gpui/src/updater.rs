//! The app updater, as the Tauri app's (`src/telemetry/app-updater.tsx`):
//! a check at launch and every six hours, an offer ("New version {version}",
//! Update now), the download with its progress, the install, and the restart
//! into it; Lattice ▸ Check for Updates… checks at once and says when nothing
//! is new. A restart that would stop a build asks first ("Restart Lattice
//! now?"), and every window saves its open edits before it (`on_app_quit`).
//! The offer to restart later ("Lattice {version} is ready") comes with the
//! automatic mode's Settings row.
//!
//! Its channel is the flavor's (`crate::flavor`). Lattice reads its own
//! `latest-native.json` beside the Tauri app's `latest.json`, always, as the
//! Tauri app reads its own. Lattice Beta reads
//! its own channel, apart from the Tauri app's, and only once the writer turns
//! on Settings › Editor & builds › Beta updates (`appUpdates`): until then it
//! checks nothing, the menu has no Check for Updates…, and Report a problem
//! files at once. Both are signed with the Tauri updater's key
//! (`scripts/gpui-bundle.mjs` signs them, as tauri-action signs the Tauri
//! app's). `LATTICE_GPUI_UPDATER_ENDPOINT` names another manifest (a local
//! feed, for rehearsing a release); what it offers is still checked against
//! that key and installed only when newer.
//!
//! Lattice on a Mac also switches back to the classic (Tauri) version when
//! the writer asks in Settings (`switch_to_classic`): it reads the Tauri
//! app's feed (`classic_channel`), takes its release for this Mac whatever
//! its version (both apps ship the same numbers), checks it against the same
//! key, installs it over this bundle as an update would be and restarts into
//! it. `LATTICE_CLASSIC_UPDATER_ENDPOINT` names another manifest to read
//! instead, for a rehearsal; the key still decides what installs.

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

/// The channel this run updates from: the flavor's manifest, or the one
/// `LATTICE_GPUI_UPDATER_ENDPOINT` names, checked with the Tauri updater's
/// public key (`plugins.updater.pubkey` in tauri.conf.json).
pub fn channel() -> Option<Channel> {
    channel_from(
        "LATTICE_GPUI_UPDATER_ENDPOINT",
        crate::flavor::current().endpoint.to_string(),
    )
}

/// The Tauri app's own feed (`plugins.updater.endpoints[0]` in
/// tauri.conf.json), or the one `LATTICE_CLASSIC_UPDATER_ENDPOINT` names,
/// checked with the same key: where the switch back to the classic version
/// finds its release.
pub fn classic_channel() -> Option<Channel> {
    let endpoint = tauri_updater()?["endpoints"][0].as_str()?.to_string();
    channel_from("LATTICE_CLASSIC_UPDATER_ENDPOINT", endpoint)
}

/// Whether this app offers the switch back to the classic version: only
/// Lattice, which a writer switched to from the Tauri app, and only on a
/// Mac, the one place it ships.
pub fn offers_classic() -> bool {
    cfg!(target_os = "macos") && crate::flavor::current().native_lattice
}

/// The Tauri app's updater settings (`plugins.updater` in tauri.conf.json),
/// read at build time.
fn tauri_updater() -> Option<serde_json::Value> {
    let mut config: serde_json::Value =
        serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).ok()?;
    Some(config["plugins"]["updater"].take())
}

/// `endpoint`, or the one the variable `env` names, with the updater's key.
fn channel_from(env: &str, endpoint: String) -> Option<Channel> {
    let public_key = tauri_updater()?["pubkey"].as_str()?.to_string();
    let endpoint = std::env::var(env)
        .ok()
        .filter(|endpoint| !endpoint.is_empty())
        .unwrap_or(endpoint);
    Some(Channel {
        endpoint,
        public_key,
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
/// while it is on.
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

/// Beta updates was turned on or off: check at once when it comes on,
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
    /// The channel, while updates are on: always for Lattice, and while
    /// Beta updates is on for Lattice Beta.
    fn active_channel(&self, cx: &App) -> Option<Channel> {
        self.channel.clone().filter(|_| {
            crate::flavor::current().native_lattice || crate::settings::get(cx).app_updates
        })
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
        self.install_release(release, channel.public_key, false, cx);
    }

    /// Settings › Switch back to the classic version, once the writer
    /// confirmed it: read the Tauri app's feed, then install its release for
    /// this Mac over this bundle and restart into it, as an update installs,
    /// whatever its version. Nothing while a download or an install is under
    /// way.
    pub fn switch_to_classic(&mut self, cx: &mut Context<Self>) {
        let Some(channel) = classic_channel().filter(|_| offers_classic()) else {
            return;
        };
        if matches!(self.phase, Phase::Downloading { .. } | Phase::Installing(_)) {
            return;
        }
        self.phase = Phase::Checking;
        cx.notify();
        show_running(
            t!("Switching to the classic version…").to_string(),
            String::new(),
            cx,
        );
        let found = cx.background_spawn(async move {
            install::fetch_text(&channel.endpoint)
                .and_then(|text| manifest::platform_release(&text))
        });
        self._task = Some(cx.spawn(async move |this, cx| {
            let found = found.await.and_then(|release| {
                release.ok_or_else(|| {
                    t!("The classic version has no release for this Mac").to_string()
                })
            });
            this.update(cx, |this, cx| match found {
                Ok(release) => this.install_release(release, channel.public_key, true, cx),
                Err(error) => {
                    this.phase = Phase::Error(error.clone());
                    show(
                        ToastLevel::Error,
                        t!("Couldn’t switch to the classic version").to_string(),
                        error,
                        Vec::new(),
                        cx,
                    );
                }
            })
            .ok();
        }));
    }

    /// Download `release`, check it against `public_key`, put it in place of
    /// this bundle and restart into it: an update, or the classic version
    /// (`classic`, which names it so in the notices).
    fn install_release(
        &mut self,
        release: manifest::Release,
        public_key: String,
        classic: bool,
        cx: &mut Context<Self>,
    ) {
        let version = release.version.clone();
        let version_line = t!("Version {version}", version = version).to_string();
        self.phase = Phase::Downloading {
            version: version.clone(),
            progress: None,
        };
        show_running(
            if classic {
                t!("Downloading the classic version…").to_string()
            } else {
                t!("Downloading update…").to_string()
            },
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
            install::verify(&bytes, &release.platform.signature, &public_key)?;
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
                        if classic {
                            t!("Couldn’t switch to the classic version").to_string()
                        } else {
                            t!("Lattice update failed").to_string()
                        },
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
    let mut notice = Notice::new(ToastLevel::Info, title)
        .source(source())
        .key(NOTICE_KEY)
        .running();
    if !detail.is_empty() {
        notice = notice.detail(detail);
    }
    notices::show(notice, cx);
}

/// The app-wide handler for Check for Updates… (and Restart to Update…).
pub fn register_actions(cx: &mut App) {
    cx.on_action(|_: &CheckForUpdates, cx| {
        if let Some(updater) = global(cx) {
            updater.update(cx, |updater, cx| updater.check(true, cx));
        }
    });
}

/// Point the updater at `channel` and turn Beta updates on, for a
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
    fn the_channel_is_the_flavors_feed_checked_with_the_tauri_updaters_key() {
        let channel = super::channel().unwrap();
        assert_eq!(channel.endpoint, crate::flavor::current().endpoint);
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(channel.public_key, config["plugins"]["updater"]["pubkey"]);
    }

    #[test]
    fn the_classic_channel_is_the_tauri_apps_feed_with_the_same_key() {
        let classic = super::classic_channel().unwrap();
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(
            classic.endpoint,
            config["plugins"]["updater"]["endpoints"][0]
        );
        assert_eq!(classic.public_key, super::channel().unwrap().public_key);
        // A binary outside a bundle is Lattice Beta, which never offers it.
        assert!(!super::offers_classic());
    }
}
