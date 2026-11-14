//! Overleaf in the window (`crate::overleaf`): the titlebar's Overleaf
//! control (`canvas-toolbar.tsx`), "Open from Overleaf", syncing (the
//! window's editors saved first), manual mode's Review changes, the Overleaf
//! commands, and what a sync asks of the window (a build, the conflict
//! resolver, Settings › Overleaf to sign in again).
//!
//! The control is the app's: unlinked, a cloud that opens the picker; linked,
//! a split button on the accent wash, its left half syncing (Review changes
//! in manual mode) and its chevron opening a menu with the project's name,
//! Open in Overleaf and Open another Overleaf project. A dot on its corner
//! says where the link stands: green while syncing or live, a breathing
//! amber while the channel joins, red when it failed (syncing carries on;
//! the tooltip says why), and an accent dot for work waiting on Overleaf in
//! manual mode.

use std::time::Duration;

use gpui::{
    AnimationExt as _, AnyElement, AppContext as _, Context, Corners, Entity, IntoElement,
    ParentElement as _, Styled as _, Subscription, Task, Window, actions, div, px,
};
use lattice_i18n::t;
use lattice_settings::{OverleafSyncMode, SettingsTab, TitlebarTool};
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{IconButton, MenuAction, MenuPopover, Surface},
    motion::Motion,
    tokens::RADIUS_PILL,
};

use super::Shell;
use crate::{
    build::chip_mark::infinity_loader,
    overleaf::{
        ChannelStatus, OverleafBridge, OverleafBridgeEvent,
        bridge::SyncOptions,
        picker::{OverleafPicker, PickerEvent, PickerSetup},
        review::{OverleafReview, ReviewEvent},
        sync as overleaf_sync,
    },
};

actions!(lattice, [OpenOverleafProject, SyncOverleaf, OpenOnOverleaf]);

/// The window's Overleaf dialogs, while they are open.
#[derive(Default)]
pub(crate) struct OverleafLayers {
    picker: Option<(Entity<OverleafPicker>, Subscription)>,
    review: Option<(Entity<OverleafReview>, Subscription)>,
    /// Saving the window's editors before a sync or an upload.
    pending: Option<Task<()>>,
}

impl Shell {
    /// The window's bridge, and what the window does with what it says.
    pub(super) fn init_overleaf(
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<OverleafBridge>, Vec<Subscription>) {
        let bridge = cx.new(OverleafBridge::new);
        let subscriptions = vec![
            cx.subscribe_in(&bridge, window, Self::on_overleaf_event),
            cx.observe(&bridge, |this, _, cx| {
                this.show_overleaf_save(cx);
                this.push_agent_overleaf(cx);
                cx.notify()
            }),
            // Another window signed in or out, or a request found the
            // session expired: read the link again.
            cx.observe_global::<crate::overleaf::SessionGeneration>(|this, cx| {
                this.overleaf
                    .update(cx, |bridge, cx| bridge.check_session(cx));
            }),
        ];
        (bridge, subscriptions)
    }

    fn on_overleaf_event(
        &mut self,
        _: &Entity<OverleafBridge>,
        event: &OverleafBridgeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // The files reach the editors and the tree through the watcher;
            // the PDF follows them, as after any outside edit.
            OverleafBridgeEvent::Incoming => {
                if crate::settings::builds_automatically(cx) {
                    self.run_build(super::build::BuildRequest::automatic(), window, cx);
                }
            }
            OverleafBridgeEvent::OpenConflict(path) => {
                self.open_conflict_resolver(path.clone(), true, window, cx)
            }
            OverleafBridgeEvent::OpenSettings => {
                self.open_settings(Some(SettingsTab::Overleaf), window, cx)
            }
            OverleafBridgeEvent::PresenceChanged => self.show_overleaf_carets(cx),
        }
    }

    /// "Open from Overleaf".
    pub(crate) fn open_overleaf_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overleaf_layers.picker.is_some() {
            return;
        }
        let linked = self.overleaf.read(cx).linked();
        let setup = PickerSetup {
            can_open_here: self.project.is_some(),
            current_project: (!linked)
                .then(|| {
                    self.project
                        .as_ref()
                        .map(|_| self.project_name(cx).to_string())
                })
                .flatten(),
            known_folders: crate::recents::RecentProjects::list(cx)
                .iter()
                .map(|recent| recent.path.clone())
                .collect(),
        };
        let picker = cx.new(|cx| OverleafPicker::new(setup, window, cx));
        let subscription = cx.subscribe_in(&picker, window, Self::on_picker_event);
        picker.update(cx, |picker, cx| picker.focus_search(window, cx));
        self.overleaf_layers.picker = Some((picker, subscription));
        cx.notify();
    }

    fn on_picker_event(
        &mut self,
        picker: &Entity<OverleafPicker>,
        event: &PickerEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            PickerEvent::Dismiss => {
                self.overleaf_layers.picker = None;
                self.focus_front(window, cx);
                cx.notify();
            }
            PickerEvent::Open { root, here } => {
                self.overleaf_layers.picker = None;
                // Focus was in the picker's search, which is gone; left there,
                // this window's shortcuts would not reach it once the writer
                // comes back from the project's own window.
                self.focus_front(window, cx);
                cx.notify();
                // A window that already shows the project is brought forward.
                let this_window = window.window_handle().window_id();
                if let Some(handle) =
                    super::windows::window_showing_except(root, Some(this_window), cx)
                {
                    handle
                        .update(cx, |_, window, _| window.activate_window())
                        .ok();
                } else {
                    self.reveal_project(root.clone(), *here, window, cx);
                }
            }
            PickerEvent::Publish(name) => {
                self.publish_to_overleaf(picker.clone(), name.clone(), cx)
            }
            PickerEvent::ConnectionChanged => {
                self.overleaf
                    .update(cx, |bridge, cx| bridge.reload_link(cx));
            }
        }
    }

    /// Save, upload and link the open project; the picker hears how it went.
    fn publish_to_overleaf(
        &mut self,
        picker: Entity<OverleafPicker>,
        name: String,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            picker.update(cx, |picker, cx| picker.published(Ok(false), cx));
            return;
        };
        let saved = self.save_before_leaving(cx);
        self.overleaf_layers.pending = Some(cx.spawn(async move |this, cx| {
            if let Some(saved) = saved
                && !saved.await
            {
                picker.update(cx, |picker, cx| picker.published(Ok(false), cx));
                return;
            }
            let upload_root = root.clone();
            let (linked, expired) = cx
                .background_spawn(async move { overleaf_sync::publish(&upload_root, &name) })
                .await;
            let current = this
                .update(cx, |this, cx| {
                    this.root(cx).as_deref() == Some(root.as_path())
                })
                .unwrap_or(false);
            picker.update(cx, |picker, cx| {
                picker.published(
                    match linked {
                        Ok(_) => Ok(current),
                        Err(error) => Err((error, expired)),
                    },
                    cx,
                )
            });
            this.update(cx, |this, cx| {
                this.overleaf
                    .update(cx, |bridge, cx| bridge.reload_link(cx));
            })
            .ok();
        }));
    }

    /// The toolbar's sync: in manual mode a review of what would change,
    /// else a sync after the window's editors are saved.
    pub(crate) fn sync_overleaf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let bridge = self.overleaf.read(cx);
        if bridge.link().is_none() || bridge.syncing() {
            return;
        }
        if bridge.mode() == OverleafSyncMode::Manual {
            self.open_overleaf_review(window, cx);
        } else {
            self.run_overleaf_sync(cx);
        }
    }

    /// Save the window's editors, then sync.
    fn run_overleaf_sync(&mut self, cx: &mut Context<Self>) {
        let saved = self.save_before_leaving(cx);
        self.overleaf_layers.pending = Some(cx.spawn(async move |this, cx| {
            if let Some(saved) = saved
                && !saved.await
            {
                return;
            }
            this.update(cx, |this, cx| {
                this.overleaf
                    .update(cx, |bridge, cx| bridge.sync(SyncOptions::default(), cx));
            })
            .ok();
        }));
    }

    fn open_overleaf_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        if self.overleaf_layers.review.is_some() {
            return;
        }
        let review = cx.new(|cx| OverleafReview::new(root, cx));
        let subscription =
            cx.subscribe_in(
                &review,
                window,
                |this, review, event, window, cx| match event {
                    ReviewEvent::Close => {
                        this.overleaf_layers.review = None;
                        this.focus_front(window, cx);
                        cx.notify();
                    }
                    ReviewEvent::Apply => this.apply_review(review.clone(), cx),
                },
            );
        let focus = gpui::Focusable::focus_handle(review.read(cx), cx);
        window.focus(&focus, cx);
        self.overleaf_layers.review = Some((review, subscription));
        cx.notify();
    }

    /// Review's Apply: save, sync, and tell the dialog how the sync went.
    fn apply_review(&mut self, review: Entity<OverleafReview>, cx: &mut Context<Self>) {
        let saved = self.save_before_leaving(cx);
        self.overleaf_layers.pending = Some(cx.spawn(async move |this, cx| {
            let not_run = || t!("{action} failed", action = t!("Sync")).to_string();
            if let Some(saved) = saved
                && !saved.await
            {
                review.update(cx, |review, cx| review.applied(Some(not_run()), cx));
                return;
            }
            let outcome = match this.update(cx, |this, cx| {
                this.overleaf
                    .update(cx, |bridge, cx| bridge.sync_reporting(cx))
            }) {
                Ok(outcome) => outcome.await.unwrap_or_else(|_| Err(not_run())),
                Err(_) => return,
            };
            review.update(cx, |review, cx| review.applied(outcome.err(), cx));
        }));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn overleaf_picker(&self) -> Option<Entity<OverleafPicker>> {
        self.overleaf_layers
            .picker
            .as_ref()
            .map(|(picker, _)| picker.clone())
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn overleaf_review(&self) -> Option<Entity<OverleafReview>> {
        self.overleaf_layers
            .review
            .as_ref()
            .map(|(review, _)| review.clone())
    }

    pub(crate) fn open_on_overleaf(&mut self, cx: &mut Context<Self>) {
        if let Some(link) = self.overleaf.read(cx).link().cloned() {
            crate::overleaf::bridge::open_on_overleaf(&link, cx);
        }
    }

    /// The Overleaf dialogs, for the window's overlays.
    pub(super) fn overleaf_overlays(&self) -> Vec<AnyElement> {
        self.overleaf_layers
            .picker
            .as_ref()
            .map(|(picker, _)| picker.clone().into_any_element())
            .into_iter()
            .chain(
                self.overleaf_layers
                    .review
                    .as_ref()
                    .map(|(review, _)| review.clone().into_any_element()),
            )
            .collect()
    }

    /// The titlebar's Overleaf control, unless Settings › Appearance hides it.
    pub(super) fn overleaf_sync_control(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let hidden = &crate::settings::get(cx).appearance.hidden_titlebar_tools;
        if hidden.contains(&TitlebarTool::Overleaf) {
            return None;
        }
        let bridge = self.overleaf.read(cx);
        let palette = cx.palette().clone();
        let linked = bridge.link().is_some();
        let syncing = bridge.syncing();
        let pending = bridge.remote_changes();
        let channel = bridge.channel();
        let detail = bridge.channel_detail().cloned();
        let live_editing = bridge.live_file().is_some();
        let project_name = bridge.link().map(|link| link.project_name.clone());
        let label: String = if !linked {
            t!("Open a project from Overleaf").into()
        } else if syncing {
            t!("Syncing with Overleaf…").into()
        } else if pending {
            t!("New changes on Overleaf").into()
        } else if live_editing {
            t!("Live with Overleaf").into()
        } else {
            // When the channel is not up, say why: silently falling back to
            // syncing looks exactly like the feature being broken.
            match channel {
                ChannelStatus::Connecting => detail
                    .map(|detail| detail.to_string())
                    .unwrap_or_else(|| t!("Connecting to Overleaf's live channel…").into()),
                ChannelStatus::Error => match detail {
                    Some(detail) => t!(
                        "Live editing unavailable ({detail}), syncing instead",
                        detail = detail.as_ref()
                    )
                    .into(),
                    None => t!("Live editing unavailable, syncing instead").into(),
                },
                ChannelStatus::Live => detail
                    .map(|detail| detail.to_string())
                    .unwrap_or_else(|| t!("Live").into()),
                _ => t!("Sync with Overleaf").into(),
            }
        };
        let dot = |color: gpui::Hsla| {
            div()
                .absolute()
                .top(px(3.))
                .right(px(3.))
                .size(px(7.))
                .rounded(RADIUS_PILL)
                .bg(color)
                .border(px(1.5))
                .border_color(palette.titlebar)
        };
        let badge: Option<AnyElement> = if linked && syncing {
            Some(dot(palette.success).into_any_element())
        } else if linked && pending {
            Some(dot(palette.accent).into_any_element())
        } else if linked && channel == ChannelStatus::Connecting {
            Some(
                dot(palette.warning)
                    .with_animation(
                        "overleaf-channel-breathe",
                        gpui::Animation::new(Duration::from_millis(1_600)).repeat(),
                        |this, t| {
                            let phase = (t * std::f32::consts::TAU).cos();
                            this.opacity(0.675 + 0.325 * phase)
                        },
                    )
                    .into_any_element(),
            )
        } else if linked && channel == ChannelStatus::Error {
            Some(
                dot(palette.danger)
                    .with_animation(
                        "overleaf-channel-pop",
                        Motion::Slow.animation(),
                        |this, t| {
                            let scale = if t < 0.6 {
                                0.4 + (1.35 - 0.4) * (t / 0.6)
                            } else {
                                1.35 - 0.35 * ((t - 0.6) / 0.4)
                            };
                            let inset = 3.5 * (1. - scale);
                            this.size(px(7. * scale))
                                .top(px(3. + inset))
                                .right(px(3. + inset))
                        },
                    )
                    .into_any_element(),
            )
        } else {
            None
        };
        let radius = px(6.);
        let mut primary = IconButton::new(
            "overleaf",
            if linked {
                Icon::CLOUD_UPLOAD
            } else {
                Icon::CLOUD
            },
        )
        .surface(Surface::Titlebar)
        .on(linked)
        .disabled(syncing)
        .tooltip(label)
        .on_click(cx.listener(move |shell, _, window, cx| {
            if linked {
                shell.sync_overleaf(window, cx)
            } else {
                shell.open_overleaf_picker(window, cx)
            }
        }));
        if syncing {
            primary = primary.content(infinity_loader("overleaf-syncing", px(14.), &palette));
        }
        if let Some(badge) = badge {
            primary = primary.badge(badge);
        }
        if !linked {
            return Some(primary.into_any_element());
        }
        let primary = primary.corners(Corners {
            top_left: radius,
            bottom_left: radius,
            top_right: px(0.),
            bottom_right: px(0.),
        });
        let shell = cx.entity().downgrade();
        let button = IconButton::new("overleaf-menu", Icon::CHEVRON_DOWN)
            .surface(Surface::Titlebar)
            .on(true)
            .frame(px(18.), px(28.))
            .icon_size(px(10.))
            .corners(Corners {
                top_left: px(0.),
                bottom_left: px(0.),
                top_right: radius,
                bottom_right: radius,
            })
            .tooltip(t!("Overleaf project actions"));
        let menu = MenuPopover::new("overleaf-menu-popover", button, move |menu, _, _| {
            let (open, another) = (shell.clone(), shell.clone());
            let mut menu = menu.min_w(px(256.));
            if let Some(name) = project_name.clone() {
                menu = menu.label(name).separator();
            }
            menu.item(
                MenuAction::new(t!("Open in Overleaf"), move |_, cx| {
                    open.update(cx, |shell, cx| shell.open_on_overleaf(cx)).ok();
                })
                .icon(Icon::EXTERNAL_LINK),
            )
            .item(
                MenuAction::new(t!("Open another Overleaf project"), move |window, cx| {
                    another
                        .update(cx, |shell, cx| shell.open_overleaf_picker(window, cx))
                        .ok();
                })
                .icon(Icon::CLOUD),
            )
        });
        Some(
            div()
                .flex()
                .flex_none()
                .items_center()
                .child(primary)
                .child(menu)
                .into_any_element(),
        )
    }
}
