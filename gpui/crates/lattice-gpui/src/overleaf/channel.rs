//! Overleaf's live channel for a linked project (lattice-core's
//! `overleaf_rt`, a Socket.IO 0.9 client), as the Tauri app's
//! `overleaf_rt_connect` and `use-overleaf-realtime-connection.ts` hold it:
//! joined whenever the project is linked and syncing, in either sync mode,
//! and joined again with backoff after a drop.
//!
//! Joining is the only way to learn three things the REST sync needs: the
//! project's root folder id, without which no file can be uploaded; this
//! account's role in the project; and every file's id, which removing a file
//! on Overleaf and following a rename take. They are recorded in the link
//! (`set_realtime_metadata`, `record_root_document`) as soon as the join
//! answers, before the first automatic sync can start.
//!
//! Editing documents through the channel, presence, comments and chat ride
//! the same connection; they come with the realtime part of the port.

use std::{path::PathBuf, sync::Arc, time::Duration};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{AsyncApp, Task, WeakEntity};
use lattice_core::{
    overleaf,
    overleaf_rt::{EntityEntry, RealtimeClient, RealtimeConfig, RealtimeEvent},
};
use lattice_i18n::t;

use super::{bridge::OverleafBridge, config_dir};

/// The first wait before joining again, doubling to [`RECONNECT_MAX`].
const RECONNECT_BASE: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// Where the channel stands, as the toolbar and Settings say it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChannelStatus {
    #[default]
    Off,
    Connecting,
    Live,
    Error,
}

/// What the channel tells the bridge.
pub(super) enum ChannelNews {
    /// Joined: the project's files by path, and the client, for presence and
    /// live documents until the channel drops.
    Joined {
        entities: Vec<EntityEntry>,
        client: Arc<RealtimeClient>,
    },
    /// What the channel says of people and live documents.
    Event(RealtimeEvent),
    /// The project's files changed.
    Tree(Vec<EntityEntry>),
    /// Down, joining again after the wait the detail names.
    Reconnecting(String),
    /// Down for good: why.
    Failed(String),
}

/// Authentication and project-identity failures need the writer, not a
/// retry loop (`shouldRetryConnection` in `overleaf-realtime-model.ts`).
fn should_retry(reason: &str) -> bool {
    let lower = reason.to_lowercase();
    let gone = [
        "not connected to overleaf",
        "project changed",
        "not linked",
        "newer overleaf connection",
        "can no longer open the project",
        "paused",
    ];
    let needs_writer = [
        "session expired",
        "cookie",
        "sign in",
        "signin",
        "sign-in",
        "authentication",
        "unauthorized",
        "unauthorised",
        "not authorized",
        "not authorised",
        "forbidden",
        "permission",
        "invalid project",
        "project not found",
    ];
    !gone
        .iter()
        .chain(needs_writer.iter())
        .any(|phrase| lower.contains(phrase))
}

/// What the toolbar says while the channel waits to join again.
fn reconnecting_detail(reason: &str, delay: Duration) -> String {
    let seconds = delay.as_secs_f64().ceil() as u64;
    if delay.is_zero() {
        t!(
            "Overleaf live editing disconnected ({reason}). Reconnecting now…",
            reason = reason
        )
        .into()
    } else {
        t!(
            "Overleaf live editing disconnected ({reason}). Reconnecting in {seconds} s…",
            reason = reason,
            seconds = seconds
        )
        .into()
    }
}

/// The wait before the `attempt`th join again.
fn backoff(attempt: u32) -> Duration {
    RECONNECT_BASE
        .saturating_mul(2u32.saturating_pow(attempt))
        .min(RECONNECT_MAX)
}

/// Join `root`'s project and hold the connection, telling `bridge` as it
/// changes, until the returned task is dropped (which closes it).
pub(super) fn hold(root: PathBuf, bridge: WeakEntity<OverleafBridge>, cx: &AsyncApp) -> Task<()> {
    cx.spawn(async move |cx| {
        let mut attempt = 0u32;
        let mut refusals = 0u32;
        loop {
            let (sender, mut events) = mpsc::unbounded::<RealtimeEvent>();
            let joined = cx
                .background_executor()
                .spawn(join(root.clone(), sender))
                .await;
            let reason = match joined {
                Ok((client, entities)) => {
                    attempt = 0;
                    refusals = 0;
                    let client = Guard(client);
                    let told = bridge.update(cx, |bridge, cx| {
                        bridge.channel_news(
                            ChannelNews::Joined {
                                entities,
                                client: client.0.clone(),
                            },
                            cx,
                        )
                    });
                    if told.is_err() {
                        return;
                    }
                    let mut reason = t!("connection closed").to_string();
                    while let Some(event) = events.next().await {
                        match event {
                            RealtimeEvent::TreeChanged { entities, .. } => {
                                let told = bridge.update(cx, |bridge, cx| {
                                    bridge.channel_news(ChannelNews::Tree(entities), cx)
                                });
                                if told.is_err() {
                                    return;
                                }
                            }
                            RealtimeEvent::Disconnected { reason: why } => {
                                reason = why;
                                break;
                            }
                            event @ (RealtimeEvent::PresenceUpdated { .. }
                            | RealtimeEvent::PresenceLeft { .. }
                            | RealtimeEvent::DocUpdate { .. }
                            | RealtimeEvent::DocAck { .. }
                            | RealtimeEvent::OtError { .. }
                            | RealtimeEvent::Connected { .. }
                            | RealtimeEvent::CommentAnchored { .. }
                            | RealtimeEvent::ChangesAccepted { .. }
                            | RealtimeEvent::TrackChangesToggled { .. }
                            | RealtimeEvent::ThreadsChanged
                            | RealtimeEvent::ChatMessage { .. }) => {
                                let told = bridge.update(cx, |bridge, cx| {
                                    bridge.channel_news(ChannelNews::Event(event), cx)
                                });
                                if told.is_err() {
                                    return;
                                }
                            }
                            _ => {}
                        }
                    }
                    drop(client);
                    reason
                }
                Err((reason, expired)) => {
                    if expired {
                        cx.update(super::session_changed);
                    }
                    reason
                }
            };
            if super::outcome::is_project_refusal(&reason) {
                refusals += 1;
            }
            let refused_too_often = refusals >= super::outcome::REFUSAL_RETRIES;
            if !should_retry(&reason) || refused_too_often {
                let detail = if refused_too_often {
                    t!("Overleaf keeps refusing live editing for this project, though you are still signed in. Check that the project still opens on Overleaf.").to_string()
                } else {
                    reason
                };
                bridge
                    .update(cx, |bridge, cx| {
                        bridge.channel_news(ChannelNews::Failed(detail), cx)
                    })
                    .ok();
                return;
            }
            let delay = backoff(attempt);
            attempt += 1;
            let told = bridge.update(cx, |bridge, cx| {
                bridge.channel_news(
                    ChannelNews::Reconnecting(reconnecting_detail(&reason, delay)),
                    cx,
                )
            });
            if told.is_err() {
                return;
            }
            cx.background_executor().timer(delay).await;
        }
    })
}

/// A connection closed when it is let go.
struct Guard(Arc<RealtimeClient>);

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

/// Connect and join, then record what the join said in the link; the
/// client, and the project's files. A failure says whether it found the
/// session expired.
async fn join(
    root: PathBuf,
    events: mpsc::UnboundedSender<RealtimeEvent>,
) -> Result<(Arc<RealtimeClient>, Vec<EntityEntry>), (String, bool)> {
    let (host, cookie, project_id, user_id) =
        overleaf::realtime_config(&config_dir(), &root).map_err(|error| (error, false))?;
    let connecting = lattice_core::runtime::spawn(RealtimeClient::connect(
        RealtimeConfig {
            user_id,
            host,
            cookie,
            project_id,
        },
        move |event| {
            events.unbounded_send(event).ok();
        },
    ));
    let client = match connecting.await {
        Ok(Ok(client)) => Arc::new(client),
        Ok(Err(error)) => {
            let (error, expired) = super::settled::<()>(Err(error));
            return Err((error.err().unwrap_or_default(), expired));
        }
        Err(error) => {
            return Err((
                format!("The Overleaf connection task failed: {error}"),
                false,
            ));
        }
    };
    let tree = client.project();
    // `joinProject` is the only source of the root folder id uploads need:
    // recorded before the bridge hears the channel is up, as its first
    // automatic sync may start at once.
    overleaf::set_realtime_metadata(&root, &tree.root_folder_id, tree.permission.as_str())
        .map_err(|error| (error, false))?;
    overleaf::record_root_document(&root, tree.root_document.as_deref())
        .map_err(|error| (error, false))?;
    let entities = tree.entities.clone();
    Ok((client, entities))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joining_again_backs_off_to_half_a_minute() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(10), RECONNECT_MAX);
    }

    #[test]
    fn a_dead_session_or_a_lost_project_is_not_retried() {
        assert!(should_retry("Could not reach Overleaf: connection reset"));
        assert!(!should_retry(
            "Overleaf session expired. Reconnect in Settings → Overleaf."
        ));
        assert!(!should_retry(
            "This Overleaf account can no longer open the project."
        ));
        assert!(!should_retry(
            "Syncing is paused for this project. Resume it in Settings → Overleaf."
        ));
    }
}
