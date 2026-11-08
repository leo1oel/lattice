use super::registry::{manifest_at, resolve_executable};
use super::{list, Manifest};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_OUTPUT: u64 = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
pub(crate) struct ResultOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn output(path: &Path) -> String {
    let mut bytes = Vec::new();
    if let Ok(file) = File::open(path) {
        let _ = file.take(MAX_OUTPUT + 1).read_to_end(&mut bytes);
    }
    let truncated = bytes.len() > MAX_OUTPUT as usize;
    bytes.truncate(MAX_OUTPUT as usize);
    let mut value = String::from_utf8_lossy(&bytes).to_string();
    if truncated {
        value.push_str("\n[output truncated]");
    }
    value
}

pub(crate) fn run(
    store: &Path, plugin_id: &str, command_id: &str, project: Option<&Path>,
) -> Result<ResultOutput, String> {
    let plugin =
        list(store)?.into_iter().find(|p| p.manifest.id == plugin_id).ok_or("Plugin not found")?;
    if !plugin.enabled {
        return Err("Enable the plugin before running a command".into());
    }
    let root = fs::canonicalize(&plugin.path).map_err(|e| e.to_string())?;
    let manifest: Manifest = manifest_at(&root)?;
    // A changed manifest needs a fresh, explicit enable operation. Code in a
    // linked directory can also change: only link a directory you trust.
    if serde_json::to_value(&manifest).ok() != serde_json::to_value(&plugin.manifest).ok() {
        return Err("Plugin manifest changed; disable and enable it again".into());
    }
    let action =
        manifest.commands.iter().find(|c| c.id == command_id).ok_or("Plugin command not found")?;
    let executable = resolve_executable(&root, &action.executable)?;
    fs::create_dir_all(store).map_err(|e| e.to_string())?;
    let work = store.join(format!("run-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let stdout = File::create(work.join("stdout")).map_err(|e| e.to_string())?;
        let stderr = File::create(work.join("stderr")).map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(&action.args)
            .current_dir(&root)
            .env("LATTICE_PLUGIN_ID", &manifest.id)
            .env("LATTICE_COMMAND_ID", command_id)
            .env("LATTICE_PLUGIN_API_VERSION", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if let Some(project) = project {
            command.env("LATTICE_PROJECT_ROOT", project);
        } else {
            command.env_remove("LATTICE_PROJECT_ROOT");
        }
        let mut child = command.spawn().map_err(|e| format!("Cannot start plugin: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let request = serde_json::json!({"apiVersion":1,"command":command_id,"projectRoot":project.map(|p| p.to_string_lossy().into_owned())});
            let _ = writeln!(stdin, "{request}");
        }
        let start = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if start.elapsed() >= TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Plugin command timed out after 20 seconds".into());
            }
            thread::sleep(Duration::from_millis(50));
        };
        Ok(ResultOutput {
            success: status.success(),
            exit_code: status.code(),
            stdout: output(&work.join("stdout")),
            stderr: output(&work.join("stderr")),
        })
    })();
    let _ = fs::remove_dir_all(work);
    result
}
