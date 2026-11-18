//! What the Agent's page asks of the window: its messages as the
//! [`SurfaceEvent`]s the panel's owner hears.

use serde_json::Value;

/// What the Agent asks of the window.
#[derive(Clone, Debug, PartialEq)]
pub enum SurfaceEvent {
    /// Open a project file the Agent named.
    OpenPath(String),
    /// Open the Git workspace, pinned to one turn's checkpoint diff when given.
    OpenReview(Option<TurnReview>),
    /// Open Settings on the Agent's providers, revealing a place on the
    /// page when one is named (`provider-binary-paths`).
    OpenProviderSettings(Option<String>),
    /// The selection the Agent was shown is spent.
    ClearSelection,
    /// The narrowest the Agent's panel can be with its composer intact.
    MinimumWidth(f32),
    /// The Git workspace's view tab was chosen.
    GitView(String),
    /// The Git workspace's close button.
    CloseGit,
    /// A canvas, spreadsheet or presentation tool call for the window's
    /// documents (`documents.rs`); answer with [`SynaraSurface::answer`].
    DocumentTool {
        id: u64,
        family: String,
        request: Value,
    },
    /// An annotation tool's call to record into the open round
    /// (`annotations.rs`); answered with [`SynaraSurface::answer`].
    AnnotationTool {
        id: u64,
        annotation: String,
        answer: crate::annotations::rounds::ToolAnswer,
    },
    /// The Agent creates a board or sheet at `path`.
    CreateDocument {
        id: u64,
        path: String,
        expires_at: f64,
    },
    /// The Agent's checkpoint history for the panel's thread
    /// (`checkpoints.rs`).
    History(crate::agent::checkpoints::Snapshot),
    /// The panel's turn as it now stands (`AgentDeckPresence`), `None` once
    /// no turn runs or waits.
    Turn(Option<Value>),
    /// A turn started: the writer asked the Agent something.
    TurnStarted,
}

/// A turn's checkpoint diff, reviewable after the working tree moved on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnReview {
    pub thread_id: String,
    pub turn_id: String,
    pub file_path: Option<String>,
}

/// What the page asks of the window, as the event its owner hears; `None`
/// for a message that asks nothing of it.
pub(super) fn surface_event(kind: &str, payload: &Value) -> Option<SurfaceEvent> {
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    Some(match kind {
        "agent:open-path" => SurfaceEvent::OpenPath(text("path")?),
        "agent:open-review" => SurfaceEvent::OpenReview(match (text("threadId"), text("turnId")) {
            (Some(thread_id), Some(turn_id)) => Some(TurnReview {
                thread_id,
                turn_id,
                file_path: None,
            }),
            _ => None,
        }),
        "agent:open-settings" => SurfaceEvent::OpenProviderSettings(text("target")),
        "agent:clear-selection" => SurfaceEvent::ClearSelection,
        "agent:minimum-width" => {
            SurfaceEvent::MinimumWidth(payload.get("width").and_then(Value::as_f64)? as f32)
        }
        "agent:git-view" => SurfaceEvent::GitView(text("view")?),
        "agent:turn" => SurfaceEvent::Turn(
            payload
                .get("presence")
                .filter(|presence| presence.is_object())
                .cloned(),
        ),
        "agent:turn-started" => SurfaceEvent::TurnStarted,
        "agent:close-git" => SurfaceEvent::CloseGit,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The page's messages as `src/agent` and `use-synara-host.ts` post them
    /// (`openProviderSettings(target)`, `{ target: target ?? null }`).
    #[test]
    fn provider_settings_carry_the_place_the_page_named() {
        assert_eq!(
            surface_event(
                "agent:open-settings",
                &json!({ "target": "provider-binary-paths" })
            ),
            Some(SurfaceEvent::OpenProviderSettings(Some(
                "provider-binary-paths".into()
            )))
        );
        assert_eq!(
            surface_event("agent:open-settings", &json!({ "target": null })),
            Some(SurfaceEvent::OpenProviderSettings(None))
        );
        assert_eq!(
            surface_event("agent:minimum-width", &json!({ "width": 312 })),
            Some(SurfaceEvent::MinimumWidth(312.))
        );
        assert_eq!(
            surface_event("agent:open-path", &json!({ "path": " " })),
            None
        );
        assert_eq!(surface_event("agent:history", &json!({})), None);
        assert_eq!(surface_event("agent:frame-message", &json!({})), None);
        assert_eq!(
            surface_event("agent:turn", &json!({ "presence": null })),
            Some(SurfaceEvent::Turn(None))
        );
        assert_eq!(
            surface_event("agent:turn", &json!({ "presence": { "state": "running" } })),
            Some(SurfaceEvent::Turn(Some(json!({ "state": "running" }))))
        );
    }
}
