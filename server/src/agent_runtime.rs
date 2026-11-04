//! Optional Linux sidecar supervisor. Tokens never cross the browser protocol.
use crate::{agent_sandbox::Policy, agent_workspace::Workspace};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
const START_TIMEOUT: Duration = Duration::from_secs(40);
pub const COMMANDS: &[&str] = &[
    "synara_ensure_ready",
    "headless_agent_status",
    "headless_agent_apply",
    "headless_agent_stop",
];
pub struct Running {
    child: Child,
    stopped: bool,
    pub port: u16,
    pub token: String,
    pub root: PathBuf,
    pub workspace: Workspace,
    home: PathBuf,
    _broker: crate::agent_broker::Broker,
    _metadata: crate::agent_metadata::Broker,
}
impl Running {
    fn alive(&mut self) -> bool {
        if self.stopped {
            return false;
        }
        // WNOWAIT keeps an exited leader unreaped until every descendant has
        // been stopped, preventing its SID/PID from being recycled meanwhile.
        #[cfg(target_os = "linux")]
        unsafe {
            let mut status: libc::siginfo_t = std::mem::zeroed();
            return libc::waitid(
                libc::P_PID,
                self.child.id(),
                &mut status,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            ) == 0
                && status.si_pid() == 0;
        }
        #[cfg(not(target_os = "linux"))]
        matches!(self.child.try_wait(), Ok(None))
    }
    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let pid = self.child.id();
        if let Ok(pid) = i32::try_from(pid) {
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
        }
        crate::agent_processes::stop(pid);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}
#[derive(Default)]
pub struct Hub {
    runtime: Option<PathBuf>,
    state: PathBuf,
    running: Mutex<HashMap<String, Arc<Mutex<Running>>>>,
}
impl Hub {
    pub fn new(runtime: Option<PathBuf>, state: PathBuf) -> Result<Self, String> {
        let state = state.canonicalize().map_err(|e| e.to_string())?;
        let runtime = runtime
            .map(|path| {
                path.canonicalize()
                    .map_err(|_| "Agent runtime directory is unavailable.".to_string())
            })
            .transpose()?;
        if runtime.is_some() && !cfg!(target_os = "linux") {
            return Err(
                "Headless agents require Linux Landlock; no unsafe fallback is provided.".into()
            );
        }
        Ok(Self { runtime, state, running: Default::default() })
    }
    pub fn available(&self) -> bool {
        self.runtime.is_some()
    }
    pub fn get(&self, owner: &str, root: &Path) -> Result<Arc<Mutex<Running>>, String> {
        let running = self
            .running
            .lock()
            .unwrap()
            .get(owner)
            .cloned()
            .ok_or("The agent is stopped. Open the agent panel first.")?;
        if running.lock().unwrap().root != root {
            return Err("The agent belongs to a different project.".into());
        }
        Ok(running)
    }
    pub fn invoke(
        &self, owner: &str, client: &str, root: &Path, command: &str,
    ) -> Result<Value, String> {
        if command == "headless_agent_stop" {
            let mut running = self.running.lock().unwrap();
            if let Some(agent) = running.remove(owner) {
                if !running.values().any(|other| Arc::ptr_eq(other, &agent)) {
                    agent.lock().unwrap().stop();
                }
            }
            return Ok(json!({"stopped":true}));
        }
        if command == "headless_agent_apply" {
            return self.get(owner, root)?.lock().unwrap().workspace.apply();
        }
        if command == "headless_agent_status" {
            return Ok(
                json!({"configured":self.available(),"running":self.running.lock().unwrap().get(owner).is_some_and(|r|r.lock().unwrap().root==root),"workspaceMode":"staged-explicit-writeback","provider":"codex","authentication":"dedicated-device-login"}),
            );
        }
        let Some(runtime) = &self.runtime else {
            return Err("No agent runtime configured. Start with --agent-runtime PATH.".into());
        };
        let mut running = self.running.lock().unwrap();
        let dead = running
            .values()
            .filter(|agent| !agent.lock().unwrap().alive())
            .cloned()
            .collect::<Vec<_>>();
        for agent in dead {
            running.retain(|_, other| !Arc::ptr_eq(&agent, other));
            agent.lock().unwrap().stop();
        }
        let reuse = running.get(owner).is_some_and(|agent| agent.lock().unwrap().root == root);
        if !reuse {
            if let Some(old) = running.remove(owner) {
                if !running.values().any(|other| Arc::ptr_eq(other, &old)) {
                    old.lock().unwrap().stop();
                }
            }
            if running.len() >= 128 {
                return Err("Too many agent tabs.".into());
            }
            let shared = running.values().find(|agent| agent.lock().unwrap().root == root).cloned();
            let agent = match shared {
                Some(agent) => agent,
                None => {
                    if running
                        .values()
                        .map(|agent| agent.lock().unwrap().root.clone())
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        >= 8
                    {
                        return Err("Eight projects already have active agents.".into());
                    }
                    Arc::new(Mutex::new(start(runtime, &self.state, root)?))
                }
            };
            running.insert(owner.into(), agent);
        }
        Ok(
            json!({"state":"ready","origin":format!("/api/agent/{client}/"),"authToken":null,"startupMs":null,"message":"Isolated workspace snapshot. Apply checks ordinary text edits; bibliography uses the host tools. Git/deletions/binary changes are not written back.","workspaceMode":"staged-explicit-writeback","version":"1","revision":"headless"}),
        )
    }
    pub fn close_session(&self, session: &str) {
        let mut running = self.running.lock().unwrap();
        let removed = running
            .keys()
            .filter(|owner| owner.starts_with(&format!("{session}:")))
            .cloned()
            .collect::<Vec<_>>();
        for owner in removed {
            if let Some(agent) = running.remove(&owner) {
                if !running.values().any(|other| Arc::ptr_eq(other, &agent)) {
                    agent.lock().unwrap().stop();
                }
            }
        }
    }
    pub fn close_all(&self) {
        let mut agents = self.running.lock().unwrap();
        for agent in agents.values() {
            agent.lock().unwrap().stop();
        }
        agents.clear();
    }
    pub fn reap(&self, valid: impl Fn(&str) -> bool) {
        let sessions = self
            .running
            .lock()
            .unwrap()
            .keys()
            .filter(|owner| !valid(owner.split(':').next().unwrap_or("")))
            .map(|owner| owner.split(':').next().unwrap_or("").to_string())
            .collect::<std::collections::HashSet<_>>();
        for session in sessions {
            self.close_session(&session);
        }
    }
}
#[cfg(target_os = "linux")]
fn start(runtime: &Path, state: &Path, root: &Path) -> Result<Running, String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    let archive = state.join("agents");
    if fs::read_dir(&archive).is_ok_and(|entries| entries.count() >= 32) {
        return Err("Review and remove old stopped agent workspaces before starting another (32 retained snapshots).".into());
    }
    use sha2::{Digest, Sha256};
    let identity = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    let home = archive.join(&identity[..24]);
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    crate::project::open(root)?;
    let workspace = Workspace::prepare(
        root,
        &home.join("workspace"),
        &state.join("agent-journals").join(format!("{identity}.json")),
    )?;
    let broker = crate::agent_broker::Broker::start(root)?;
    let provider = state.join("agent-provider");
    fs::create_dir_all(provider.join(".codex")).map_err(|e| e.to_string())?;
    fs::set_permissions(&provider, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    fs::create_dir_all(home.join("tmp")).map_err(|e| e.to_string())?;
    let bind = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = bind.local_addr().map_err(|e| e.to_string())?.port();
    drop(bind);
    let token =
        uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut read = vec![runtime.to_path_buf(), executable.clone(), root.to_path_buf()];
    for name in [
        "/usr",
        "/bin",
        "/lib",
        "/lib64",
        "/etc/ssl",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/passwd",
        "/etc/group",
        "/etc/localtime",
        "/etc/ld.so.cache",
        "/dev/urandom",
        "/dev/random",
        "/sys/devices/system/cpu",
        "/proc/cpuinfo",
        "/proc/meminfo",
        "/proc/self/exe",
        "/proc/self/statm",
        "/proc/self/stat",
        "/proc/self/status",
        "/proc/self/maps",
        "/proc/self/limits",
    ] {
        let path = Path::new(name);
        if path.exists() {
            read.push(path.to_path_buf());
        }
    }
    let policy =
        Policy { read, write: vec![home.clone(), provider.clone(), PathBuf::from("/dev/null")] };
    let control = state.join("agent-control").join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir_all(&control).map_err(|e| e.to_string())?;
    fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let policy_path = control.join("sandbox.json");
    crate::agent_control::create(
        &policy_path,
        Some(&serde_json::to_vec(&policy).map_err(|e| e.to_string())?),
    )?;
    let stdout = crate::agent_control::create(&control.join("stdout.log"), None)?;
    let stderr = crate::agent_control::create(&control.join("stderr.log"), None)?;
    let (parent_channel, child_channel) =
        std::os::unix::net::UnixStream::pair().map_err(|e| e.to_string())?;
    let child_descriptor = std::os::fd::AsRawFd::as_raw_fd(&child_channel);
    let mut command = Command::new(&executable);
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(child_descriptor, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .arg("agent-sandbox")
        .arg("--policy")
        .arg(&policy_path)
        .arg("--program")
        .arg(runtime.join("bin/node"))
        .arg("--")
        .arg(runtime.join("server/dist/index.mjs"))
        .arg("--port")
        .arg(port.to_string());
    command
        .env_clear()
        .env(
            "PATH",
            format!(
                "{}:{}:/usr/bin:/bin",
                runtime.join("provider-cli/bin").display(),
                runtime.join("bin").display()
            ),
        )
        .env("HOME", &home)
        .env("CODEX_HOME", provider.join(".codex"))
        .env("TMPDIR", home.join("tmp"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("SYNARA_HOME", home.join("synara"))
        .env("SYNARA_HOST", "127.0.0.1")
        .env("SYNARA_MODE", "desktop")
        .env("SYNARA_NO_BROWSER", "true")
        .env("SYNARA_AUTH_TOKEN", &token)
        .env("LATTICE_BIN", &executable)
        .env("LATTICE_AGENT_BROKER_ADDR", &broker.address)
        .env("LATTICE_AGENT_BROKER_CAPABILITY", &broker.capability)
        .env("SYNARA_PATH_HYDRATED", "1")
        .env("SHELL", "/bin/bash")
        .env("AGENT_HOST_PROFILE", "lattice")
        .env("SYNARA_TELEMETRY_ENABLED", "false")
        .env("LATTICE_DEVICE_CONTROL_ENABLED", "false")
        .current_dir(&workspace.stage)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    // Only network routing / CA settings are inherited. No host provider keys, SSH
    // agent, Google/Overleaf sessions, Lattice access token, or user HOME.
    for name in [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().map_err(|_| "Could not launch agent sandbox.".to_string())?;
    let metadata = match crate::agent_metadata::Broker::start(
        parent_channel,
        vec![home.clone(), provider.clone()],
    ) {
        Ok(value) => value,
        Err(error) => {
            crate::agent_processes::stop(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    drop(child_channel);
    let mut running = Running {
        child,
        stopped: false,
        port,
        token,
        root: root.to_path_buf(),
        workspace,
        home,
        _broker: broker,
        _metadata: metadata,
    };
    let client = crate::http::loopback(Duration::from_secs(2))
        .build()
        .map_err(|_| "Could not create health client.".to_string())?;
    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if !running.alive() {
            return Err(format!(
                "Agent runtime exited before readiness. Inspect private logs in {}",
                control.display()
            ));
        }
        if client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .is_ok_and(|r| r.status().is_success())
        {
            return Ok(running);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("The isolated agent did not become ready within 40 seconds.".into())
}
impl Running {
    pub fn contains_private(&self, bytes: &[u8]) -> bool {
        [self.token.as_bytes(), self._broker.capability.as_bytes()]
            .iter()
            .any(|marker| bytes.windows(marker.len()).any(|window| window == *marker))
    }
    pub fn redact(&self, text: &str) -> String {
        text.replace(&self.token, "[redacted]").replace(&self._broker.capability, "[redacted]")
    }
    pub fn map(&self, value: &mut Value, to_stage: bool) {
        match value {
            Value::String(value) => {
                let (from, to) = if to_stage {
                    (&self.root, &self.workspace.stage)
                } else {
                    (&self.workspace.stage, &self.root)
                };
                let from = from.to_string_lossy();
                if value == from.as_ref()
                    || value.strip_prefix(from.as_ref()).is_some_and(|rest| rest.starts_with('/'))
                {
                    *value = format!("{}{}", to.display(), &value[from.len()..]);
                }
                *value = self.redact(value);
            }
            Value::Array(values) => {
                for value in values {
                    self.map(value, to_stage)
                }
            }
            Value::Object(values) => {
                let prior = std::mem::take(values);
                for (key, mut value) in prior {
                    self.map(&mut value, to_stage);
                    values.insert(self.redact(&key), value);
                }
            }
            _ => {}
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn start(_runtime: &Path, _state: &Path, _root: &Path) -> Result<Running, String> {
    Err("Linux Landlock required".into())
}
