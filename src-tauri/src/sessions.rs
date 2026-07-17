use crate::models::{AgentMessage, AgentSession, AgentSessionSummary};
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const NEW_CONVERSATION: &str = "New";
const LEGACY_NEW_CONVERSATION: &str = "New conversation";

pub fn create(
    root: &Path,
    provider: &str,
    model: &str,
    reasoning_effort: &str,
) -> Result<AgentSession, String> {
    validate_provider(provider)?;
    validate_settings(model, reasoning_effort)?;
    let timestamp = Utc::now().to_rfc3339();
    let session = AgentSession {
        id: Uuid::new_v4().to_string(),
        title: NEW_CONVERSATION.to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        provider: provider.to_string(),
        model: model.to_string(),
        reasoning_effort: reasoning_effort.to_string(),
        messages: vec![AgentMessage {
            id: Uuid::new_v4().to_string(),
            role: "agent".to_string(),
            text: "What would you like to work on?".to_string(),
            files: Vec::new(),
            skills: Vec::new(),
        }],
    };
    write(root, &session)?;
    Ok(session)
}

pub fn save(root: &Path, mut session: AgentSession) -> Result<AgentSession, String> {
    session_path(root, &session.id)?;
    normalize_settings(&mut session)?;
    if session.title.trim().is_empty()
        || session.title == NEW_CONVERSATION
        || session.title == LEGACY_NEW_CONVERSATION
    {
        session.title = session
            .messages
            .iter()
            .find(|message| message.role == "user")
            .map(|message| conversation_title(&message.text))
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| NEW_CONVERSATION.to_string());
    }
    session.updated_at = Utc::now().to_rfc3339();
    write(root, &session)?;
    Ok(session)
}

pub fn read(root: &Path, session_id: &str) -> Result<AgentSession, String> {
    let raw = fs::read_to_string(session_path(root, session_id)?).map_err(err)?;
    let mut session: AgentSession = serde_json::from_str(&raw).map_err(err)?;
    normalize_settings(&mut session)?;
    Ok(session)
}

pub fn list(root: &Path) -> Result<Vec<AgentSessionSummary>, String> {
    let directory = root.join(".research/sessions");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(entry.path()).map_err(err)?;
        let mut session: AgentSession = serde_json::from_str(&raw).map_err(err)?;
        normalize_settings(&mut session)?;
        sessions.push(AgentSessionSummary {
            id: session.id,
            title: session.title,
            updated_at: session.updated_at,
            provider: session.provider,
            model: session.model,
            reasoning_effort: session.reasoning_effort,
            message_count: session.messages.len(),
        });
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

pub fn delete(root: &Path, session_id: &str) -> Result<(), String> {
    fs::remove_file(session_path(root, session_id)?).map_err(err)?;
    let pi_sessions = root.join(".research/pi-sessions");
    if pi_sessions.is_dir() {
        let suffix = format!("_{session_id}.jsonl");
        for entry in fs::read_dir(pi_sessions).map_err(err)? {
            let path = entry.map_err(err)?.path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&suffix))
            {
                fs::remove_file(path).map_err(err)?;
            }
        }
    }
    Ok(())
}

fn write(root: &Path, session: &AgentSession) -> Result<(), String> {
    let path = session_path(root, &session.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let raw = serde_json::to_string_pretty(session).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
}

fn session_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    if Uuid::parse_str(session_id).is_err() {
        return Err("Invalid conversation id.".to_string());
    }
    Ok(root
        .join(".research/sessions")
        .join(format!("{session_id}.json")))
}

fn validate_provider(provider: &str) -> Result<(), String> {
    match provider {
        "codex" | "claude" | "openai-api" | "anthropic-api" => Ok(()),
        _ => Err("Unknown agent provider.".to_string()),
    }
}

fn normalize_settings(session: &mut AgentSession) -> Result<(), String> {
    validate_provider(&session.provider)?;
    if session.model.trim().is_empty() {
        session.model = default_model(&session.provider).to_string();
    }
    if session.reasoning_effort.trim().is_empty() {
        session.reasoning_effort = "high".to_string();
    }
    validate_settings(&session.model, &session.reasoning_effort)
}

fn default_model(provider: &str) -> &'static str {
    match provider {
        "codex" | "openai-api" => "gpt-5.6-sol",
        "claude" => "claude-opus-4-8",
        "anthropic-api" => "claude-sonnet-5",
        _ => "",
    }
}

fn validate_settings(model: &str, reasoning_effort: &str) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("Choose an agent model.".to_string());
    }
    match reasoning_effort {
        "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => Ok(()),
        _ => Err("Choose a supported reasoning effort.".to_string()),
    }
}

fn conversation_title(message: &str) -> String {
    let normalized = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = normalized.chars();
    let title = characters.by_ref().take(54).collect::<String>();
    if characters.next().is_some() {
        format!("{title}…")
    } else {
        title
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_messages_without_skills_remain_readable() {
        let message: AgentMessage = serde_json::from_str(
            r#"{"id":"old","role":"agent","text":"Earlier response","files":[]}"#,
        )
        .unwrap();
        assert!(message.skills.is_empty());
    }

    #[test]
    fn conversations_can_be_created_saved_restored_and_deleted() {
        let root = std::env::temp_dir().join(format!("lattice-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut session = create(&root, "codex", "gpt-5.6-sol", "high").unwrap();
        assert_eq!(session.title, "New");
        session.messages.push(AgentMessage {
            id: Uuid::new_v4().to_string(),
            role: "user".to_string(),
            text: "Rewrite the introduction around the central hypothesis".to_string(),
            files: Vec::new(),
            skills: Vec::new(),
        });
        let session = save(&root, session).unwrap();
        assert_eq!(
            session.title,
            "Rewrite the introduction around the central hypothesis"
        );
        assert_eq!(list(&root).unwrap()[0].id, session.id);
        assert_eq!(read(&root, &session.id).unwrap().messages.len(), 2);
        assert_eq!(read(&root, &session.id).unwrap().model, "gpt-5.6-sol");
        fs::create_dir_all(root.join(".research/pi-sessions")).unwrap();
        let pi_session = root
            .join(".research/pi-sessions")
            .join(format!("2026-07-17T12-00-00_{}.jsonl", session.id));
        fs::write(&pi_session, "{}\n").unwrap();
        delete(&root, &session.id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        assert!(!pi_session.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
