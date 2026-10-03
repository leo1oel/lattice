//! Loopback browser host: serves the app to a browser on a fixed local port.
//!
//! `http://127.0.0.1:18452` is the fixed, bookmarkable entry point. Every
//! workspace opened there is backed by a hidden native *host* WebView that owns
//! the project and relays IPC to the visible page over a WebSocket bridge
//! (`session`). In packaged builds the visible page is normally the bundled
//! Chromium renderer (`crate::chromium`); "Open in browser" hands the same
//! workspace to the default browser and the window comes back when the tab
//! returns it or closes. The listener lives exactly as long as Lattice runs.
//!
//! - `/__lattice_session` mints or resumes a session token for the fixed entry,
//!   or hands out the one a single-use `?entry=` nonce was issued for.
//! - `/__lattice_bridge` upgrades a host, browser, or desktop peer.
//! - everything else serves the bundled frontend assets.

pub(crate) mod dialogs;
mod server;
mod session;
mod takeover;

use super::AppState;
use serde::Serialize;
use session::{BrowserSession, BrowserSessionConfig, Effect, HandoffTimeout, ReturnPlan, Sessions};
use std::{
    collections::HashMap,
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

const PREFERRED_PORT: u16 = 18452;
/// How long a handoff waits for the surface giving up the workspace to save
/// before giving up on the handoff. That save may wait up to 15 seconds for
/// deferred Overleaf whole-file syncs, and a waiting tab gives up on its own
/// after 20 (`handoff-timeout` in browser-runtime.ts).
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(17);
const SERVER_UNAVAILABLE: &str = "Browser server state is unavailable.";
pub(crate) const SERVICE_WINDOW_LABEL: &str = "browser-service";

#[derive(Default)]
pub(crate) struct BrowserHost {
    running: Mutex<Option<RunningServer>>,
}

#[derive(Clone)]
struct RunningServer {
    port: u16,
    sessions: Sessions,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBridgeConfig<'a> {
    token: &'a str,
    port: u16,
}

fn bind_browser_listener(take_over_background_host: bool) -> io::Result<TcpListener> {
    #[cfg(feature = "perf-lab")]
    if let Some(port) = crate::perf_lab::port() {
        // A lab run has its own port and never takes over anyone's listener.
        return TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    }
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PREFERRED_PORT);
    match TcpListener::bind(address) {
        Ok(listener) => Ok(listener),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            takeover::replace_stale_browser_host(address, take_over_background_host).ok_or(error)
        }
        Err(error) => Err(error),
    }
}

fn new_host_label() -> String {
    format!("browser-{}", uuid::Uuid::new_v4().simple())
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl BrowserHost {
    /// Open `project_root` in a new bridged workspace: a new tab when the
    /// caller is a browser tab, otherwise a new Chromium window.
    pub(crate) fn open_project(
        &self, app: &tauri::AppHandle, state: &AppState, project_root: PathBuf, in_browser: bool,
    ) -> Result<String, String> {
        let host_label = new_host_label();
        state.bind_window(&host_label, project_root.clone())?;
        let opened = self.open_session(app, in_browser, |origin| {
            BrowserSession::new(host_label.clone(), origin)
        });
        if let Err(reason) = opened {
            state.abandon_window(&host_label);
            return Err(reason);
        }
        Ok(host_label)
    }

    /// Open a browser-hosted project's authenticated URL again; false when no
    /// session backs `host_label`. The surface may focus the existing page or
    /// replace it with a fresh one; either outcome is usable, unlike focusing
    /// the deliberately hidden native host window.
    pub(crate) fn reopen_window(
        &self, app: &tauri::AppHandle, host_label: &str,
    ) -> Result<bool, String> {
        let Some((config, origin)) = self.workspace_config(host_label)? else {
            return Ok(false);
        };
        open_workspace(app, &self.sessions()?, &config, &origin)?;
        Ok(true)
    }

    fn server(&self) -> Result<Option<RunningServer>, String> {
        Ok(self.running.lock().map_err(|_| SERVER_UNAVAILABLE.to_string())?.clone())
    }

    fn sessions(&self) -> Result<Sessions, String> {
        self.server()?.map(|server| server.sessions).ok_or_else(|| SERVER_UNAVAILABLE.to_string())
    }

    /// True when a browser tab currently shows the bridged workspace `host_label`.
    pub(crate) fn shown_in_browser(&self, host_label: &str) -> bool {
        self.sessions().is_ok_and(|sessions| {
            sessions.lock().is_ok_and(|sessions| {
                sessions.values().any(|session| {
                    session.host_label == host_label
                        && session.owner == Some(session::Surface::Browser)
                })
            })
        })
    }

    /// Hand the workspace of window `label` to the default browser.
    ///
    /// A Chromium window opens its own session's address there: the tab asks
    /// the window to save and yield, then the window hides until the tab gives
    /// the workspace back or closes. A native WebKit window has no shareable
    /// session, so a new one is prepared that stays inactive until that window
    /// has closed (`activate_source`). No login item is involved: the address
    /// works for as long as Lattice runs.
    pub(crate) fn open_in_browser(
        &self, app: &tauri::AppHandle, state: &AppState, label: &str,
    ) -> Result<(), String> {
        if label.starts_with("browser-") {
            if self.shown_in_browser(label) {
                return Err("This workspace is already open in your browser.".to_string());
            }
            let Some((config, origin)) = self.workspace_config(label)? else {
                return Err("This Lattice workspace is no longer available.".to_string());
            };
            return open_in_default_browser(app, &self.sessions()?, &config, &origin);
        }
        let project_root = state.root_for(label)?;
        // Closing the native window must not end the process while the tab
        // still needs its host, nor once that tab is gone.
        let resident_was_present = app.get_window(SERVICE_WINDOW_LABEL).is_some();
        self.keep_resident(app)?;
        let opened = self.open_session(app, true, |origin| BrowserSession {
            source_label: Some(label.to_string()),
            project_root,
            entry_session: true,
            active: false,
            ..BrowserSession::new(new_host_label(), origin)
        });
        match opened {
            Ok(token) => {
                // A tab that never connects must not leave the workspace with
                // no window at all: it then reopens natively.
                let sessions = self.sessions()?;
                server::settle_later(app, &sessions, token, 0, server::SESSION_CONNECT_TIMEOUT);
                Ok(())
            }
            Err(reason) => {
                if !resident_was_present {
                    if let Some(window) = app.get_window(SERVICE_WINDOW_LABEL) {
                        let _ = window.destroy();
                    }
                }
                Err(reason)
            }
        }
    }

    /// Move the browser workspace `host_label` back to the desktop: to its
    /// parked Chromium window (after the tab yields), to a reopened Chromium
    /// window, or, without Chromium, to a new native window.
    pub(crate) fn return_to_desktop(
        &self, app: &tauri::AppHandle, state: &AppState, host_label: &str,
    ) -> Result<(), String> {
        let sessions = self.sessions()?;
        let chromium_running = app.state::<crate::chromium::ChromiumRuntime>().is_running();
        match session::request_return(&sessions, host_label, chromium_running)? {
            ReturnPlan::Handoff(token, id) => {
                apply_effect(app, &sessions, &token, Effect::HandoffStarted(id));
                Ok(())
            }
            ReturnPlan::OpenChromium => {
                let Some((config, origin)) = self.workspace_config(host_label)? else {
                    return Err("This Lattice workspace is no longer available.".to_string());
                };
                open_workspace(app, &sessions, &config, &origin)
            }
            ReturnPlan::Native(token) => {
                let root = state
                    .root_for(host_label)?
                    .ok_or_else(|| "This browser workspace has no project open.".to_string())?;
                reopen_in_native_window(app, state, root)?;
                if let Some(host_label) = session::finish_native_return(&sessions, &token) {
                    retire_host_soon(app, host_label);
                }
                Ok(())
            }
        }
    }

    /// Complete a native window's handoff only after it has run its normal
    /// close-request cleanup. Until then the browser's IPC calls stay queued,
    /// so two interfaces can never operate on the same project concurrently.
    pub(crate) fn activate_source(&self, source_label: &str, state: &AppState) {
        let Ok(sessions) = self.sessions() else {
            return;
        };
        let handoffs = sessions.lock().map_or_else(
            |_| Vec::new(),
            |sessions| {
                sessions
                    .iter()
                    .filter(|(_, session)| {
                        !session.active && session.source_label.as_deref() == Some(source_label)
                    })
                    .map(|(token, session)| {
                        (token.clone(), session.host_label.clone(), session.project_root.clone())
                    })
                    .collect::<Vec<_>>()
            },
        );
        for (token, host_label, project_root) in handoffs {
            let bound = project_root.map_or(Ok(()), |root| state.bind_window(&host_label, root));
            if let Err(reason) = bound {
                session::send_error(&sessions, &token, &reason);
                continue;
            }
            if let Ok(mut sessions) = sessions.lock() {
                if let Some(session) = sessions.get_mut(&token) {
                    session::activate(session);
                }
            }
        }
    }

    /// Once the last native window has handed its workspace to the browser,
    /// the app is only a local service for the tab. Keep that hidden bridge
    /// out of the Dock, Command-Tab and the Window menu instead of showing an
    /// app with no windows.
    pub(crate) fn hide_desktop_shell_if_browser_only(&self, app: &tauri::AppHandle) {
        let Ok(sessions) = self.sessions() else {
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // The Destroyed callback can run before Tauri removes the source
            // from its window map. Let that lifecycle settle before deciding
            // whether any native workspace remains.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let has_session =
                sessions.lock().is_ok_and(|sessions| session::holds_native_handoff(&sessions));
            let windows = app.webview_windows();
            let browser_only =
                !windows.is_empty() && windows.keys().all(|label| label.starts_with("browser-"));
            if has_session && browser_only {
                if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
                    log::warn!(
                        target: "lattice::browser",
                        "could not hide browser host from the desktop: {error}"
                    );
                }
            }
        });
    }

    fn workspace_config(
        &self, host_label: &str,
    ) -> Result<Option<(BrowserSessionConfig, String)>, String> {
        let Some(server) = self.server()? else {
            return Ok(None);
        };
        let sessions = session::lock(&server.sessions)?;
        Ok(sessions.iter().find(|(_, session)| session.host_label == host_label).map(
            |(token, session)| {
                (
                    BrowserSessionConfig::new(token, session, server.port),
                    session.browser_origin.clone(),
                )
            },
        ))
    }

    /// Reopen the workspace owned by the fixed entry, if one is still alive.
    /// This is the macOS reopen behavior while its window is closed; a
    /// workspace a browser tab holds opens on its standby screen.
    pub(crate) fn reopen_entry(&self, app: &tauri::AppHandle) -> Result<bool, String> {
        let Some(server) = self.server()? else {
            return Ok(false);
        };
        let config = server
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| session::reusable_entry_config(&sessions, server.port, None));
        let Some(config) = config else {
            return Ok(false);
        };
        open_workspace(app, &server.sessions, &config, &browser_origin(app, server.port))?;
        Ok(true)
    }

    /// Start the small loopback listener without creating a workspace. The
    /// listener survives browser-tab teardown and is what makes the bookmarked
    /// address a permanent entry point.
    pub(crate) fn start(
        &self, app: &tauri::AppHandle, take_over_background_host: bool,
    ) -> Result<u16, String> {
        self.ensure_server(app, take_over_background_host).map(|server| server.port)
    }

    /// A native window with no WebView keeps Tauri's event loop alive after the
    /// last browser workspace is torn down. Unlike retaining the bridge, this
    /// costs no renderer and owns no project; an explicit app Quit still exits
    /// normally because the window is only hidden, not an exit interceptor.
    pub(crate) fn keep_resident(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if app.get_window(SERVICE_WINDOW_LABEL).is_some() {
            return Ok(());
        }
        tauri::window::WindowBuilder::new(app, SERVICE_WINDOW_LABEL)
            .title("")
            .inner_size(1.0, 1.0)
            .visible(false)
            .focused(false)
            .focusable(false)
            .skip_taskbar(true)
            .build()
            .map(|_| ())
            .map_err(|error| format!("Could not keep local browser access ready: {error}"))
    }

    /// Register a new session, start its hidden host, and open its page in
    /// the default browser or the usual workspace surface; returns its token.
    fn open_session(
        &self, app: &tauri::AppHandle, in_browser: bool,
        session: impl FnOnce(String) -> BrowserSession,
    ) -> Result<String, String> {
        let server = self.ensure_server(app, false)?;
        let token = new_token();
        let session = session(browser_origin(app, server.port));
        let host_label = session.host_label.clone();
        let config = BrowserSessionConfig::new(&token, &session, server.port);
        let origin = session.browser_origin.clone();
        {
            let mut sessions = session::lock(&server.sessions)?;
            if session
                .source_label
                .as_deref()
                .is_some_and(|source_label| session::handoff_pending(&sessions, source_label))
            {
                return Err("This Lattice window is already opening in your browser.".to_string());
            }
            sessions.insert(token.clone(), session);
        }

        let opened = build_host_window(app, &host_label, &token, server.port).and_then(|()| {
            let page = if in_browser {
                open_in_default_browser(app, &server.sessions, &config, &origin)
            } else {
                open_workspace(app, &server.sessions, &config, &origin)
            };
            page.inspect_err(|_| destroy_window(app, &host_label))
        });
        if let Err(error) = opened {
            session::remove(&server.sessions, &token);
            return Err(error);
        }
        Ok(token)
    }

    fn ensure_server(
        &self, app: &tauri::AppHandle, take_over_background_host: bool,
    ) -> Result<RunningServer, String> {
        let mut running = self.running.lock().map_err(|_| SERVER_UNAVAILABLE.to_string())?;
        if let Some(server) = running.as_ref() {
            return Ok(server.clone());
        }

        // A bookmark can only be permanent if its port is permanent. Do not
        // silently fall back to a random port: that would make the setting look
        // enabled while the saved address opens some other process or nothing.
        let listener = bind_browser_listener(take_over_background_host).map_err(|error| {
            format!(
                "Could not start local browser access at http://127.0.0.1:{PREFERRED_PORT}: {error}"
            )
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure local browser access: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not read the local browser address: {error}"))?
            .port();
        let server = RunningServer { port, sessions: Arc::new(Mutex::new(HashMap::new())) };
        server::spawn(app.clone(), port, Arc::clone(&server.sessions), listener);
        *running = Some(server.clone());
        Ok(server)
    }
}

fn open_workspace(
    app: &tauri::AppHandle, sessions: &Sessions, config: &BrowserSessionConfig, origin: &str,
) -> Result<(), String> {
    if app.state::<crate::chromium::ChromiumRuntime>().open_url(&config.url(origin))? {
        return Ok(());
    }
    open_in_default_browser(app, sessions, config, origin)
}

/// The default browser gets a tokenless entry address with a single-use
/// nonce: `open` puts it in process arguments, and the browser keeps it in
/// history and bookmarks.
fn open_in_default_browser(
    app: &tauri::AppHandle, sessions: &Sessions, config: &BrowserSessionConfig, origin: &str,
) -> Result<(), String> {
    let nonce = session::issue_entry_nonce(sessions, &config.token)?;
    app.opener()
        .open_url(session::entry_url(origin, &nonce), None::<&str>)
        .map_err(|error| format!("Could not open the browser workspace: {error}"))
}

fn browser_origin(app: &tauri::AppHandle, port: u16) -> String {
    #[cfg(debug_assertions)]
    if let Some(url) = app.config().build.dev_url.as_ref() {
        return url.origin().ascii_serialization();
    }
    let _ = app;
    format!("http://127.0.0.1:{port}")
}

fn build_host_window(
    app: &tauri::AppHandle, host_label: &str, token: &str, port: u16,
) -> Result<(), String> {
    let config = serde_json::to_string(&HostBridgeConfig { token, port })
        .map_err(|error| format!("Could not configure browser access: {error}"))?;
    tauri::WebviewWindowBuilder::new(app, host_label, WebviewUrl::App("index.html".into()))
        .title("")
        .visible(false)
        .skip_taskbar(true)
        // This WebView is the native half of the browser bridge. WebKit's default
        // hidden-view policy suspends its JavaScript, which would leave later
        // browser invokes waiting forever.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(format!("window.__LATTICE_BROWSER_HOST_CONFIG__ = {config};"))
        .build()
        .map(|_| ())
        .map_err(|error| format!("Could not start the browser bridge: {error}"))
}

fn destroy_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

/// Show `root`, which a browser tab held, in a native window again.
fn reopen_in_native_window(
    app: &tauri::AppHandle, state: &AppState, root: PathBuf,
) -> Result<(), String> {
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| format!("Could not show Lattice in the Dock: {error}"))?;
    let (_, window) = crate::ipc::windows::open_desktop_window(app, state, root)?;
    let _ = window.set_focus();
    Ok(())
}

/// Destroy a retired session's hidden host once its last messages are out.
fn retire_host_soon(app: &tauri::AppHandle, host_label: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        destroy_window(&app, &host_label);
    });
}

/// Show or hide the Chromium window of a workspace while a tab holds it.
fn show_chromium_workspace(
    app: &tauri::AppHandle, sessions: &Sessions, token: &str, visible: bool,
) {
    let host_label = sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(token).map(|session| session.host_label.clone()));
    let Some(host_label) = host_label else {
        return;
    };
    let chromium = app.state::<crate::chromium::ChromiumRuntime>();
    if let Err(reason) = chromium.set_window_visibility(&host_label, visible) {
        let action = if visible { "show" } else { "hide" };
        log::warn!(target: "lattice::chromium", "could not {action} Chromium workspace: {reason}");
    }
}

/// Apply what a session change asks of the app.
fn apply_effect(app: &tauri::AppHandle, sessions: &Sessions, token: &str, effect: Effect) {
    match effect {
        Effect::HandoffStarted(id) => {
            let (app, sessions, token) = (app.clone(), Arc::clone(sessions), token.to_string());
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(HANDOFF_TIMEOUT).await;
                match session::finish_handoff(&sessions, &token, id) {
                    None => {}
                    Some(HandoffTimeout::Kept) => log::warn!(
                        target: "lattice::browser",
                        "the workspace did not confirm its save in time; it stays where it is"
                    ),
                    Some(HandoffTimeout::Switched(effect)) => {
                        apply_effect(&app, &sessions, &token, effect);
                    }
                }
            });
        }
        Effect::Parked => show_chromium_workspace(app, sessions, token, false),
        Effect::Resumed => show_chromium_workspace(app, sessions, token, true),
    }
}
