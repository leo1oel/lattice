//! Settings › Overleaf (`OverleafSettingsSection` in `overleaf-connect.tsx`):
//! the account's connection (signed in as whom, or the sign-in), the open
//! project's link (syncing, paused, or waiting on a sign-in to its host)
//! with Pause and Resume, and the sync behaviour every window shares: Live
//! sync or Manual, and what deleting a file here does on Overleaf.
//!
//! Pausing keeps the link and everything it needs to start again, so
//! resuming is an ordinary sync: whatever changed on either side while it
//! was paused merges against the copy from the last sync.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement as _,
    SharedString, Styled as _, Subscription, Task, Window, div, px,
};
use lattice_core::overleaf::{OverleafLink, OverleafStatus};
use lattice_i18n::t;
use lattice_settings::{OverleafRemoteDelete, OverleafSyncMode};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    components::Button,
    tokens::{FONT_WEIGHT_SEMIBOLD, RADIUS_PANEL, RADIUS_PILL},
};

use super::{
    controls::{self, PageWidth, Row},
    dialog::SettingsDialog,
};
use crate::{
    confirm::{self, Confirm},
    overleaf::{
        ChannelStatus,
        account::{self, Login, LoginEvent},
        bridge::link_matches_session,
        picker::relative_time,
    },
};

/// The page's view of the account and the open project's link.
pub struct OverleafConnection {
    root: Option<std::path::PathBuf>,
    status: Option<OverleafStatus>,
    link: Option<OverleafLink>,
    loading: bool,
    error: Option<SharedString>,
    disconnecting: bool,
    login: Entity<Login>,
    session_seen: u64,
    task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl OverleafConnection {
    pub fn new(root: Option<std::path::PathBuf>, cx: &mut Context<Self>) -> Self {
        let login = cx.new(|_| Login::default());
        let subscriptions = vec![
            cx.subscribe(&login, |this, _, event, cx| match event {
                LoginEvent::Connected(session) => {
                    this.status = Some(session.clone());
                    this.load(cx);
                }
            }),
            cx.observe(&login, |_, _, cx| cx.notify()),
            // The backend marks the session expired the moment Overleaf turns
            // it away, from whichever request noticed.
            cx.observe_global::<crate::overleaf::SessionGeneration>(|this, cx| {
                if crate::overleaf::session_generation(cx) != this.session_seen {
                    this.load(cx);
                }
            }),
        ];
        let mut connection = Self {
            root,
            status: None,
            link: None,
            loading: true,
            error: None,
            disconnecting: false,
            login,
            session_seen: crate::overleaf::session_generation(cx),
            task: None,
            _subscriptions: subscriptions,
        };
        connection.load(cx);
        connection
    }

    /// The account and the link as the page shows them, once read.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scenario_state(&self) -> Option<(OverleafStatus, Option<OverleafLink>)> {
        (!self.loading)
            .then(|| {
                self.status
                    .clone()
                    .map(|status| (status, self.link.clone()))
            })
            .flatten()
    }

    /// The account and the link as given, with nothing asked of the network:
    /// the parity harness's Settings › Overleaf.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn scenario_stage(
        &mut self,
        status: OverleafStatus,
        link: Option<OverleafLink>,
        cx: &mut Context<Self>,
    ) {
        self.task = None;
        self.loading = false;
        self.error = None;
        self.session_seen = crate::overleaf::session_generation(cx);
        self.status = Some(status);
        self.link = link;
        cx.notify();
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.session_seen = crate::overleaf::session_generation(cx);
        cx.notify();
        let root = self.root.clone();
        let read = cx.background_spawn(async move {
            let status = account::status();
            // Whether the open project is tied to an Overleaf project is
            // separate from whether the account is connected.
            let link = root.and_then(|root| crate::overleaf::sync::link(&root).ok().flatten());
            (status, link)
        });
        self.task = Some(cx.spawn(async move |this, cx| {
            let (status, link) = read.await;
            this.update(cx, |this, cx| {
                this.loading = false;
                match status {
                    Ok(status) => {
                        this.status = Some(status);
                        this.error = None;
                    }
                    Err(error) => {
                        this.status = None;
                        this.error = Some(error.into());
                    }
                }
                this.link = link;
                cx.notify();
            })
            .ok();
        }));
    }

    fn sign_out(&mut self, cx: &mut Context<Self>) {
        if self.disconnecting {
            return;
        }
        let text = t!(
            "Sign out of Overleaf?\n\nLinked projects stop syncing until you sign in again. Downloaded files stay on this Mac."
        );
        let (title, body) = text.split_once("\n\n").unwrap_or((text, ""));
        let this = cx.entity().downgrade();
        confirm::ask(
            Confirm::new(title.to_string())
                .body(body.to_string())
                .confirm_label(t!("Sign out"))
                .on_confirm(move |_, cx| {
                    this.update(cx, |this, cx| {
                        this.disconnecting = true;
                        cx.notify();
                        let run = cx.background_spawn(async move { account::disconnect() });
                        this.task = Some(cx.spawn(async move |this, cx| {
                            let result = run.await;
                            this.update(cx, |this, cx| {
                                this.disconnecting = false;
                                if let Err(error) = result {
                                    crate::notices::error(
                                        t!("Could not disconnect from Overleaf"),
                                        error,
                                        cx,
                                    );
                                }
                                // Signing out ends syncing too: every window
                                // re-reads where it stands.
                                crate::overleaf::session_changed(cx);
                                this.load(cx);
                            })
                            .ok();
                        }));
                    })
                    .ok();
                }),
            cx,
        );
    }
}

/// A status card (`.overleaf-status-row`): the glyph with its state dot,
/// what it means, the detail beneath it, and an optional action.
fn status_row(
    probe: &'static str,
    top: gpui::Pixels,
    icon: Icon,
    connected: bool,
    title: SharedString,
    detail: SharedString,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let glyph = div()
        .relative()
        .flex_none()
        .child(crate::overleaf::parts::glyph(
            icon,
            crate::overleaf::parts::Tone::Neutral,
            false,
            cx,
        ))
        .child(
            div()
                .absolute()
                .right(px(-2.))
                .bottom(px(-2.))
                .size(px(10.))
                .rounded(RADIUS_PILL)
                .bg(if connected {
                    palette.success
                } else {
                    palette.warning
                })
                .border_2()
                .border_color(palette.raised),
        );
    div()
        .relative()
        .children(lattice_ui::parity::bordered_probe(
            probe,
            gpui::Edges::all(px(1.)),
        ))
        .mt(top)
        .py(px(12.))
        .px(px(16.))
        .flex()
        .items_center()
        .gap(px(12.))
        .border_1()
        .border_color(palette.line)
        .rounded(RADIUS_PANEL)
        .bg(palette.raised)
        .child(glyph)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .relative()
                        .min_w_0()
                        .truncate()
                        .text_role_in(TextRole::BodyCompact, TypeScale::Settings, cx)
                        .font_weight(FONT_WEIGHT_SEMIBOLD)
                        .text_color(palette.text)
                        .children(lattice_ui::parity::probe(format!("{probe}/title")))
                        .children(lattice_ui::parity::text_probe(
                            format!("{probe}/title"),
                            0,
                            title.clone(),
                        ))
                        .child(title),
                )
                .child(
                    div()
                        .min_w_0()
                        .text_role_in(TextRole::Micro, TypeScale::Settings, cx)
                        .text_color(palette.text_secondary)
                        .child(detail),
                ),
        )
        .children(action)
        .into_any_element()
}

pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let root = dialog
        .project
        .as_ref()
        .map(|project| project.read(cx).root().to_path_buf());
    let connection = dialog
        .overleaf
        .get_or_insert_with(|| cx.new(|cx| OverleafConnection::new(root, cx)))
        .clone();
    let shell = dialog.shell();
    let groups = vec![
        connection_group(&connection, shell, window, cx),
        behaviour_group(dialog, width, cx),
    ];
    controls::page("Overleaf", width, groups, cx)
}

fn connection_group(
    connection: &Entity<OverleafConnection>,
    shell: gpui::WeakEntity<crate::shell::Shell>,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let (loading, error, status, link, disconnecting, login) = {
        let state = connection.read(cx);
        (
            state.loading,
            state.error.clone(),
            state.status.clone(),
            state.link.clone(),
            state.disconnecting,
            state.login.clone(),
        )
    };
    let known = (!loading && error.is_none())
        .then_some(status.clone())
        .flatten();
    let mut children: Vec<AnyElement> = Vec::new();
    if loading && error.is_none() {
        children.push(
            div()
                .mt(px(12.))
                .child(crate::build::chip_mark::infinity_loader(
                    "overleaf-settings-loading",
                    px(15.),
                    &palette,
                ))
                .into_any_element(),
        );
    }
    if let Some(error) = error.clone() {
        let reload = connection.clone();
        children.push(
            div()
                .mt(px(12.))
                .child(crate::overleaf::parts::retry_row(
                    "overleaf-settings-retry",
                    error,
                    loading,
                    t!("Try again").into(),
                    move |_, cx| reload.update(cx, |connection, cx| connection.load(cx)),
                    false,
                    cx,
                ))
                .into_any_element(),
        );
    }
    let sign_out = |id: &'static str| {
        let connection = connection.clone();
        Button::new(id, t!("Sign out"))
            .compact()
            .disabled(disconnecting)
            .on_click(move |_, _, cx| connection.update(cx, |c, cx| c.sign_out(cx)))
            .into_any_element()
    };
    let account_name = |status: &OverleafStatus| {
        status
            .email
            .clone()
            .or_else(|| status.name.clone())
            .unwrap_or_else(|| t!("your Overleaf account").into())
    };
    if let Some(status) = known.as_ref().filter(|status| status.connected) {
        children.push(status_row(
            "overleaf/settings/account",
            px(12.),
            Icon::CLOUD,
            true,
            t!("Connected as {0}", account_name(status)).into(),
            status.host.clone().into(),
            Some(sign_out("overleaf-sign-out")),
            cx,
        ));
    }
    if let Some(status) = known.as_ref().filter(|status| status.expired) {
        children.push(status_row(
            "overleaf/settings/account",
            px(12.),
            Icon::CLOUD_ALERT,
            false,
            t!("Your Overleaf session expired. Sign in again").into(),
            status
                .email
                .clone()
                .or_else(|| status.name.clone())
                .unwrap_or_else(|| status.host.clone())
                .into(),
            Some(sign_out("overleaf-sign-out-expired")),
            cx,
        ));
    }
    // A card straight after another sits closer (`.overleaf-status-row +
    // .overleaf-status-row`).
    let mut after_status = known
        .as_ref()
        .is_some_and(|status| status.connected || status.expired);
    if let Some(status) = known.as_ref().filter(|status| !status.connected) {
        after_status = false;
        children.push(
            div()
                .mt(px(12.))
                .py(px(12.))
                .px(px(16.))
                .border_1()
                .border_color(palette.line)
                .rounded(RADIUS_PANEL)
                .bg(palette.raised)
                .child(crate::overleaf::parts::login_controls(
                    "overleaf-settings-login",
                    &login,
                    if status.expired {
                        t!("Reconnect to Overleaf").into()
                    } else {
                        t!("Connect to Overleaf").into()
                    },
                    Some(t!("You sign in on Overleaf. Lattice never sees your password.").into()),
                    false,
                    window,
                    cx,
                ))
                .into_any_element(),
        );
    } else {
        let before = children.len();
        children.extend(crate::overleaf::parts::login_messages(&login, cx));
        after_status &= children.len() == before;
    }
    if let Some(link) = link {
        let linked_host = if !link.host.trim().is_empty() {
            link.host.trim().to_string()
        } else if let Some(status) = &status {
            status.host.trim().to_string()
        } else {
            t!("the linked Overleaf host").into()
        };
        let connected_to_host = known.as_ref().is_some_and(|status| {
            status.connected && link_matches_session(&status.host, &link.host)
        });
        let detail: String = if error.is_some() {
            t!(
                "Couldn’t check the connection. Still linked to {linkedHost}",
                linkedHost = &linked_host
            )
            .into()
        } else if loading || status.is_none() {
            t!(
                "Checking the connection to {linkedHost}…",
                linkedHost = &linked_host
            )
            .into()
        } else if !status.as_ref().is_some_and(|status| status.connected) {
            if link.paused {
                t!(
                    "Sign in to {linkedHost}, then resume",
                    linkedHost = &linked_host
                )
                .into()
            } else {
                t!(
                    "Sign in to {linkedHost} to resume syncing",
                    linkedHost = &linked_host
                )
                .into()
            }
        } else if !connected_to_host {
            t!(
                "This project uses {linkedHost}. Sign out and connect to it to resume",
                linkedHost = &linked_host
            )
            .into()
        } else {
            match &link.last_sync {
                Some(at) => t!("Last synced {0}", relative_time(at)).into(),
                None => t!("Not synced yet").into(),
            }
        };
        let title: String = if !connected_to_host {
            t!("“{0}” stays linked", &link.project_name).into()
        } else if link.paused {
            t!("Syncing with “{0}” is paused", &link.project_name).into()
        } else {
            t!("This project syncs with “{0}”", &link.project_name).into()
        };
        let paused = link.paused;
        let shell = shell.clone();
        let reload = connection.clone();
        let action = connected_to_host.then(|| {
            Button::new(
                "overleaf-pause",
                if paused {
                    t!("Resume syncing")
                } else {
                    t!("Pause syncing")
                },
            )
            .compact()
            .on_click(move |_, _, cx| {
                shell
                    .update(cx, |shell, cx| {
                        shell
                            .overleaf
                            .update(cx, |bridge, cx| bridge.set_paused(!paused, cx));
                    })
                    .ok();
                // The bridge writes the link; read it back once it has.
                let reload = reload.clone();
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(300))
                        .await;
                    reload.update(cx, |connection, cx| connection.load(cx));
                })
                .detach();
            })
            .into_any_element()
        });
        children.push(status_row(
            "overleaf/settings/link",
            if after_status { px(8.) } else { px(12.) },
            Icon::LINK_2,
            connected_to_host && !paused,
            title.into(),
            detail.into(),
            action,
            cx,
        ));
    }
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .text_role_in(TextRole::Subtitle, TypeScale::Settings, cx)
                .font_weight(FONT_WEIGHT_SEMIBOLD)
                .text_color(palette.text)
                .child(t!("Connection")),
        )
        .children(children)
        .into_any_element()
}

fn behaviour_group(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let settings = super::get(cx).clone();
    let palette = cx.palette().clone();
    let channel = dialog
        .shell()
        .upgrade()
        .map(|shell| shell.read(cx).overleaf.read(cx).channel())
        .unwrap_or_default();
    let mode = controls::select(
        "overleaf-sync-mode",
        vec![
            (OverleafSyncMode::Live, t!("Live sync").into()),
            (OverleafSyncMode::Manual, t!("Manual").into()),
        ],
        settings.overleaf_sync_mode,
        |mode, _, cx| super::update(cx, |settings| settings.overleaf_sync_mode = mode),
    );
    let delete = controls::select(
        "overleaf-remote-delete",
        vec![
            (OverleafRemoteDelete::Ask, t!("Ask before deleting").into()),
            (
                OverleafRemoteDelete::Always,
                t!("Delete on Overleaf too").into(),
            ),
            (
                OverleafRemoteDelete::Never,
                t!("Keep it on Overleaf").into(),
            ),
        ],
        settings.overleaf_remote_delete,
        |policy, _, cx| super::update(cx, |settings| settings.overleaf_remote_delete = policy),
    );
    // Only the live channel's state is worth a line under Sync mode; only
    // "Delete on Overleaf too" has a fact its label cannot carry.
    let channel_line = (settings.overleaf_sync_mode == OverleafSyncMode::Live
        && channel != ChannelStatus::Off)
        .then(|| {
            let (text, ink): (&str, gpui::Hsla) = match channel {
                ChannelStatus::Connecting => {
                    (t!("Connecting live editing…"), palette.text_secondary)
                }
                ChannelStatus::Error => (
                    t!("Live editing is unavailable; regular syncing continues"),
                    palette.danger,
                ),
                _ => (t!("Live editing is connected"), palette.success),
            };
            let dot = match channel {
                ChannelStatus::Connecting => palette.warning,
                _ => ink,
            };
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_role_in(TextRole::Caption, TypeScale::Settings, cx)
                .text_color(ink)
                .child(div().flex_none().size(px(6.)).rounded(RADIUS_PILL).bg(dot))
                .child(text)
        });
    let mut sync_mode = Row::new("overleaf-sync-mode", t!("Sync mode")).control(mode);
    if let Some(line) = channel_line {
        sync_mode = sync_mode.description_element(line);
    }
    let mut remote =
        Row::new("overleaf-remote-delete", t!("When you delete a file here")).control(delete);
    if settings.overleaf_remote_delete == OverleafRemoteDelete::Always {
        remote = remote.description(t!("Overleaf history keeps a copy"), cx);
    }
    let row = |dialog: &SettingsDialog, row: Row, cx: &App| {
        let id = row.id;
        div()
            .relative()
            .child(dialog.measure(id))
            .child(row.revealed(dialog.revealed(id)).render(width, cx))
            .into_any_element()
    };
    controls::group(
        Some(t!("Sync behavior").into()),
        vec![row(dialog, sync_mode, cx), row(dialog, remote, cx)],
        cx,
    )
}
