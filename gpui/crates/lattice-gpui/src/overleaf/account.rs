//! The Overleaf account: where its session stands, the sign-in window, and
//! signing out, as the Tauri app has them (`use-overleaf-login.ts` and
//! `overleaf_begin_login`, `overleaf_poll_login`, `overleaf_cancel_login`,
//! `overleaf_disconnect` in `src-tauri/src/ipc/overleaf.rs`).
//!
//! Signing in happens on Overleaf's own login page, in a window of its own:
//! the writer signs in exactly as in a browser (SSO included), and Lattice
//! never sees the password. The window is a WKWebView with no browser
//! chrome, in a fresh cookie store each time, so the next sign-in can choose
//! another account; a control on every page but the login page leads back to
//! it (`overleaf_login_return.js`, the Tauri app's own script). While it is
//! open its cookie jar is read every 1.5 s; once it holds a session cookie
//! that opens the dashboard, lattice-core saves it as the session and the
//! window closes.

use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, EventEmitter, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Task, Window, WindowBounds,
    WindowOptions, div, px, size,
};
use gpui_webview::WebView;
use lattice_core::overleaf::{self, LoginAttempts, OverleafStatus};
use lattice_i18n::t;
use lattice_ui::ActiveLattice as _;

use super::config_dir;

/// Every sign-in attempt, so ending them (Cancel, Sign out) wins over a poll
/// still validating a cookie.
static LOGINS: LazyLock<Arc<LoginAttempts>> = LazyLock::new(Default::default);

/// How often the sign-in window's cookies are read.
const POLL: Duration = Duration::from_millis(1_500);
/// Polls before the wait says what to do next: signing in takes seconds,
/// never half a minute.
const HINT_AFTER: u32 = 20;

/// The account's session, read from the GPUI app's own session file.
pub fn status() -> Result<OverleafStatus, String> {
    overleaf::session_status(&config_dir())
}

/// Sign out: forget the session (the downloaded projects stay), ending any
/// sign-in under way so its poll cannot save one again.
pub fn disconnect() -> Result<(), String> {
    LOGINS.end(|| overleaf::disconnect(&config_dir()))
}

/// The sign-in window, while it is open.
struct LoginWindow {
    handle: AnyWindowHandle,
    webview: Entity<WebView>,
}

#[derive(Default)]
struct LoginWindowSlot(Option<LoginWindow>);

impl gpui::Global for LoginWindowSlot {}

/// The view the sign-in window shows: the page, filling it.
struct LoginPage {
    webview: Option<Entity<WebView>>,
}

impl Render for LoginPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(cx.palette().window)
            .children(self.webview.clone())
    }
}

/// The script that gives every page but the login page a control back to it.
fn login_return_script(login: &str, label: &str) -> String {
    let config = serde_json::json!({ "url": login, "label": label });
    format!(
        "{}({config});",
        include_str!("../../../../../src-tauri/src/ipc/overleaf_login_return.js")
    )
}

/// Open Overleaf's login page in the sign-in window, or bring the open one
/// forward.
fn open_login_window(cx: &mut App) -> Result<(), String> {
    if let Some(handle) = cx
        .try_global::<LoginWindowSlot>()
        .and_then(|slot| slot.0.as_ref().map(|open| open.handle))
    {
        if handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
        {
            return Ok(());
        }
    }
    let host = super::host();
    let login = format!("{host}/login");
    let script = login_return_script(&login, &t!("Back to Overleaf sign-in"));
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1040.), px(780.)),
            cx,
        ))),
        titlebar: Some(gpui::TitlebarOptions {
            title: Some(t!("Sign in to Overleaf").into()),
            ..Default::default()
        }),
        focus: true,
        ..Default::default()
    };
    let mut built: Result<Entity<WebView>, String> = Err(String::new());
    let handle = cx
        .open_window(options, |window, cx| {
            let builder = wry::WebViewBuilder::new()
                .with_url(&login)
                .with_initialization_script_for_main_only(script, true)
                // Signing out removes Lattice's saved session, not WebKit's
                // cookies. A fresh store lets the next sign-in choose another
                // account instead of silently capturing the previous one.
                .with_incognito(true)
                .with_accept_first_mouse(true);
            built = WebView::build(builder, window, cx)
                .map(|webview| cx.new(|_| webview))
                .map_err(|error| error.to_string());
            cx.new(|_| LoginPage {
                webview: built.as_ref().ok().cloned(),
            })
        })
        .map_err(|error| format!("Could not open the Overleaf sign-in window: {error}"))?;
    let any: AnyWindowHandle = handle.into();
    let webview = match built {
        Ok(webview) => webview,
        Err(error) => {
            any.update(cx, |_, window, _| window.remove_window()).ok();
            return Err(format!(
                "Could not open the Overleaf sign-in window: {error}"
            ));
        }
    };
    cx.set_global(LoginWindowSlot(Some(LoginWindow {
        handle: any,
        webview,
    })));
    Ok(())
}

/// Close the sign-in window, if it is open.
fn close_login_window(cx: &mut App) {
    let open = cx
        .try_global::<LoginWindowSlot>()
        .and_then(|slot| slot.0.as_ref().map(|open| open.handle));
    cx.set_global(LoginWindowSlot(None));
    if let Some(handle) = open {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// The session cookie header the sign-in window holds for Overleaf's host,
/// once it holds one; `Err` when the window was closed.
fn login_cookie(cx: &mut App) -> Result<Option<String>, ()> {
    let Some((handle, webview)) = cx
        .try_global::<LoginWindowSlot>()
        .and_then(|slot| slot.0.as_ref())
        .map(|open| (open.handle, open.webview.clone()))
    else {
        return Err(());
    };
    // The window was closed with its own button.
    if handle.update(cx, |_, _, _| ()).is_err() {
        return Err(());
    }
    let host = super::host();
    let target = host
        .split("://")
        .nth(1)
        .unwrap_or_default()
        .split(['/', ':'])
        .next()
        .unwrap_or_default()
        .to_string();
    // The whole jar, matched by domain here: Wry's `cookies_for_url`
    // compares the cookie's domain and the URL's host for equality, so a
    // `.overleaf.com` cookie never matches `www.overleaf.com`.
    let cookies = webview.read(cx).raw().cookies().unwrap_or_default();
    let matching: Vec<_> = cookies
        .iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_some_and(|domain| overleaf::cookie_domain_matches(domain, &target))
        })
        .collect();
    if !overleaf::has_session_cookie(matching.iter().map(|cookie| cookie.name())) {
        return Ok(None);
    }
    Ok(Some(
        matching
            .iter()
            .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
            .collect::<Vec<_>>()
            .join("; "),
    ))
}

/// What a sign-in's controls show.
pub enum LoginEvent {
    /// Signed in; the session is saved.
    Connected(OverleafStatus),
}

/// One place's sign-in: Settings › Overleaf and the picker each keep one, so
/// a writer can connect from either without being sent to the other.
#[derive(Default)]
pub struct Login {
    pub pending: bool,
    pub error: Option<SharedString>,
    pub notice: Option<SharedString>,
    /// What to do next, once the wait has gone on long enough to look stuck.
    pub hint: Option<SharedString>,
    poll: Option<Task<()>>,
}

impl EventEmitter<LoginEvent> for Login {}

impl Login {
    /// Open the sign-in window and wait for a session.
    pub fn begin(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.error = None;
        self.notice = None;
        self.hint = None;
        if let Err(error) = open_login_window(cx) {
            self.error = Some(error.into());
            cx.notify();
            return;
        }
        self.pending = true;
        cx.notify();
        self.poll = Some(cx.spawn(async move |this, cx| {
            let mut attempts = 0;
            loop {
                // Taken before the window is read: Cancel or Sign out from
                // here on ends this attempt, and its session is not saved.
                let attempt = LOGINS.current();
                let cookie = cx.update(login_cookie);
                let answer = match cookie {
                    Err(()) => None,
                    Ok(None) => Some(Err(None)),
                    Ok(Some(header)) => {
                        let logins = Arc::clone(&LOGINS);
                        let validated = cx
                            .background_spawn(async move {
                                overleaf::store_session_cookie(
                                    &config_dir(),
                                    &super::host(),
                                    &header,
                                    &logins,
                                    attempt,
                                )
                            })
                            .await;
                        match validated {
                            Ok(Some(session)) => Some(Ok(session)),
                            Ok(None) => None,
                            // A session cookie exists before the writer has
                            // signed in (anonymous visitors get one), so a
                            // rejected cookie usually means "not yet".
                            Err(reason) => Some(Err(Some(reason))),
                        }
                    }
                };
                let go_on = this
                    .update(cx, |this, cx| match answer {
                        None => {
                            this.cancelled(cx);
                            false
                        }
                        Some(Ok(session)) => {
                            this.pending = false;
                            this.hint = None;
                            close_login_window(cx);
                            super::session_changed(cx);
                            cx.emit(LoginEvent::Connected(session));
                            cx.notify();
                            false
                        }
                        Some(Err(detail)) => {
                            attempts += 1;
                            if attempts >= HINT_AFTER {
                                this.hint = Some(match detail {
                                    Some(detail) => t!("Still not connected: {0}", detail).into(),
                                    None => t!("Still waiting. Cancel this attempt, close the Overleaf window, and try connecting again").into(),
                                });
                                cx.notify();
                            }
                            true
                        }
                    })
                    .unwrap_or(false);
                if !go_on {
                    return;
                }
                cx.background_executor().timer(POLL).await;
            }
        }));
    }

    /// The writer cancelled, or closed the sign-in window.
    fn cancelled(&mut self, cx: &mut Context<Self>) {
        self.pending = false;
        self.hint = None;
        self.poll = None;
        // Ends the attempt in the backend too: a poll already validating a
        // cookie then saves no session.
        LOGINS.end(|| ());
        close_login_window(cx);
        self.notice = Some(t!("Sign-in was cancelled").into());
        cx.notify();
    }

    /// Cancel: close the sign-in window and stop waiting.
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            self.cancelled(cx);
        }
    }
}

impl Drop for Login {
    /// A place that stops waiting (the picker closing) leaves the window to
    /// the writer, as the Tauri app's unmount does: only the poll stops.
    fn drop(&mut self) {
        self.poll = None;
    }
}
