use crate::commands;
use crate::models::{AgentPayload, AgentResult};
use crate::{papers, project};
use serde_json::Value;
use std::path::Path;
use std::process::Command;

pub fn run(
    root: &Path,
    provider: &str,
    message: &str,
    active_file: Option<&str>,
    selection: Option<&str>,
) -> Result<AgentResult, String> {
    if message.trim().is_empty() {
        return Err("Write a message first.".to_string());
    }
    let prompt = build_prompt(root, message, active_file, selection)?;
    let raw = match provider {
        "codex" => run_codex(root, &prompt)?,
        "claude" => run_claude(root, &prompt)?,
        "openai-api" => run_openai_api(&prompt)?,
        "anthropic-api" => run_anthropic_api(&prompt)?,
        _ => return Err("Choose Codex or Claude.".to_string()),
    };
    let payload = parse_payload(&raw)?;
    if payload.edits.is_empty() {
        return Ok(AgentResult {
            summary: payload.summary,
            changed_files: Vec::new(),
            transaction_id: None,
        });
    }
    let edits = payload
        .edits
        .into_iter()
        .map(|edit| (edit.path, edit.content))
        .collect::<Vec<_>>();
    let changed_files = edits.iter().map(|(path, _)| path.clone()).collect();
    let transaction = project::apply_transaction(root, &payload.summary, edits)?;
    Ok(AgentResult {
        summary: payload.summary,
        changed_files,
        transaction_id: Some(transaction.id),
    })
}

fn build_prompt(
    root: &Path,
    message: &str,
    active_file: Option<&str>,
    selection: Option<&str>,
) -> Result<String, String> {
    let manifest = project::read_manifest(root)?;
    let brief = project::read_file(root, ".research/brief.md").unwrap_or_default();
    let active_path = active_file.unwrap_or(
        manifest
            .root_documents
            .iter()
            .find(|document| document.is_default)
            .or_else(|| manifest.root_documents.first())
            .map(|document| document.path.as_str())
            .unwrap_or("main.tex"),
    );
    let active_source = project::read_file(root, active_path).unwrap_or_default();
    let bibliography = project::read_file(root, &manifest.primary_bibliography).unwrap_or_default();
    let evidence = relevant_evidence(root, message)?;
    let selection = selection.unwrap_or("");
    Ok(format!(
        r#"You are the writing agent inside a local-first scientific LaTeX editor.
Return exactly one JSON object and no markdown fences or commentary.
The object must follow this shape:
{{"summary":"short description of the result","edits":[{{"path":"project-relative path","content":"complete new file content"}}]}}

Rules:
- Work only from the project context below.
- Preserve valid LaTeX and the project's existing style.
- Ground factual scientific claims in the supplied evidence and cite them using keys already present in the bibliography.
- If evidence is insufficient, say so in summary and return no speculative edit.
- Return complete content for every file you change.
- Never edit paths outside the project or anything under .research/history.
- Prefer a focused edit over rewriting unrelated sections.

USER REQUEST:
{message}

PROJECT BRIEF:
{brief}

ACTIVE FILE: {active_path}
```latex
{active_source}
```

SELECTED TEXT:
{selection}

BIBLIOGRAPHY ({bib_path}):
```bibtex
{bibliography}
```

RELEVANT PAPER EVIDENCE:
{evidence}
"#,
        bib_path = manifest.primary_bibliography
    ))
}

fn relevant_evidence(root: &Path, query: &str) -> Result<String, String> {
    let terms = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.len() >= 5)
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>();
    let mut ranked = Vec::new();
    for id in papers::list_papers(root)? {
        let content = papers::read_paper(root, &id)?;
        let lower = content.to_lowercase();
        let score = terms
            .iter()
            .map(|term| lower.matches(term).count())
            .sum::<usize>();
        ranked.push((score, id, content));
    }
    ranked.sort_by_key(|item| std::cmp::Reverse(item.0));
    let excerpts = ranked
        .into_iter()
        .take(3)
        .map(|(_, id, content)| {
            let excerpt = content.chars().take(18_000).collect::<String>();
            format!("\n--- arXiv {id} ---\n{excerpt}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(if excerpts.is_empty() {
        "No papers have been imported into this project.".to_string()
    } else {
        excerpts
    })
}

fn run_codex(root: &Path, prompt: &str) -> Result<String, String> {
    let output = Command::new(commands::resolve("codex"))
        .current_dir(root)
        .arg("exec")
        .arg("--json")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--skip-git-repo-check")
        .arg(prompt)
        .output()
        .map_err(|error| format!("Could not start Codex CLI: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Codex failed.\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut messages = Vec::new();
    for line in stdout.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if value.get("type").and_then(Value::as_str) == Some("item.completed") {
                if let Some(item) = value.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            messages.push(text.to_string());
                        }
                    }
                }
            }
        }
    }
    messages
        .last()
        .cloned()
        .ok_or_else(|| "Codex returned no agent message.".to_string())
}

fn run_claude(root: &Path, prompt: &str) -> Result<String, String> {
    let output = Command::new(commands::resolve("claude"))
        .current_dir(root)
        .arg("--print")
        .arg("--output-format")
        .arg("json")
        .arg("--permission-mode")
        .arg("plan")
        .arg(prompt)
        .output()
        .map_err(|error| format!("Could not start Claude Code: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Claude failed.\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    value
        .get("result")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "Claude returned no result.".to_string())
}

fn run_openai_api(prompt: &str) -> Result<String, String> {
    let key = load_api_key("openai")?;
    let response = reqwest::blocking::Client::new()
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": "gpt-5.6",
            "input": prompt,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "lattice_project_edits",
                    "strict": true,
                    "schema": agent_schema()
                }
            }
        }))
        .send()
        .map_err(|error| format!("Could not reach the OpenAI API: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|error| format!("Could not parse the OpenAI response: {error}"))?;
    if !status.is_success() {
        return Err(api_error("OpenAI", status.as_u16(), &value));
    }
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return Ok(text.to_string());
    }
    value
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                item.get("content")
                    .and_then(Value::as_array)
                    .and_then(|content| {
                        content.iter().find_map(|block| {
                            (block.get("type").and_then(Value::as_str) == Some("output_text"))
                                .then(|| block.get("text").and_then(Value::as_str))
                                .flatten()
                        })
                    })
            })
        })
        .map(ToString::to_string)
        .ok_or_else(|| "OpenAI returned no text output.".to_string())
}

fn run_anthropic_api(prompt: &str) -> Result<String, String> {
    let key = load_api_key("anthropic")?;
    let response = reqwest::blocking::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": "claude-sonnet-5",
            "max_tokens": 16000,
            "messages": [{"role": "user", "content": prompt}],
            "output_config": {
                "format": {
                    "type": "json_schema",
                    "schema": agent_schema()
                }
            }
        }))
        .send()
        .map_err(|error| format!("Could not reach the Anthropic API: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|error| format!("Could not parse the Anthropic response: {error}"))?;
    if !status.is_success() {
        return Err(api_error("Anthropic", status.as_u16(), &value));
    }
    value
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            })
        })
        .map(ToString::to_string)
        .ok_or_else(|| "Anthropic returned no text output.".to_string())
}

fn agent_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["summary", "edits"],
        "additionalProperties": false
    })
}

fn api_error(provider: &str, status: u16, value: &Value) -> String {
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown API error");
    format!("{provider} API request failed ({status}): {message}")
}

pub fn save_api_key(provider: &str, key: &str) -> Result<(), String> {
    let provider = keychain_provider(provider)?;
    if key.trim().is_empty() {
        return Err("Enter an API key.".to_string());
    }
    keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(|error| error.to_string())?
        .set_password(key.trim())
        .map_err(|error| format!("Could not save the key in macOS Keychain: {error}"))
}

pub fn delete_api_key(provider: &str) -> Result<(), String> {
    let provider = keychain_provider(provider)?;
    let entry = keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not remove the key from macOS Keychain: {error}"
        )),
    }
}

pub fn api_key_status() -> Vec<(String, bool)> {
    ["openai", "anthropic"]
        .into_iter()
        .map(|provider| (provider.to_string(), load_api_key(provider).is_ok()))
        .collect()
}

fn load_api_key(provider: &str) -> Result<String, String> {
    let provider = keychain_provider(provider)?;
    keyring::Entry::new("app.leo1oel.researchwriter", provider)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|_| {
            format!("No {provider} API key is configured. Open agent settings to add one.")
        })
}

fn keychain_provider(provider: &str) -> Result<&str, String> {
    match provider {
        "openai" | "anthropic" => Ok(provider),
        _ => Err("Unknown API key provider.".to_string()),
    }
}

fn parse_payload(raw: &str) -> Result<AgentPayload, String> {
    let trimmed = raw.trim();
    if let Ok(payload) = serde_json::from_str::<AgentPayload>(trimmed) {
        return Ok(payload);
    }
    let start = trimmed
        .find('{')
        .ok_or_else(|| "The agent did not return structured edits.".to_string())?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| "The agent did not return structured edits.".to_string())?;
    serde_json::from_str(&trimmed[start..=end])
        .map_err(|error| format!("Could not parse the agent response: {error}"))
}

pub fn provider_status() -> Vec<(String, bool)> {
    ["codex", "claude"]
        .into_iter()
        .map(|name| (name.to_string(), commands::available(name)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_fenced_payload() {
        let payload = parse_payload("```json\n{\"summary\":\"done\",\"edits\":[]}\n```").unwrap();
        assert_eq!(payload.summary, "done");
    }

    #[test]
    #[ignore = "uses a local Codex subscription"]
    fn gets_a_structured_response_from_codex() {
        let parent =
            std::env::temp_dir().join(format!("lattice-agent-e2e-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let root = project::create(&parent, "paper").unwrap();
        let result = run(
            &root,
            "codex",
            "Do not edit any file. Briefly confirm that the active file is valid LaTeX.",
            Some("main.tex"),
            None,
        )
        .unwrap();
        assert!(!result.summary.is_empty());
        assert!(result.changed_files.is_empty());
        fs::remove_dir_all(parent).unwrap();
    }
}
