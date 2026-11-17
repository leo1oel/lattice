//! An ordinary WKWebView placed over the Browser panel's content rectangle.
//! It has its own persistent website data store and no Tauri IPC scripts,
//! custom protocols, or app user-content controller.

use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{
    NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURLRequest, NSURL, NSUUID,
};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView,
    WKWebViewConfiguration, WKWebsiteDataStore,
};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use tauri::{Url, WebviewWindow};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PanelCommand {
    Navigate { url: String },
    Place { bounds: Option<PanelBounds> },
    Back,
    Forward,
    Reload,
    Status,
    Close,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelStatus {
    url: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    loading: bool,
}

fn web_address(address: &str) -> Option<Url> {
    let url = Url::parse(address.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || matches!(url.host_str(), None | Some("tauri.localhost" | "asset.localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url)
}

define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    struct BrowserNavigation;

    unsafe impl NSObjectProtocol for BrowserNavigation {}

    unsafe impl WKNavigationDelegate for BrowserNavigation {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_navigation(
            &self, view: &WKWebView, action: &WKNavigationAction,
            finish: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            // New-tab links stay in this browser panel. Retaining the view in
            // the AppKit hierarchy never grants a website the host's bridge.
            let request = unsafe { action.request() };
            let frame = unsafe { action.targetFrame() };
            let address = request.URL().and_then(|url| url.absoluteString());
            let allowed = address.is_some_and(|address| {
                let address = address.to_string();
                web_address(&address).is_some()
                    || (matches!(address.as_str(), "about:blank" | "about:srcdoc")
                        && frame.as_ref().is_some_and(|frame| !unsafe { frame.isMainFrame() }))
            }) && !unsafe { action.shouldPerformDownload() };
            if allowed && frame.is_some() {
                finish.call((WKNavigationActionPolicy::Allow,));
            } else {
                finish.call((WKNavigationActionPolicy::Cancel,));
                if allowed {
                    unsafe { view.loadRequest(&request) };
                }
            }
        }
    }
);

struct Browser {
    view: Retained<WKWebView>,
    _navigation: Retained<BrowserNavigation>,
}

impl Browser {
    fn new(parent: &WKWebView, mtm: MainThreadMarker) -> Self {
        // Stable across launches so signing in to websites works. Keep this
        // separate from Overleaf's WebViews and the system browser's profile.
        let uuid = if cfg!(lattice_beta) {
            "44E1655C-50B7-4B10-B963-F1400565E965"
        } else {
            "8715DF38-DE72-464C-9743-464ACB3397FA"
        };
        let identifier = NSUUID::initWithUUIDString(NSUUID::alloc(), &NSString::from_str(uuid))
            .expect("valid Browser profile UUID");
        // SAFETY: config, delegate and views are created and used on AppKit's thread.
        unsafe {
            let configuration = WKWebViewConfiguration::new(mtm);
            configuration
                .setWebsiteDataStore(&WKWebsiteDataStore::dataStoreForIdentifier(&identifier, mtm));
            let view = WKWebView::initWithFrame_configuration(
                WKWebView::alloc(mtm),
                NSRect::default(),
                &configuration,
            );
            let navigation: Retained<BrowserNavigation> =
                msg_send![BrowserNavigation::alloc(mtm), init];
            view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation)));
            view.setHidden(true);
            parent.addSubview(&view);
            Self { view, _navigation: navigation }
        }
    }

    fn navigate(&self, url: &str) -> Result<(), String> {
        let url = web_address(url)
            .and_then(|url| NSURL::URLWithString(&NSString::from_str(url.as_str())))
            .ok_or_else(|| "Enter an HTTP or HTTPS web address.".to_string())?;
        unsafe { self.view.loadRequest(&NSURLRequest::requestWithURL(&url)) };
        Ok(())
    }

    fn place(&self, parent: &WKWebView, bounds: Option<PanelBounds>) {
        let Some(bounds) = bounds else {
            self.view.setHidden(true);
            return;
        };
        let parent_bounds = parent.bounds();
        let ratio = parent_bounds.size.width / bounds.viewport_width;
        let width = bounds.width * ratio;
        let height = bounds.height * ratio;
        let top = bounds.y * ratio;
        let x = parent_bounds.origin.x + bounds.x * ratio;
        let y = parent_bounds.origin.y
            + if parent.isFlipped() { top } else { parent_bounds.size.height - top - height };
        if ratio.is_finite()
            && ratio > 0.0
            && x.is_finite()
            && y.is_finite()
            && width.is_finite()
            && height.is_finite()
            && width > 0.0
            && height > 0.0
        {
            self.view.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)));
            self.view.setHidden(false);
        } else {
            self.view.setHidden(true);
        }
    }

    fn status(&self) -> PanelStatus {
        unsafe {
            PanelStatus {
                url: self
                    .view
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .map(|value| value.to_string()),
                can_go_back: self.view.canGoBack(),
                can_go_forward: self.view.canGoForward(),
                loading: self.view.isLoading(),
            }
        }
    }
}

thread_local! {
    // Accessed only by the main-thread webview callbacks and window lifecycle.
    static BROWSERS: RefCell<HashMap<String, Browser>> = RefCell::default();
}

pub(crate) fn forget(label: &str) {
    BROWSERS.with(|browsers| {
        if let Some(browser) = browsers.borrow_mut().remove(label) {
            browser.view.removeFromSuperview();
        }
    });
}

fn perform(
    label: &str, parent: &WKWebView, mtm: MainThreadMarker, command: PanelCommand,
) -> Result<PanelStatus, String> {
    if let PanelCommand::Close = command {
        forget(label);
        return Ok(PanelStatus::default());
    }
    BROWSERS.with(|browsers| {
        let mut browsers = browsers.borrow_mut();
        if matches!(&command, PanelCommand::Navigate { .. }) {
            browsers.entry(label.to_string()).or_insert_with(|| Browser::new(parent, mtm));
        }
        let Some(browser) = browsers.get(label) else { return Ok(PanelStatus::default()) };
        match command {
            PanelCommand::Navigate { url } => browser.navigate(&url)?,
            PanelCommand::Place { bounds } => browser.place(parent, bounds),
            PanelCommand::Back => {
                unsafe { browser.view.goBack() };
            }
            PanelCommand::Forward => {
                unsafe { browser.view.goForward() };
            }
            PanelCommand::Reload => {
                unsafe { browser.view.reload() };
            }
            PanelCommand::Status | PanelCommand::Close => {}
        }
        Ok(browser.status())
    })
}

#[tauri::command]
pub(crate) async fn browser_panel(
    window: WebviewWindow, command: PanelCommand,
) -> Result<PanelStatus, String> {
    let label = window.label().to_string();
    if !crate::is_workspace_window(&label) {
        return Err("The Browser panel needs a desktop workspace window.".into());
    }
    let (done, result) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |platform| {
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = done.send(Err("Could not reach the Browser panel.".into()));
                return;
            };
            // SAFETY: Tauri provides the live macOS WKWebView for this callback.
            let parent = unsafe { &*platform.inner().cast::<WKWebView>() };
            let _ = done.send(perform(&label, parent, mtm, command));
        })
        .map_err(crate::util::err)?;
    result.await.map_err(crate::util::err)?
}

#[cfg(test)]
mod tests {
    use super::web_address;

    #[test]
    fn browser_addresses_are_web_urls_and_never_lattice_protocols() {
        for address in ["https://example.com/", "http://127.0.0.1:3000/"] {
            assert!(web_address(address).is_some());
        }
        for address in [
            "https://user:password@example.com",
            "file:///tmp/a",
            "javascript:alert(1)",
            "tauri://localhost",
            "http://tauri.localhost/",
            "http://asset.localhost/",
            "data:text/html,x",
        ] {
            assert!(web_address(address).is_none(), "{address}");
        }
    }
}
