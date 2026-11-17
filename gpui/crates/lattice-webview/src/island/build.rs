//! Building an island's webview: its builder (the page, the asset protocol,
//! the bridge and the navigation rules) and what the island keeps of it.

use anyhow::{Context as _, Result};
use futures::{StreamExt as _, channel::mpsc};
use gpui::{AppContext as _, Context, Focusable as _, Rgba, Window};
use gpui_webview::WebView;

use super::{DRAWN_POLL, Island, IslandState};
use crate::{
    bridge,
    native::{keep_drawing_when_occluded, lab_ignore_occlusion},
    navigation::{navigable, origin_of},
    protocol,
};

impl Island {
    pub(super) fn build(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.building = false;
        if !self.active || self.webview.is_some() {
            return;
        }
        match self.build_webview(window, cx) {
            Ok(()) => {
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

    fn build_webview(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Result<()> {
        let (sender, mut receiver) = mpsc::unbounded::<(String, String)>();
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
        let lab = lab_ignore_occlusion();
        if lab {
            builder = builder.with_background_throttling(wry::BackgroundThrottlingPolicy::Disabled);
        }
        let webview =
            WebView::build(builder, window, cx).context("building the island's webview")?;
        if lab {
            keep_drawing_when_occluded(&webview);
        }
        self.handle = Some(webview.handle());
        self.token = token;
        let webview = cx.new(|_| webview);
        let focus = webview.read(cx).focus_handle(cx);
        self._webview_subscriptions =
            vec![cx.on_focus_out(&focus, window, |this, _, window, cx| {
                this.sync_native_focus(window, cx);
            })];
        self.webview = Some(webview);
        self.sync_native_visibility(cx);
        self._drawn_poll = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(DRAWN_POLL).await;
                let alive = this.update_in(cx, |this, window, cx| {
                    if this.active {
                        this.check_drawn(window, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        }));
        self._inbox = Some(cx.spawn_in(window, async move |this, cx| {
            while let Some((sender, body)) = receiver.next().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.receive(&sender, &body, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
        Ok(())
    }
}
