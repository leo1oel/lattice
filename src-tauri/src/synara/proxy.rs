//! System proxy settings for the sidecar's provider CLIs.
//!
//! Provider CLIs are ordinary child processes and do not use CFNetwork, so a
//! Finder-launched app translates macOS's system proxy into their environment,
//! without overriding any proxy variable the user already set.

use std::collections::BTreeSet;
use std::process::Command;
use system_configuration::core_foundation::array::CFArray;
use system_configuration::core_foundation::base::{CFType, CFTypeRef, TCFType};
use system_configuration::core_foundation::dictionary::CFDictionary;
use system_configuration::core_foundation::number::CFNumber;
use system_configuration::core_foundation::string::{CFString, CFStringRef};
use system_configuration::dynamic_store::SCDynamicStoreBuilder;
use system_configuration::sys::schema_definitions::{
    kSCPropNetProxiesExceptionsList, kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPPort,
    kSCPropNetProxiesHTTPProxy, kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSPort,
    kSCPropNetProxiesHTTPSProxy,
};

struct SystemProxyEnvironment {
    http_proxy: Option<String>,
    https_proxy: Option<String>,
    no_proxy: String,
}

pub(super) fn apply_system_proxy_environment(command: &mut Command) {
    if let Some(proxy) = system_proxy_environment() {
        apply_proxy_environment(command, &proxy, |key| std::env::var_os(key).is_some());
    }
}

fn apply_proxy_environment(
    command: &mut Command, proxy: &SystemProxyEnvironment,
    inherited_env_is_set: impl Fn(&str) -> bool,
) {
    let is_set = |keys: [&str; 2]| keys.into_iter().any(&inherited_env_is_set);
    let all_proxy_is_set = is_set(["ALL_PROXY", "all_proxy"]);
    let mut applied_proxy = false;
    for (key, lowercase, value) in [
        ("HTTP_PROXY", "http_proxy", &proxy.http_proxy),
        ("HTTPS_PROXY", "https_proxy", &proxy.https_proxy),
    ] {
        if let Some(value) =
            value.as_ref().filter(|_| !all_proxy_is_set && !is_set([key, lowercase]))
        {
            command.env(key, value);
            applied_proxy = true;
        }
    }
    if applied_proxy && !is_set(["NO_PROXY", "no_proxy"]) {
        command.env("NO_PROXY", &proxy.no_proxy);
    }
}

fn proxy_bypass_list(exceptions: Vec<String>) -> String {
    let mut entries = BTreeSet::from(["localhost", "127.0.0.1", "::1"].map(String::from));
    entries.extend(
        exceptions
            .iter()
            .map(|exception| exception.trim())
            .filter(|exception| !exception.is_empty() && *exception != "<local>")
            .map(|exception| {
                exception
                    .strip_prefix("*.")
                    .map_or_else(|| exception.to_string(), |domain| format!(".{domain}"))
            }),
    );
    entries.into_iter().collect::<Vec<_>>().join(",")
}

fn system_proxy_environment() -> Option<SystemProxyEnvironment> {
    let store = SCDynamicStoreBuilder::new("Lattice Synara provider proxy").build()?;
    let settings = store.get_proxies()?;
    let (http, https, exceptions_key) = unsafe {
        (
            [kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPProxy, kSCPropNetProxiesHTTPPort],
            [kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSProxy, kSCPropNetProxiesHTTPSPort],
            kSCPropNetProxiesExceptionsList,
        )
    };
    let http_proxy = proxy_url(&settings, http);
    let https_proxy = proxy_url(&settings, https);
    if http_proxy.is_none() && https_proxy.is_none() {
        return None;
    }
    let exceptions = settings
        .find(exceptions_key)
        .and_then(|value| value.downcast::<CFArray>())
        .map(|values| {
            values
                .get_all_values()
                .into_iter()
                .filter_map(|value| {
                    let value = unsafe { CFType::wrap_under_get_rule(value as CFTypeRef) };
                    value.downcast::<CFString>().map(|value| value.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(SystemProxyEnvironment {
        http_proxy,
        https_proxy,
        no_proxy: proxy_bypass_list(exceptions),
    })
}

fn proxy_url(
    settings: &CFDictionary<CFString, CFType>, [enabled, host, port]: [CFStringRef; 3],
) -> Option<String> {
    let number = |key: CFStringRef| {
        settings.find(key).and_then(|value| value.downcast::<CFNumber>())?.to_i32()
    };
    if number(enabled) != Some(1) {
        return None;
    }
    let host = settings
        .find(host)
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())?;
    let port = number(port).filter(|value| (1..=u16::MAX.into()).contains(value))?;
    let host = if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host
    };
    Some(format!("http://{host}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_env(command: &Command, key: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(name, _)| *name == key)
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    }

    #[test]
    fn applies_system_proxy_without_overriding_explicit_environment() {
        let proxy = SystemProxyEnvironment {
            http_proxy: Some("http://127.0.0.1:7897".to_string()),
            https_proxy: Some("http://127.0.0.1:7897".to_string()),
            no_proxy: "localhost,127.0.0.1,::1".to_string(),
        };
        let mut command = Command::new("node");
        apply_proxy_environment(&mut command, &proxy, |key| key == "http_proxy");

        assert_eq!(command_env(&command, "HTTP_PROXY"), None);
        assert_eq!(command_env(&command, "HTTPS_PROXY").as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(command_env(&command, "NO_PROXY").as_deref(), Some("localhost,127.0.0.1,::1"));

        let mut explicit = Command::new("node");
        apply_proxy_environment(&mut explicit, &proxy, |key| key == "ALL_PROXY");
        assert_eq!(explicit.get_envs().count(), 0);
    }

    #[test]
    fn normalizes_system_proxy_bypass_entries_for_cli_children() {
        assert_eq!(
            proxy_bypass_list(vec![
                "*.local".to_string(),
                "<local>".to_string(),
                "10.0.0.0/8".to_string(),
            ]),
            ".local,10.0.0.0/8,127.0.0.1,::1,localhost"
        );
    }
}
