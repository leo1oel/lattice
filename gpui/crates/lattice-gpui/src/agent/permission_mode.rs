//! The Agent's permission mode, as Synara reports it to the Agent island
//! (`synara:agent-permission-mode`, `use-synara-host.ts`): what a compile
//! repair runs under, so a repair never has more access than the writer
//! gave the Agent. Unknown until the Agent's frame says.

use gpui::{App, Global};
use serde_json::Value;

/// One of Synara's permission modes (`SYNARA_PERMISSION_MODES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionMode {
    ApprovalRequired,
    Auto,
    FullAccess,
}

impl PermissionMode {
    pub fn parse(mode: &str) -> Option<Self> {
        Some(match mode {
            "approval-required" => Self::ApprovalRequired,
            "auto" => Self::Auto,
            "full-access" => Self::FullAccess,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApprovalRequired => "approval-required",
            Self::Auto => "auto",
            Self::FullAccess => "full-access",
        }
    }
}

struct AgentPermissionMode(PermissionMode);

impl Global for AgentPermissionMode {}

/// The Agent's current permission mode, `None` until it is known.
pub fn permission_mode(cx: &App) -> Option<PermissionMode> {
    cx.try_global::<AgentPermissionMode>().map(|mode| mode.0)
}

pub fn set_permission_mode(mode: PermissionMode, cx: &mut App) {
    cx.set_global(AgentPermissionMode(mode));
}

/// A task's `runtimeMode`: the mode, or null for the Agent's own default
/// while it is unknown.
pub fn runtime_mode(mode: Option<PermissionMode>) -> Value {
    mode.map_or(Value::Null, |mode| Value::from(mode.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runtime_mode_is_the_known_mode_or_null() {
        assert_eq!(runtime_mode(None), Value::Null);
        for mode in ["approval-required", "auto", "full-access"] {
            assert_eq!(runtime_mode(PermissionMode::parse(mode)), Value::from(mode));
        }
        assert_eq!(PermissionMode::parse("yolo"), None);
    }
}
