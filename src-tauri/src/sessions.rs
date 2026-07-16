use crate::models::{AgentMessage, AgentSession, AgentSessionSummary};
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const NEW_CONVERSATION: &str = "New conversation";

pub fn create(root: &Path, provider: &str) -> Result<AgentSession, String> {
    validate_provider(provider)?;
    let timestamp = Utc::now().to_rfc3339();
    let session = AgentSession {
        id: Uuid::new_v4().to_string(),
        title: NEW_CONVERSATION.to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        provider: provider.to_string(),
        messages: vec![AgentMessage {
            id: Uuid::new_v4().to_string(),
            role: "agent".to_string(),
            text: "Tell me what you want to write or revise. I can work across the project, use imported papers as evidence, and keep this conversation with the project.".to_string(),
            files: Vec::new(),
        }],
    };
    write(root, &session)?;
    Ok(session)
}

pub fn save(root: &Path, mut session: AgentSession) -> Result<AgentSession, String> {
    session_path(root, &session.id)?;
    validate_provider(&session.provider)?;
    if session.title.trim().is_empty() || session.title == NEW_CONVERSATION {
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
    serde_json::from_str(&raw).map_err(err)
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
        let session: AgentSession = serde_json::from_str(&raw).map_err(err)?;
        sessions.push(AgentSessionSummary {
            id: session.id,
            title: session.title,
            updated_at: session.updated_at,
            provider: session.provider,
            message_count: session.messages.len(),
        });
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

pub fn delete(root: &Path, session_id: &str) -> Result<(), String> {
    fs::remove_file(session_path(root, session_id)?).map_err(err)
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
    fn conversations_can_be_created_saved_restored_and_deleted() {
        let root = std::env::temp_dir().join(format!("lattice-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut session = create(&root, "codex").unwrap();
        session.messages.push(AgentMessage {
            id: Uuid::new_v4().to_string(),
            role: "user".to_string(),
            text: "Rewrite the introduction around the central hypothesis".to_string(),
            files: Vec::new(),
        });
        let session = save(&root, session).unwrap();
        assert_eq!(
            session.title,
            "Rewrite the introduction around the central hypothesis"
        );
        assert_eq!(list(&root).unwrap()[0].id, session.id);
        assert_eq!(read(&root, &session.id).unwrap().messages.len(), 2);
        delete(&root, &session.id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
