use super::{Manifest, Plugin};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-_".contains(&c))
        && id.as_bytes()[0].is_ascii_alphanumeric()
}

pub(super) fn manifest_at(root: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(root.join("lattice-plugin.json"))
        .map_err(|e| format!("Cannot read plugin manifest: {e}"))?;
    if text.len() > 65536 {
        return Err("Plugin manifest exceeds 64 KiB".into());
    }
    let m: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("Invalid plugin manifest: {e}"))?;
    if !valid_id(&m.id)
        || m.name.trim().is_empty()
        || m.name.len() > 120
        || m.version.trim().is_empty()
        || m.version.len() > 80
        || m.api_version != 1
    {
        return Err("Invalid plugin identity or unsupported API version (expected 1)".into());
    }
    if m.commands.is_empty() || m.commands.len() > 32 {
        return Err("A plugin must declare 1–32 commands".into());
    }
    let mut ids = HashSet::new();
    for command in &m.commands {
        let relative = Path::new(&command.executable);
        if !valid_id(&command.id)
            || !ids.insert(&command.id)
            || command.title.trim().is_empty()
            || command.title.len() > 120
            || command.args.len() > 32
            || command.args.iter().any(|s| s.len() > 4096)
            || relative.as_os_str().is_empty()
            || !relative.components().all(|p| matches!(p, Component::Normal(_)))
        {
            return Err("Invalid plugin command".into());
        }
        let binary = fs::canonicalize(root.join(relative))
            .map_err(|e| format!("Cannot find plugin executable: {e}"))?;
        if !binary.starts_with(root) || !binary.is_file() {
            return Err("Plugin executable must be a file inside its directory".into());
        }
    }
    Ok(m)
}

fn read(store: &Path) -> Result<Vec<Plugin>, String> {
    match fs::read(store.join("plugins.json")) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("Cannot read plugin registry: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Cannot read plugin registry: {e}")),
    }
}

fn write(store: &Path, plugins: &[Plugin]) -> Result<(), String> {
    fs::create_dir_all(store).map_err(|e| e.to_string())?;
    let path = store.join("plugins.json");
    let temp = store.join(format!("plugins-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, serde_json::to_vec_pretty(plugins).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(temp);
        return Err(e.to_string());
    }
    Ok(())
}

pub(crate) fn list(store: &Path) -> Result<Vec<Plugin>, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|e| e.to_string())?;
    read(store)
}

pub(crate) fn install(store: &Path, source: &Path) -> Result<Vec<Plugin>, String> {
    let path = fs::canonicalize(source).map_err(|e| format!("Cannot open plugin folder: {e}"))?;
    if !path.is_dir() {
        return Err("Choose a plugin directory".into());
    }
    let manifest = manifest_at(&path)?;
    let _guard = REGISTRY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut plugins = read(store)?;
    if plugins.iter().any(|p| p.manifest.id == manifest.id) {
        return Err("A plugin with this ID is already installed".into());
    }
    plugins.push(Plugin { manifest, path: path.to_string_lossy().into_owned(), enabled: false });
    write(store, &plugins)?;
    Ok(plugins)
}

pub(crate) fn set_enabled(store: &Path, id: &str, enabled: bool) -> Result<Vec<Plugin>, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut plugins = read(store)?;
    let plugin = plugins.iter_mut().find(|p| p.manifest.id == id).ok_or("Plugin not found")?;
    if enabled {
        let root = fs::canonicalize(&plugin.path).map_err(|e| e.to_string())?;
        let actual = manifest_at(&root)?;
        if actual.id != plugin.manifest.id {
            return Err("Plugin ID changed; remove and reinstall it".into());
        }
        plugin.manifest = actual;
    }
    plugin.enabled = enabled;
    write(store, &plugins)?;
    Ok(plugins)
}

pub(crate) fn remove(store: &Path, id: &str) -> Result<Vec<Plugin>, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut plugins = read(store)?;
    let before = plugins.len();
    plugins.retain(|p| p.manifest.id != id);
    if plugins.len() == before {
        return Err("Plugin not found".into());
    }
    write(store, &plugins)?;
    Ok(plugins)
}

pub(super) fn resolve_executable(root: &Path, executable: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(root.join(executable)).map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("Plugin executable moved outside its directory".into());
    }
    Ok(path)
}
