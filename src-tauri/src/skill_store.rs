use crate::agents::AgentRuntime;
use crate::models::{AgentSkill, AgentSkillSaveRequest};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Default, Serialize, Deserialize)]
struct SkillPreferences {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

#[derive(Clone)]
struct SkillSource {
    name: String,
    description: String,
    scope: &'static str,
    content: String,
    path: PathBuf,
}

pub fn list(root: &Path, runtime: &AgentRuntime) -> Result<Vec<AgentSkill>, String> {
    let preferences = read_preferences(runtime)?;
    let built_ins = read_directory(&runtime.assets.join("skills"), "built-in")?;
    let application = read_directory(&runtime.config.join("skills"), "application")?;
    let project = read_directory(&root.join(".research/skills"), "project")?;
    let built_in_names = built_ins.keys().cloned().collect::<BTreeSet<_>>();
    let mut effective = built_ins;
    effective.extend(application);
    effective.extend(project);
    Ok(effective
        .into_values()
        .map(|source| AgentSkill {
            enabled: !preferences.disabled.contains(&source.name),
            editable: source.scope != "built-in",
            overridden: source.scope != "built-in" && built_in_names.contains(&source.name),
            name: source.name,
            description: source.description,
            scope: source.scope.to_string(),
            content: source.content,
        })
        .collect())
}

pub fn enabled_paths(root: &Path, runtime: &AgentRuntime) -> Result<Vec<PathBuf>, String> {
    let preferences = read_preferences(runtime)?;
    let mut effective = read_directory(&runtime.assets.join("skills"), "built-in")?;
    effective.extend(read_directory(&runtime.config.join("skills"), "application")?);
    effective.extend(read_directory(&root.join(".research/skills"), "project")?);
    Ok(effective
        .into_values()
        .filter(|source| !preferences.disabled.contains(&source.name))
        .map(|source| source.path)
        .collect())
}

pub fn save(
    root: &Path,
    runtime: &AgentRuntime,
    request: AgentSkillSaveRequest,
) -> Result<AgentSkill, String> {
    let (name, _) = parse_metadata(&request.content)?;
    let directory = scope_directory(root, runtime, &request.scope)?;
    if let Some(original_name) = request.original_name.as_deref() {
        validate_name(original_name)?;
        if original_name != name {
            let old = directory.join(original_name);
            if old.exists() {
                fs::remove_dir_all(old).map_err(err)?;
            }
        }
    }
    let path = directory.join(&name).join("SKILL.md");
    fs::create_dir_all(path.parent().expect("skill path has a parent")).map_err(err)?;
    fs::write(&path, ensure_trailing_newline(&request.content)).map_err(err)?;
    let mut preferences = read_preferences(runtime)?;
    preferences.disabled.remove(&name);
    write_preferences(runtime, &preferences)?;
    list(root, runtime)?
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| "The saved skill could not be loaded.".to_string())
}

pub fn set_enabled(runtime: &AgentRuntime, name: &str, enabled: bool) -> Result<(), String> {
    validate_name(name)?;
    let mut preferences = read_preferences(runtime)?;
    if enabled {
        preferences.disabled.remove(name);
    } else {
        preferences.disabled.insert(name.to_string());
    }
    write_preferences(runtime, &preferences)
}

pub fn delete(root: &Path, runtime: &AgentRuntime, name: &str, scope: &str) -> Result<(), String> {
    validate_name(name)?;
    if scope == "built-in" {
        return Err("Bundled skills can be disabled, but their original files are kept so they can be restored.".to_string());
    }
    let directory = scope_directory(root, runtime, scope)?;
    let path = directory.join(name);
    if !path.is_dir() {
        return Err("The skill no longer exists.".to_string());
    }
    fs::remove_dir_all(path).map_err(err)
}

fn read_directory(directory: &Path, scope: &'static str) -> Result<BTreeMap<String, SkillSource>, String> {
    let mut skills = BTreeMap::new();
    if !directory.is_dir() {
        return Ok(skills);
    }
    for entry in fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path().join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(err)?;
        let (name, description) = parse_metadata(&content)?;
        skills.insert(name.clone(), SkillSource { name, description, scope, content, path });
    }
    Ok(skills)
}

fn parse_metadata(content: &str) -> Result<(String, String), String> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Err("A skill must start with YAML frontmatter containing name and description.".to_string());
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(value.trim().trim_matches(['\'', '"']).to_string());
        } else if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().trim_matches(['\'', '"']).to_string());
        }
    }
    let name = name.filter(|value| !value.is_empty()).ok_or_else(|| "The skill frontmatter needs a name.".to_string())?;
    validate_name(&name)?;
    let description = description.filter(|value| !value.is_empty()).ok_or_else(|| "The skill frontmatter needs a description.".to_string())?;
    Ok((name, description))
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('-')
        || !name.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
    {
        return Err("Skill names may only contain lowercase letters, numbers, and hyphens.".to_string());
    }
    Ok(())
}

fn scope_directory(root: &Path, runtime: &AgentRuntime, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "application" => Ok(runtime.config.join("skills")),
        "project" => Ok(root.join(".research/skills")),
        _ => Err("Choose whether the skill applies to all Lattice projects or only this project.".to_string()),
    }
}

fn read_preferences(runtime: &AgentRuntime) -> Result<SkillPreferences, String> {
    let path = runtime.config.join("skills.json");
    if !path.is_file() {
        return Ok(SkillPreferences::default());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(err)?).map_err(err)
}

fn write_preferences(runtime: &AgentRuntime, preferences: &SkillPreferences) -> Result<(), String> {
    fs::create_dir_all(&runtime.config).map_err(err)?;
    let raw = serde_json::to_string_pretty(preferences).map_err(err)?;
    fs::write(runtime.config.join("skills.json"), format!("{raw}\n")).map_err(err)
}

fn ensure_trailing_newline(content: &str) -> String {
    format!("{}\n", content.trim_end())
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn project_skills_override_bundled_skills_and_can_be_disabled() {
        let base = std::env::temp_dir().join(format!("lattice-skills-{}", Uuid::new_v4()));
        let root = base.join("project");
        let assets = base.join("assets");
        let config = base.join("config");
        fs::create_dir_all(assets.join("skills/writing")).unwrap();
        fs::write(assets.join("skills/writing/SKILL.md"), "---\nname: writing\ndescription: Built in.\n---\n").unwrap();
        let runtime = AgentRuntime::new(base.join("pi"), assets, config);
        save(&root, &runtime, AgentSkillSaveRequest {
            original_name: None,
            scope: "project".to_string(),
            content: "---\nname: writing\ndescription: Project voice.\n---\n".to_string(),
        }).unwrap();
        let skills = list(&root, &runtime).unwrap();
        assert_eq!(skills[0].scope, "project");
        assert!(skills[0].overridden);
        set_enabled(&runtime, "writing", false).unwrap();
        assert!(enabled_paths(&root, &runtime).unwrap().is_empty());
        delete(&root, &runtime, "writing", "project").unwrap();
        assert_eq!(list(&root, &runtime).unwrap()[0].scope, "built-in");
        fs::remove_dir_all(base).unwrap();
    }
}
