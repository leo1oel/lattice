//! Building an island's webview: its builder (the page, the asset protocol,
//! the bridge and the navigation rules) and what the island keeps of it.
//! On Windows the webview is built in a task, outside GPUI's updates
//! (`crate::detached`).

use anyhow::{Context as _, Result};
use futures::{StreamExt as _, channel::mpsc};
use gpui::{AppContext as _, Context, Rgba, Window};
use gpui_webview::WebView;

use super::{DRAWN_POLL, Island, IslandState, update_in_home};
use crate::{
    bridge,
    native::{
        keep_drawing_when_occluded, lab_ignore_occlusion, refuse_keyboard_while_hidden,
        watch_keyboard,
    },
    navigation::{navigable, origin_of},
    protocol,
};

/// A webview's builder, before the webview is built, with what the island
/// keeps of it once it is.
struct PendingWebView {
    builder: wry::WebViewBuilder<'static>,
    inbox: Inbox,
    token: String,
}

/// A built webview, with what the island keeps of its builder.
struct BuiltWebView {
    webview: WebView,
    inbox: Inbox,
    token: String,
}

/// What the page's bridge sends: the sending frame's URL and the body.
type Inbox = mpsc::UnboundedReceiver<(String, String)>;

impl Island {
    pub(super) fn build(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.building = false;
        if !self.active || self.webview.is_some() {
            return;
        }
        let pending = match self.webview_builder(window, cx) {
            Ok(pending) => pending,
            Err(error) => return self.finish_build(Err(error), window, cx),
        };
        #[cfg(not(target_os = "windows"))]
        {
            let PendingWebView {
                builder,
                inbox,
                token,
            } = pending;
            let built = WebView::build(builder, window, cx)
                .context("building the island's webview")
                .map(|webview| BuiltWebView {
                    webview,
                    inbox,
                    token,
                });
            self.finish_build(built, window, cx);
        }
        // WebView2 pumps the thread's messages while it builds, which must
        // not happen inside this update (`detached.rs`): the task builds it
        // in its own body, and the island stays `building` until then, so
        // no frame starts another build.
        #[cfg(target_os = "windows")]
        {
            let parent = match crate::detached::DetachedParent::of(window) {
                Ok(parent) => parent,
                Err(error) => return self.finish_build(Err(error), window, cx),
            };
            self.building = true;
            cx.spawn_in(window, async move |this, cx| {
                let PendingWebView {
                    builder,
                    inbox,
                    token,
                } = pending;
                // The island (and its window) may have gone since this was
                // queued; nothing is borrowed between these two updates.
                if this.update(cx, |_, _| ()).is_err() {
                    return;
                }
                let raw = parent.build(builder);
                this.update_in(cx, |this, window, cx| {
                    this.building = false;
                    let built =
                        raw.context("building the island's webview")
                            .map(|raw| BuiltWebView {
                                webview: WebView::new(raw, window, cx),
                                inbox,
                                token,
                            });
                    this.finish_build(built, window, cx);
                })
                .ok();
            })
            .detach();
        }
    }

    /// The island's webview builder, with the bridge's channel and token.
    fn webview_builder(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<PendingWebView> {
        let (sender, inbox) = mpsc::unbounded::<(String, String)>();
        let served = self.served.clone();
        let frame_origins = self.frame_origins.clone();
        let token = bridge::new_token()?;
        let mut builder = wry::WebViewBuilder::new()
            .with_url(protocol::url(&format!("bundle/{}", self.config.entry)))
            .with_custom_protocol(protocol::SCHEME.into(), move |_, request| {
                protocol::respond(&served, &request)
            })
            .with_initialization_script_for_main_only(bridge::script(&token), true)
            .with_ipc_handler(move |request| {
                let sender_uri = request.uri().to_string();
                sender
                    .unbounded_send((sender_uri, request.into_body()))
                    .ok();
            })
            // The page never leaves the island; its links go through the
            // bridge to the system browser. No frame loads a project file as
            // a document either: one would have an island URL.
            .with_navigation_handler(move |url| {
                navigable(&url)
                    || frame_origins
                        .lock()
                        .is_ok_and(|origins| origins.contains(&origin_of(&url)))
            })
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_incognito(true)
            .with_accept_first_mouse(true)
            .with_hotkeys_zoom(false)
            .with_back_forward_navigation_gestures(false)
            .with_devtools(cfg!(debug_assertions));
        builder = self.take_file_drops(builder, window, cx);
        if let Some(ground) = self.config.ground {
            let rgba = Rgba::from(ground);
            let channel = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
            builder = builder.with_background_color((
                channel(rgba.r),
                channel(rgba.g),
                channel(rgba.b),
                channel(rgba.a),
            ));
        }
        if lab_ignore_occlusion() {
            builder = builder.with_background_throttling(wry::BackgroundThrottlingPolicy::Disabled);
        }
        Ok(PendingWebView {
            builder,
            inbox,
            token,
        })
    }

    /// Take the built webview (or the failure to build it) into the island.
    /// A webview built for an island hidden or already rebuilt meanwhile (a
    /// build on Windows finishes later) is dropped: the next frame the
    /// island is shown in builds it again.
    fn finish_build(
        &mut self,
        built: Result<BuiltWebView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match built {
            Ok(_) if !self.active || self.webview.is_some() => {}
            Ok(built) => {
                self.attach(built, window, cx);
                self.state = IslandState::Loading;
                self.stats.builds += 1;
                self.push_theme(cx);
            }
            Err(error) => {
                log::error!("{}: {error:#}", self.config.name);
                self.state = IslandState::Failed(format!("{error:#}"));
            }
        }
        cx.notify();
    }

    fn attach(&mut self, built: BuiltWebView, window: &mut Window, cx: &mut Context<Self>) {
        let BuiltWebView {
            webview,
            mut inbox,
            token,
        } = built;
        refuse_keyboard_while_hidden(&webview, window);
        self._keyboard = watch_keyboard(&webview).map(|mut took| {
            cx.spawn(async move |this, cx| {
                while took.next().await.is_some() {
                    let alive = update_in_home(&this, cx, |this, window, cx| {
                        // Asked again: the message comes after the view took
                        // the keyboard, which it may have given up since.
                        if this.native_focus(cx) == Some(true) {
                            this.set_page_focused(true, window, cx);
                        }
                    });
                    if alive.is_err() {
                        break;
                    }
                }
            })
        });
        if lab_ignore_occlusion() {
            keep_drawing_when_occluded(&webview);
        }
        self.handle = Some(webview.handle());
        self.token = token;
        let webview = cx.new(|_| webview);
        self.webview = Some(webview);
        self.listen_to_focus(window, cx);
        self.sync_native_visibility(cx);
        // Each update in the window the island is in by then, which moving
        // the page changes (`Island::move_to_window`).
        self._drawn_poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(DRAWN_POLL).await;
                let alive = update_in_home(&this, cx, |this, window, cx| {
                    if this.active {
                        this.check_drawn(window, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        }));
        self._inbox = Some(cx.spawn(async move |this, cx| {
            while let Some((sender, body)) = inbox.next().await {
                if update_in_home(&this, cx, |this, window, cx| {
                    this.receive(&sender, &body, window, cx)
                })
                .is_err()
                {
                    break;
                }
            }
        }));
    }
}
