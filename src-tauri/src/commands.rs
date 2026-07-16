use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;
use wait_timeout::ChildExt;

pub fn command(name: &str) -> Command {
    let mut command = Command::new(resolve(name));
    command.env("PATH", child_path());
    command
}

pub fn output_with_timeout(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {label}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Could not capture {label} output."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Could not capture {label} errors."))?;
    let stdout_reader = thread::spawn(move || read_stream(stdout));
    let stderr_reader = thread::spawn(move || read_stream(stderr));

    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| format!("Could not wait for {label}: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "{label} did not respond within {} minutes. Check the CLI in Terminal and try again.",
                timeout.as_secs() / 60
            ));
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("Could not read {label} output."))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("Could not read {label} errors."))??;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

pub fn resolve(name: &str) -> PathBuf {
    command_directories()
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|path| is_executable(path))
        .unwrap_or_else(|| PathBuf::from(name))
}

pub fn available(name: &str) -> bool {
    is_executable(&resolve(name))
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn child_path() -> OsString {
    env::join_paths(command_directories())
        .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin")))
}

fn command_directories() -> Vec<PathBuf> {
    let mut directories = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/Library/TeX/texbin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".cargo/bin"));
    }

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

fn read_stream(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_standard_system_command() {
        assert!(available("sh"));
    }

    #[test]
    fn child_commands_can_find_mactex_tools() {
        let command = command("sh");
        let path = command
            .get_envs()
            .find_map(|(name, value)| (name == "PATH").then_some(value).flatten())
            .unwrap();
        assert!(env::split_paths(path).any(|entry| entry == Path::new("/Library/TeX/texbin")));
    }
}
