//! The picker's dialog: its header, the account, the search and the archived
//! switch over the stage, the publish card and the download line, with the
//! keyboard and the scrim.

use super::*;

impl Render for OverleafPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let transferring = self.transferring();
        let working = self.working();
        let known = self.known().cloned();
        let signed_out = known.as_ref().is_some_and(|status| !status.connected);
        let (width, height) = if signed_out {
            (px(440.).min(viewport.width - px(40.)), None)
        } else {
            (
                px(860.).min(viewport.width - px(40.)),
                Some(px(640.).min(viewport.height - px(40.))),
            )
        };
        let narrow = width < px(600.);

        let close = IconButton::new("overleaf-picker-close", Icon::CLOSE)
            .tooltip(if transferring {
                t!("You can close this once the transfer finishes").to_string()
            } else {
                t!("Close").to_string()
            })
            .disabled(transferring)
            .on_click(cx.listener(|this, _, _, cx| this.dismiss(cx)));
        let header = div()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .relative()
                    .children(parity::probe("overleaf/picker/title"))
                    // The panel header's title (`.ui-panel-header-title`, the
                    // sans subtitle, set solid) at the title's size.
                    .text_role(TextRole::Subtitle, cx)
                    .text_size(TextRole::Title.size(TypeScale::Interface))
                    .line_height(relative(1.))
                    .text_color(palette.text)
                    .child(Icon::CLOUD.element(px(22.), palette.accent))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .children(parity::text_probe(
                                "overleaf/picker/title",
                                0,
                                t!("Open from Overleaf"),
                            ))
                            .child(t!("Open from Overleaf")),
                    ),
            )
            .child(close);
        let lede = known
            .as_ref()
            .filter(|status| status.connected)
            .map(|status| {
                let account = status
                    .email
                    .clone()
                    .or_else(|| status.name.clone())
                    .unwrap_or_else(|| status.host.clone());
                div().flex_none().mt(px(6.)).mb(px(16.)).flex().child(
                    div()
                        .relative()
                        .children(parity::bordered_probe(
                            "overleaf/picker/account",
                            gpui::Edges::all(px(1.)),
                        ))
                        .children(parity::text_probe(
                            "overleaf/picker/account",
                            0,
                            account.clone(),
                        ))
                        .min_w_0()
                        .max_w(if narrow { relative(1.) } else { relative(0.5) })
                        .h(px(28.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .border_1()
                        .border_color(palette.line)
                        .rounded(RADIUS_PILL)
                        .text_role(TextRole::Micro, cx)
                        .font_weight(FontWeight::NORMAL)
                        .text_color(palette.text_secondary)
                        .child(
                            div()
                                .flex_none()
                                .size(px(6.))
                                .rounded(RADIUS_PILL)
                                .bg(palette.success),
                        )
                        .child(div().min_w_0().truncate().child(account)),
                )
            });

        let mut body = div().flex_1().min_h_0().flex().flex_col();
        if lede.is_none() {
            body = body.mt(px(16.));
        }
        if let Some(error) = self.transfer_error.clone() {
            body = body.child(
                div()
                    .flex_none()
                    .mb(px(12.))
                    .child(inline_message(error, true, cx)),
            );
        }
        let frame = |list: bool, plain: bool| {
            div()
                .relative()
                .when(!plain, |this| {
                    this.children(parity::bordered_probe(
                        "overleaf/picker/stage",
                        gpui::Edges::all(px(1.)),
                    ))
                })
                .flex_1()
                .min_h(if plain { px(0.) } else { px(300.) })
                .flex()
                .flex_col()
                .rounded(RADIUS_PANEL)
                .overflow_hidden()
                .when(!plain, |this| this.border_1().border_color(palette.line))
                .when(!list && !plain, |this| this.bg(palette.input))
        };
        if let Some(started) = self.status_loading.filter(|_| self.status_error.is_none()) {
            let opacity = loading_opacity("overleaf-controls-skeleton", started, window, cx);
            body = body
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .h(px(32.))
                        .mb(px(12.))
                        .opacity(opacity)
                        .child(
                            div()
                                .flex_1()
                                .h_full()
                                .border_1()
                                .border_color(palette.line)
                                .rounded(RADIUS_CONTROL),
                        )
                        .child(
                            div()
                                .w(px(112.))
                                .h(px(8.))
                                .rounded(RADIUS_PILL)
                                .bg(palette.line),
                        ),
                )
                .child(frame(false, false).child(self.skeleton(started, window, cx)));
        } else if let Some(error) = self.status_error.clone() {
            let this = cx.entity().downgrade();
            body = body.child(frame(false, false).child(stage_message(
                Some(glyph(Icon::CLOUD_OFF, Tone::Danger, true, cx)),
                vec![parts::retry_row(
                    "overleaf-status-retry",
                    error,
                    false,
                    t!("Retry").into(),
                    move |_, cx| {
                        this.update(cx, |this, cx| this.load_status(cx)).ok();
                    },
                    true,
                    cx,
                )],
            )));
        } else if let Some(status) = known.as_ref().filter(|status| !status.connected) {
            let mut children = Vec::new();
            if status.expired {
                children.push(stage_text(t!("Your Overleaf session expired"), false, cx));
            }
            children.push(parts::login_controls(
                "overleaf-picker-login",
                &self.login,
                if status.expired {
                    t!("Reconnect to Overleaf").into()
                } else {
                    t!("Connect to Overleaf").into()
                },
                Some(t!("You sign in on Overleaf. Lattice never sees your password.").into()),
                true,
                window,
                cx,
            ));
            body = body.child(
                frame(false, true)
                    .pt(px(16.))
                    .pb(px(8.))
                    .child(stage_message(
                        status
                            .expired
                            .then(|| glyph(Icon::CLOUD_ALERT, Tone::Warning, true, cx)),
                        children,
                    )),
            );
        } else if known.is_some() {
            let controls = div()
                .flex_none()
                .flex()
                .when(narrow, |this| this.flex_wrap())
                .items_center()
                .gap(if narrow { px(8.) } else { px(12.) })
                .mb(px(12.))
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .when(narrow, |this| this.min_w_full())
                        .children(parity::probe("overleaf/picker/search"))
                        .child(Field::new(&self.search).search().disabled(working)),
                )
                .child(
                    Checkbox::new(
                        "overleaf-show-archived",
                        if self.show_archived {
                            CheckState::On
                        } else {
                            CheckState::Off
                        },
                    )
                    .label(t!("Show archived"))
                    .parity("overleaf/picker/archived")
                    .disabled(working)
                    .on_toggle({
                        let this = cx.entity().downgrade();
                        move |on, _, cx| {
                            let on = *on;
                            this.update(cx, |this, cx| {
                                this.show_archived = on;
                                cx.notify();
                            })
                            .ok();
                        }
                    }),
                );
            let (stage, list) = self.stage(window, cx);
            body = body.child(controls).child(frame(list, false).child(stage));
            if self.setup.current_project.is_some() {
                body = body.child(self.publish_card(cx));
            }
            body = body.children(self.progress(cx));
        }

        let card = div()
            .id("overleaf-picker")
            .relative()
            .children(parity::probe("overleaf/picker"))
            .w(width)
            .when_some(height, |this, height| this.h(height))
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .overflow_hidden()
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if this.publish_name.read(cx).focus_handle(cx).is_focused(window) {
                    return;
                }
                let key = event.keystroke.key.as_str();
                let handled = match key {
                    "up" => {
                        this.step(-1, None, cx);
                        true
                    }
                    "down" => {
                        this.step(1, None, cx);
                        true
                    }
                    _ => false,
                };
                if handled {
                    cx.stop_propagation();
                }
            }))
            .child(header)
            .children(lede)
            .child(body);
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "overleaf-picker-layer",
            LayerPlacement::Center,
            rise_in("overleaf-picker-in", card),
            move |_, cx| {
                this.update(cx, |this, cx| this.dismiss(cx)).ok();
            },
        )
        .closable_by_scrim(!transferring)
    }
}
