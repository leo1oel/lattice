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
    effective.extend(read_directory(
        &runtime.config.join("skills"),
        "application",
    )?);
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
        // Wherever it was before, not merely where it is going: an edit that
        // only changed the scope left the old copy installed — still handed to
        // the agent in every other project, and invisible in this one because
        // a project skill shadows an application one.
        for from in scope_directories(root, runtime) {
            let old = from.join(original_name);
            let new = directory.join(&name);
            if old == new || !old.is_dir() {
                continue;
            }
            // A skill is a directory: `references/`, `evals/` and scripts sit
            // beside SKILL.md and the model reads them at run time. Move the
            // whole thing, because deleting it and writing back only SKILL.md
            // destroyed everything else in it without saying so.
            if new.exists() {
                fs::remove_dir_all(&new).map_err(err)?;
            }
            fs::create_dir_all(&directory).map_err(err)?;
            fs::rename(&old, &new).map_err(err)?;
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

fn read_directory(
    directory: &Path,
    scope: &'static str,
) -> Result<BTreeMap<String, SkillSource>, String> {
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
        skills.insert(
            name.clone(),
            SkillSource {
                name,
                description,
                scope,
                content,
                path,
            },
        );
    }
    Ok(skills)
}

/// Every directory a user-owned skill can live in. Built-in skills are not
/// here: they ship inside the app and are restored rather than moved.
fn scope_directories(root: &Path, runtime: &AgentRuntime) -> Vec<PathBuf> {
    vec![runtime.config.join("skills"), root.join(".research/skills")]
}

fn parse_metadata(content: &str) -> Result<(String, String), String> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Err(
            "A skill must start with YAML frontmatter containing name and description.".to_string(),
        );
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
    let name = name
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The skill frontmatter needs a name.".to_string())?;
    validate_name(&name)?;
    let description = description
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The skill frontmatter needs a description.".to_string())?;
    Ok((name, description))
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('-')
        || !name.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(
            "Skill names may only contain lowercase letters, numbers, and hyphens.".to_string(),
        );
    }
    Ok(())
}

fn scope_directory(root: &Path, runtime: &AgentRuntime, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "application" => Ok(runtime.config.join("skills")),
        "project" => Ok(root.join(".research/skills")),
        _ => Err(
            "Choose whether the skill applies to all Lattice projects or only this project."
                .to_string(),
        ),
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

    /// A skill is a directory, not a file: `references/`, `evals/` and scripts
    /// sit beside SKILL.md and the model reads them at run time. Renaming one
    /// in Settings removed the old directory and wrote back only SKILL.md,
    /// so everything beside it was destroyed with nothing said.
    /// Moving a skill between "All Lattice projects" and "This project only".
    ///
    /// The save resolved its directory from the new scope and only removed the
    /// old name inside that same directory, so changing scope left the old
    /// copy where it was — still handed to the agent in every other project,
    /// and invisible here because a project skill shadows an application one.
    #[test]
    fn changing_a_skills_scope_moves_it_rather_than_copying_it() {
        let base = std::env::temp_dir().join(format!("lattice-skill-scope-{}", Uuid::new_v4()));
        let root = base.join("project");
        let runtime = AgentRuntime::new(base.join("pi"), base.join("assets"), base.join("config"));
        save(
            &root,
            &runtime,
            AgentSkillSaveRequest {
                original_name: None,
                scope: "application".to_string(),
                content: "---\nname: notes\ndescription: Everywhere.\n---\n".to_string(),
            },
        )
        .unwrap();
        assert!(runtime.config.join("skills/notes/SKILL.md").exists());

        save(
            &root,
            &runtime,
            AgentSkillSaveRequest {
                original_name: Some("notes".to_string()),
                scope: "project".to_string(),
                content: "---\nname: notes\ndescription: Here only.\n---\n".to_string(),
            },
        )
        .unwrap();

        assert!(root.join(".research/skills/notes/SKILL.md").exists());
        assert!(
            !runtime.config.join("skills/notes").exists(),
            "the application copy is still installed for every other project",
        );
        let skills = list(&root, &runtime).unwrap();
        assert_eq!(skills.len(), 1, "got: {skills:?}");
        assert_eq!(skills[0].scope, "project");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn renaming_a_skill_keeps_the_files_beside_its_skill_md() {
        let base = std::env::temp_dir().join(format!("lattice-skill-rename-{}", Uuid::new_v4()));
        let root = base.join("project");
        let runtime = AgentRuntime::new(base.join("pi"), base.join("assets"), base.join("config"));
        let skills = root.join(".research/skills");
        fs::create_dir_all(skills.join("old-name/references")).unwrap();
        fs::write(
            skills.join("old-name/SKILL.md"),
            "---\nname: old-name\ndescription: Before.\n---\n",
        )
        .unwrap();
        fs::write(skills.join("old-name/references/notes.md"), "kept\n").unwrap();

        save(
            &root,
            &runtime,
            AgentSkillSaveRequest {
                original_name: Some("old-name".to_string()),
                scope: "project".to_string(),
                content: "---\nname: new-name\ndescription: After.\n---\n".to_string(),
            },
        )
        .unwrap();

        assert!(!skills.join("old-name").exists());
        assert_eq!(
            fs::read_to_string(skills.join("new-name/references/notes.md")).unwrap(),
            "kept\n"
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn project_skills_override_bundled_skills_and_can_be_disabled() {
        let base = std::env::temp_dir().join(format!("lattice-skills-{}", Uuid::new_v4()));
        let root = base.join("project");
        let assets = base.join("assets");
        let config = base.join("config");
        fs::create_dir_all(assets.join("skills/writing")).unwrap();
        fs::write(
            assets.join("skills/writing/SKILL.md"),
            "---\nname: writing\ndescription: Built in.\n---\n",
        )
        .unwrap();
        let runtime = AgentRuntime::new(base.join("pi"), assets, config);
        save(
            &root,
            &runtime,
            AgentSkillSaveRequest {
                original_name: None,
                scope: "project".to_string(),
                content: "---\nname: writing\ndescription: Project voice.\n---\n".to_string(),
            },
        )
        .unwrap();
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
