//! A trusted navigation bar beside an unprivileged remote WebView.
//! Remote pages never receive workspace IPC authority, a sidecar token or a
//! persistent browser profile. Website framing restrictions are not bypassed.
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, State, Webview};
use tauri_plugin_opener::OpenerExt;

const CONTENT: &str = "site-content-";
const CONTROLS: &str = "site-controls-";
const BAR_HEIGHT: f64 = 80.0;
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
    let window_label = format!("site-window-{id}");
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
                window: window_label.clone(),
                status: BrowserStatus { url: url.to_string(), title: String::new(), loading: true },
            },
        );
    }
    let result = create_window(
        &app,
        &window_label,
        &controls,
        &content,
        url,
        locale.as_deref() == Some("zh-CN"),
    );
    if result.is_err() {
        app.state::<WebBrowsers>().0.lock().unwrap().remove(&controls);
        if let Some(window) = app.get_window(&window_label) {
            let _ = window.destroy();
        }
    }
    result.map_err(|_| "Could not open the web browser window.".to_string())
}

fn create_window(
    app: &AppHandle, label: &str, controls: &str, content: &str, url: tauri::Url, chinese: bool,
) -> tauri::Result<()> {
    let window = tauri::window::WindowBuilder::new(app, label)
        .title(if chinese { "Lattice 浏览器" } else { "Lattice Browser" })
        .inner_size(1100.0, 800.0)
        .min_inner_size(600.0, 420.0)
        .build()?;
    let route = if chinese { "browser.html?lang=zh-CN" } else { "browser.html?lang=en" };
    let development_url =
        if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
    let toolbar =
        tauri::webview::WebviewBuilder::new(controls, tauri::WebviewUrl::App(route.into()))
            // The trusted toolbar cannot navigate to a remote document.
            .on_navigation(move |url| toolbar_address(url, development_url.as_ref()))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    window.add_child(
        toolbar,
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(1100.0, BAR_HEIGHT),
    )?;
    let navigation_app = app.clone();
    let navigation_controls = controls.to_string();
    let title_app = app.clone();
    let title_controls = controls.to_string();
    let load_app = app.clone();
    let load_controls = controls.to_string();
    let popup_app = app.clone();
    let popup_content = content.to_string();
    let remote = tauri::webview::WebviewBuilder::new(content, tauri::WebviewUrl::External(url))
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
        .on_document_title_changed(move |_, title| {
            update(&title_app, &title_controls, |status| {
                status.title = title.chars().take(256).collect()
            })
        })
        .on_page_load(move |_, payload| {
            update(&load_app, &load_controls, |status| {
                status.loading = payload.event() == tauri::webview::PageLoadEvent::Started
            })
        })
        .on_new_window(move |url, _| {
            if address(url.as_str()).is_ok() {
                if let Some(view) = popup_app.get_webview(&popup_content) {
                    let _ = view.navigate(url);
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|_, _| false);
    window.add_child(
        remote,
        LogicalPosition::new(0.0, BAR_HEIGHT),
        LogicalSize::new(1100.0, 800.0 - BAR_HEIGHT),
    )?;
    let event_app = app.clone();
    let event_controls = controls.to_string();
    let event_content = content.to_string();
    let event_window = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(size) => {
            let scale = event_window.scale_factor().unwrap_or(1.0);
            if let Some(view) = event_app.get_webview(&event_content) {
                let _ = view.set_size(LogicalSize::new(
                    f64::from(size.width) / scale,
                    (f64::from(size.height) / scale - BAR_HEIGHT).max(1.0),
                ));
            }
            if let Some(view) = event_app.get_webview(&event_controls) {
                let _ = view.set_size(LogicalSize::new(f64::from(size.width) / scale, BAR_HEIGHT));
            }
        }
        tauri::WindowEvent::Destroyed => {
            event_app.state::<WebBrowsers>().0.lock().unwrap().remove(&event_controls);
        }
        _ => {}
    });
    Ok(())
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
    if let Some(view) = app.get_webview(&content) {
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
    app.get_webview(&content)
        .ok_or_else(|| UNAVAILABLE.to_string())?
        .navigate(url)
        .map_err(|_| UNAVAILABLE.to_string())
}

#[tauri::command]
pub async fn web_browser_action(
    app: AppHandle, caller: Webview, state: State<'_, WebBrowsers>, action: String,
) -> Result<(), String> {
    let (content, window, _) = own_session(&state, &caller)?;
    let view = app.get_webview(&content).ok_or_else(|| UNAVAILABLE.to_string())?;
    let operation = match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        "close" => app.get_window(&window).ok_or_else(|| UNAVAILABLE.to_string())?.close(),
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

#[cfg(test)]
mod tests;
