use crate::models::{
    AgentMessage, AgentSession, AgentSessionSearchResult, AgentSessionSummary,
};
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
    normalize_legacy_echoes(&mut session);
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
    normalize_legacy_echoes(&mut session);
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
        normalize_legacy_echoes(&mut session);
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

pub fn search(root: &Path, query: &str) -> Result<Vec<AgentSessionSearchResult>, String> {
    let needle = query.trim().to_lowercase();
    let summaries = list(root)?;
    let mut results = Vec::new();
    for summary in summaries {
        let session = read(root, &summary.id)?;
        let matching_message = session.messages.iter().find(|message| {
            message.text.to_lowercase().contains(&needle)
                || message
                    .files
                    .iter()
                    .any(|file| file.to_lowercase().contains(&needle))
        });
        if needle.is_empty() || session.title.to_lowercase().contains(&needle) || matching_message.is_some() {
            let snippet = matching_message
                .map(|message| search_snippet(&message.text, &needle))
                .unwrap_or_default();
            results.push(AgentSessionSearchResult { session: summary, snippet });
        }
    }
    Ok(results)
}

pub fn create_branch(
    root: &Path,
    source: &AgentSession,
    new_session_id: &str,
    message_id: &str,
) -> Result<AgentSession, String> {
    session_path(root, new_session_id)?;
    let message_index = source
        .messages
        .iter()
        .position(|message| message.id == message_id && message.role == "user")
        .ok_or_else(|| "The message to branch from is no longer available.".to_string())?;
    let timestamp = Utc::now().to_rfc3339();
    let session = AgentSession {
        id: new_session_id.to_string(),
        title: NEW_CONVERSATION.to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        provider: source.provider.clone(),
        model: source.model.clone(),
        reasoning_effort: source.reasoning_effort.clone(),
        messages: source.messages[..message_index].to_vec(),
    };
    write(root, &session)?;
    Ok(session)
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

fn normalize_legacy_echoes(session: &mut AgentSession) {
    let mut previous_user = None::<String>;
    for message in &mut session.messages {
        match message.role.as_str() {
            "user" => previous_user = Some(message.text.clone()),
            "agent" => {
                if let Some(user) = previous_user.take() {
                    if let Some(answer) = message.text.strip_prefix(&user) {
                        if !answer.trim().is_empty() {
                            message.text = answer.trim_start().to_string();
                        }
                    }
                }
            }
            _ => previous_user = None,
        }
    }
}

fn search_snippet(text: &str, needle: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return String::new();
    }
    let lower = compact.to_lowercase();
    let start = lower
        .find(needle)
        .map(|index| lower[..index].chars().count().saturating_sub(36))
        .unwrap_or(0);
    let total = compact.chars().count();
    let visible = compact.chars().skip(start).take(110).collect::<String>();
    let visible_count = visible.chars().count();
    let mut snippet = visible;
    if start > 0 {
        snippet.insert(0, '…');
    }
    if start + visible_count < total {
        snippet.push('…');
    }
    snippet
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

    #[test]
    fn conversations_can_be_searched_and_branched_without_changing_the_original() {
        let root = std::env::temp_dir().join(format!("lattice-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut original = create(&root, "codex", "gpt-5.6-sol", "high").unwrap();
        let message_id = Uuid::new_v4().to_string();
        original.messages.push(AgentMessage {
            id: message_id.clone(),
            role: "user".to_string(),
            text: "Compare against the strongest diffusion baseline".to_string(),
            files: vec!["sections/related.tex".to_string()],
            skills: Vec::new(),
        });
        original.messages.push(AgentMessage {
            id: Uuid::new_v4().to_string(),
            role: "agent".to_string(),
            text: "I updated the section.".to_string(),
            files: Vec::new(),
            skills: Vec::new(),
        });
        original = save(&root, original).unwrap();
        let results = search(&root, "diffusion baseline").unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].snippet.contains("diffusion baseline"));

        let branch_id = Uuid::new_v4().to_string();
        let branch = create_branch(&root, &original, &branch_id, &message_id).unwrap();
        assert_eq!(branch.messages.len(), 1);
        assert_eq!(read(&root, &original.id).unwrap().messages.len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_streamed_answers_do_not_repeat_the_user_question() {
        let mut session = AgentSession {
            id: Uuid::new_v4().to_string(),
            title: "Question".to_string(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            provider: "codex".to_string(),
            model: "gpt-5.6-sol".to_string(),
            reasoning_effort: "high".to_string(),
            messages: vec![
                AgentMessage { id: Uuid::new_v4().to_string(), role: "user".to_string(), text: "What model are you?".to_string(), files: Vec::new(), skills: Vec::new() },
                AgentMessage { id: Uuid::new_v4().to_string(), role: "agent".to_string(), text: "What model are you?I am an assistant.".to_string(), files: Vec::new(), skills: Vec::new() },
            ],
        };
        normalize_legacy_echoes(&mut session);
        assert_eq!(session.messages[1].text, "I am an assistant.");
    }
}
