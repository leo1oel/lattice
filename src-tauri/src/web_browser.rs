//! Native navigation controls around an unprivileged remote WebView.
//! Remote pages never receive workspace IPC authority, a sidecar token or a
//! persistent browser profile. Website framing restrictions are not bypassed.
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State, Webview};
use tauri_plugin_opener::OpenerExt;

const CONTENT: &str = "site-content-";
const CONTROLS: &str = "site-controls-";
const UNAVAILABLE: &str = "The web browser window is no longer available.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    url: String,
    title: String,
    loading: bool,
}
struct BrowserSession {
    content: String,
    window: String,
    status: BrowserStatus,
    chinese: bool,
}
#[derive(Default)]
pub struct WebBrowsers(Mutex<HashMap<String, BrowserSession>>);

/// Custom app commands do not use the plugin ACL. Enforce this boundary before
/// the generated workspace dispatcher, even if a remote page learns its IPC key.
pub fn isolated<R: Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| match filter_invoke(invoke) {
        Some(invoke) => handler(invoke),
        None => true,
    }
}

fn filter_invoke<R: Runtime>(invoke: tauri::ipc::Invoke<R>) -> Option<tauri::ipc::Invoke<R>> {
    let label = invoke.message.webview().label().to_string();
    let command = invoke.message.command();
    if label.starts_with(CONTENT)
        || (label.starts_with(CONTROLS)
            && !matches!(
                command,
                "web_browser_status" | "web_browser_navigate" | "web_browser_action"
            ))
    {
        invoke.resolver.reject("Workspace commands are unavailable in web content.");
        return None;
    }
    Some(invoke)
}

fn address(input: &str) -> Result<tauri::Url, String> {
    let input = input.trim();
    let url = tauri::Url::parse(input)
        .or_else(|_| tauri::Url::parse(&format!("https://{input}")))
        .map_err(|_| "Enter an HTTP or HTTPS web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Enter an HTTP or HTTPS web address.".to_string());
    }
    Ok(url)
}

fn toolbar_address(url: &tauri::Url, development_url: Option<&tauri::Url>) -> bool {
    let native_origin = ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none();
    url.path() == "/browser.html"
        && (native_origin || development_url.is_some_and(|base| base.origin() == url.origin()))
}

fn update(app: &AppHandle, controls: &str, change: impl FnOnce(&mut BrowserStatus)) {
    if let Ok(mut browsers) = app.state::<WebBrowsers>().0.lock() {
        if let Some(browser) = browsers.get_mut(controls) {
            change(&mut browser.status);
        }
    }
}

#[tauri::command]
pub async fn web_browser_open(
    app: AppHandle, url: Option<String>, locale: Option<String>,
) -> Result<(), String> {
    let url = address(url.as_deref().unwrap_or("https://example.com"))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let controls = format!("{CONTROLS}{id}");
    let content = format!("{CONTENT}{id}");
    {
        let state = app.state::<WebBrowsers>();
        let mut browsers = state.0.lock().map_err(|_| UNAVAILABLE.to_string())?;
        if browsers.len() >= 4 {
            return Err("Close a web browser window before opening another.".into());
        }
        browsers.insert(
            controls.clone(),
            BrowserSession {
                content: content.clone(),
                window: content.clone(),
                chinese: locale.as_deref() == Some("zh-CN"),
                status: BrowserStatus { url: url.to_string(), title: String::new(), loading: true },
            },
        );
    }
    let result = create_window(&app, &controls, &content, url, locale.as_deref() == Some("zh-CN"));
    if result.is_err() {
        app.state::<WebBrowsers>().0.lock().unwrap().remove(&controls);
        if let Some(window) = app.get_webview_window(&content) {
            let _ = window.destroy();
        }
    }
    result.map_err(|_| "Could not open the web browser window.".to_string())
}

fn create_window(
    app: &AppHandle, controls: &str, content: &str, url: tauri::Url, chinese: bool,
) -> tauri::Result<()> {
    let navigation_app = app.clone();
    let navigation_controls = controls.to_string();
    let title_app = app.clone();
    let title_controls = controls.to_string();
    let load_app = app.clone();
    let load_controls = controls.to_string();
    let popup_app = app.clone();
    let popup_content = content.to_string();
    // A normal, single-WebView window preserves Wry's page-first command-key
    // handling. Enabling Tauri's global multi-webview feature breaks editors.
    let remote = tauri::WebviewWindowBuilder::new(app, content, tauri::WebviewUrl::External(url))
        .title(if chinese { "Lattice 浏览器" } else { "Lattice Browser" })
        .inner_size(1100.0, 800.0)
        .min_inner_size(600.0, 420.0)
        .incognito(true)
        .on_navigation(move |url| {
            if address(url.as_str()).is_err() {
                return false;
            }
            update(&navigation_app, &navigation_controls, |status| {
                status.url = url.to_string();
                status.loading = true;
            });
            true
        })
        .on_document_title_changed(move |window, title| {
            let title: String = title.chars().take(256).collect();
            let origin =
                window.url().map(|url| url.origin().ascii_serialization()).unwrap_or_default();
            let _ = window.set_title(&format!("{origin} — {title} — Lattice"));
            update(&title_app, &title_controls, |status| status.title = title);
        })
        .on_page_load(move |_, payload| {
            update(&load_app, &load_controls, |status| {
                status.loading = payload.event() == tauri::webview::PageLoadEvent::Started
            })
        })
        .on_new_window(move |url, _| {
            if address(url.as_str()).is_ok() {
                if let Some(view) = popup_app.get_webview_window(&popup_content) {
                    let _ = view.navigate(url);
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
        .build()?;
    let route = if chinese { "browser.html?lang=zh-CN" } else { "browser.html?lang=en" };
    let development_url =
        if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
    let toolbar =
        tauri::WebviewWindowBuilder::new(app, controls, tauri::WebviewUrl::App(route.into()))
            .title(if chinese { "网页地址 — Lattice" } else { "Web address — Lattice" })
            .inner_size(960.0, 96.0)
            .min_inner_size(650.0, 96.0)
            .resizable(false)
            .visible(false)
            .parent(&remote)?
            .on_navigation(move |url| toolbar_address(url, development_url.as_ref()))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()?;
    let close_toolbar = toolbar.clone();
    let close_remote = remote.clone();
    toolbar.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_toolbar.hide();
            let _ = close_remote.set_focus();
        }
    });
    let event_app = app.clone();
    let event_controls = controls.to_string();
    remote.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            event_app.state::<WebBrowsers>().0.lock().unwrap().remove(&event_controls);
            if let Some(toolbar) = event_app.get_webview_window(&event_controls) {
                let _ = toolbar.destroy();
            }
        }
    });
    if let Some(label) = crate::macos_window::focused_window_label() {
        focus_menu(app, &label);
    }
    Ok(())
}

pub(crate) fn is_browser_window(label: &str) -> bool {
    label.starts_with(CONTENT) || label.starts_with(CONTROLS)
}

pub(crate) fn window_state_tracks(label: &str) -> bool {
    !label.starts_with("browser-") && !is_browser_window(label)
}

pub(crate) fn append_navigation_menu<R: Runtime>(
    app: &tauri::AppHandle<R>, menu: &tauri::menu::Menu<R>,
) -> tauri::Result<()> {
    menu::append(app, menu)
}

pub(crate) fn focus_menu<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    menu::focus(app, label);
}
pub(crate) fn handle_menu_event(app: &AppHandle, event: &tauri::menu::MenuEvent) -> bool {
    menu::handle(app, event)
}

fn own_session(
    state: &WebBrowsers, caller: &Webview,
) -> Result<(String, String, BrowserStatus), String> {
    state
        .0
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .get(caller.label())
        .map(|session| (session.content.clone(), session.window.clone(), session.status.clone()))
        .ok_or_else(|| UNAVAILABLE.to_string())
}

#[tauri::command]
pub async fn web_browser_status(
    app: AppHandle, caller: Webview, state: State<'_, WebBrowsers>,
) -> Result<BrowserStatus, String> {
    let (content, _, mut status) = own_session(&state, &caller)?;
    // SPA history.pushState can change the address without a new page load.
    if let Some(view) = app.get_webview_window(&content) {
        if let Ok(url) = view.url() {
            status.url = url.to_string();
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn web_browser_navigate(
    app: AppHandle, caller: Webview, state: State<'_, WebBrowsers>, url: String,
) -> Result<(), String> {
    let url = address(&url)?;
    let (content, _, _) = own_session(&state, &caller)?;
    let remote = app.get_webview_window(&content).ok_or_else(|| UNAVAILABLE.to_string())?;
    remote.navigate(url).map_err(|_| UNAVAILABLE.to_string())?;
    if let Some(toolbar) = app.get_webview_window(caller.label()) {
        let _ = toolbar.hide();
    }
    let _ = remote.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn web_browser_action(
    app: AppHandle, caller: Webview, state: State<'_, WebBrowsers>, action: String,
) -> Result<(), String> {
    let (_, window, _) = own_session(&state, &caller)?;
    perform_action(&app, &window, &action)
}

fn perform_action(app: &AppHandle, window: &str, action: &str) -> Result<(), String> {
    let state = app.state::<WebBrowsers>();
    let controls = state
        .0
        .lock()
        .map_err(|_| UNAVAILABLE.to_string())?
        .iter()
        .find(|(_, session)| session.content == window)
        .map(|(controls, _)| controls.clone())
        .ok_or_else(|| UNAVAILABLE.to_string())?;
    let content = window;
    let view = app.get_webview_window(&content).ok_or_else(|| UNAVAILABLE.to_string())?;
    let operation = match action {
        "address" => {
            let toolbar =
                app.get_webview_window(&controls).ok_or_else(|| UNAVAILABLE.to_string())?;
            toolbar.show().map_err(|_| UNAVAILABLE.to_string())?;
            toolbar.set_focus().map_err(|_| UNAVAILABLE.to_string())?;
            toolbar.eval("window.dispatchEvent(new Event('lattice-browser-address'))")
        }
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        "close" => app.get_webview_window(&content).ok_or_else(|| UNAVAILABLE.to_string())?.close(),
        "external" => {
            return app
                .opener()
                .open_url(
                    address(view.url().map_err(|_| UNAVAILABLE.to_string())?.as_str())?.as_str(),
                    None::<&str>,
                )
                .map_err(|_| "Could not open this page in the default browser.".to_string())
        }
        _ => return Err("Unknown web browser action.".to_string()),
    };
    operation.map_err(|_| UNAVAILABLE.to_string())
}

mod menu;
#[cfg(test)]
mod tests;
