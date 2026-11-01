//! The environment the sidecar's provider CLIs need from the writer's own
//! setup, which a Finder or Dock launch does not inherit: proxy settings and
//! provider endpoints and keys. Three layers, the first to name a variable
//! wins: what Lattice itself was launched with, what the login shell exports
//! (`shell_env`), then the macOS system proxy (`proxy`).
//!
//! Values never reach a log; Settings receives them redacted (`report`).

use super::proxy::{self, SystemProxy};
use super::shell_env::{ShellError, ShellRead};
use serde::Serialize;
use std::collections::BTreeMap;
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
/// Every variable of these families configures a provider CLI: Claude Code
/// pointed at Kimi, GLM or DeepSeek through `ANTHROPIC_BASE_URL`, its model
/// overrides, Codex's `OPENAI_BASE_URL`.
const PROVIDER_FAMILIES: &[&str] = &["ANTHROPIC_", "CLAUDE_CODE_", "OPENAI_", "AZURE_OPENAI_"];
/// Other providers contribute only their key and endpoint.
const PROVIDERS: &[&str] = &[
    "DEEPSEEK",
    "MOONSHOT",
    "KIMI",
    "ZHIPU",
    "ZHIPUAI",
    "GLM",
    "ZAI",
    "DASHSCOPE",
    "QWEN",
    "SILICONFLOW",
    "ARK",
    "VOLCENGINE",
    "MINIMAX",
    "OPENROUTER",
    "GEMINI",
    "GOOGLE",
    "XAI",
    "GROQ",
    "MISTRAL",
    "TOGETHER",
    "FIREWORKS",
    "PERPLEXITY",
];
const PROVIDER_SUFFIXES: &[&str] = &["_API_KEY", "_BASE_URL", "_API_BASE"];

/// Whether `name` is one the agent takes from the writer's environment.
pub(super) fn is_inherited(name: &str) -> bool {
    PROXY_NAMES.contains(&name)
        || PROVIDER_FAMILIES.iter().any(|family| name.starts_with(family))
        || PROVIDER_SUFFIXES.iter().any(|suffix| {
            name.strip_suffix(suffix).is_some_and(|provider| PROVIDERS.contains(&provider))
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Source {
    /// Lattice's own environment, which the sidecar inherits as it is.
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
            .filter(|(name, _)| is_inherited(name))
            .collect();
        Self::layered(launch, shell, proxy::system_proxy())
    }

    fn layered(
        launch: BTreeMap<String, String>, shell: ShellRead, system: Option<SystemProxy>,
    ) -> Self {
        let (shell, shell_error) = match shell {
            Ok(variables) => (variables, None),
            Err(error) => (BTreeMap::new(), Some(error)),
        };
        let mut base = BTreeMap::new();
        for (layer, source) in [(launch, Source::Launch), (shell, Source::Shell)] {
            for (name, value) in layer {
                base.entry(name).or_insert(Variable { value, source });
            }
        }
        let mut environment = Self { variables: BTreeMap::new(), base, shell_error };
        environment.variables = environment.with_system_proxy(system.as_ref());
        environment
    }

    fn with_system_proxy(&self, system: Option<&SystemProxy>) -> BTreeMap<String, Variable> {
        let mut variables = self.base.clone();
        if let Some(system) = system {
            for (name, value) in
                proxy::system_proxy_variables(system, |name| self.base.contains_key(name))
            {
                variables.insert(name.to_string(), Variable { value, source: Source::SystemProxy });
            }
        }
        variables
    }

    /// Hand the sidecar what it does not already inherit.
    pub(super) fn apply(&self, command: &mut Command) {
        for (name, variable) in &self.variables {
            if variable.source != Source::Launch {
                command.env(name, &variable.value);
            }
        }
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
    fn inherits_only_proxy_and_provider_variables() {
        for name in [
            "HTTPS_PROXY",
            "no_proxy",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "OPENAI_BASE_URL",
            "DEEPSEEK_API_KEY",
            "MOONSHOT_BASE_URL",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(is_inherited(name), "{name}");
        }
        for name in [
            "PATH",
            "HOME",
            "GITHUB_TOKEN",
            "STRIPE_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "SYNARA_HOME",
        ] {
            assert!(!is_inherited(name), "{name}");
        }
    }

    /// A Finder launch inherits none of the shell's settings; the sidecar
    /// must still receive them, with the launch environment winning and the
    /// system proxy filling only what neither set.
    #[test]
    fn a_finder_launch_hands_the_sidecar_the_login_shell_settings() {
        let shell = map(&[
            ("ANTHROPIC_BASE_URL", "https://api.moonshot.cn/anthropic"),
            ("ANTHROPIC_AUTH_TOKEN", "sk-shell"),
            ("HTTPS_PROXY", "http://127.0.0.1:7890"),
            ("OPENAI_BASE_URL", "https://shell.example/v1"),
        ]);
        let launch = map(&[("OPENAI_BASE_URL", "https://launch.example/v1")]);
        let environment =
            AgentEnvironment::layered(launch, Ok(shell), system("http://127.0.0.1:6152"));
        let mut command = Command::new("node");
        environment.apply(&mut command);
        let env = command_env(&command);
        assert_eq!(env["ANTHROPIC_BASE_URL"], "https://api.moonshot.cn/anthropic");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-shell");
        assert_eq!(env["HTTPS_PROXY"], "http://127.0.0.1:7890", "the shell's proxy wins");
        assert_eq!(env["HTTP_PROXY"], "http://127.0.0.1:6152", "the system proxy fills the gap");
        // Inherited as it is, so not set again.
        assert!(!env.contains_key("OPENAI_BASE_URL"));
        let report = serde_json::to_value(environment.report("zsh".into(), true, false)).unwrap();
        let openai = report["variables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variable| variable["name"] == "OPENAI_BASE_URL")
            .unwrap();
        assert_eq!(openai["source"], "launch");
        assert_eq!(openai["value"], "https://launch.example/v1");
    }

    #[test]
    fn a_shell_that_fails_still_leaves_the_system_proxy() {
        let environment = AgentEnvironment::layered(
            BTreeMap::new(),
            Err(ShellError::Timeout),
            system("http://127.0.0.1:7890"),
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
        let started = AgentEnvironment::layered(BTreeMap::new(), Ok(BTreeMap::new()), None);
        assert!(started.system_proxy_changed(system("http://127.0.0.1:7890").as_ref()));
        assert!(!started.system_proxy_changed(None));
        let now = AgentEnvironment::layered(
            BTreeMap::new(),
            Ok(BTreeMap::new()),
            system("http://127.0.0.1:7890"),
        );
        assert!(now.differs_from(&started));
        // A shell proxy shadows the system one, so changing it changes nothing.
        let shell =
            map(&[("HTTPS_PROXY", "http://127.0.0.1:1"), ("HTTP_PROXY", "http://127.0.0.1:1")]);
        let shadowed = AgentEnvironment::layered(BTreeMap::new(), Ok(shell), None);
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
