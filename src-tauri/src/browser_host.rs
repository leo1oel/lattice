//! Loopback browser host: serves the app to a browser on a fixed local port.
//!
//! `http://127.0.0.1:18452` is the fixed entry point. Every workspace opened
//! there is backed by a hidden native *host* WebView that owns the project and
//! relays IPC to the visible page over a WebSocket bridge (`session`). In
//! packaged builds the visible page is the bundled Chromium renderer
//! (`crate::chromium`); an ordinary browser tab can use the same entry on the
//! development and testing path (`--browser-host`).
//!
//! - `/__lattice_session` mints or resumes a session token for the fixed entry.
//! - `/__lattice_bridge` upgrades a host, browser, or desktop peer.
//! - everything else serves the bundled frontend assets.

pub(crate) mod dialogs;
mod server;
mod session;
mod takeover;

use super::AppState;
use serde::Serialize;
use session::{BrowserSession, BrowserSessionConfig, Sessions};
use std::{
    collections::HashMap,
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

const PREFERRED_PORT: u16 = 18452;
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
    pub(crate) fn open_project(
        &self, app: &tauri::AppHandle, state: &AppState, project_root: PathBuf,
    ) -> Result<String, String> {
        let host_label = new_host_label();
        state.bind_window(&host_label, project_root.clone())?;
        let opened =
            self.open_session(app, |origin| BrowserSession::new(host_label.clone(), origin));
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
        let Some(browser_url) = self.workspace_url(host_label)? else {
            return Ok(false);
        };
        open_workspace_url(app, &browser_url)?;
        Ok(true)
    }

    fn server(&self) -> Result<Option<RunningServer>, String> {
        Ok(self.running.lock().map_err(|_| SERVER_UNAVAILABLE.to_string())?.clone())
    }

    fn workspace_url(&self, host_label: &str) -> Result<Option<String>, String> {
        let Some(server) = self.server()? else {
            return Ok(None);
        };
        let sessions = session::lock(&server.sessions)?;
        Ok(sessions.iter().find(|(_, session)| session.host_label == host_label).map(
            |(token, session)| {
                BrowserSessionConfig::new(token, session, server.port).url(&session.browser_origin)
            },
        ))
    }

    /// Reopen the Chromium workspace owned by the fixed entry, if one is still
    /// alive. This is the macOS reopen behavior while its window is closed.
    pub(crate) fn reopen_entry(&self, app: &tauri::AppHandle) -> Result<bool, String> {
        let Some(server) = self.server()? else {
            return Ok(false);
        };
        let config = server.sessions.lock().ok().and_then(|sessions| {
            session::reusable_entry_config(&sessions, server.port, None, true)
        });
        let Some(config) = config else {
            return Ok(false);
        };
        open_workspace_url(app, &config.url(&browser_origin(app, server.port)))?;
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

    /// Register a new session, start its hidden host, and open its page.
    fn open_session(
        &self, app: &tauri::AppHandle, session: impl FnOnce(String) -> BrowserSession,
    ) -> Result<String, String> {
        let server = self.ensure_server(app, false)?;
        let token = new_token();
        let session = session(browser_origin(app, server.port));
        let host_label = session.host_label.clone();
        let browser_url =
            BrowserSessionConfig::new(&token, &session, server.port).url(&session.browser_origin);
        session::lock(&server.sessions)?.insert(token.clone(), session);

        let opened = build_host_window(app, &host_label, &token, server.port).and_then(|()| {
            open_workspace_url(app, &browser_url).inspect_err(|_| destroy_window(app, &host_label))
        });
        if let Err(error) = opened {
            session::remove(&server.sessions, &token);
            return Err(error);
        }
        Ok(browser_url)
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

fn open_workspace_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    if app.state::<crate::chromium::ChromiumRuntime>().open_url(url)? {
        return Ok(());
    }
    open_in_default_browser(app, url)
}

fn open_in_default_browser(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
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
