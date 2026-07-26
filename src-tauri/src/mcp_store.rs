//! Lattice-owned MCP server config for the bundled OMP runtime.
//!
//! OMP reads these files through its native discovery provider:
//! - application (all projects): `$PI_CODING_AGENT_DIR/mcp.json`
//! - project: `<project>/.omp/mcp.json`

use crate::agents::AgentRuntime;
use crate::models::{McpServer, McpServerSaveRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const SCHEMA_URL: &str =
    "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigFile {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    #[serde(default)]
    mcp_servers: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    disabled_servers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    enabled_servers: Vec<String>,
}

pub fn list(root: &Path, runtime: &AgentRuntime) -> Result<Vec<McpServer>, String> {
    let application = read_servers(&application_path(runtime))?;
    let project = read_servers(&project_path(root))?;
    let application_names = application.keys().cloned().collect::<Vec<_>>();
    let mut effective = application;
    effective.extend(project);
    Ok(effective
        .into_iter()
        .map(|(name, (scope, value))| {
            let overridden =
                scope == "project" && application_names.iter().any(|item| item == &name);
            to_server(name, scope, value, overridden)
        })
        .collect())
}

pub fn save(
    root: &Path,
    runtime: &AgentRuntime,
    request: McpServerSaveRequest,
) -> Result<McpServer, String> {
    let name = normalize_name(&request.name)?;
    let scope = normalize_scope(&request.scope)?;
    let path = config_path(root, runtime, scope)?;
    let mut file = read_config(&path)?;
    if let Some(original) = request.original_name.as_deref() {
        let original = normalize_name(original)?;
        if original != name {
            file.mcp_servers.remove(&original);
        }
        // Only when editing an existing entry, and only from the file it is
        // leaving: changing the scope alone used to leave the old entry
        // configured for every other project, hidden here because a project
        // entry shadows an application one. Adding a *new* entry that shares a
        // name is the deliberate override, and must not disturb what it
        // shadows.
        for other in [application_path(runtime), project_path(root)] {
            if other == path {
                continue;
            }
            let mut previous = read_config(&other)?;
            if previous.mcp_servers.remove(&original).is_some() {
                write_config(&other, &previous)?;
            }
        }
    }
    let entry = server_value(&request)?;
    file.mcp_servers.insert(name.clone(), entry);
    write_config(&path, &file)?;
    list(root, runtime)?
        .into_iter()
        .find(|server| server.name == name)
        .ok_or_else(|| "The saved MCP server could not be loaded.".to_string())
}

pub fn set_enabled(
    root: &Path,
    runtime: &AgentRuntime,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    let name = normalize_name(name)?;
    let servers = list(root, runtime)?;
    let server = servers
        .into_iter()
        .find(|item| item.name == name)
        .ok_or_else(|| format!("MCP server \"{name}\" was not found."))?;
    let path = config_path(root, runtime, &server.scope)?;
    let mut file = read_config(&path)?;
    let entry = file
        .mcp_servers
        .get_mut(&name)
        .ok_or_else(|| format!("MCP server \"{name}\" was not found."))?;
    let object = entry
        .as_object_mut()
        .ok_or_else(|| format!("MCP server \"{name}\" has an invalid configuration."))?;
    object.insert("enabled".to_string(), Value::Bool(enabled));
    write_config(&path, &file)
}

pub fn delete(root: &Path, runtime: &AgentRuntime, name: &str, scope: &str) -> Result<(), String> {
    let name = normalize_name(name)?;
    let scope = normalize_scope(scope)?;
    let path = config_path(root, runtime, scope)?;
    let mut file = read_config(&path)?;
    if file.mcp_servers.remove(&name).is_none() {
        return Err(format!("MCP server \"{name}\" was not found."));
    }
    write_config(&path, &file)
}

fn application_path(runtime: &AgentRuntime) -> PathBuf {
    runtime.config.join("mcp.json")
}

fn project_path(root: &Path) -> PathBuf {
    root.join(".omp").join("mcp.json")
}

fn config_path(root: &Path, runtime: &AgentRuntime, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "application" => Ok(application_path(runtime)),
        "project" => Ok(project_path(root)),
        _ => Err(
            "Choose whether the MCP server applies to all Lattice projects or only this project."
                .to_string(),
        ),
    }
}

fn read_servers(path: &Path) -> Result<BTreeMap<String, (&'static str, Value)>, String> {
    let scope = if path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        == Some(".omp")
    {
        "project"
    } else {
        "application"
    };
    let file = read_config(path)?;
    Ok(file
        .mcp_servers
        .into_iter()
        .map(|(name, value)| (name, (scope, value)))
        .collect())
}

fn read_config(path: &Path) -> Result<McpConfigFile, String> {
    if !path.is_file() {
        return Ok(McpConfigFile {
            schema: Some(SCHEMA_URL.to_string()),
            ..McpConfigFile::default()
        });
    }
    let raw = fs::read_to_string(path).map_err(err)?;
    let mut file: McpConfigFile = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Could not parse {}: {error}",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("mcp.json")
        )
    })?;
    if file.schema.is_none() {
        file.schema = Some(SCHEMA_URL.to_string());
    }
    Ok(file)
}

fn write_config(path: &Path, file: &McpConfigFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let mut out = file.clone();
    if out.schema.is_none() {
        out.schema = Some(SCHEMA_URL.to_string());
    }
    let raw = serde_json::to_string_pretty(&out).map_err(err)?;
    fs::write(path, format!("{raw}\n")).map_err(err)
}

fn server_value(request: &McpServerSaveRequest) -> Result<Value, String> {
    let transport = request.transport.trim().to_ascii_lowercase();
    let mut map = Map::new();
    map.insert("enabled".to_string(), Value::Bool(request.enabled));
    match transport.as_str() {
        "stdio" | "" => {
            let command = request
                .command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "stdio MCP servers need a command.".to_string())?;
            map.insert("type".to_string(), Value::String("stdio".to_string()));
            map.insert("command".to_string(), Value::String(command.to_string()));
            if !request.args.is_empty() {
                map.insert(
                    "args".to_string(),
                    Value::Array(
                        request
                            .args
                            .iter()
                            .map(|arg| Value::String(arg.clone()))
                            .collect(),
                    ),
                );
            }
            if !request.env.is_empty() {
                map.insert("env".to_string(), string_map_value(&request.env));
            }
            if let Some(cwd) = request
                .cwd
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                map.insert("cwd".to_string(), Value::String(cwd.to_string()));
            }
        }
        "http" | "sse" => {
            let url = request
                .url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{transport} MCP servers need a URL."))?;
            map.insert("type".to_string(), Value::String(transport.clone()));
            map.insert("url".to_string(), Value::String(url.to_string()));
            if !request.headers.is_empty() {
                map.insert("headers".to_string(), string_map_value(&request.headers));
            }
        }
        other => {
            return Err(format!(
                "Unsupported MCP transport \"{other}\". Use stdio, http, or sse."
            ));
        }
    }
    Ok(Value::Object(map))
}

fn string_map_value(entries: &BTreeMap<String, String>) -> Value {
    Value::Object(
        entries
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

fn to_server(name: String, scope: &str, value: Value, overridden: bool) -> McpServer {
    let object = value.as_object();
    let enabled = object
        .and_then(|map| map.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let transport = object
        .and_then(|map| map.get("type"))
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            if object.and_then(|map| map.get("url")).is_some() {
                "http".to_string()
            } else {
                "stdio".to_string()
            }
        });
    let command = object
        .and_then(|map| map.get("command"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let args: Vec<String> = object
        .and_then(|map| map.get("args"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let env = read_string_map(object.and_then(|map| map.get("env")));
    let cwd = object
        .and_then(|map| map.get("cwd"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let url = object
        .and_then(|map| map.get("url"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let headers = read_string_map(object.and_then(|map| map.get("headers")));
    let summary = match transport.as_str() {
        "http" | "sse" => url.clone().unwrap_or_else(|| transport.clone()),
        _ => {
            let mut parts = Vec::new();
            if let Some(command) = &command {
                parts.push(command.clone());
            }
            parts.extend(args.iter().cloned());
            if parts.is_empty() {
                "stdio".to_string()
            } else {
                parts.join(" ")
            }
        }
    };
    McpServer {
        name,
        scope: scope.to_string(),
        enabled,
        overridden,
        transport,
        command,
        args,
        env,
        cwd,
        url,
        headers,
        summary,
    }
}

fn read_string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("MCP server names cannot be empty.".to_string());
    }
    if name.len() > 100 {
        return Err("MCP server names may be at most 100 characters.".to_string());
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-'))
    {
        return Err(
            "MCP server names may only contain letters, numbers, underscores, dots, and hyphens."
                .to_string(),
        );
    }
    Ok(name.to_string())
}

fn normalize_scope(scope: &str) -> Result<&'static str, String> {
    match scope {
        "application" => Ok("application"),
        "project" => Ok("project"),
        _ => Err(
            "Choose whether the MCP server applies to all Lattice projects or only this project."
                .to_string(),
        ),
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn runtime_at(base: &Path) -> AgentRuntime {
        AgentRuntime::new(base.join("pi"), base.join("assets"), base.join("config"))
    }

    #[test]
    fn saves_application_and_project_servers_with_project_override() {
        let base = std::env::temp_dir().join(format!("lattice-mcp-{}", Uuid::new_v4()));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let runtime = runtime_at(&base);

        save(
            &root,
            &runtime,
            McpServerSaveRequest {
                original_name: None,
                name: "docs".to_string(),
                scope: "application".to_string(),
                enabled: true,
                transport: "stdio".to_string(),
                command: Some("npx".to_string()),
                args: vec!["-y".to_string(), "demo-mcp".to_string()],
                env: BTreeMap::new(),
                cwd: None,
                url: None,
                headers: BTreeMap::new(),
            },
        )
        .unwrap();
        save(
            &root,
            &runtime,
            McpServerSaveRequest {
                original_name: None,
                name: "docs".to_string(),
                scope: "project".to_string(),
                enabled: true,
                transport: "http".to_string(),
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                cwd: None,
                url: Some("https://example.com/mcp".to_string()),
                headers: BTreeMap::from([("Authorization".to_string(), "Bearer x".to_string())]),
            },
        )
        .unwrap();

        let servers = list(&root, &runtime).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].scope, "project");
        assert!(servers[0].overridden);
        assert_eq!(servers[0].transport, "http");
        assert!(application_path(&runtime).is_file());
        assert!(project_path(&root).is_file());

        set_enabled(&root, &runtime, "docs", false).unwrap();
        assert!(!list(&root, &runtime).unwrap()[0].enabled);

        delete(&root, &runtime, "docs", "project").unwrap();
        let remaining = list(&root, &runtime).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].scope, "application");
        assert_eq!(remaining[0].transport, "stdio");

        fs::remove_dir_all(base).unwrap();
    }

    /// Moving a server between "All Lattice projects" and "This project only".
    ///
    /// The save wrote into the new scope's file and removed the old name only
    /// from that same file, so a scope change left the old entry configured
    /// everywhere else — and invisible here, because a project entry shadows
    /// an application one.
    #[test]
    fn changing_a_servers_scope_moves_it_rather_than_copying_it() {
        let base = std::env::temp_dir().join(format!("lattice-mcp-scope-{}", Uuid::new_v4()));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let runtime = runtime_at(&base);
        let request = |scope: &str| McpServerSaveRequest {
            original_name: (scope == "project").then(|| "docs".to_string()),
            name: "docs".to_string(),
            scope: scope.to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "demo-mcp".to_string()],
            env: BTreeMap::new(),
            cwd: None,
            url: None,
            headers: BTreeMap::new(),
        };

        save(&root, &runtime, request("application")).unwrap();
        save(&root, &runtime, request("project")).unwrap();

        let servers = list(&root, &runtime).unwrap();
        assert_eq!(servers.len(), 1, "got: {servers:?}");
        assert_eq!(servers[0].scope, "project");
        assert!(
            !servers[0].overridden,
            "the application entry is still configured for every other project",
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_invalid_names_and_missing_transport_fields() {
        let base = std::env::temp_dir().join(format!("lattice-mcp-bad-{}", Uuid::new_v4()));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let runtime = runtime_at(&base);
        let err = save(
            &root,
            &runtime,
            McpServerSaveRequest {
                original_name: None,
                name: "bad name".to_string(),
                scope: "application".to_string(),
                enabled: true,
                transport: "stdio".to_string(),
                command: Some("npx".to_string()),
                args: Vec::new(),
                env: BTreeMap::new(),
                cwd: None,
                url: None,
                headers: BTreeMap::new(),
            },
        )
        .unwrap_err();
        assert!(err.contains("letters"));
        let err = save(
            &root,
            &runtime,
            McpServerSaveRequest {
                original_name: None,
                name: "remote".to_string(),
                scope: "application".to_string(),
                enabled: true,
                transport: "http".to_string(),
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                cwd: None,
                url: None,
                headers: BTreeMap::new(),
            },
        )
        .unwrap_err();
        assert!(err.contains("URL"));
        fs::remove_dir_all(base).unwrap();
    }
}
