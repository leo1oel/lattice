//! The whole environment the sidecar starts with. Agents never receive the
//! writer's environment or API keys: the sidecar starts from an empty
//! environment (`apply`) holding only what Lattice sets for it and the
//! allowlisted variables below, which run programs, TeX and git as the
//! writer, and reach the network through their proxy. Providers sign in
//! through their own login files (`~/.claude`, `~/.codex`) or Settings ›
//! Agent › Model endpoint, never through a key in the environment.
//!
//! Three layers, the first to name a variable wins: what Lattice itself was
//! launched with, what the login shell exports (`shell_env`), then the macOS
//! system proxy (`proxy`). `PATH` is the login shell's before the launch's,
//! which a Finder or Dock launch truncates, followed by Lattice's own search
//! path (`commands::child_path`).
//!
//! Values never reach a log; Settings receives them redacted (`report`).

use super::proxy;
use super::shell_env::{ShellError, ShellRead};
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;

/// The proxy variables, in both spellings, and the certificate bundles a
/// TLS-intercepting proxy needs beside them.
const PROXY_NAMES: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];
/// The fork offers its iOS Simulator dock and `device_*` tools only to a host
/// that sets this. A writing app has no simulator to drive, so no layer may
/// hand it to the sidecar.
const DEVICE_CONTROL_ENTITLEMENT: &str = "LATTICE_DEVICE_CONTROL_ENABLED";
/// Who and where the writer is, their language, and where temporary files
/// go: what any program needs to run as them. `SSH_AUTH_SOCK` is a
/// credential and stays out.
const SYSTEM_NAMES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TZ",
    "LANG",
    "LANGUAGE",
    "__CF_USER_TEXT_ENCODING",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    // Where the provider CLIs keep their logins, when the writer moved them.
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
];

/// Whether `name` is one the agent takes from the writer's environment:
/// the system names, the locale (`LC_*`), TeX's search paths (`TEXMF*`,
/// `TEXINPUTS`, `BIBINPUTS`, …) and the proxy, and never a name that looks
/// like a credential, whatever family it belongs to.
pub(super) fn is_inherited(name: &str) -> bool {
    !is_secret(name)
        && (SYSTEM_NAMES.contains(&name)
            || PROXY_NAMES.contains(&name)
            || name.starts_with("LC_")
            || name.starts_with("TEXMF")
            || name.ends_with("INPUTS"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SystemProxy {
    pub(super) http_proxy: Option<String>,
    pub(super) https_proxy: Option<String>,
    pub(super) no_proxy: String,
}

/// The variables `proxy` sets, skipping any `is_set` reports in either
/// spelling, and all of them when `ALL_PROXY` is set.
pub(super) fn system_proxy_variables(
    proxy: &SystemProxy, is_set: impl Fn(&str) -> bool,
) -> Vec<(&'static str, String)> {
    let is_set = |keys: [&str; 2]| keys.into_iter().any(&is_set);
    let mut variables = Vec::new();
    if is_set(["ALL_PROXY", "all_proxy"]) {
        return variables;
    }
    for (key, lowercase, value) in [
        ("HTTP_PROXY", "http_proxy", &proxy.http_proxy),
        ("HTTPS_PROXY", "https_proxy", &proxy.https_proxy),
    ] {
        if let Some(value) = value.as_ref().filter(|_| !is_set([key, lowercase])) {
            variables.push((key, value.clone()));
        }
    }
    if !variables.is_empty() && !is_set(["NO_PROXY", "no_proxy"]) {
        variables.push(("NO_PROXY", proxy.no_proxy.clone()));
    }
    variables
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Source {
    /// The environment Lattice itself was launched with.
    Launch,
    Shell,
    SystemProxy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Variable {
    value: String,
    source: Source,
}

#[derive(Clone, Debug, Default)]
pub(super) struct AgentEnvironment {
    /// The launch and shell layers, which a system proxy change leaves alone.
    base: BTreeMap<String, Variable>,
    variables: BTreeMap<String, Variable>,
    shell_error: Option<ShellError>,
}

impl AgentEnvironment {
    pub(super) fn resolve(shell: ShellRead) -> Self {
        // `vars()` would panic on a value that is not UTF-8.
        let launch = std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        Self::layered(launch, shell, proxy::system_proxy(), &crate::commands::child_path())
    }

    fn layered(
        launch: BTreeMap<String, String>, mut shell: ShellRead, system: Option<SystemProxy>,
        lattice_path: &OsStr,
    ) -> Self {
        // The login shell's PATH wins over the launch's, which is the
        // truncated one whenever the shell's is needed at all.
        let shell_path = shell.as_mut().ok().and_then(|variables| variables.remove("PATH"));
        let (shell, shell_error) = match shell {
            Ok(variables) => (variables, None),
            Err(error) => (BTreeMap::new(), Some(error)),
        };
        let mut base = BTreeMap::new();
        if let Some(value) = shell_path {
            base.insert("PATH".to_string(), Variable { value, source: Source::Shell });
        }
        for (layer, source) in [(launch, Source::Launch), (shell, Source::Shell)] {
            for (name, value) in layer.into_iter().filter(|(name, _)| is_inherited(name)) {
                base.entry(name).or_insert(Variable { value, source });
            }
        }
        let path = base
            .entry("PATH".to_string())
            .or_insert(Variable { value: String::new(), source: Source::Launch });
        path.value = search_path(&path.value, lattice_path);
        let mut environment = Self { variables: BTreeMap::new(), base, shell_error };
        environment.variables = environment.with_system_proxy(system.as_ref());
        environment
    }

    fn with_system_proxy(&self, system: Option<&SystemProxy>) -> BTreeMap<String, Variable> {
        let mut variables = self.base.clone();
        if let Some(system) = system {
            for (name, value) in system_proxy_variables(system, |name| self.base.contains_key(name))
            {
                variables.insert(name.to_string(), Variable { value, source: Source::SystemProxy });
            }
        }
        variables
    }

    /// Give `command` exactly this environment and what Lattice has already
    /// set on it, and nothing else of Lattice's own environment, so neither
    /// the launch nor anything the sidecar starts sees a key Lattice holds.
    pub(super) fn apply(&self, command: &mut Command) {
        let set_by_lattice: Vec<(OsString, OsString)> = command
            .get_envs()
            .filter_map(|(name, value)| Some((name.to_owned(), value?.to_owned())))
            .collect();
        command.env_clear();
        command.envs(self.variables.iter().map(|(name, variable)| (name, &variable.value)));
        command.envs(set_by_lattice);
        command.env_remove(DEVICE_CONTROL_ENTITLEMENT);
    }

    /// Whether a sidecar started with `self` would now start differently.
    pub(super) fn differs_from(&self, other: &Self) -> bool {
        fn values(environment: &AgentEnvironment) -> Vec<(&String, &String)> {
            environment.variables.iter().map(|(name, variable)| (name, &variable.value)).collect()
        }
        values(self) != values(other)
    }

    /// Whether the system proxy as it is now would change what `self` hands
    /// the sidecar.
    pub(super) fn system_proxy_changed(&self, system: Option<&SystemProxy>) -> bool {
        self.with_system_proxy(system) != self.variables
    }

    pub(super) fn len(&self) -> usize {
        self.variables.len()
    }

    pub(super) fn shell_error(&self) -> Option<ShellError> {
        self.shell_error
    }

    pub(super) fn report(&self, shell: String, running: bool, stale: bool) -> EnvironmentReport {
        EnvironmentReport {
            running,
            stale,
            shell,
            shell_error: self.shell_error.map(ShellError::code),
            variables: self
                .variables
                .iter()
                .map(|(name, variable)| ReportedVariable {
                    name: name.clone(),
                    value: redacted(name, &variable.value),
                    source: variable.source,
                })
                .collect(),
        }
    }
}

/// `base`'s folders, then those of Lattice's own search path it lacks.
fn search_path(base: &str, lattice: &OsStr) -> String {
    let mut directories: Vec<PathBuf> = std::env::split_paths(base).collect();
    for directory in std::env::split_paths(lattice) {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    directories.retain(|directory| !directory.as_os_str().is_empty());
    std::env::join_paths(directories)
        .ok()
        .and_then(|path| path.into_string().ok())
        .unwrap_or_else(|| base.to_string())
}

/// What Settings shows: the variables a start would use now, redacted, and
/// whether the running sidecar started with different ones.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReport {
    running: bool,
    stale: bool,
    /// The login shell's name ("zsh").
    shell: String,
    shell_error: Option<&'static str>,
    variables: Vec<ReportedVariable>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportedVariable {
    name: String,
    value: String,
    source: Source,
}

const MASK: &str = "••••";

fn is_secret(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH", "HEADERS", "CREDENTIAL"]
        .iter()
        .any(|word| name.contains(word))
}

/// `value` as Settings may show it: a secret's last four characters at most;
/// a URL without its password or query.
pub(super) fn redacted(name: &str, value: &str) -> String {
    if is_secret(name) {
        let characters = value.chars().count();
        return if characters >= 16 {
            let tail: String = value.chars().skip(characters - 4).collect();
            format!("{MASK}{tail}")
        } else {
            MASK.to_string()
        };
    }
    let Some((scheme, rest)) = value.split_once("://") else { return value.to_string() };
    let (authority, path) = rest.find(['/', '?', '#']).map_or((rest, ""), |at| rest.split_at(at));
    let host = authority
        .rsplit_once('@')
        .map_or(authority.to_string(), |(_, host)| format!("{MASK}@{host}"));
    let path =
        path.split_once(['?', '#']).map_or(path.to_string(), |(path, _)| format!("{path}?{MASK}"));
    format!("{scheme}://{host}{path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_never_receives_device_control() {
        let mut command = Command::new("node");
        // As if the login shell or Lattice's own launch exported it.
        command.env(DEVICE_CONTROL_ENTITLEMENT, "true");
        AgentEnvironment::default().apply(&mut command);
        assert!(!command_env(&command).contains_key(DEVICE_CONTROL_ENTITLEMENT));
    }

    #[test]
    fn applies_system_proxy_without_overriding_explicit_environment() {
        let proxy = SystemProxy {
            http_proxy: Some("http://127.0.0.1:7897".to_string()),
            https_proxy: Some("http://127.0.0.1:7897".to_string()),
            no_proxy: "localhost,127.0.0.1,::1".to_string(),
        };
        assert_eq!(
            system_proxy_variables(&proxy, |key| key == "http_proxy"),
            [
                ("HTTPS_PROXY", "http://127.0.0.1:7897".to_string()),
                ("NO_PROXY", "localhost,127.0.0.1,::1".to_string()),
            ]
        );
        assert!(system_proxy_variables(&proxy, |key| key == "ALL_PROXY").is_empty());
    }

    fn map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()
    }

    fn command_env(command: &Command) -> BTreeMap<String, String> {
        command
            .get_envs()
            .filter_map(|(name, value)| {
                Some((name.to_string_lossy().into_owned(), value?.to_string_lossy().into_owned()))
            })
            .collect()
    }

    fn system(proxy: &str) -> Option<SystemProxy> {
        Some(SystemProxy {
            http_proxy: Some(proxy.to_string()),
            https_proxy: Some(proxy.to_string()),
            no_proxy: "localhost,127.0.0.1,::1".to_string(),
        })
    }

    #[test]
    fn inherits_only_system_tex_and_proxy_variables() {
        for name in [
            "PATH",
            "HOME",
            "USER",
            "SHELL",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TEXMFHOME",
            "TEXINPUTS",
            "BIBINPUTS",
            "XDG_CONFIG_HOME",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "HTTPS_PROXY",
            "no_proxy",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(is_inherited(name), "{name}");
        }
        for name in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "AZURE_OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "MOONSHOT_BASE_URL",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "OPENROUTER_API_KEY",
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "STRIPE_API_KEY",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "HF_TOKEN",
            "SSH_AUTH_SOCK",
            "SYNARA_HOME",
            DEVICE_CONTROL_ENTITLEMENT,
            // Allowlisted families never carry a credential either.
            "TEXMF_TOKEN",
            "LC_SECRET",
        ] {
            assert!(!is_inherited(name), "{name}");
        }
    }

    /// A Finder launch inherits none of the shell's settings; the sidecar
    /// still receives the ones it needs, with the launch environment winning,
    /// the shell's PATH ahead of the launch's, and the system proxy filling
    /// only what neither set. Provider keys and endpoints from either layer
    /// stay out.
    #[test]
    fn a_finder_launch_hands_the_sidecar_only_the_allowlisted_shell_settings() {
        let path = |directories: &[&str]| {
            std::env::join_paths(directories).unwrap().into_string().unwrap()
        };
        let shell_path = path(&["/Users/w/.nvm/bin", "/usr/bin"]);
        let mut shell = map(&[
            ("ANTHROPIC_BASE_URL", "https://api.moonshot.cn/anthropic"),
            ("ANTHROPIC_AUTH_TOKEN", "sk-shell"),
            ("DEEPSEEK_API_KEY", "sk-deepseek"),
            ("HTTPS_PROXY", "http://127.0.0.1:7890"),
            ("LANG", "en_US.UTF-8"),
            ("TEXINPUTS", ".:~/tex//:"),
        ]);
        shell.insert("PATH".to_string(), shell_path);
        let launch = map(&[
            ("HOME", "/Users/w"),
            ("PATH", "/usr/bin:/bin"),
            ("OPENAI_API_KEY", "sk-launch"),
            ("LANG", "C"),
        ]);
        let environment = AgentEnvironment::layered(
            launch,
            Ok(shell),
            system("http://127.0.0.1:6152"),
            OsStr::new(&path(&["/Library/TeX/texbin", "/usr/bin"])),
        );
        let mut command = Command::new("node");
        environment.apply(&mut command);
        let env = command_env(&command);
        for name in
            ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"]
        {
            assert!(!env.contains_key(name), "{name}");
        }
        assert_eq!(env["HOME"], "/Users/w");
        assert_eq!(env["LANG"], "C", "the launch wins");
        assert_eq!(env["TEXINPUTS"], ".:~/tex//:");
        assert_eq!(env["PATH"], path(&["/Users/w/.nvm/bin", "/usr/bin", "/Library/TeX/texbin"]));
        assert_eq!(env["HTTPS_PROXY"], "http://127.0.0.1:7890", "the shell's proxy wins");
        assert_eq!(env["HTTP_PROXY"], "http://127.0.0.1:6152", "the system proxy fills the gap");
        let report = serde_json::to_value(environment.report("zsh".into(), true, false)).unwrap();
        let home = report["variables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variable| variable["name"] == "HOME")
            .unwrap();
        assert_eq!(home["source"], "launch");
        assert_eq!(home["value"], "/Users/w");
    }

    /// The real boundary: a sidecar started from a Lattice that holds
    /// provider keys in its own environment, from a terminal launch or a
    /// developer's shell, receives none of them, while what Lattice set on
    /// the command (the guard's variables, the auth token) survives.
    #[cfg(unix)]
    #[test]
    fn a_provider_key_in_lattices_environment_never_reaches_the_child() {
        let keys = [
            ("OPENAI_API_KEY", "sk-parent-openai-0123456789"),
            ("ANTHROPIC_API_KEY", "sk-parent-anthropic-0123456789"),
            ("LATTICE_TEST_UNLISTED", "parent-only"),
        ];
        for (name, value) in keys {
            std::env::set_var(name, value);
        }
        let shell = map(&[
            ("DEEPSEEK_API_KEY", "sk-shell-deepseek-0123456789"),
            ("TEXINPUTS", ".:/lattice-test//:"),
            ("PATH", "/usr/bin:/bin"),
        ]);
        let environment = AgentEnvironment::resolve(Ok(shell));
        for (name, _) in keys {
            std::env::remove_var(name);
        }
        let mut command = Command::new("/usr/bin/env");
        command.env("LATTICE_BIBLIOGRAPHY_SANDBOX", "1").env("SYNARA_AUTH_TOKEN", "lattice-set");
        environment.apply(&mut command);
        let output = command.output().expect("run env");
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        let child: BTreeMap<&str, &str> =
            output.lines().filter_map(|line| line.split_once('=')).collect();
        for name in
            ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "LATTICE_TEST_UNLISTED"]
        {
            assert!(!child.contains_key(name), "{name} reached the child");
        }
        for value in
            keys.map(|(_, value)| value).into_iter().chain(["sk-shell-deepseek-0123456789"])
        {
            assert!(!output.contains(value), "a key's value reached the child");
        }
        assert_eq!(child["LATTICE_BIBLIOGRAPHY_SANDBOX"], "1");
        assert_eq!(child["SYNARA_AUTH_TOKEN"], "lattice-set");
        assert_eq!(child["TEXINPUTS"], ".:/lattice-test//:");
        assert!(child["PATH"].starts_with("/usr/bin:/bin"), "{}", child["PATH"]);
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(child["HOME"], home.to_str().unwrap());
        }
        for (name, _) in child {
            assert!(
                name.starts_with("LATTICE_BIBLIOGRAPHY_SANDBOX")
                    || name == "SYNARA_AUTH_TOKEN"
                    || is_inherited(name),
                "{name} is not allowlisted"
            );
        }
    }

    #[test]
    fn a_shell_that_fails_still_leaves_the_system_proxy() {
        let environment = AgentEnvironment::layered(
            BTreeMap::new(),
            Err(ShellError::Timeout),
            system("http://127.0.0.1:7890"),
            OsStr::new(""),
        );
        let mut command = Command::new("node");
        environment.apply(&mut command);
        assert_eq!(command_env(&command)["HTTPS_PROXY"], "http://127.0.0.1:7890");
        let report = serde_json::to_value(environment.report("zsh".into(), false, false)).unwrap();
        assert_eq!(report["shellError"], "timeout");
    }

    /// P2: the sidecar's environment is fixed when it starts, so turning a
    /// proxy on afterwards has to be noticed and offered as a restart.
    #[test]
    fn notices_a_system_proxy_turned_on_after_the_agent_started() {
        let started =
            AgentEnvironment::layered(BTreeMap::new(), Ok(BTreeMap::new()), None, OsStr::new(""));
        assert!(started.system_proxy_changed(system("http://127.0.0.1:7890").as_ref()));
        assert!(!started.system_proxy_changed(None));
        let now = AgentEnvironment::layered(
            BTreeMap::new(),
            Ok(BTreeMap::new()),
            system("http://127.0.0.1:7890"),
            OsStr::new(""),
        );
        assert!(now.differs_from(&started));
        // A shell proxy shadows the system one, so changing it changes nothing.
        let shell =
            map(&[("HTTPS_PROXY", "http://127.0.0.1:1"), ("HTTP_PROXY", "http://127.0.0.1:1")]);
        let shadowed = AgentEnvironment::layered(BTreeMap::new(), Ok(shell), None, OsStr::new(""));
        assert!(!shadowed.system_proxy_changed(system("http://127.0.0.1:7890").as_ref()));
    }

    #[test]
    fn redacts_secrets_and_url_credentials() {
        assert_eq!(redacted("DEEPSEEK_API_KEY", "sk-0123456789abcdef"), "••••cdef");
        assert_eq!(redacted("ANTHROPIC_AUTH_TOKEN", "short"), "••••");
        assert_eq!(
            redacted("ANTHROPIC_CUSTOM_HEADERS", "x-api-key: sk-0123456789abcdef"),
            "••••cdef"
        );
        assert_eq!(
            redacted("HTTPS_PROXY", "http://user:pass@127.0.0.1:7890"),
            "http://••••@127.0.0.1:7890"
        );
        assert_eq!(
            redacted("OPENAI_BASE_URL", "https://example.com/v1?key=sk-secret#x"),
            "https://example.com/v1?••••"
        );
        assert_eq!(
            redacted("ANTHROPIC_BASE_URL", "https://api.moonshot.cn/anthropic"),
            "https://api.moonshot.cn/anthropic"
        );
        assert_eq!(redacted("ANTHROPIC_MODEL", "kimi-k2"), "kimi-k2");
    }
}
